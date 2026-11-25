"""Print the last poke_done summary from the trace."""
from __future__ import annotations

import json
import os
import pathlib
import sys

run = os.environ.get("POKE_RUN_NAME", "")
default = f"runs/{run}/trace.jsonl" if run else ""
arg = sys.argv[1] if len(sys.argv) > 1 else default
if not arg:
    raise SystemExit("usage: last_done.py <trace.jsonl> (or set POKE_RUN_NAME)")
p = pathlib.Path(arg)
summary = None
for line in p.read_text("utf-8", errors="replace").splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    msg = rec.get("message") or {}
    if msg.get("role") != "assistant":
        continue
    for part in msg.get("content") or []:
        if isinstance(part, dict) and part.get("type") == "toolCall" and part.get("name") == "poke_done":
            summary = (part.get("arguments") or {}).get("summary")

print((summary or "(none)")[:2500])
