"""Status watcher for the map arm.

Runs alongside the agent, waits until the run gains N game actions, then prints
one compact report (and appends it to runs/<run>/watch20.log). Exits after the
requested number of reports, so the harness can notify the operator without
polling the emulator.

Read-only: reads actions.jsonl / dream state / memory files and calls /observe.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
import traceback
import urllib.request
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent


def count_actions(run: str) -> int:
    p = ROOT / "runs" / run / "actions.jsonl"
    if not p.exists():
        return 0
    with p.open("r", encoding="utf-8", errors="replace") as f:
        return sum(1 for line in f if line.strip())


def load_actions(run: str) -> list[dict]:
    p = ROOT / "runs" / run / "actions.jsonl"
    if not p.exists():
        return []
    out: list[dict] = []
    with p.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
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


def read_dream(run: str) -> dict:
    p = ROOT / "runs" / run / "memory" / ".dream_state.json"
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return {}


def snapshot_memory(run: str) -> dict:
    base = ROOT / "runs" / run / "memory"
    mem = base / "MEMORY.md"
    out = {
        "memory_mtime": mem.stat().st_mtime if mem.exists() else 0,
        "memory_size": mem.stat().st_size if mem.exists() else 0,
        "maps": {},
    }
    maps = base / "maps"
    if maps.exists():
        for p in maps.glob("*.md"):
            out["maps"][p.name] = (p.stat().st_mtime, p.stat().st_size)
    return out


def step_text(step: dict) -> str:
    pos = ",".join(map(str, step.get("pos") or []))
    tiles = f" +{step['tiles']}b" if step.get("tiles") else ""
    return f"{step.get('button')}:{step.get('outcome')}{tiles}@{step.get('map')}({pos})"


def action_text(a: dict, limit: int = 4) -> str:
    steps = a.get("steps") or []
    if not steps:
        return "(no steps)"
    body = " | ".join(step_text(s) for s in steps[:limit])
    if len(steps) > limit:
        body += f" | ... +{len(steps) - limit}"
    return body


def fmt_party(party: list) -> str:
    if not party:
        return "(none)"
    parts = []
    for p in party:
        hp = p.get("hp")
        mx = p.get("max_hp") or p.get("maxhp") or p.get("hp_max")
        hp_txt = f"{hp}/{mx}" if mx else f"{hp}"
        parts.append(f"#{p.get('species')} L{p.get('level')} {hp_txt}hp")
    return " | ".join(parts)


def fmt_obs(o: dict) -> str:
    if "error" in o:
        return f"DOWN ({o['error']})"
    badges = o.get("badges")
    badges_txt = json.dumps(badges) if badges is not None else "?"
    return (
        f"{o.get('map')} ({o.get('x')},{o.get('y')}) "
        f"battle={o.get('battle')} money={o.get('money')} badges={badges_txt}"
    )


def screen_tail(o: dict, n: int = 3) -> str:
    text = (o.get("screen") or o.get("text") or "").replace("\r", "\n")
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    return " / ".join(lines[-n:]) if lines else ""


def level_map(party: list) -> dict:
    return {p.get("species"): p.get("level") for p in party or [] if p.get("species") is not None}


def baseline_file(run: str) -> pathlib.Path:
    return ROOT / "runs" / run / ".watch20_baseline"


def read_baseline(run: str) -> int | None:
    p = baseline_file(run)
    try:
        return int(p.read_text("utf-8").strip())
    except Exception:
        return None


def write_baseline(run: str, n: int) -> None:
    p = baseline_file(run)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(n), encoding="utf-8")


def last_dream(run: str, limit: int = 240) -> str:
    p = ROOT / "runs" / run / "DREAM.md"
    if not p.exists():
        return ""
    try:
        text = p.read_text("utf-8", errors="replace")
    except Exception:
        return ""
    idx = text.rfind("## Dream ")
    if idx < 0:
        return ""
    chunk = [ln.strip() for ln in text[idx:].split("\n") if ln.strip()]
    head = chunk[0] if chunk else ""
    body = " ".join(chunk[1:])[:limit]
    return f"{head} :: {body}"


def all_fainted(obs: dict) -> bool:
    party = obs.get("party") or []
    return bool(party) and all((p.get("hp") or 0) <= 0 for p in party)


def critical(obs: dict) -> str:
    if "error" in obs:
        return ""
    if all_fainted(obs):
        return "ALL POKEMON FAINTED"
    if obs.get("battle") == 255:
        return "BATTLE STATE 255 (blackout/whiteout?)"
    return ""


def last_thinking(run: str, limit: int = 520) -> str:
    """Return the agent's most recent thinking block (tail-read the trace)."""
    p = ROOT / "runs" / run / "trace.jsonl"
    if not p.exists():
        return ""
    try:
        size = p.stat().st_size
        chunk = 12_000_000
        with p.open("rb") as f:
            f.seek(max(0, size - chunk))
            data = f.read().decode("utf-8", "replace")
        for line in reversed(data.split("\n")):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            m = r.get("message") or {}
            if m.get("role") != "assistant":
                continue
            for x in reversed(m.get("content") or []):
                if (isinstance(x, dict) and x.get("type") == "thinking"
                        and str(x.get("thinking") or "").strip()):
                    return " ".join(str(x["thinking"]).split())[-limit:]
    except Exception:
        pass
    return ""


def window_start(run: str, port: int) -> dict:
    obs = observe(port)
    ok = "error" not in obs
    return {
        "mem": snapshot_memory(run),
        "levels": level_map(obs.get("party") or []) if ok else {},
        "hp": {p.get("species"): p.get("hp") for p in (obs.get("party") or []) if p.get("species") is not None} if ok else {},
        "badges": obs.get("badges") if ok else None,
        "money": obs.get("money") if ok else None,
        "dreams": read_dream(run).get("dreams", 0),
    }


def report(run: str, port: int, start_n: int, end_n: int, started: float,
           start_snap: dict) -> str:
    mem_start = start_snap["mem"]
    lv_start = start_snap["levels"]
    badge_start = start_snap["badges"]
    money_start = start_snap["money"]
    elapsed = (time.time() - started) / 60
    actions = load_actions(run)
    window = actions[start_n:end_n]
    obs = observe(port)
    mem_end = snapshot_memory(run)
    dream = read_dream(run)

    lines = [f"=== MAP WATCH {datetime.now().strftime('%H:%M:%S')} ==="]
    lines.append(f"window: {start_n} -> {end_n} (+{end_n - start_n}), {elapsed:.1f} min")
    lines.append(f"STATE: {fmt_obs(obs)}")
    if "error" not in obs:
        lines.append(f"PARTY: {fmt_party(obs.get('party') or [])}")
        tail = screen_tail(obs)
        if tail:
            lines.append(f"SCREEN: {tail}")
        menu = obs.get("menu")
        if menu and isinstance(menu.get("row"), int):
            scr = (obs.get("screen") or "").split("\n")
            row = menu["row"]
            lines.append(f"MENU: row {row} (index {menu.get('index')})")
            for i in range(max(0, row - 2), min(len(scr), row + 3)):
                mark = ">" if i == row else " "
                lines.append(f"  {mark} {scr[i].rstrip()}")
    lines.append(
        "DREAM: dreams={dreams} actions={actions}/50 due={due} read_after={read}".format(
            dreams=dream.get("dreams", 0),
            actions=dream.get("actions", 0),
            due=dream.get("due", False),
            read=dream.get("read_after_dream", "?"),
        )
    )
    think = last_thinking(run)
    if think:
        lines.append("THINK: " + think)
    lines.append(f"COUNT: map={end_n}/5000 remaining={5000 - end_n}")

    if window:
        maps_seen: list[str] = []
        for a in window:
            for s in a.get("steps") or []:
                m = s.get("map")
                if m and (not maps_seen or maps_seen[-1] != m):
                    maps_seen.append(m)
        lines.append(f"MAPS: {' -> '.join(maps_seen)}")
        lines.append("ACTIONS:")
        for i, a in enumerate(window[-8:], start=max(start_n, end_n - 8)):
            lines.append(f"  {i} {a.get('kind')}: {action_text(a)}")
    else:
        lines.append("ACTIONS: (none)")

    changed = []
    for name, (mt, sz) in mem_end["maps"].items():
        old = mem_start["maps"].get(name)
        if old is None or old[0] != mt or old[1] != sz:
            changed.append(name)
    mem_changed = (
        mem_end["memory_mtime"] != mem_start["memory_mtime"]
        or mem_end["memory_size"] != mem_start["memory_size"]
    )
    lines.append(
        f"MEMORY: {'changed' if mem_changed else 'unchanged'} ({mem_end['memory_size']} chars); "
        f"maps changed: {', '.join(changed) if changed else 'none'}"
    )

    flags = []
    if "error" not in obs:
        lv_end = level_map(obs.get("party") or [])
        for sp, lv in lv_end.items():
            if sp in lv_start and lv != lv_start[sp]:
                flags.append(f"level {sp}: {lv_start[sp]}->{lv}")
        if badge_start is not None and obs.get("badges") != badge_start:
            flags.append(f"badges {badge_start}->{obs.get('badges')}")
        if money_start is not None and obs.get("money") != money_start:
            flags.append(f"money {money_start}->{obs.get('money')}")
        hp_start = start_snap.get("hp") or {}
        hp_end = {p.get("species"): p.get("hp") for p in (obs.get("party") or []) if p.get("species") is not None}
        if hp_start and hp_start == hp_end:
            flags.append("HP unchanged")
        elif hp_start:
            flags.append("HP changed")
    # stuck heuristic: same button, same position, no HP change for the whole window
    buttons = [s.get("button") for a in window for s in (a.get("steps") or []) if s.get("button")]
    positions = {tuple(s.get("pos") or []) for a in window for s in (a.get("steps") or []) if s.get("pos")}
    if buttons and len(set(buttons)) == 1 and len(positions) == 1:
        flags.append(f"STUCK? {len(buttons)}x {buttons[0]} at {list(positions)[0]}")
    if not flags:
        flags.append("none")
    lines.append("FLAGS: " + "; ".join(flags))
    if dream.get("dreams", 0) != start_snap.get("dreams", 0):
        lines.append("DREAM LOG: " + last_dream(run))
    return "\n".join(lines)


def acquire_lock(run: str):
    """Keep at most one watcher per run; the OS releases the lock if the process dies."""
    p = ROOT / "runs" / run / ".watch20.lock"
    p.parent.mkdir(parents=True, exist_ok=True)
    f = p.open("w", encoding="utf-8")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    f.write(str(os.getpid()))
    f.flush()
    return f


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.environ.get("POKE_RUN_NAME", ""))
    ap.add_argument("--port", type=int, default=int(os.environ.get("POKE_PORT", "8765")))
    ap.add_argument("--every", type=int, default=20)
    ap.add_argument("--reports", type=int, default=1, help="0 = run until timeout")
    ap.add_argument("--timeout-min", type=float, default=90)
    ap.add_argument("--interval", type=float, default=10)
    ap.add_argument("--baseline", type=int, default=None, help="override starting action count")
    args = ap.parse_args()
    if not args.run:
        ap.error("--run or POKE_RUN_NAME is required")

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    log_path = ROOT / "runs" / args.run / "watch20.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    lock = acquire_lock(args.run)
    if lock is None:
        msg = f"WATCH20 refused: another watcher already holds runs/{args.run}/.watch20.lock"
        print(msg)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
        return

    deadline = time.time() + args.timeout_min * 60
    emitted = 0
    current = count_actions(args.run)
    if args.baseline is not None:
        start_n = args.baseline
    else:
        saved = read_baseline(args.run)
        start_n = saved if saved is not None else current
    if start_n > current:
        start_n = current
    started = time.time()

    # Baseline snapshot so a stalled or already-finished run is visible immediately.
    start_snap = window_start(args.run, args.port)
    obs0 = observe(args.port)
    print(f"WATCH20 armed: run={args.run} port={args.port} every={args.every} "
          f"start={start_n} {fmt_obs(obs0)}")
    sys.stdout.flush()

    while time.time() < deadline:
        try:
            n = count_actions(args.run)
            now_obs = observe(args.port)
            alert = critical(now_obs)
            if alert:
                text = f"!!! ALERT: {alert} at {n} actions"
                print(text)
                body = report(args.run, args.port, start_n, n, started, start_snap)
                print(body)
                print()
                sys.stdout.flush()
                with log_path.open("a", encoding="utf-8") as f:
                    f.write(text + "\n" + body + "\n\n")
                return
            if n >= start_n + args.every:
                end_n = start_n + args.every
                text = report(args.run, args.port, start_n, end_n, started, start_snap)
                print(text)
                print()
                sys.stdout.flush()
                with log_path.open("a", encoding="utf-8") as f:
                    f.write(text + "\n\n")
                emitted += 1
                start_n = end_n
                write_baseline(args.run, end_n)
                started = time.time()
                start_snap = window_start(args.run, args.port)
                if args.reports and emitted >= args.reports:
                    return
                continue
        except Exception:
            tb = traceback.format_exc()
            print(tb)
            sys.stdout.flush()
            with log_path.open("a", encoding="utf-8") as f:
                f.write(f"[{datetime.now().isoformat(timespec='seconds')}] WATCH20 ERROR (continuing)\n{tb}\n")
        time.sleep(args.interval)

    msg = f"WATCH20 timeout at {count_actions(args.run)} actions; emitted={emitted}"
    print(msg)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")


if __name__ == "__main__":
    main()
