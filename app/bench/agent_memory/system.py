"""agent_memory/system.py — 让 agent 自己维护记忆目录的 CLB 系统。

和 dsh_memory 的区别：
- dsh_memory：judge 只输出 JSON 事实，代码负责去重/合并/升格；
- 这里：记忆就是一个普通目录，模型拿 memory_list/read/write/delete 工具
  自己决定写什么、改什么、删什么；代码只做路径消毒和容量上限。

答题时同样可以调用这些工具（完整 agent 循环），最终动作通过 submit 工具提交。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import litellm
from pydantic import ValidationError

from ...interface import (
    ContinualLearningSystem,
    Observation,
    Query,
    Response,
    observation_marks_instance_complete,
)
from ...registry import register_system
from ...usage import UsageEvent
from .memory_fs import MemoryFS

ANSWER_SYSTEM = """You are an agent solving a continual-learning benchmark task across many \
independent instances. A persistent memory directory survives across instances.

At the start of each instance you see the current MEMORY.md index. Memory tools:
- memory_list(): list memory files with size and a one-line preview
- memory_read(path): read a memory markdown file
- memory_write(path, content): create or overwrite a memory markdown file
- memory_delete(path): delete a memory file

Use them when a prior lesson may apply or when an existing note is stale. Memory
operations are limited per step, so spend them only when they change your answer.
To finish, call submit with the task action. Do not dump final answers into memory;
store reusable knowledge about the environment, strategy rules, and traps instead."""

TRUST_SUFFIX = (
    "\n\nMemory notes record findings verified in earlier instances. Treat them as "
    "established facts unless a fresh query contradicts them; do not re-derive them "
    "from scratch."
)

VERIFIED_HEADER = "### Verified memory (confirmed in earlier instances; do not re-derive)\n\n"

MAINTAINER_SYSTEM = """You maintain a small, durable memory directory for a benchmark agent \
that will face many future instances of the same task family.

You receive: the current memory index, the question, the actions taken, and the final
feedback. Update memory so future instances solve faster.

Rules:
- MEMORY.md is the index. Keep it under ~1200 characters, one short line per lesson,
  pointing to notes/<topic>.md files for details.
- Store reusable knowledge: how the environment works (identifiers, semantics, common
  confusions), strategy rules that worked, and concrete traps ("X means Y; do Z instead").
  Never store final answers verbatim; write in your own words.
- Tool results are the strongest evidence: keep the concrete facts they show (table or
  column names, unit, enum values, error text), not the narrative of what you tried.
- Date each fact with the instance it came from (for example "i12"). When a later
  observation contradicts an old note, rewrite that note and say what changed and when.
- If new evidence contradicts an old note, rewrite or delete the old note; do not append
  a duplicate.
- Only record what is likely to recur. Skip one-off quirks.
- Call finish with a one-line summary when done."""

DREAM_SYSTEM = """You are the memory librarian for a benchmark agent. The memory directory \
has grown through many instances and now needs consolidation ("dreaming").

You receive the current index, the file list with sizes, and recent maintenance summaries.
Reorganize memory with the file tools:

- Merge overlapping or duplicate notes into one canonical note per topic; delete the rest.
- Rewrite MEMORY.md as a compact index (under ~1200 characters): one line per topic with a
  pointer to its note.
- Drop one-off or stale details; keep knowledge likely to recur.
- When two notes disagree, keep the newest dated version and delete the superseded one.
- Only reference files that exist; fix or drop dangling index lines.
- Aim to cut total memory roughly in half, so future lessons have room to land.
- Finish with finish(summary) describing what you merged, dropped, or rewrote."""

MEMORY_TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "memory_list",
            "description": "List memory files with size and a one-line preview.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_read",
            "description": "Read a memory markdown file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_write",
            "description": "Create or overwrite a memory markdown file. Keep it short.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_delete",
            "description": "Delete a memory file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finish",
            "description": "Finish memory maintenance with a one-line summary.",
            "parameters": {
                "type": "object",
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
                "additionalProperties": False,
            },
        },
    },
]


def _resolve_api_key(env_name: str, ref_name: str) -> str | None:
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


def _inline_refs(schema: dict) -> dict:
    """把 pydantic 生成的 $defs/$ref 展开，避免网关不认。"""

    defs = schema.get("$defs") or {}

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node and len(node) == 1:
                name = node["$ref"].split("/")[-1]
                return resolve(defs.get(name, {}))
            return {key: resolve(value) for key, value in node.items() if key != "$defs"}
        if isinstance(node, list):
            return [resolve(item) for item in node]
        return node

    out = resolve(schema)
    out.pop("title", None)
    return out


@register_system("dsh_agent_memory")
class AgentMemorySystem(ContinualLearningSystem):
    """记忆目录由 agent 自己维护；答题时也可读写记忆文件。"""

    supports_baseline = False

    def __init__(
        self,
        model: str = "openai/deepseek-v4.1-flash",
        memory_root: str = "",
        system_prompt: str = ANSWER_SYSTEM,
        memory_enabled: bool = True,
        keep_history: bool = True,
        history_max_chars: int = 14000,
        max_rounds: int = 5,
        memory_calls_per_step: int = 3,
        maintain_rounds: int = 10,
        dream_every: int = 10,
        dream_ratio: float = 0.75,
        dream_target_ratio: float = 0.5,
        dream_rounds: int = 12,
        memory_trust: bool = False,
        request_retries: int = 3,
        max_file_chars: int = 3000,
        max_total_chars: int = 16000,
        max_files: int = 40,
        temperature: float = 0.0,
        request_timeout: float = 180.0,
        api_base: str = "",
        api_key_env: str = "OPENAI_API_KEY",
        api_key_ref: str = "OPENCODE_GO_API_KEY",
        session_id: str = "",
        name: str = "dsh_agent_memory",
    ):
        self._name = name
        self.model = model
        self.memory_enabled = bool(memory_enabled)
        self.keep_history = bool(keep_history)
        self.history_max_chars = int(history_max_chars)
        self.system_prompt = system_prompt
        if memory_trust and system_prompt == ANSWER_SYSTEM:
            self.system_prompt = ANSWER_SYSTEM + TRUST_SUFFIX
        self.memory_trust = bool(memory_trust)
        self.request_retries = int(request_retries)
        self.max_rounds = int(max_rounds)
        self.memory_calls_per_step = int(memory_calls_per_step)
        self.maintain_rounds = int(maintain_rounds)
        self.dream_every = int(dream_every)
        self.dream_ratio = float(dream_ratio)
        self.dream_target_ratio = float(dream_target_ratio)
        self.dream_rounds = int(dream_rounds)
        self.temperature = float(temperature)
        self.request_timeout = float(request_timeout)
        self.api_base = api_base
        self.api_key_env = api_key_env
        self.api_key = _resolve_api_key(api_key_env, api_key_ref) or ""

        if api_base:
            litellm.drop_params = True
            litellm.api_base = api_base
            litellm.headers = {"x-opencode-session": session_id or str(uuid.uuid4())}

        root = Path(memory_root) if memory_root else Path(
            tempfile.mkdtemp(prefix="agent-memory-")
        )
        self.memory_root = root
        self.fs = MemoryFS(
            root,
            max_file_chars=max_file_chars,
            max_total_chars=max_total_chars,
            max_files=max_files,
        )

        self._messages: list[dict[str, str]] = []
        self._instance_key: tuple[Any, Any] | None = None
        self._pending: list[dict[str, Any]] = []
        self._observations: list[str] = []
        self._current_instance: dict[str, Any] = {}
        self._last_action: Any = None
        self._task_hint = ""
        self.maintain_count = 0
        self.maintain_failures = 0
        self.dream_count = 0
        self.memory_tool_calls = 0

    # ------------------------------------------------------------------ LLM
    def _complete(self, messages: list[dict], tools: list[dict], *, purpose: str):
        last: Exception | None = None
        for attempt in range(self.request_retries + 1):
            try:
                response = litellm.completion(
                    model=self.model,
                    messages=messages,
                    tools=tools,
                    tool_choice="auto",
                    temperature=self.temperature,
                    timeout=self.request_timeout,
                    api_key=self.api_key or None,
                    api_base=self.api_base or None,
                )
                self._record_usage(response, purpose)
                return response
            except Exception as exc:  # 网络抖动/限流：退避重试
                last = exc
                transient = any(
                    key in type(exc).__name__
                    for key in ("Timeout", "Connection", "RateLimit", "ServiceUnavailable", "InternalServer")
                )
                if attempt >= self.request_retries or not transient:
                    raise
                time.sleep(min(20.0, 5.0 * (attempt + 1)))
        raise last  # pragma: no cover - 循环内必返回或抛出

    def _record_usage(self, response: Any, purpose: str) -> None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        self.record_usage_event(
            UsageEvent(
                call_type=purpose,
                model=self.model,
                input_tokens=getattr(usage, "prompt_tokens", None),
                output_tokens=getattr(usage, "completion_tokens", None),
                total_tokens=getattr(usage, "total_tokens", None),
                raw_usage=usage.model_dump() if hasattr(usage, "model_dump") else None,
            )
        )

    # ------------------------------------------------------------------ 工具
    def _tools_for(self, response_schema: type) -> list[dict]:
        submit = {
            "type": "function",
            "function": {
                "name": "submit",
                "description": "Submit the final task action for this step.",
                "parameters": _inline_refs(response_schema.model_json_schema()),
            },
        }
        tools = [submit]
        if self.memory_enabled:
            tools.extend(MEMORY_TOOL_DEFS[:-1])
        return tools

    def _execute_memory_tool(self, name: str, args: dict) -> str:
        try:
            if name == "memory_list":
                files = self.fs.list_files()
                return json.dumps(files, ensure_ascii=False, indent=1)
            if name == "memory_read":
                return self.fs.read(str(args.get("path", "")))
            if name == "memory_write":
                return self.fs.write(str(args.get("path", "")), str(args.get("content", "")))
            if name == "memory_delete":
                return self.fs.delete(str(args.get("path", "")))
        except Exception as exc:  # 工具错误回给模型，不中断运行
            return f"[错误] {type(exc).__name__}: {exc}"
        return f"[错误] 未知工具 {name}"

    @staticmethod
    def _parse_args(raw: Any) -> dict:
        if isinstance(raw, dict):
            return raw
        try:
            parsed = json.loads(raw or "{}")
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    # ------------------------------------------------------------------ 回答
    def respond(self, query: Query) -> Response:
        prompt = query.prompt or ""
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

        instance_key = (query.instance_index, query.instance_id)
        new_instance = instance_key != self._instance_key
        if new_instance:
            self._instance_key = instance_key
            self._messages = []
            self._pending = []
            self._observations = []

        block = ""
        if self.memory_enabled and new_instance:
            block = self.fs.index_text()
            if self.memory_trust and block:
                block = VERIFIED_HEADER + block
        content = f"{block}\n\n{prompt}" if block else prompt

        tools = self._tools_for(query.response_schema)
        messages: list[dict] = [{"role": "system", "content": self.system_prompt}]
        if self.keep_history:
            messages.extend(self._messages)
        messages.append({"role": "user", "content": content})

        action, meta = self._tool_loop(
            messages,
            tools,
            response_schema=query.response_schema,
            max_rounds=self.max_rounds,
            max_memory_calls=self.memory_calls_per_step,
            purpose="answer",
        )

        if self.keep_history:
            self._messages.append({"role": "user", "content": prompt})
            self._messages.append(
                {"role": "assistant", "content": action.model_dump_json()}
            )
            self._trim_history()

        self._current_instance = {
            "id": query.instance_id,
            "index": query.instance_index,
            "opp": (query.metadata or {}).get("opponent_name"),
        }
        self._last_action = action
        self._pending.append(
            {"prompt": prompt[:1200], "action": action.model_dump_json()}
        )
        return Response(
            action=action,
            metadata={
                "system_type": "dsh_agent_memory",
                "memory_files": self.fs.stats()["files"],
                "memory_chars": self.fs.stats()["total_chars"],
                "memory_tool_calls": meta.get("memory_calls", 0),
                "rounds": meta.get("rounds", 0),
                "model": self.model,
            },
        )

    def _tool_loop(
        self,
        messages: list[dict],
        tools: list[dict],
        *,
        response_schema: type,
        max_rounds: int,
        max_memory_calls: int,
        purpose: str,
    ) -> tuple[Any, dict]:
        memory_calls = 0
        submit_only = [tool for tool in tools if tool["function"]["name"] == "submit"]
        for round_no in range(max_rounds):
            last_round = round_no == max_rounds - 1
            response = self._complete(
                messages, submit_only if last_round else tools, purpose=purpose
            )
            msg = response.choices[0].message
            tool_calls = list(getattr(msg, "tool_calls", None) or [])
            if last_round and tool_calls and not any(
                tc.function.name == "submit" for tc in tool_calls
            ):
                # 最后一轮只给了 submit：模型却想调别的工具，直接进入兜底
                continue
            if not tool_calls:
                text = (msg.content or "").strip()
                parsed = self._try_parse_action(text, response_schema)
                if parsed is not None:
                    return parsed, {"rounds": round_no + 1, "memory_calls": memory_calls}
                messages.append({"role": "assistant", "content": text or "(empty)"})
                messages.append(
                    {
                        "role": "user",
                        "content": "请调用 submit 工具提交最终动作，不要直接输出文本。",
                    }
                )
                continue
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": msg.content or None,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            }
            messages.append(assistant_msg)
            for tc in tool_calls:
                name = tc.function.name
                args = self._parse_args(tc.function.arguments)
                if name == "submit":
                    try:
                        return (
                            response_schema.model_validate(args),
                            {"rounds": round_no + 1, "memory_calls": memory_calls},
                        )
                    except ValidationError as exc:
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.id,
                                "content": f"提交校验失败，请修正后重试: {exc.errors()[:2]}",
                            }
                        )
                        continue
                if name.startswith("memory_"):
                    if memory_calls >= max_memory_calls:
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.id,
                                "content": "本步记忆工具预算已用完，请调用 submit 提交动作。",
                            }
                        )
                        continue
                    memory_calls += 1
                    self.memory_tool_calls += 1
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": self._execute_memory_tool(name, args),
                        }
                    )
                    continue
                messages.append(
                    {"role": "tool", "tool_call_id": tc.id, "content": f"[错误] 未知工具 {name}"}
                )
        # 兜底：轮次用完后再给一次「只允许 submit」的机会
        messages.append(
            {
                "role": "user",
                "content": "轮次已用完：现在直接调用 submit 提交最终动作（或在文本里输出合法动作 JSON），"
                "不要再调用记忆工具。",
            }
        )
        try:
            response = self._complete(messages, submit_only, purpose=purpose)
            msg = response.choices[0].message
            for tc in list(getattr(msg, "tool_calls", None) or []):
                if tc.function.name != "submit":
                    continue
                args = self._parse_args(tc.function.arguments)
                try:
                    return response_schema.model_validate(args), {
                        "rounds": max_rounds + 1,
                        "memory_calls": memory_calls,
                    }
                except ValidationError:
                    continue
            parsed = self._try_parse_action((msg.content or "").strip(), response_schema)
            if parsed is not None:
                return parsed, {"rounds": max_rounds + 1, "memory_calls": memory_calls}
        except Exception:
            pass
        raise RuntimeError(f"工具循环超过 {max_rounds} 轮仍未提交动作")

    @staticmethod
    def _try_parse_action(text: str, response_schema: type) -> Any:
        text = text.strip()
        if not text:
            return None
        candidates = [text]
        if "```" in text:
            parts = text.split("```")
            candidates.extend(part.lstrip("json").strip() for part in parts if part.strip())
        for candidate in candidates:
            try:
                data = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict):
                try:
                    return response_schema.model_validate(data)
                except ValidationError:
                    continue
        return None

    def _trim_history(self) -> None:
        total = sum(len(message.get("content") or "") for message in self._messages)
        while total > self.history_max_chars and len(self._messages) > 4:
            removed = self._messages.pop(1)
            total -= len(removed.get("content") or "")

    # ------------------------------------------------------------------ 反馈
    def observe(self, observation: Observation, next_query: Query | None = None) -> None:
        content = (observation.content or "").strip()
        if content:
            if not observation_marks_instance_complete(observation):
                self._observations.append(content[:1500])
                if self.keep_history:
                    self._messages.append({"role": "user", "content": f"FEEDBACK: {content}"})
                    self._trim_history()
        if not self.memory_enabled:
            return
        if not observation_marks_instance_complete(observation):
            return
        self._maintain(content)
        self._pending = []
        self._observations = []

    def _maintain(self, final_observation: str) -> None:
        if not self._pending:
            return
        instance = self._current_instance or {}
        instance_id = str(instance.get("id") or "unknown")
        lines = [
            f"任务: {self._task_hint}",
            f"实例: {instance_id} (index {instance.get('index')})",
            "",
            "### 当前记忆",
            self.fs.index_text(max_chars=1200),
            "",
            "### 本次实例（动作与工具结果）",
        ]
        if self._pending:
            lines.append(f"问题: {self._pending[0]['prompt'][:600]}")
        observations = list(self._observations)
        for step, item in enumerate(self._pending, start=1):
            lines.append(f"{step}. 动作: {item['action'][:300]}")
            if step - 1 < len(observations):
                lines.append(f"   结果: {observations[step - 1][:300]}")
        if final_observation:
            lines.append(f"最终反馈: {final_observation[:800]}")
        digest = "\n".join(lines)[:9000]

        tools = [tool for tool in MEMORY_TOOL_DEFS]
        messages = [
            {"role": "system", "content": MAINTAINER_SYSTEM},
            {"role": "user", "content": digest},
        ]
        finish_summary = ""
        error = ""
        ops_before = len(self.fs.ops)
        try:
            for _ in range(self.maintain_rounds):
                response = self._complete(messages, tools, purpose="maintain")
                msg = response.choices[0].message
                tool_calls = list(getattr(msg, "tool_calls", None) or [])
                if not tool_calls:
                    break
                messages.append(
                    {
                        "role": "assistant",
                        "content": msg.content or None,
                        "tool_calls": [
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.name,
                                    "arguments": tc.function.arguments,
                                },
                            }
                            for tc in tool_calls
                        ],
                    }
                )
                finished = False
                for tc in tool_calls:
                    name = tc.function.name
                    args = self._parse_args(tc.function.arguments)
                    if name == "finish":
                        finish_summary = str(args.get("summary", ""))[:300]
                        finished = True
                        messages.append(
                            {"role": "tool", "tool_call_id": tc.id, "content": "[ok] 收工"}
                        )
                        continue
                    result = self._execute_memory_tool(name, args)
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
                if finished:
                    break
        except Exception as exc:  # 维护失败不应中断整个 run
            error = f"{type(exc).__name__}: {exc}"

        self._enforce_index_limit()
        self.maintain_count += 1
        if error:
            self.maintain_failures += 1
        self._record_maintenance(instance_id, final_observation, ops_before, finish_summary, error)
        self._maybe_dream(instance_id)

    # ------------------------------------------------------------------ dream
    def _memory_ratio(self) -> float:
        stats = self.fs.stats()
        return stats["total_chars"] / max(1, self.fs.max_total_chars)

    def _maybe_dream(self, instance_id: str) -> None:
        if not self.memory_enabled:
            return
        due = self.dream_every > 0 and self.maintain_count % self.dream_every == 0
        if not (due or self._memory_ratio() >= self.dream_ratio):
            return
        self._dream(instance_id)

    def _snapshot_history(self, keep: int = 3) -> str:
        """把当前记忆复制到 <root>-history/<stamp>/，用于审计与回滚。"""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        history_root = self.memory_root.parent / f"{self.memory_root.name}-history"
        target = history_root / stamp
        try:
            target.mkdir(parents=True, exist_ok=True)
            for item in self.fs.list_files():
                src = self.memory_root / item["path"]
                dst = target / item["path"]
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
            dirs = sorted(path for path in history_root.iterdir() if path.is_dir())
            for old in dirs[:-keep]:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            return ""
        return str(target)

    def _dream(self, instance_id: str) -> None:
        """整理记忆：合并重复、精简索引、删掉一次性细节。"""
        stats_before = self.fs.stats()
        history_dir = self._snapshot_history()
        recent: list[str] = []
        try:
            lines = [
                line
                for line in (self.memory_root / "runs.jsonl")
                .read_text(encoding="utf-8", errors="ignore")
                .splitlines()
                if line.strip()
            ]
            for line in lines[-8:]:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") == "maintenance" and record.get("summary"):
                    recent.append(str(record["summary"])[:160])
        except OSError:
            pass

        digest = "\n".join(
            [
                f"记忆目录：{stats_before['files']} 个文件，{stats_before['total_chars']} 字"
                f"（上限 {self.fs.max_total_chars} 字）。",
                f"当前占用 {self._memory_ratio():.0%}，目标压到约 {self.dream_target_ratio:.0%}。",
                "",
                "最近维护摘要:",
                *([f"- {item}" for item in recent] or ["- （无）"]),
                "",
                "### 当前记忆",
                self.fs.index_text(max_chars=2000),
            ]
        )[:9000]

        tools = list(MEMORY_TOOL_DEFS)
        messages = [
            {"role": "system", "content": DREAM_SYSTEM},
            {"role": "user", "content": digest},
        ]
        summary = ""
        error = ""
        ops_before = len(self.fs.ops)
        try:
            for _ in range(self.dream_rounds):
                response = self._complete(messages, tools, purpose="dream")
                msg = response.choices[0].message
                tool_calls = list(getattr(msg, "tool_calls", None) or [])
                if not tool_calls:
                    break
                messages.append(
                    {
                        "role": "assistant",
                        "content": msg.content or None,
                        "tool_calls": [
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.name,
                                    "arguments": tc.function.arguments,
                                },
                            }
                            for tc in tool_calls
                        ],
                    }
                )
                finished = False
                for tc in tool_calls:
                    name = tc.function.name
                    args = self._parse_args(tc.function.arguments)
                    if name == "finish":
                        summary = str(args.get("summary", ""))[:300]
                        finished = True
                        messages.append(
                            {"role": "tool", "tool_call_id": tc.id, "content": "[ok] 收工"}
                        )
                        continue
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": self._execute_memory_tool(name, args),
                        }
                    )
                if finished:
                    break
        except Exception as exc:  # dream 失败不影响主流程
            error = f"{type(exc).__name__}: {exc}"

        self._enforce_index_limit()
        self.dream_count += 1
        record = {
            "at": datetime.now(timezone.utc).isoformat(),
            "type": "dream",
            "instance": instance_id,
            "ops": self.fs.ops[ops_before:],
            "summary": summary,
            "error": error,
            "stats_before": stats_before,
            "stats_after": self.fs.stats(),
            "history_dir": history_dir,
        }
        try:
            with open(self.memory_root / "runs.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def _enforce_index_limit(self, limit: int = 2000) -> None:
        try:
            text = self.fs.read("MEMORY.md", max_chars=100000)
            if len(text) > limit:
                self.fs.write("MEMORY.md", text[:limit] + "\n\n<!-- 超长部分已截断 -->")
        except Exception:
            return

    def _record_maintenance(
        self,
        instance_id: str,
        final_observation: str,
        ops_before: int,
        summary: str,
        error: str,
    ) -> None:
        record = {
            "at": datetime.now(timezone.utc).isoformat(),
            "type": "maintenance",
            "instance": instance_id,
            "ops": self.fs.ops[ops_before:],
            "summary": summary,
            "error": error,
            "stats": self.fs.stats(),
            "feedback": final_observation[:300],
        }
        try:
            with open(self.memory_root / "runs.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass

    # ------------------------------------------------------------------ 生命周期
    def reset(self) -> None:
        self._messages = []
        self._pending = []
        self._observations = []
        self._current_instance = {}
        self._instance_key = None
        self._last_action = None

    @property
    def name(self) -> str:
        return self._name

    def get_run_artifacts(self) -> dict[str, Any]:
        snapshot = self.fs.snapshot()
        return {
            "memory_backend": "dsh_agent_memory",
            "memory_dir": str(self.memory_root),
            "memory_files": snapshot,
            "artifact_type": "dsh_agent_memory",
            "counts": self.fs.stats(),
            "maintain_count": self.maintain_count,
            "maintain_failures": self.maintain_failures,
            "dream_count": self.dream_count,
            "memory_tool_calls": self.memory_tool_calls,
        }
