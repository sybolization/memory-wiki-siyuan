#!/usr/bin/env node
/**
 * backfill_spatial.mjs - turn the SIGHT blocks already present in a Pi
 * session trace into runs/<run>/spatial.jsonl.
 *
 * This is a one-time history import for runs that started before the emulator
 * server wrote spatial.jsonl directly.  It only reads the agent's own tool
 * results.  No ROM data and no memory files are consulted.
 *
 * Usage:
 *   node tools/backfill_spatial.mjs --run runs/gbc_map_14
 *   node tools/backfill_spatial.mjs --run runs/gbc_map_14 --out spatial.jsonl
 */
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.resolve(HERE, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const runArg = arg("run", process.env.POKE_RUN_NAME ?? "");
if (!runArg) {
  console.error("backfill_spatial: pass --run <name|path> or set POKE_RUN_NAME");
  process.exit(2);
}
const runPath = (!path.isAbsolute(runArg) && !/[\\/]/.test(runArg)) ? path.join("runs", runArg) : runArg;
const runDir = path.isAbsolute(runPath) ? runPath : path.resolve(ROOT, runPath);
const outName = arg("out", "spatial.jsonl");
const outPath = path.isAbsolute(outName) ? outName : path.join(runDir, outName);

const CELLS = new Set([".", ",", "#", "D", "N", "x", "S", "@", "?"]);

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function parseSight(text, origin) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes("SIGHT DURING THIS ACTION"));
  if (at < 0) return null;
  const head = lines[at].match(/SIGHT DURING THIS ACTION \((\d+) screen samples/);
  const samples = head ? Number(head[1]) : 0;

  // Legend is the next non-empty line; the column header follows it.
  let i = at + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  i++; // skip legend
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return null;
  // Header offsets are fixed-width (%+3d) so +9 and +10 can touch.  Do not
  // split on whitespace: read 3-character cells from the same 5-column indent
  // that _grid_rows uses.
  const headerBody = lines[i].slice(5);
  const xs = [];
  for (let c = 0; c + 3 <= headerBody.length; c += 3) {
    const tok = headerBody.slice(c, c + 3).trim();
    if (!/^[+-]?\d+$/.test(tok)) {
      xs.length = 0;
      break;
    }
    xs.push(Number(tok));
  }
  if (xs.length < 3) return null;
  i++;

  const cells = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const label = line.slice(0, 3).trim();
    if (!/^[+-]?\d+$/.test(label)) break;
    const y = Number(label);
    const body = line.slice(5);
    for (let c = 0; c < xs.length; c++) {
      const ch = body.slice(c * 3, c * 3 + 3).trim();
      if (!ch) continue;
      if (!CELLS.has(ch)) continue;
      if (ch === "?") continue;
      cells.push([origin.x + xs[c], origin.y + y, ch]);
    }
  }
  if (!cells.length) return null;
  return { samples, cells };
}

function parseState(text) {
  const m = text.match(/STATE ([A-Z0-9_]+) \((\d+),(\d+)\)/);
  if (!m) return null;
  return { map: m[1], x: Number(m[2]), y: Number(m[3]) };
}

const sessions = fs.readdirSync(path.join(runDir, "pi-sessions"))
  .filter((n) => n.endsWith(".jsonl"))
  .sort()
  .map((n) => path.join(runDir, "pi-sessions", n));
if (!sessions.length) {
  console.error("no pi-sessions/*.jsonl under " + runDir);
  process.exit(1);
}

const out = [];
const seen = new Set();
for (const session of sessions) {
  const raw = fs.readFileSync(session, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event.message;
    if (!message || message.role !== "toolResult" || !Array.isArray(message.content)) continue;
    if (message.toolName !== "poke_program" && message.toolName !== "poke_act") continue;
    const text = textOf(message);
    if (!text.includes("SIGHT DURING THIS ACTION")) continue;
    const state = parseState(text);
    if (!state) continue;
    const sight = parseSight(text, state);
    if (!sight) continue;

    // The play session can be resumed; the same tool may appear in more than
    // one session snapshot.  Deduplicate by the call id when present.
    const id = message.toolCallId || "";
    const dedupe = id + "|" + state.map + "|" + state.x + "," + state.y + "|" + sight.cells.length;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const t = Number(message.timestamp);
    out.push({
      kind: "sight",
      map: state.map,
      map_id: null,
      start: null,
      end: [state.x, state.y],
      cells: sight.cells,
      samples: sight.samples,
      t: Number.isFinite(t) ? Math.round(t / 1000) : 0,
      source: "backfill",
    });
  }
}

if (!out.length) {
  console.error("no SIGHT blocks found in " + sessions.join(", "));
  process.exit(2);
}

const tmp = outPath + ".tmp";
fs.writeFileSync(tmp, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
fs.renameSync(tmp, outPath);
const cells = out.reduce((n, r) => n + r.cells.length, 0);
const maps = [...new Set(out.map((r) => r.map))];
console.log("wrote " + outPath);
console.log("records=" + out.length + " cells=" + cells + " maps=" + maps.join(","));
