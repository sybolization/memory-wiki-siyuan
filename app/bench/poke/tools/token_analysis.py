"""bench/poke/tools/token_analysis.py - per-step token accounting for poke runs.

Usage:
    python tools/token_analysis.py runs/gbc_map_01 runs/gbc_map_10 runs/gbc_map_14

Definitions (all read from the raw pi trace, NOT from summary.json):
  turn          one assistant message_end event (message.usage is authoritative)
  action        one game action record in actions.jsonl (== one poke_act/poke_program call)
  step          one button step inside a poke_program record (actions.jsonl -> steps[])

Important: message_update events also carry `usage`, but those are streaming
snapshots that repeat the cumulative value on every chunk. Summing them
inflates the total by ~7x (that is what summary.json's cache_read_total does).
Only message_end / turn_end usage is counted here.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

FIELDS = ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")
GAME_TOOLS = {"poke_act", "poke_program"}

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / "runs"


def load_trace(trace: Path):
    """Return [(usage_dict, [tool names]), ...] for assistant message_end events."""
    result = []
    with trace.open(encoding="utf-8-sig", errors="ignore") as fh:
        for line in fh:
            # fast prefilter: most lines are streaming message_update chunks
            if '"message_end"' not in line:
                continue
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") != "message_end":
                continue
            msg = ev.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            u = msg.get("usage") or {}
            tools = [
                c.get("name")
                for c in (msg.get("content") or [])
                if isinstance(c, dict) and c.get("type") == "toolCall"
            ]
            result.append((u, tools))
    return result


def load_actions(path: Path):
    n_actions = 0
    n_steps = 0
    kinds: dict[str, int] = {}
    if not path.exists():
        return 0, 0, kinds
    with path.open(encoding="utf-8-sig", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                a = json.loads(line)
            except ValueError:
                continue
            n_actions += 1
            k = a.get("kind", "?")
            kinds[k] = kinds.get(k, 0) + 1
            n_steps += len(a.get("steps") or [])
    return n_actions, n_steps, kinds


def analyze(run: Path):
    turns = load_trace(run / "trace.jsonl")
    n_actions, n_steps, kinds = load_actions(run / "actions.jsonl")

    totals = {f: 0 for f in FIELDS}
    per_turn = []
    game_tokens = 0
    game_turns = 0
    game_calls = 0
    tool_calls: dict[str, int] = {}

    for u, tools in turns:
        tt = u.get("totalTokens") or 0
        for f in FIELDS:
            totals[f] += u.get(f) or 0
        per_turn.append(tt)
        for t in tools:
            tool_calls[t] = tool_calls.get(t, 0) + 1
        has_game = any(t in GAME_TOOLS for t in tools)
        if has_game:
            game_turns += 1
            game_tokens += tt
            game_calls += sum(1 for t in tools if t in GAME_TOOLS)

    total = totals["totalTokens"]
    cache_share = totals["cacheRead"] / total if total else 0

    return {
        "name": run.name,
        "turns": len(turns),
        "actions": n_actions,
        "steps": n_steps,
        "kinds": kinds,
        "game_turns": game_turns,
        "game_calls": game_calls,
        "totals": totals,
        "total": total,
        "per_turn": per_turn,
        "tok_per_turn": total / len(turns) if turns else 0,
        "median_turn": statistics.median(per_turn) if per_turn else 0,
        "p90_turn": sorted(per_turn)[int(len(per_turn) * 0.9)] if per_turn else 0,
        "max_turn": max(per_turn) if per_turn else 0,
        "tok_per_action_all": total / n_actions if n_actions else 0,
        "tok_per_action_game": game_tokens / game_calls if game_calls else 0,
        "tok_per_step_all": total / n_steps if n_steps else 0,
        "tok_per_step_game": game_tokens / n_steps if n_steps else 0,
        # cacheRead is the same ~57k prefix re-sent every turn; it is a fixed
        # per-turn overhead, not a cost caused by the step. Strip it out to get
        # the marginal cost of one action / one button step.
        "marginal_per_action": (totals["input"] + totals["output"]) / game_calls if game_calls else 0,
        "marginal_per_step": (totals["input"] + totals["output"]) / n_steps if n_steps else 0,
        "cache_per_action": totals["cacheRead"] / game_calls if game_calls else 0,
        "actions_per_turn": n_actions / len(turns) if turns else 0,
        "steps_per_action": n_steps / n_actions if n_actions else 0,
        "cache_share": cache_share,
        "tool_calls": tool_calls,
    }


def fmt(n):
    return f"{n:,.0f}"


def main():
    args = sys.argv[1:]
    runs = [Path(a) if Path(a).is_absolute() or a.startswith("runs") else RUNS / a for a in args]
    if not runs:
        runs = [RUNS / "gbc_map_01", RUNS / "gbc_map_10", RUNS / "gbc_map_14"]
    data = [analyze(r) for r in runs]

    print("=" * 118)
    print("TOKEN ACCOUNTING (source: trace.jsonl message_end usage; summary.json is NOT used)")
    print("=" * 118)
    hdr = (
        f"{'run':<14}{'turns':>7}{'actions':>8}{'steps':>8}{'gameCalls':>10}"
        f"{'totalTok':>13}{'tok/turn':>10}{'tok/act(game)':>15}{'tok/act(all)':>14}{'tok/step(game)':>16}{'cache%':>8}"
    )
    print(hdr)
    print("-" * 118)
    for d in data:
        print(
            f"{d['name']:<14}{d['turns']:>7}{d['actions']:>8}{d['steps']:>8}{d['game_calls']:>10}"
            f"{fmt(d['total']):>13}{fmt(d['tok_per_turn']):>10}"
            f"{fmt(d['tok_per_action_game']):>15}{fmt(d['tok_per_action_all']):>14}"
            f"{fmt(d['tok_per_step_game']):>16}{d['cache_share']*100:>7.1f}%"
        )

    print()
    print("MARGINAL COST (totalTokens minus the fixed cacheRead prefix):")
    print(f"{'run':<14}{'input+out':>14}{'marg/action':>13}{'marg/step':>12}{'cache/action':>14}")
    print("-" * 70)
    for d in data:
        io = d["totals"]["input"] + d["totals"]["output"]
        print(
            f"{d['name']:<14}{fmt(io):>14}{fmt(d['marginal_per_action']):>13}"
            f"{fmt(d['marginal_per_step']):>12}{fmt(d['cache_per_action']):>14}"
        )
    print()
    for d in data:
        t = d["totals"]
        print(f"--- {d['name']} ---")
        print(
            f"  input={fmt(t['input'])} output={fmt(t['output'])} "
            f"cacheRead={fmt(t['cacheRead'])} reasoning={fmt(t['reasoning'])} (reasoning is INSIDE output, not additive)"
        )
        print(
            f"  CHECK input+output+cacheRead = {fmt(t['input'] + t['output'] + t['cacheRead'])} "
            f"= totalTokens {fmt(d['total'])}"
        )
        print(
            f"  per-turn totalTokens: mean={fmt(d['tok_per_turn'])} "
            f"median={fmt(d['median_turn'])} p90={fmt(d['p90_turn'])} max={fmt(d['max_turn'])}"
        )
        print(
            f"  actions/turn={d['actions_per_turn']:.3f}  steps/action={d['steps_per_action']:.2f}  "
            f"game_turns={d['game_turns']}"
        )
        print(
            f"  tokens/step (all incl. memory overhead)={fmt(d['tok_per_step_all'])}  "
            f"kinds={d['kinds']}"
        )
        top = sorted(d["tool_calls"].items(), key=lambda x: -x[1])[:12]
        print("  tool calls:", " ".join(f"{k}={v}" for k, v in top))


if __name__ == "__main__":
    main()
