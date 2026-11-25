"""
dsh_memory/system.py — 把插件记忆架构接到 Continual Learning Bench 的系统实现。

映射关系（保持 DESIGN.md 的架构不变）：
- 会话（session）      = 一个 instance（一手牌 / 一个任务实例）；
- 工作区（workspace）  = 对手变体（calling_station / loose_aggressive / fit_or_fold）；
- 每手结束            = 一次 dream（判断子会话提取笔记 + 巩固 wiki）；
- 每次 respond        = 注入"已升格全局页 + 近期笔记"，再回答当前 query。

隔离：记忆只写 memory_root（默认临时目录），测试产物落在 bench/ 下。
"""

from __future__ import annotations

import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

import litellm

from ...errors import ProviderRefusalError
from ...interface import (
    ContinualLearningSystem,
    Observation,
    Query,
    Response,
    observation_marks_instance_complete,
)
from ...registry import register_system
from ..utils import completion_with_structured_output
from .dream import build_digest, run_judge
from .store import CONF_LABEL, Store

DEFAULT_SYSTEM_PROMPT = (
    "You are an agent in a continual-learning benchmark. You will be given a "
    "memory block distilled from previous instances (global lessons and session "
    "notes). Use it to adapt your policy; when notes conflict with the current "
    "evidence, trust the current observation and ignore the stale note."
)


def _resolve_api_key(env_name: str, ref_name: str) -> str | None:
    """优先用环境变量；没有则从 DSH 凭据文件里读同名 secret（不打印、不落盘）。"""
    value = os.environ.get(env_name)
    if value:
        return value
    home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh-cline"))
    credentials = home / ".credentials.yaml"
    if not credentials.exists():
        return None
    pattern = re.compile(rf"^\s*{re.escape(ref_name)}\s*:\s*(.+)$")
    for line in credentials.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = pattern.match(line)
        if match:
            return match.group(1).strip().strip('"').strip("'")
    return None


@register_system("dsh_memory")
class DSHMemorySystem(ContinualLearningSystem):
    """插件式记忆系统：先注入记忆、再行动；每手结束做一次 dream。"""

    # 每个 system 实例都有自己的 memory_root（默认临时目录），baseline 的
    # 每个 worker 也是独立进程+独立目录，因此可以安全并行；rollout 本身单进程顺序跑。
    parallel_safe = True
    # 跳过 CLB 的 stateless baseline：它会在 ProcessPoolExecutor 里实例化 120 份
    # system，实测在 109/120 处偶发挂起（worker 空闲、无出站连接）。
    # 对照改成同 schedule 下的 icl / icl_notepad 分数，以及后续单独跑的 no-memory 臂。
    supports_baseline = False

    def __init__(
        self,
        model: str = "deepseek/deepseek-chat",
        judge_model: str = "",
        memory_root: str = "",
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        top_k_notes: int = 40,
        max_inject_chars: int = 3500,
        wiki_min_sessions: int = 3,
        wiki_min_workspaces: int = 2,
        wiki_max_ratio: float = 0.7,
        max_digest_chars: int = 12000,
        reset_clears_memory: bool = True,
        memory_enabled: bool = True,
        keep_history: bool = True,
        history_max_chars: int = 14000,
        api_base: str = "",
        api_key_env: str = "OPENAI_API_KEY",
        api_key_ref: str = "OPENCODE_GO_API_KEY",
        session_id: str = "",
        name: str = "dsh_memory",
    ):
        self._name = name
        self.model = model
        self.judge_model = judge_model or model
        self.memory_enabled = bool(memory_enabled)
        self.keep_history = bool(keep_history)
        self.history_max_chars = history_max_chars
        self.system_prompt = system_prompt
        self.top_k_notes = top_k_notes
        self.max_inject_chars = max_inject_chars
        self.wiki_min_sessions = wiki_min_sessions
        self.wiki_min_workspaces = wiki_min_workspaces
        self.wiki_max_ratio = wiki_max_ratio
        self.max_digest_chars = max_digest_chars
        self.reset_clears_memory = reset_clears_memory
        self.api_base = api_base

        if api_base:
            # OpenAI 兼容网关：base + 会话头都走 litellm 的进程级设置
            litellm.drop_params = True
            litellm.api_base = api_base
            litellm.headers = {"x-opencode-session": session_id or str(uuid.uuid4())}
            key = _resolve_api_key(api_key_env, api_key_ref)
            if key:
                os.environ.setdefault(api_key_env, key)

        root = Path(memory_root) if memory_root else Path(
            tempfile.mkdtemp(prefix="dsh-memory-")
        )
        self.memory_root = root
        self.store = Store(root)
        self.state = self.store.load()

        self._pending: list[dict[str, Any]] = []
        self._current_instance: dict[str, Any] = {}
        self._last_observation = ""
        self._last_action: Any = None
        self._messages: list[dict[str, str]] = []
        self._instance_key: tuple[Any, Any] | None = None
        self._task_hint = ""
        self.dream_count = 0
        self.dream_failures = 0

    # ------------------------------------------------------------------ 回答
    def respond(self, query: Query) -> Response:
        prompt = query.prompt or ""
        if not prompt.strip():
            if self._last_action is not None:
                return Response(
                    action=self._last_action, metadata={"repeat": True, "system_type": "dsh_memory"}
                )
            raise RuntimeError("empty prompt and no previous action to repeat")

        schema_name = getattr(query.response_schema, "__name__", "")
        if "Database" in schema_name:
            self._task_hint = (
                "database_exploration：未知 SQLite 数据库问答，先 QUERY 探索再 ANSWER，"
                "按探索查询次数计分"
            )
        elif "Poker" in schema_name:
            self._task_hint = "exploitable_poker：单挑无限注德州扑克，按筹码收益计分"
        else:
            self._task_hint = schema_name or "unknown"

        # 同一 instance 内保留对话历史：查询结果通过 FEEDBACK 消息进入上下文，
        # 否则模型看不到自己的探索过程，只会反复查同一张表。
        instance_key = (query.instance_index, query.instance_id)
        new_instance = instance_key != self._instance_key
        if new_instance:
            self._instance_key = instance_key
            self._messages = []
            self._pending = []
            self._last_observation = ""

        block = ""
        if self.memory_enabled and new_instance:
            block = self.store.injection_block(
                self.state, max_chars=self.max_inject_chars, max_lines=self.top_k_notes
            )
        content = f"{block}\n\n{prompt}" if block else prompt
        system_text = (
            self.system_prompt
            if self.memory_enabled
            else "You are an agent in a continual-learning benchmark."
        )
        if self.keep_history:
            self._messages.append({"role": "user", "content": content})
            messages = [{"role": "system", "content": system_text}, *self._messages]
        else:
            messages = [
                {"role": "system", "content": system_text},
                {"role": "user", "content": content},
            ]
        try:
            action, usage = completion_with_structured_output(
                model=self.model,
                messages=messages,
                response_schema=query.response_schema,
            )
        except ProviderRefusalError:
            raise
        except Exception as exc:
            raise RuntimeError(f"LLM call failed: {exc}") from exc
        self.record_usage_event(usage)
        if self.keep_history:
            self._messages.append({"role": "assistant", "content": action.model_dump_json()})
            self._trim_history()

        metadata = query.metadata or {}
        self._current_instance = {
            "id": query.instance_id or metadata.get("instance_id"),
            "index": query.instance_index,
            "opp": metadata.get("opponent_name"),
        }
        self._last_action = action
        self._pending.append(
            {
                "prompt": prompt,
                "action": action.model_dump_json(),
            }
        )
        return Response(
            action=action,
            metadata={
                "system_type": "dsh_memory",
                "memory_block_chars": len(block),
                "notes_entries": len(self.state.get("entries", [])),
                "promoted_topics": sum(
                    1
                    for item in self.state.get("topics", {}).values()
                    if item.get("status") == "promoted"
                ),
                "model": self.model,
            },
        )

    # ------------------------------------------------------------------ 反馈
    def observe(self, observation: Observation, next_query: Query | None = None) -> None:
        content = (observation.content or "").strip()
        if content:
            self._last_observation = content
            if self.keep_history and not observation_marks_instance_complete(observation):
                self._messages.append({"role": "user", "content": f"FEEDBACK: {content}"})
                self._trim_history()
        if not self.memory_enabled:
            return
        if not observation_marks_instance_complete(observation):
            return
        self._dream()
        self._pending = []
        self._last_observation = ""

    def _trim_history(self) -> None:
        """控制同实例上下文的体积：保留第一条（含记忆块的问题），砍掉最旧的成对消息。"""
        total = sum(len(message.get("content") or "") for message in self._messages)
        while total > self.history_max_chars and len(self._messages) > 4:
            removed = self._messages.pop(1)
            total -= len(removed.get("content") or "")

    def _dream(self) -> None:
        """会话级 dream：判断器提取 → 写笔记 → 巩固 wiki → 记审计。"""
        if not self._pending:
            return
        meta = self._current_instance or {}
        instance_id = str(meta.get("id") or "unknown")
        instance_index = int(meta.get("index") or 0)
        opponent = str(meta.get("opp") or "")
        listing = self.store.list_for_judge(self.state, limit=20)
        memory_lines = [
            f"{number}. [{CONF_LABEL.get(entry.get('confidence', 1), 'U')}|{entry['scope']}] "
            f"{entry['text'][:100]}"
            for number, entry in enumerate(listing, start=1)
        ]
        digest = build_digest(
            self._pending,
            self._last_observation,
            task_hint=self._task_hint,
            memory_lines=memory_lines,
            max_chars=self.max_digest_chars,
        )
        facts, ops, usage, error = run_judge(
            self.judge_model, digest, task_hint=self._task_hint
        )
        if usage is not None:
            self.record_usage_event(usage)
        maintenance = self.store.apply_maintenance(
            self.state,
            listing=listing,
            retract_indices=ops.get("retract", []),
            corrections=ops.get("corrections", []),
        )
        added = self.store.add_facts(
            self.state,
            instance_id=instance_id,
            instance_index=instance_index,
            opponent=opponent,
            facts=facts,
        )
        merged = self.store.merge_similar(self.state)
        summary = self.store.rebuild_wiki(
            self.state,
            min_sessions=self.wiki_min_sessions,
            min_workspaces=self.wiki_min_workspaces,
            max_ratio=self.wiki_max_ratio,
        )
        self.store.save(self.state)
        self.dream_count += 1
        if error:
            self.dream_failures += 1
        self.store.record_run(
            {
                "instance": instance_id,
                "index": instance_index,
                "opponent": opponent,
                "added": added,
                "facts": len(facts),
                "merged": merged,
                **maintenance,
                "error": error,
                **summary,
            }
        )

    # ------------------------------------------------------------------ 生命周期
    def reset(self) -> None:
        """只清进程内状态，不清已学到的知识（知识是跨 run 的资产）。"""
        self._pending = []
        self._current_instance = {}
        self._last_observation = ""
        self._last_action = None
        self._messages = []
        self._instance_key = None
        self.state = self.store.load()

    @property
    def name(self) -> str:
        return self._name

    def get_run_artifacts(self) -> dict[str, Any]:
        # CLB 的 trace 约定：memory_backend / memory_dir / memory_files
        memory_files: dict[str, str] = {}
        notes = {}
        for path in sorted(self.store.notes_dir.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")[:4000]
            except OSError:
                continue
            notes[path.name] = text
            memory_files[f"notes/{path.name}"] = text
        wiki = {}
        for path in sorted(self.store.wiki_dir.glob("*.md")):
            if path.name == "index.md":
                continue
            try:
                text = path.read_text(encoding="utf-8")[:4000]
            except OSError:
                continue
            wiki[path.name] = text
            memory_files[f"wiki/{path.name}"] = text
        return {
            "memory_backend": "dsh_memory",
            "memory_dir": str(self.memory_root),
            "memory_files": memory_files,
            "artifact_type": "dsh_memory",
            "notes": notes,
            "wiki": wiki,
            "entries": len(self.state.get("entries", [])),
            "topics": len(self.state.get("topics", {})),
            "dreams": self.dream_count,
            "dream_failures": self.dream_failures,
            "runs_recorded": self.state.get("runs", 0),
        }
