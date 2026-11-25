"""bench/poke/tools/analyze.py - summarize a run trace.

Usage: python tools/analyze.py runs/live_06
Reports token usage, per-tool call counts, the action sequence, memory writes,
and the final assistant text.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRACE = Path(sys.argv[1]) / "trace.jsonl" if len(sys.argv) > 1 else HERE.parent / "runs" / "live_06" / "trace.jsonl"
if TRACE.is_dir():
    TRACE = TRACE / "trace.jsonl"

tokens = {"input": 0, "output": 0, "cacheRead": 0, "reasoning": 0}
calls: dict[str, int] = {}
actions: list[str] = []
memory_writes: list[str] = []
final_text = ""
turns = 0

with TRACE.open(encoding="utf-8-sig", errors="ignore") as fh:
    for line in fh:
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
        if msg.get("role") != "assistant":
            continue
        turns += 1
        u = msg.get("usage") or {}
        for k in tokens:
            tokens[k] += u.get(k) or 0
        for c in msg.get("content") or []:
            t = c.get("type")
            if t == "text" and c.get("text", "").strip():
                final_text = c["text"].strip()
            elif t == "toolCall":
                name = c.get("name")
                calls[name] = calls.get(name, 0) + 1
                a = c.get("arguments") or {}
                if name == "poke_act":
                    actions.append(f"{a.get('button')}/{a.get('frames', 24)}")
                elif name == "memory_write":
                    memory_writes.append(str(a.get("path")))

print(f"trace: {TRACE}")
print(f"assistant turns: {turns}")
print(f"tokens: input={tokens['input']} output={tokens['output']} cacheRead={tokens['cacheRead']} reasoning={tokens['reasoning']}")
print(f"tool calls: {json.dumps(calls, ensure_ascii=False)}")
print(f"actions ({len(actions)}): {' '.join(actions)}")
print(f"memory writes: {memory_writes}")
print("final text:", (final_text[:500] + "...") if len(final_text) > 500 else final_text)
