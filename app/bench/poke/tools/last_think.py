"""Print the agent's most recent non-empty thinking block from the trace."""
from __future__ import annotations

import argparse
import json
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.environ.get("POKE_RUN_NAME", ""))
    ap.add_argument("--mb", type=int, default=24)
    ap.add_argument("--limit", type=int, default=1200)
    args = ap.parse_args()
    if not args.run:
        ap.error("--run or POKE_RUN_NAME is required")

    p = ROOT / "runs" / args.run / "trace.jsonl"
    size = p.stat().st_size
    with p.open("rb") as f:
        f.seek(max(0, size - args.mb * 1_000_000))
        data = f.read().decode("utf-8", "replace")

    found = ""
    for line in reversed(data.split("\n")):
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
        for part in reversed(msg.get("content") or []):
            if (isinstance(part, dict) and part.get("type") == "thinking"
                    and str(part.get("thinking") or "").strip()):
                found = " ".join(str(part["thinking"]).split())
                break
        if found:
            break

    print(found[-args.limit:] if found else "(no thinking found)")


if __name__ == "__main__":
    main()
