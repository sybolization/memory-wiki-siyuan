#!/usr/bin/env node
/**
 * render_working.mjs - refresh the shared working-memory view and the Python
 * analysis workbench.
 *
 * The seen mask comes from runs/<run>/spatial.jsonl, which contains SIGHT
 * cells the emulator actually showed.  When runs/<run>/terrain/<MAP>.json
 * exists, seen cells are drawn with the ROM's own collision terrain decoded
 * from <MAP>_Blocks + the tileset collision table; terrain never adds a cell.
 * The analysis copy contains only this run's own action/SIGHT history, never a
 * global ROM map.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { viewExplored } from "../lib/map_view.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseJsonl(raw) {
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

// The SIGHT ledger is appended after an action, so its last record can trail
// the player by one step.  Read the live RAM state for the current map and
// '@'; fall back to the ledger if the server is not running.
async function readLiveState() {
  const base = arg("url", process.env.POKE_URL ?? ("http://127.0.0.1:" + arg("port", "8765")));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(base + "/observe", { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const live = await readLiveState();

function buildSummary(actions, spatial, runName, memoryDir) {
  const maps = {};
  const transitions = [];
  const blockedKeys = {};
  const lastActions = [];
  let current = null;
  let prevMap = null;
  let blocked = 0;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] ?? {};
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const parts = [];
    for (const s of steps) {
      const map = String(s.map ?? "?");
      const pos = Array.isArray(s.pos) ? s.pos : [];
      if (!maps[map]) maps[map] = { steps: 0, firstAction: i + 1, lastPos: null };
      maps[map].steps++;
      maps[map].lastPos = pos;
      if (prevMap !== map) {
        transitions.push({ action: i + 1, map, pos });
        prevMap = map;
      }
      current = { map, pos, action: i + 1, button: s.button, outcome: s.outcome };
      parts.push(String(s.button) + ":" + String(s.outcome) + "@" + map + "(" + pos.join(",") + ")");
      if (s.outcome === "blocked") {
        blocked++;
        const key = map + "(" + pos.join(",") + ") " + String(s.button);
        blockedKeys[key] = (blockedKeys[key] ?? 0) + 1;
      }
    }
    if (i >= Math.max(0, actions.length - 20)) {
      lastActions.push((i + 1) + ". " + (a.kind ?? "?") + ": " + parts.join(" | ").slice(0, 360));
    }
  }

  const repeatedBlocked = Object.entries(blockedKeys)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({ key, count }));

  const spatialStats = {};
  for (const rec of spatial) {
    const map = String(rec?.map ?? "");
    if (!map || !Array.isArray(rec.cells)) continue;
    if (!spatialStats[map]) spatialStats[map] = { records: 0, seen: new Set() };
    spatialStats[map].records++;
    for (const c of rec.cells) {
      if (Array.isArray(c) && c.length >= 2) spatialStats[map].seen.add(String(c[0]) + "," + String(c[1]));
    }
  }
  const spatialOut = {};
  for (const [map, st] of Object.entries(spatialStats)) {
    spatialOut[map] = { records: st.records, seen: st.seen.size };
  }

  let dreams = 0;
  try {
    const ds = JSON.parse(fs.readFileSync(path.join(memoryDir, ".dream_state.json"), "utf8"));
    dreams = Number(ds.dreams ?? 0);
  } catch {}
  let notesOpen = 0;
  try {
    notesOpen = fs.readdirSync(path.join(memoryDir, "notes"))
      .filter((n) => /^note-\d{4}\.md$/.test(n)).length;
  } catch {}

  return {
    run: runName,
    generated: new Date().toISOString(),
    actions: actions.length,
    spatial_records: spatial.length,
    dreams,
    notes_open: notesOpen,
    current,
    maps,
    transitions: transitions.slice(-60),
    blocked,
    repeated_blocked: repeatedBlocked,
    spatial: spatialOut,
    last_actions: lastActions,
  };
}

const runArg = arg("run", process.env.POKE_RUN_NAME ?? "");
if (!runArg) {
  console.error("render_working: pass --run <name|path> or set POKE_RUN_NAME");
  process.exit(2);
}
const runPath = (!path.isAbsolute(runArg) && !/[\\/]/.test(runArg)) ? path.join("runs", runArg) : runArg;
const runDir = path.isAbsolute(runPath) ? runPath : path.resolve(ROOT, runPath);
const workDir = path.join(runDir, "memory", "working");
const analysisDir = path.join(workDir, "analysis");
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(analysisDir, { recursive: true });

// Keep a self-contained, read-only data snapshot for the dream's Python
// workbench.  Only this run's own actions/SIGHT are copied; no ROM map.
const actionsPath = path.join(runDir, "actions.jsonl");
const spatialPath = path.join(runDir, "spatial.jsonl");
const actionsRaw = fs.existsSync(actionsPath) ? fs.readFileSync(actionsPath, "utf8") : "";
const spatialRaw = fs.existsSync(spatialPath) ? fs.readFileSync(spatialPath, "utf8") : "";
writeAtomic(path.join(analysisDir, "actions.jsonl"), actionsRaw);
writeAtomic(path.join(analysisDir, "spatial.jsonl"), spatialRaw);
const summary = buildSummary(parseJsonl(actionsRaw), parseJsonl(spatialRaw), path.basename(runDir), path.join(runDir, "memory"));
summary.live = live ? {
  map: live.map,
  pos: [live.x, live.y],
  battle: live.battle,
  hp: live.party?.[0]?.hp ?? null,
  level: live.party?.[0]?.level ?? null,
} : null;
writeAtomic(path.join(analysisDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
const py = path.join(ROOT, ".venv", "Scripts", "python.exe");
const pyPath = fs.existsSync(py) ? py.replace(/\\/g, "/") : "python";
writeAtomic(path.join(analysisDir, "python.sh"),
  "#!/bin/sh\n# Generated wrapper for the benchmark Python.\nexec \"" + pyPath + "\" \"$@\"\n");
const analysisReadme = [
  "# Analysis workbench",
  "> Python workbench over this run's own action/SIGHT history. Not a memory file.",
  "",
  "Data snapshots (refreshed after actions):",
  "- `actions.jsonl` - raw run actions, same schema as runs/<run>/actions.jsonl",
  "- `spatial.jsonl` - raw SIGHT cells, same schema as runs/<run>/spatial.jsonl",
  "- `summary.json` - compact counts, maps, map transitions, blocked probes, last actions",
  "- `python.sh` - wrapper for the benchmark Python",
  "",
  "Write a script here and run it:",
  "  bash working/analysis/python.sh analysis.py",
  "",
  "The data contains only cells the game has shown and the agent's own actions.",
  "There is no ROM map or unseen map data in this folder.",
  "",
].join("\n");
writeAtomic(path.join(analysisDir, "README.md"), analysisReadme);

const readme = [
  "# Working memory",
  "> Generated read-only view of what the game has actually shown. You may read it.",
  "",
  "This folder is rebuilt from SIGHT observations after actions. It contains no ROM map data,",
  "no inferred blocks and no hidden map. A blank cell means \"never seen\", not walkable floor.",
  "Walls and ladders/warps are the only features drawn.",
  "",
  "Files:",
  "- `CURRENT.md` - full ASCII map of every cell seen so far on the current map, with",
  "  absolute coordinates and the seen-floor edges that lead into never-seen cells.",
  "  The map and '@' follow the live RAM position when the emulator server is reachable.",
  "- `analysis/` - Python workbench: actions.jsonl, spatial.jsonl, summary.json and python.sh.",
  "- `README.md` - this note.",
  "",
].join("\n");
fs.writeFileSync(path.join(workDir, "README.md"), readme, "utf8");

const body = viewExplored(runDir, { map: live?.map ?? "current", full: true, edges: 20, live });
const text = [
  "# Working map (fog of war, SIGHT only)",
  "> Generated full current-map view from every cell the game has shown so far. Read-only; only walls and ladders are drawn; blank = never seen; no hidden map.",
  "",
  body,
  "",
  "_This file is rebuilt automatically after actions. It is not a substitute for MEMORY.md or TODO.md._",
  "",
].join("\n");

const target = path.join(workDir, "CURRENT.md");
const tmp = target + ".tmp";
fs.writeFileSync(tmp, text, "utf8");
fs.renameSync(tmp, target);
