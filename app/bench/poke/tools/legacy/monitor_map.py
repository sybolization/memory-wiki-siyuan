import json
import pathlib
import re
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNS = [("gbc_map_01", 8765), ("gbc_full_02", 8766)]
LOG = ROOT / "runs" / "monitor_map.log"
START = time.time()
LAST = {}
IDLE = 0

while True:
    parts, done, current = [], 0, {}
    for name, port in RUNS:
        try:
            h = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5))
            acts = h.get("actions")
        except Exception:
            acts = "down"
        current[name] = acts
        ctx = "?"
        t = ROOT / "runs" / name / "trace.jsonl"
        if t.exists():
            txt = t.read_text("utf8", errors="ignore")[-400000:]
            m = re.findall(r'"totalTokens":(\d+)', txt)
            ctx = m[-1] if m else "0"
        aj = ROOT / "runs" / name / "actions.jsonl"
        nacts = sum(1 for _ in aj.open("r", encoding="utf-8")) if aj.exists() else 0
        mem = ROOT / "runs" / name / "memory" / "MEMORY.md"
        memsz = len(mem.read_text("utf8", errors="ignore")) if mem.exists() else 0
        maps = ROOT / "runs" / name / "memory" / "maps"
        nmaps = len(list(maps.glob("*.md"))) if maps.exists() else 0
        fin = (ROOT / "runs" / name / "summary.json").exists()
        done += 1 if fin else 0
        parts.append(f"{name} acts={nacts} ctx={ctx} mem={memsz} maps={nmaps}" + (" DONE" if fin else ""))
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
    if IDLE >= 15:  # 30 minutes with no action growth
        print("STALLED: no action growth for 30 minutes", flush=True)
        break
    if time.time() - START > 5 * 3600:
        print("TIMEOUT: 5 hours", flush=True)
        break
    time.sleep(120)
