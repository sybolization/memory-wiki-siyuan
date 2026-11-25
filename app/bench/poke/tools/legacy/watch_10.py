"""Watch the map arm and exit after it gains N actions, printing a snapshot.

Read-only: talks to /observe and reads run artifacts. Used by the operator to
get a status report every N actions without polling the emulator too often.
"""
from __future__ import annotations

import json
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAP_RUN = "gbc_map_01"
FULL_RUN = "gbc_full_02"
STEP = int(sys.argv[1]) if len(sys.argv) > 1 else 10
TIMEOUT_MIN = int(sys.argv[2]) if len(sys.argv) > 2 else 45
PORTS = {MAP_RUN: 8765, FULL_RUN: 8766}


def count_actions(run: str) -> int:
    p = ROOT / "runs" / run / "actions.jsonl"
    if not p.exists():
        return 0
    return sum(1 for _ in p.open("r", encoding="utf-8", errors="replace"))


def load_actions(run: str) -> list[dict]:
    p = ROOT / "runs" / run / "actions.jsonl"
    if not p.exists():
        return []
    out = []
    for line in p.open("r", encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def observe(port: int, timeout: float = 5.0) -> dict:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/observe", timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as exc:
        return {"error": str(exc)}


def fmt_obs(o: dict) -> str:
    if "error" in o:
        return "DOWN (" + o["error"] + ")"
    party = ", ".join(
        f"#{p.get('species')}L{p.get('level')} {p.get('hp')}hp" for p in (o.get("party") or [])
    )
    return (
        f"{o.get('map')} ({o.get('x')},{o.get('y')}) "
        f"battle={o.get('battle')} money={o.get('money')} "
        f"badges={o.get('badges')} party=[{party}]"
    )


def steps_line(action: dict) -> str:
    steps = action.get("steps") or []
    if not steps:
        return "(no steps)"
    parts = []
    for s in steps[:6]:
        parts.append(f"{s.get('button')}:{s.get('outcome')}@{s.get('map')}({','.join(map(str, s.get('pos') or []))})")
    if len(steps) > 6:
        parts.append(f"... +{len(steps) - 6} steps")
    return " | ".join(parts)


def memory_state(run: str) -> dict:
    mem = ROOT / "runs" / run / "memory" / "MEMORY.md"
    maps = ROOT / "runs" / run / "memory" / "maps"
    info = {
        "memory_mtime": mem.stat().st_mtime if mem.exists() else 0,
        "memory_size": mem.stat().st_size if mem.exists() else 0,
        "maps": {},
    }
    if maps.exists():
        for p in maps.glob("*.md"):
            info["maps"][p.name] = (p.stat().st_mtime, p.stat().st_size)
    return info


def main() -> None:
    start_n = count_actions(MAP_RUN)
    start_mem = memory_state(MAP_RUN)
    started = time.time()
    deadline = started + TIMEOUT_MIN * 60
    n = start_n

    while time.time() < deadline:
        time.sleep(15)
        n = count_actions(MAP_RUN)
        if n >= start_n + STEP:
            break

    elapsed = time.time() - started
    actions = load_actions(MAP_RUN)
    window = actions[start_n:n]
    end_mem = memory_state(MAP_RUN)

    changed_maps = []
    for name, (mt, sz) in end_mem["maps"].items():
        old = start_mem["maps"].get(name)
        if old is None or old[0] != mt or old[1] != sz:
            changed_maps.append(name)
    mem_changed = (
        end_mem["memory_mtime"] != start_mem["memory_mtime"]
        or end_mem["memory_size"] != start_mem["memory_size"]
    )

    print("=== WATCH REPORT ===")
    print(f"window: actions {start_n} -> {n} (+{n - start_n}), elapsed {elapsed / 60:.1f} min, {time.strftime('%H:%M:%S')}")
    print("MAP  :", fmt_obs(observe(PORTS[MAP_RUN])))
    print("FULL :", fmt_obs(observe(PORTS[FULL_RUN])))
    print("counts:", f"map={n}", f"full={count_actions(FULL_RUN)}")

    if window:
        maps_seen = []
        for a in window:
            for s in a.get("steps") or []:
                m = s.get("map")
                if m and (not maps_seen or maps_seen[-1] != m):
                    maps_seen.append(m)
        print("maps in window:", " -> ".join(maps_seen))
        print("last actions:")
        for i, a in enumerate(window[-10:], start=start_n + max(0, len(window) - 10)):
            print(f"  {i} {a.get('kind')}: {steps_line(a)}")
    else:
        print("last actions: (none in window)")

    print("memory:", "changed" if mem_changed else "unchanged", f"({end_mem['memory_size']} chars)")
    print("map files changed:", ", ".join(changed_maps) if changed_maps else "none")

    rl = ROOT / "runs" / MAP_RUN / "resume_log.txt"
    if rl.exists():
        exits = rl.read_text("utf8", errors="ignore").count("resume exit=")
        print("map resume exits:", exits)

    if n < start_n + STEP:
        print(f"NOTE: no +{STEP} actions within {TIMEOUT_MIN} min")


if __name__ == "__main__":
    main()
