"""bench/poke/tools/dream_analysis.py - cost and trigger mix of the dream passes.

Usage:
    python tools/dream_analysis.py runs/gbc_map_10 runs/gbc_map_14

Reads runs/<run>/dream-sessions/dNNN/trace.jsonl (one separate pi session per
dream) and reports per-dream token usage, turn count, wall duration and whether
the dream was scheduled by the 50-action gate or started voluntarily.
"""
from __future__ import annotations

import json
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / "runs"
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


def parse_ts(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v / 1000.0 if v > 1e11 else float(v)
    s = str(v)
    if ISO.match(s):
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    try:
        n = float(s)
        return n / 1000.0 if n > 1e11 else n
    except ValueError:
        return None


def dream_stats(d: Path):
    trace = d / "trace.jsonl"
    turns = 0
    tokens = 0
    breakdown = {"input": 0, "output": 0, "cacheRead": 0, "reasoning": 0}
    first = last = None
    trigger = ""
    if trace.exists():
        with trace.open(encoding="utf-8-sig", errors="ignore") as fh:
            for line in fh:
                if '"message_end"' not in line and '"message"' not in line:
                    continue
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                msg = ev.get("message") or {}
                t = parse_ts(ev.get("timestamp")) or parse_ts(msg.get("timestamp"))
                if t:
                    first = t if first is None else min(first, t)
                    last = t if last is None else max(last, t)
                if ev.get("type") != "message_end":
                    continue
                if msg.get("role") == "user" and not trigger:
                    for c in msg.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "text":
                            m = re.search(r"TRIGGER:([^\n]*)", c.get("text") or "")
                            if m:
                                trigger = m.group(1).strip()[:160]
                if msg.get("role") != "assistant":
                    continue
                u = msg.get("usage") or {}
                turns += 1
                tokens += u.get("totalTokens") or 0
                for k in breakdown:
                    breakdown[k] += u.get(k) or 0
    duration = (last - first) if (first and last) else 0
    return {
        "id": d.name,
        "turns": turns,
        "tokens": tokens,
        "duration": duration,
        "trigger": trigger,
        "scheduled": trigger.lower().startswith("scheduled"),
        **breakdown,
    }


def main():
    args = sys.argv[1:] or ["runs/gbc_map_10", "runs/gbc_map_14"]
    for a in args:
        run = Path(a) if a.startswith("runs") or Path(a).is_absolute() else RUNS / a
        ds = sorted((run / "dream-sessions").glob("d*")) if (run / "dream-sessions").exists() else []
        rows = [dream_stats(d) for d in ds]
        rows = [r for r in rows if r["turns"]]
        print("=" * 100)
        print(f"{run.name}: {len(rows)} dreams with a trace")
        if not rows:
            continue
        tot = sum(r["tokens"] for r in rows)
        sched = sum(1 for r in rows if r["scheduled"])
        print(f"  dream tokens total={tot:,}  mean={tot/len(rows):,.0f}  "
              f"median={statistics.median(r['tokens'] for r in rows):,.0f}  "
              f"max={max(r['tokens'] for r in rows):,}")
        print(f"  dream turns  mean={statistics.mean(r['turns'] for r in rows):.1f}  "
              f"max={max(r['turns'] for r in rows)}")
        print(f"  wall time    mean={statistics.mean(r['duration'] for r in rows):.1f}s  "
              f"total={sum(r['duration'] for r in rows)/60:.1f}min")
        print(f"  trigger      scheduled={sched}  voluntary/other={len(rows)-sched}")
        print(f"  {'id':<6}{'turns':>6}{'tokens':>12}{'sec':>8}  trigger")
        for r in rows:
            print(f"  {r['id']:<6}{r['turns']:>6}{r['tokens']:>12,}{r['duration']:>8.0f}  "
                  f"{r['trigger'][:70]}")


if __name__ == "__main__":
    main()
