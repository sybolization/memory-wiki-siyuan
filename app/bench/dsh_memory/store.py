"""
dsh_memory/store.py — 记忆存储、注入块与 wiki 巩固。

架构对照（DESIGN.md）：
- 笔记（notes/）= 会话级原始条目，每条带 [V|I|U] 与 (s<instance>) 证据戳；
- 巩固（rebuild_wiki）= 按"同一结论"聚合，够门槛的 [g] 升格成 wiki 页，其余留在 candidates；
- 体积闸门 = 升格页字节 / 笔记字节 ≤ 比例上限，超标则本轮不升格；
- 注入（injection_block）= 已升格的全局页 + 近期笔记，按字符预算截断。

隔离：所有文件只写在 memory_root 下，不碰 $DSH_HOME/memory。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = 1

CONF_WEIGHT = {"U": 1, "I": 2, "V": 3}
CONF_LABEL = {3: "V", 2: "I", 1: "U"}

# 隐私闸门：命中任意一条就不让进笔记（与插件 lint.js 的规则对齐）
PRIVACY_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("absolute-path", re.compile(r"[A-Za-z]:\\[^\s]+")),
    ("unc-path", re.compile(r"\\\\[^\s]+")),
    ("user-home", re.compile(r"/(?:home|Users)/[^\s]+")),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("secret", re.compile(r"[A-Za-z0-9+/]{32,}={0,2}")),
)

_PUNCT = re.compile(r"[\s，。！？、；：,.!?;:'\"“”‘’（）()\[\]{}<>《》\-—_/\\|]+")

# 极性词：用来做"必须 vs 不要"的冲突启发式
_POSITIVE = ("必须", "务必", "一定要", "总是", "坚持", "always", "should", "must")
_NEGATIVE = ("不要", "切忌", "避免", "绝不能", "别", "never", "avoid", "don't", "do not")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def day_of(iso: str) -> str:
    return (iso or "")[:10]


def norm_text(text: str) -> str:
    """去空白、去标点、转小写后的文本，用于判重。"""
    return _PUNCT.sub("", (text or "").strip().lower())


def scan_privacy(text: str) -> list[tuple[str, str]]:
    issues: list[tuple[str, str]] = []
    for rule, pattern in PRIVACY_RULES:
        match = pattern.search(text or "")
        if match:
            issues.append((rule, match.group(0)[:80]))
    return issues


def bigrams(text: str) -> set[str]:
    clean = norm_text(text)
    return {clean[i : i + 2] for i in range(0, max(0, len(clean) - 1))}


def polarity(text: str) -> int:
    lowered = (text or "").lower()
    positive = sum(1 for word in _POSITIVE if word in lowered)
    negative = sum(1 for word in _NEGATIVE if word in lowered)
    return positive - negative


def jaccard(left: str, right: str) -> float:
    a, b = bigrams(left), bigrams(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _slugify(text: str) -> str:
    """可读前缀 + 内容哈希；中文/标点/长度都安全。"""
    words = re.findall(r"[A-Za-z0-9]+|[\u4e00-\u9fff]{1,6}", text)
    prefix = "-".join(words[:6]).lower()[:48].strip("-") or "entry"
    digest = hashlib.sha1(norm_text(text).encode("utf-8")).hexdigest()[:6]
    return f"{prefix}-{digest}"


class Store:
    """记忆根目录的读写入口（单进程顺序使用，不需要锁）。"""

    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.notes_dir = self.root / "notes"
        self.wiki_dir = self.root / "wiki"
        self.candidates_dir = self.wiki_dir / "candidates"
        self.index_path = self.root / "index.json"
        self.runs_path = self.root / "runs.jsonl"
        for directory in (self.root, self.notes_dir, self.wiki_dir, self.candidates_dir):
            directory.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 状态
    def load(self) -> dict[str, Any]:
        if not self.index_path.exists():
            return {
                "version": VERSION,
                "entries": [],
                "topics": {},
                "runs": 0,
                "updatedAt": now_iso(),
            }
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        data.setdefault("version", VERSION)
        data.setdefault("entries", [])
        data.setdefault("topics", {})
        data.setdefault("runs", 0)
        data.setdefault("updatedAt", now_iso())
        return data

    def save(self, state: dict[str, Any]) -> None:
        state["updatedAt"] = now_iso()
        self.index_path.write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def clear(self) -> None:
        """清空记忆（用于 CLB 的 stateless 基线：每个 instance 前 reset）。"""
        for directory in (self.notes_dir, self.wiki_dir, self.candidates_dir):
            for path in directory.glob("*.md"):
                path.unlink(missing_ok=True)
        self.index_path.unlink(missing_ok=True)

    # ------------------------------------------------------------------ 笔记
    def add_facts(
        self,
        state: dict[str, Any],
        *,
        instance_id: str,
        instance_index: int,
        opponent: str,
        facts: list[tuple[str, str, str]],
    ) -> int:
        """写入一批 (scope, confidence, text)；返回新增条目数。

        - 同一条文本只保留一份，重复出现时追加证据（这正是"多次出现才升格"的基础）；
        - 命中隐私规则直接丢弃，并记在 state 的 lint 列表里。
        """
        added = 0
        stamp = f"s{instance_index}"
        note_lines: list[str] = []
        for scope, confidence, text in facts:
            text = (text or "").strip()
            if not text:
                continue
            issues = scan_privacy(text)
            if issues:
                state.setdefault("lint", []).append(
                    {"text": text[:120], "rule": issues[0][0], "at": now_iso()}
                )
                continue
            key = norm_text(text)
            existing = next(
                (entry for entry in state["entries"] if entry["key"] == key), None
            )
            evidence_item = {"s": instance_index, "id": instance_id, "opp": opponent}
            if existing is not None:
                if evidence_item not in existing["evidence"]:
                    existing["evidence"].append(evidence_item)
                existing["confidence"] = max(
                    existing.get("confidence", 1), CONF_WEIGHT.get(confidence, 1)
                )
                continue
            entry = {
                "key": key,
                "text": text[:200],
                "scope": "g" if scope == "g" else "p",
                "confidence": CONF_WEIGHT.get(confidence, 1),
                "evidence": [evidence_item],
                "addedAt": now_iso(),
                "conflicts": [],
            }
            state["entries"].append(entry)
            added += 1
            note_lines.append(
                f"- [{confidence}|{entry['scope']}] {entry['text']} ({stamp},{opponent or '-'})"
            )
        if note_lines:
            note_path = self.notes_dir / f"{instance_index:04d}-{_slugify(instance_id)}.md"
            header = f"# {instance_id}\n\n"
            note_path.write_text(
                header + "\n".join(note_lines) + "\n", encoding="utf-8"
            )
        return added

    def notes_bytes(self) -> int:
        total = 0
        for path in self.notes_dir.glob("*.md"):
            try:
                total += path.stat().st_size
            except OSError:
                continue
        return total

    # ------------------------------------------------------------------ 巩固
    def rebuild_wiki(
        self,
        state: dict[str, Any],
        *,
        min_sessions: int = 3,
        min_workspaces: int = 2,
        max_ratio: float = 0.7,
        candidate_limit: int = 40,
    ) -> dict[str, Any]:
        """把笔记聚合成升格页/候选页；只升格 [g]。"""
        promoted: list[dict[str, Any]] = []
        candidates: list[dict[str, Any]] = []
        for entry in state["entries"]:
            if entry["scope"] != "g":
                continue
            sessions = len({item["id"] for item in entry["evidence"]})
            workspaces = len(
                {item["opp"] for item in entry["evidence"] if item.get("opp")}
            )
            entry["_sessions"] = sessions
            entry["_workspaces"] = workspaces
            if sessions >= min_sessions or workspaces >= min_workspaces:
                promoted.append(entry)
            else:
                candidates.append(entry)

        # 冲突启发式：字面相近 + 极性相反 → 双方标记，真正裁决留给下一轮
        for index, left in enumerate(promoted):
            for right in promoted[index + 1 :]:
                if (
                    jaccard(left["text"], right["text"]) >= 0.5
                    and polarity(left["text"]) * polarity(right["text"]) < 0
                ):
                    left["conflicts"].append(right["text"][:120])
                    right["conflicts"].append(left["text"][:120])

        promoted_bytes = sum(
            len(render_page(entry, entry["_sessions"], entry["_workspaces"]))
            for entry in promoted
        )
        notes_bytes = self.notes_bytes()
        ratio = promoted_bytes / notes_bytes if notes_bytes else 0.0
        # 体积闸门只量升格页；候选是临时缓存，不参与
        blocked = ratio > max_ratio
        pages = [] if blocked else promoted

        # 全量重建（升格页 + 目录页 + 候选页），先清掉孤儿文件
        for path in self.wiki_dir.glob("*.md"):
            if path.name != "index.md":
                path.unlink(missing_ok=True)
        for path in self.candidates_dir.glob("*.md"):
            path.unlink(missing_ok=True)

        topics: dict[str, Any] = {}
        for entry in pages:
            slug = _slugify(entry["text"])
            (self.wiki_dir / f"{slug}.md").write_text(
                render_page(entry, entry["_sessions"], entry["_workspaces"]),
                encoding="utf-8",
            )
            topics[slug] = {
                "status": "promoted",
                "text": entry["text"],
                "page": f"wiki/{slug}.md",
                "evidence": len(entry["evidence"]),
                "updatedAt": now_iso(),
            }
        kept_candidates = sorted(
            candidates, key=lambda entry: len(entry["evidence"]), reverse=True
        )[:candidate_limit]
        for entry in kept_candidates:
            slug = _slugify(entry["text"])
            (self.candidates_dir / f"{slug}.md").write_text(
                render_page(entry, entry["_sessions"], entry["_workspaces"]),
                encoding="utf-8",
            )
            topics[slug] = {
                "status": "candidate",
                "text": entry["text"],
                "page": f"wiki/candidates/{slug}.md",
                "evidence": len(entry["evidence"]),
                "updatedAt": now_iso(),
            }

        self._write_index(topics)
        state["topics"] = topics
        state["runs"] = int(state.get("runs", 0)) + 1

        return {
            "promoted": len(pages),
            "candidates": len(kept_candidates),
            "ratio": round(ratio, 3),
            "blocked": blocked,
        }

    def _write_index(self, topics: dict[str, Any]) -> None:
        promoted = [item for item in topics.values() if item["status"] == "promoted"]
        lines = ["# DSH memory wiki", "", f"updated: {day_of(now_iso())}", ""]
        if not promoted:
            lines.append("(no consolidated global lessons yet)")
        for item in sorted(promoted, key=lambda item: item["evidence"], reverse=True):
            lines.append(f"- {item['text'][:100]} · evidence {item['evidence']}")
        (self.wiki_dir / "index.md").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )

    # ------------------------------------------------------------------ 维护
    def list_for_judge(
        self, state: dict[str, Any], *, limit: int = 20
    ) -> list[dict[str, Any]]:
        """给判断器看的"已有笔记"清单（按置信度、时间排序，返回引用本身）。"""
        return sorted(
            state.get("entries", []),
            key=lambda entry: (
                CONF_WEIGHT.get(entry.get("confidence", 1), 1),
                entry.get("addedAt", ""),
            ),
            reverse=True,
        )[:limit]

    def apply_maintenance(
        self,
        state: dict[str, Any],
        *,
        listing: list[dict[str, Any]],
        retract_indices: list[int],
        corrections: list[tuple[int, str]],
    ) -> dict[str, int]:
        """执行判断器的撤回/改写指令；编号对应 list_for_judge 的顺序（1-based）。"""
        drop_ids = {
            id(listing[index - 1])
            for index in retract_indices
            if 1 <= index <= len(listing)
        }
        removed = 0
        if drop_ids:
            before = len(state["entries"])
            state["entries"] = [
                entry for entry in state["entries"] if id(entry) not in drop_ids
            ]
            removed = before - len(state["entries"])
        corrected = 0
        for index, text in corrections:
            if not (1 <= index <= len(listing)):
                continue
            text = (text or "").strip()
            if not text:
                continue
            entry = listing[index - 1]
            entry["text"] = text
            entry["key"] = norm_text(text)
            entry["updatedAt"] = now_iso()
            corrected += 1
        return {"retracted": removed, "corrected": corrected}

    def merge_similar(self, state: dict[str, Any], *, threshold: float = 0.7) -> int:
        """近义条目合并：保留置信度高/证据多的一条，其余并入证据。"""
        entries = state.get("entries", [])
        kept: list[dict[str, Any]] = []
        merged = 0
        for entry in sorted(
            entries,
            key=lambda item: (
                CONF_WEIGHT.get(item.get("confidence", 1), 1),
                len(item.get("evidence") or []),
                len(item.get("text") or ""),
            ),
            reverse=True,
        ):
            for target in kept:
                if jaccard(target.get("text", ""), entry.get("text", "")) >= threshold:
                    for evidence in entry.get("evidence") or []:
                        if evidence not in target["evidence"]:
                            target["evidence"].append(evidence)
                    target["confidence"] = max(
                        target.get("confidence", 1), entry.get("confidence", 1)
                    )
                    merged += 1
                    break
            else:
                kept.append(entry)
        if merged:
            state["entries"] = kept
        return merged

    # ------------------------------------------------------------------ 注入
    def injection_block(
        self,
        state: dict[str, Any],
        *,
        max_chars: int = 3500,
        max_lines: int = 40,
        max_inferred_lines: int = 12,
    ) -> str:
        """始终可见的记忆块：全局页 + 已验证事实（固定占位）+ 限量推测。"""
        promoted = [
            item["text"]
            for item in state.get("topics", {}).values()
            if item.get("status") == "promoted"
        ]
        lines: list[str] = []
        if promoted:
            lines.append("=== Global lessons (consolidated) ===")
            lines.extend(f"- {text[:160]}" for text in promoted)
        entries = state.get("entries", [])
        verified = sorted(
            (
                entry
                for entry in entries
                if CONF_WEIGHT.get(entry.get("confidence", 1), 1) >= 3
            ),
            key=lambda entry: entry.get("addedAt", ""),
            reverse=True,
        )[: max(1, max_lines // 2)]
        inferred = sorted(
            (
                entry
                for entry in entries
                if CONF_WEIGHT.get(entry.get("confidence", 1), 1) < 3
            ),
            key=lambda entry: entry.get("addedAt", ""),
            reverse=True,
        )[:max_inferred_lines]
        selected = (verified + inferred)[:max_lines]
        if selected:
            if lines:
                lines.append("")
            lines.append("=== Session notes (evidence-backed) ===")
            for entry in selected:
                label = CONF_LABEL.get(entry.get("confidence", 1), "U")
                stamp = entry["evidence"][-1]["s"] if entry.get("evidence") else "?"
                opponent = entry["evidence"][-1].get("opp") or "-"
                lines.append(
                    f"- [{label}|{entry['scope']}] {entry['text'][:160]} (s{stamp},{opponent})"
                )
        if not lines:
            return ""
        block = "=== Agent memory · context ===\n" + "\n".join(lines) + "\n=== end memory ==="
        return block[:max_chars]

    # ------------------------------------------------------------------ 审计
    def record_run(self, record: dict[str, Any]) -> None:
        record = {"at": now_iso(), **record}
        with self.runs_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def render_page(entry: dict[str, Any], sessions: int, workspaces: int) -> str:
    """渲染 wiki 页（frontmatter + 证据；不写任何路径）。"""
    text = entry["text"]
    lines = [
        "---",
        f"title: {json.dumps(text[:80], ensure_ascii=False)}",
        "scope: global",
        f"status: {'promoted' if workspaces >= 2 or sessions >= 3 else 'candidate'}",
        f"updated: {day_of(now_iso())}",
        f"evidence: {json.dumps(entry['evidence'][:20], ensure_ascii=False)}",
        f"conflict: {json.dumps(entry.get('conflicts') or [], ensure_ascii=False)}",
        "---",
        "",
        text,
        "",
        "## 证据（不含路径）",
        "",
    ]
    for item in entry["evidence"][:20]:
        lines.append(
            f"- instance {item.get('id', '?')} · {item.get('opp') or 'unknown'} · (s{item.get('s', '?')})"
        )
    conflicts = entry.get("conflicts") or []
    if conflicts:
        lines.extend(["", "## ⚠ 冲突", ""])
        lines.extend(f"- {item}" for item in conflicts[:5])
    return "\n".join(lines) + "\n"
