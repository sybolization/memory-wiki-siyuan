"""Evaluate the 2026-11-19 spatial-memory A/B run.

Reads only run artifacts (no emulator, no model calls).
"""
from __future__ import annotations

import collections
import json
import pathlib
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNS = [("gbc_map_01", "structured map"), ("gbc_full_02", "no map tool")]


def load_json(path: pathlib.Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def actions(run: str):
    p = ROOT / "runs" / run / "actions.jsonl"
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def trace_stats(run: str):
    calls = collections.Counter()
    tool_ms = collections.defaultdict(list)
    model_ms = []
    compactions = 0
    p = ROOT / "runs" / run / "trace.jsonl"
    if not p.exists():
        return calls, tool_ms, model_ms, compactions
    for line in p.open(encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        t = r.get("type")
        if t == "tool_execution_end":
            tool_ms[r.get("toolName")].append(r.get("durationMs") or 0)
        elif t == "turn_end":
            m = r.get("message") or {}
            if m.get("role") == "assistant":
                model_ms.append(m.get("durationMs") or 0)
        elif t == "compaction_end":
            compactions += 1
        m = r.get("message") or {}
        if m.get("role") == "assistant":
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    calls[c.get("name")] += 1
    return calls, tool_ms, model_ms, compactions


def summarize(run: str):
    acts = actions(run)
    summary = load_json(ROOT / "runs" / run / "summary.json", {})
    mem = ROOT / "runs" / run / "memory"
    mem_file = mem / "MEMORY.md"
    maps_dir = mem / "maps"
    map_files = sorted(maps_dir.glob("*.md")) if maps_dir.exists() else []

    first = {}
    steps = 0
    unchanged = 0
    blocked_actions = 0
    per_map = collections.Counter()
    for i, rec in enumerate(acts):
        st = rec.get("steps") or []
        for s in st:
            m = s.get("map")
            if m and m not in first:
                first[m] = i
            per_map[m] += 1
            steps += 1
            ch = s.get("changed")
            if isinstance(ch, (int, float)) and ch < 0.005:
                unchanged += 1
        if st and all((s.get("outcome") in ("blocked", "limit", "bad_token", "bad_button")) for s in st):
            blocked_actions += 1

    calls, tool_ms, model_ms, compactions = trace_stats(run)
    tool_total = sum(sum(v) for v in tool_ms.values())
    model_total = sum(model_ms)
    return {
        "run": run,
        "summary": summary,
        "actions": len(acts),
        "steps": steps,
        "unchanged_pct": round(100.0 * unchanged / max(1, steps), 1),
        "blocked_actions": blocked_actions,
        "first": first,
        "per_map": dict(per_map),
        "calls": dict(calls),
        "model_ms": model_total,
        "tool_ms": tool_total,
        "tool_by_name": {k: sum(v) for k, v in tool_ms.items()},
        "compactions": compactions,
        "mem_chars": len(mem_file.read_text(encoding="utf-8").replace("\r\n", "\n")) if mem_file.exists() else 0,
        "map_files": [(p.name, len(p.read_text(encoding="utf-8"))) for p in map_files],
        "map_update_calls": calls.get("map_update", 0),
        "model_median_s": round(statistics.median(model_ms) / 1000, 2) if model_ms else 0,
        "model_mean_s": round(statistics.mean(model_ms) / 1000, 2) if model_ms else 0,
        "model_p90_s": round(sorted(model_ms)[int(0.9 * len(model_ms))] / 1000, 2) if model_ms else 0,
        "tool_mean_s": round(statistics.mean([x for v in tool_ms.values() for x in v]) / 1000, 2) if tool_ms else 0,
    }


def main() -> int:
    rows = [summarize(run) for run, _ in RUNS]
    print("# Spatial-memory A/B (gbc_map_01 vs gbc_full_02)\n")
    print("| metric | " + " | ".join(f"{r['run']}" for r in rows) + " |")
    print("|---|" + "---|" * len(rows))
    def row(name, fn):
        print(f"| {name} | " + " | ".join(str(fn(r)) for r in rows) + " |")
    row("final map", lambda r: r["summary"].get("final_map", "?"))
    row("final pos", lambda r: f"{r['summary'].get('final_x','?')},{r['summary'].get('final_y','?')}")
    row("badges", lambda r: r["summary"].get("badges", ""))
    row("party", lambda r: r["summary"].get("party", "?"))
    row("actions", lambda r: r["actions"])
    row("game steps", lambda r: r["steps"])
    row("unique maps", lambda r: len(r["per_map"]))
    row("forest first action", lambda r: r["first"].get("VIRIDIAN_FOREST", "-"))
    row("forest north gate", lambda r: r["first"].get("VIRIDIAN_FOREST_NORTH_GATE", "-"))
    row("Pewter first action", lambda r: r["first"].get("PEWTER_CITY", "-"))
    row("blocked-only actions", lambda r: r["blocked_actions"])
    row("unchanged steps", lambda r: str(r["unchanged_pct"]) + "%")
    row("map_update calls", lambda r: r["map_update_calls"])
    row("map files", lambda r: ", ".join(f"{n}({c})" for n, c in r["map_files"]) or "-")
    row("memory chars", lambda r: r["mem_chars"])
    row("compactions", lambda r: r["compactions"])
    row("model total (h)", lambda r: round(r["model_ms"] / 3600000, 2))
    row("tool total (s)", lambda r: round(r["tool_ms"] / 1000, 1))
    row("model mean (s)", lambda r: r["model_mean_s"])
    row("model median (s)", lambda r: r["model_median_s"])
    row("model p90 (s)", lambda r: r["model_p90_s"])
    row("tool mean (s)", lambda r: r["tool_mean_s"])
    print("\n## Map files\n")
    for r in rows:
        print(f"### {r['run']}")
        if not r["map_files"]:
            print("- (none)")
            continue
        for name, chars in r["map_files"]:
            p = ROOT / "runs" / r["run"] / "memory" / "maps" / name
            print(f"\n#### maps/{name} ({chars} chars)\n")
            print(p.read_text(encoding="utf-8", errors="replace")[:1800])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
