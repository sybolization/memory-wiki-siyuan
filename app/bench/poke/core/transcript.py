"""把 pi 的 trace.jsonl 压成 /live 页面用的对话轮次。"""
from __future__ import annotations

import json

from core.paths import RUNS


def read_transcript(run: str | None, limit: int = 150) -> dict:
    """Parse a run trace into compact transcript items for the live page."""
    base = RUNS.resolve()
    if run:
        d = (base / run).resolve()
        if base not in d.parents:
            return {"items": [], "total": 0, "error": "bad run name"}
    else:
        cands = [p for p in base.glob("*") if (p / "trace.jsonl").exists()]
        if not cands:
            return {"items": [], "total": 0}
        d = max(cands, key=lambda p: (p / "trace.jsonl").stat().st_mtime)
    path = d / "trace.jsonl"
    if not path.exists():
        return {"items": [], "total": 0, "run": d.name}
    items = []
    turn = 0
    for line in path.read_text(encoding="utf-8-sig", errors="ignore").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") != "message_end":
            continue
        msg = ev.get("message") or {}
        role = msg.get("role")
        if role == "assistant":
            turn += 1
            for c in msg.get("content") or []:
                if c.get("type") == "thinking" and c.get("thinking"):
                    items.append({"turn": turn, "kind": "thinking", "text": c["thinking"]})
                elif c.get("type") == "text" and c.get("text"):
                    items.append({"turn": turn, "kind": "text", "text": c["text"]})
                elif c.get("type") == "toolCall":
                    items.append({"turn": turn, "kind": "tool", "name": c.get("name"), "text": json.dumps(c.get("arguments"), ensure_ascii=False)})
        elif role == "toolResult":
            content = msg.get("content") or []
            text = ""
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    text += c.get("text", "")
                elif isinstance(c, dict) and c.get("type") == "image":
                    text += "[screenshot]"
            items.append({"turn": turn, "kind": "result", "name": msg.get("toolName"), "text": text[:400]})
    turns = []
    for it in items[-limit:]:
        if not turns or turns[-1]["turn"] != it["turn"]:
            turns.append({"turn": it["turn"], "items": []})
        turns[-1]["items"].append(it)
    return {"run": d.name, "total": len(items), "turns": turns}
