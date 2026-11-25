"""agent_memory/memory_fs.py — Claude 风格的记忆目录。

模型通过工具调用读写这个目录；代码只负责三件事：
1. 路径消毒（只能操作 root 下、只能 .md）；
2. 容量上限（单文件、总字数、文件数）；
3. 记录每次操作的审计日志。

不做任何内容理解——写什么、删什么、怎么组织，全部由模型自己决定。
"""

from __future__ import annotations

from pathlib import Path

MEMORY_TEMPLATE = """# MEMORY

<!-- 顶层索引。保持短小：每条一句话，指向 notes/ 下的详细笔记。 -->

- （还没有记忆）
"""


class MemoryFS:
    """受约束的记忆文件系统。"""

    def __init__(
        self,
        root: Path,
        *,
        max_file_chars: int = 3000,
        max_total_chars: int = 16000,
        max_files: int = 40,
    ):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_file_chars = max_file_chars
        self.max_total_chars = max_total_chars
        self.max_files = max_files
        self.ops: list[dict] = []
        index = self.root / "MEMORY.md"
        if not index.exists():
            index.write_text(MEMORY_TEMPLATE, encoding="utf-8")

    # ---------------------------------------------------------------- 路径
    def _safe(self, rel: str) -> Path:
        rel = (rel or "").strip().replace("\\", "/")
        if not rel or rel.startswith("/") or ".." in rel.split("/"):
            raise ValueError(f"非法路径: {rel!r}")
        if not rel.lower().endswith(".md"):
            raise ValueError("只能操作 .md 文件")
        path = (self.root / rel).resolve()
        root = self.root.resolve()
        if path != root and root not in path.parents:
            raise ValueError(f"路径越界: {rel!r}")
        return path

    def _total_chars(self) -> int:
        total = 0
        for p in self.root.rglob("*.md"):
            try:
                total += len(p.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                continue
        return total

    # ---------------------------------------------------------------- 工具
    def list_files(self) -> list[dict]:
        out: list[dict] = []
        for path in sorted(self.root.rglob("*.md")):
            rel = path.relative_to(self.root).as_posix()
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            first = next(
                (ln.strip().lstrip("#").strip() for ln in text.splitlines() if ln.strip()),
                "",
            )
            out.append({"path": rel, "chars": len(text), "preview": first[:120]})
            if len(out) >= self.max_files + 10:
                break
        return out

    def read(self, rel: str, max_chars: int = 4000) -> str:
        try:
            path = self._safe(rel)
        except ValueError as exc:
            return f"[错误] {exc}"
        if not path.exists():
            return f"[错误] 文件不存在: {rel}；用 memory_list 看现有文件"
        text = path.read_text(encoding="utf-8", errors="ignore")
        if len(text) > max_chars:
            text = text[:max_chars] + "\n...[截断]"
        return text

    def write(self, rel: str, content: str) -> str:
        try:
            path = self._safe(rel)
        except ValueError as exc:
            return f"[错误] {exc}"
        content = (content or "").strip()
        if not content:
            return "[错误] 内容为空；要删除请用 memory_delete"
        if len(content) > self.max_file_chars:
            return (
                f"[错误] 单文件上限 {self.max_file_chars} 字，当前 {len(content)} 字；"
                "请精简后再写"
            )
        exists = path.exists()
        if not exists and len(list(self.root.rglob("*.md"))) >= self.max_files:
            return f"[错误] 文件数已达上限 {self.max_files}；先合并或删除旧笔记"
        old = len(path.read_text(encoding="utf-8", errors="ignore")) if exists else 0
        new_total = self._total_chars() - old + len(content)
        if new_total > self.max_total_chars:
            return (
                f"[错误] 记忆总量上限 {self.max_total_chars} 字，写入后会到 {new_total} 字；"
                "请先删除或压缩旧笔记"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self.ops.append({"op": "write", "path": rel, "chars": len(content)})
        return f"[ok] 已写入 {rel}（{len(content)} 字）"

    def delete(self, rel: str) -> str:
        try:
            path = self._safe(rel)
        except ValueError as exc:
            return f"[错误] {exc}"
        if rel == "MEMORY.md":
            return "[错误] 不能删除顶层索引 MEMORY.md；可以清空或改写它"
        if not path.exists():
            return f"[错误] 文件不存在: {rel}"
        path.unlink()
        self.ops.append({"op": "delete", "path": rel})
        return f"[ok] 已删除 {rel}"

    # ---------------------------------------------------------------- 视图
    def index_text(self, max_chars: int = 1600) -> str:
        memory = self.read("MEMORY.md", max_chars=max_chars)
        lines = [memory.rstrip(), "", "### 记忆文件"]
        files = [f for f in self.list_files() if f["path"] != "MEMORY.md"]
        if not files:
            lines.append("- （空；可以用 memory_write 创建 notes/<主题>.md）")
        else:
            for item in files[: self.max_files]:
                lines.append(f"- {item['path']}（{item['chars']} 字）{item['preview'][:80]}")
        return "\n".join(lines)

    def snapshot(self, per_file_chars: int = 3000) -> dict[str, str]:
        out: dict[str, str] = {}
        for item in self.list_files():
            rel = item["path"]
            try:
                text = self._safe(rel).read_text(encoding="utf-8")
            except (OSError, ValueError):
                continue
            out[rel] = text[:per_file_chars]
        return out

    def stats(self) -> dict:
        files = self.list_files()
        return {
            "files": len(files),
            "total_chars": sum(item["chars"] for item in files),
            "ops": len(self.ops),
        }
