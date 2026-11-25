import pathlib
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNS = ["gbc_map_01", "gbc_full_02"]
LOG = ROOT / "runs" / "monitor_resume2.log"
TARGET = 5000
START = time.time()
LAST = {}
IDLE = 0
# baseline: map has one resume leg done, full will have two
EXPECTED_EXITS = {"gbc_map_01": 1, "gbc_full_02": 2}

while True:
    parts, done, current = [], 0, {}
    for name in RUNS:
        aj = ROOT / "runs" / name / "actions.jsonl"
        n = sum(1 for _ in aj.open("r", encoding="utf-8")) if aj.exists() else 0
        current[name] = n
        rl = ROOT / "runs" / name / "resume_log.txt"
        exits = rl.read_text("utf8", errors="ignore").count("resume exit=") if rl.exists() else 0
        finished = exits >= EXPECTED_EXITS[name]
        if finished:
            done += 1
        maps = ROOT / "runs" / name / "memory" / "maps"
        nmaps = len(list(maps.glob("*.md"))) if maps.exists() else 0
        parts.append(f"{name} actions={n}/{TARGET} maps={nmaps}" + (" DONE" if finished else ""))
    line = time.strftime("[%H:%M:%S] ") + " | ".join(parts)
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    if done == len(RUNS):
        break
    if LAST and all(current.get(k) == v for k, v in LAST.items()):
        IDLE += 1
    else:
        IDLE = 0
    LAST = current
    if IDLE >= 30:
        print("STALLED: no action growth for 60 minutes", flush=True)
        break
    if time.time() - START > 12 * 3600:
        print("TIMEOUT: 12 hours", flush=True)
        break
    time.sleep(120)
