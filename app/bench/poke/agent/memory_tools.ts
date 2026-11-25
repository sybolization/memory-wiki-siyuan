/**
 * memory_tools.ts - 面向 agent 记忆目录的 read / write / edit / plan 工具，以及 dream 仪式。
 *
 * POKE_MEMORY_DIR  root of the memory dir (MEMORY.md, maps/*.md, TODO.md)
 * POKE_MEMORY_MODE "full" (default) or "blinded" (tools exist but return nothing)
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beginDream, bumpWrite, dreamOptions, loadDream, markRead } from "../lib/dream_state.mjs";

const ROOT = process.env.POKE_MEMORY_DIR ?? path.join(process.cwd(), "memory");
const MODE = process.env.POKE_MEMORY_MODE ?? "full";
const BLINDED = MODE === "blinded";
// Dreaming runs in a separate agent: POKE_DREAM_CHILD=1 is the dream session,
// which can read the run log and rewrite memory but never plays. The playing
// session only calls memory_dream, which spawns that separate agent.
const DREAM_CHILD = process.env.POKE_DREAM_CHILD === "1";
const DREAM_READ_DIR = process.env.POKE_DREAM_READ_DIR ?? "";
const RUN_NAME = process.env.POKE_RUN_NAME ?? "";
const POKE_ROOT = process.env.POKE_ROOT ?? process.cwd();
const MAX_FILE = 12000;
const MAX_TOTAL = 48000;
const MAX_FILES = 80;
// notes/ is a small mailbox between the playing agent and the dream, not
// long-term memory. It has its own quota so a full mailbox cannot block
// MEMORY.md or TODO.md edits.
const NOTES_DIR = "notes";
const MAX_NOTE_CHARS = 800;
const MAX_NOTES = 24;
const MAX_NOTES_TOTAL = 12000;
// TODO.md 顶部的长期战略块。plan 工具只改这一块，下面的战术 checklist
// 仍由 act / dream 维护；dream 必须保留 PLAN，矛盾时加 audit 行而不是删除。
const TODO_FILE = "TODO.md";
const PLAN_HEADING = "## PLAN";
const MAX_PLAN_GOAL = 600;
const MAX_PLAN_WHY = 800;
const MAX_PLAN_STEP = 300;
const MAX_PLAN_STEPS = 8;
// working/ is a generated read-only view shared by act and dream.  It is not
// long-term memory, is refreshed from SIGHT records, and must not count
// against the memory caps or the MEMORY INDEX.
const WORKING_DIR = "working";
const DREAM = dreamOptions();
const DREAM_ENABLED = process.env.POKE_DREAM_ENABLED ? process.env.POKE_DREAM_ENABLED === "1" : true;
const BASH_PATH = process.env.POKE_BASH
  ?? (process.platform === "win32" && fs.existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash");

function msg(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

function noteWrite(): any {
  if (DREAM_CHILD || !DREAM_ENABLED) return null;
  return bumpWrite(ROOT);
}

function dreamNote(s: any): string {
  const n = Number(s?.writes ?? 0);
  return (
    "\n\nDREAM DUE: " + n + " memory writes since the last dream (trigger " + DREAM.writes + "). " +
    "Call memory_dream before the next game action; poke_act and poke_program will refuse until it runs. " +
    "A separate dream agent (no game tools) audits the action log and rewrites the memory files."
  );
}

// plan 写入的块格式固定，方便 poke_tools.ts 的 planTag() 和 dream 解析：
//   ## PLAN
//   > goal: ...
//   > why: ...
//   > written: ...
//   > horizon: ...
//   1. ...
//   2. ...
function planBlock(params: any): string {
  const goal = String(params.goal ?? "").replace(/\s+/g, " ").trim();
  if (!goal) throw new Error("goal is empty");
  if (goal.length > MAX_PLAN_GOAL) throw new Error("goal too long (" + goal.length + " > " + MAX_PLAN_GOAL + " chars); condense it");
  const why = String(params.why ?? "").replace(/\s+/g, " ").trim();
  if (why.length > MAX_PLAN_WHY) throw new Error("why too long (" + why.length + " > " + MAX_PLAN_WHY + " chars); condense it");
  const raw = Array.isArray(params.steps)
    ? params.steps
    : String(params.steps ?? "").split(/\r?\n/);
  const steps = raw.map((s: any) => String(s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (steps.length > MAX_PLAN_STEPS) throw new Error("too many steps (" + steps.length + " > " + MAX_PLAN_STEPS + "); keep 3-6");
  for (const s of steps) {
    if (s.length > MAX_PLAN_STEP) throw new Error("step too long (" + s.length + " > " + MAX_PLAN_STEP + " chars); split it");
  }
  const horizon = Number(params.horizon ?? 0);
  const reviewAt = Number(params.review_at ?? 0);
  const lines = [PLAN_HEADING];
  lines.push("> goal: " + goal);
  if (why) lines.push("> why: " + why);
  lines.push("> written: " + new Date().toISOString());
  if (horizon > 0 || reviewAt > 0) {
    const bits: string[] = [];
    if (horizon > 0) bits.push(horizon + " actions");
    if (reviewAt > 0) bits.push("review at act " + reviewAt);
    lines.push("> horizon: " + bits.join("; "));
  }
  steps.forEach((s, i) => lines.push((i + 1) + ". " + s));
  return lines.join("\n");
}

// 只替换/插入 ## PLAN 块，保留 TODO.md 的标题、描述和战术 checklist。
function upsertPlan(body: string, block: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+PLAN\b/i.test(l.trim()));
  if (start >= 0) {
    // PLAN 块只包含标题、> 元信息和编号 milestone；遇到空行后的
    // checklist / 下一个二级标题就结束，不能把下面的战术项一起吃掉。
    let end = start + 1;
    while (end < lines.length) {
      const t = lines[end].trim();
      if (t === "" || /^>/.test(t) || /^\d+\.\s+/.test(t)) { end++; continue; }
      break;
    }
    while (end > start + 1 && lines[end - 1].trim() === "") end--;
    const next = [...lines.slice(0, start), ...block.split("\n"), "", ...lines.slice(end)];
    return next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }
  // 没有 PLAN 时，插到第一条 checklist 或第一个二级标题之前；没有就放末尾。
  let at = lines.findIndex((l) => /^\s*[-*]\s+\[[ xX]\]/.test(l) || /^##\s+/.test(l.trim()));
  if (at < 0) at = lines.length;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  const next = [...lines.slice(0, at), "", ...block.split("\n"), "", ...lines.slice(at)];
  return next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function ensureTodo(body: string): string {
  if (body.trim()) return body;
  return "# TODO\n> Next physical actions. The PLAN section is the long-term strategy; the checklist is the next 3-6 moves.\n";
}

function hasPlanBlock(text: string): boolean {
  return /^##\s+PLAN\b/im.test(text);
}

// PLAN 由 act 拥有；dream 可以补 audit 行，但不能整块删掉。
function planGuard(rel: string, before: string, after: string): string {
  if (!DREAM_CHILD || rel !== TODO_FILE) return "";
  if (hasPlanBlock(before) && !hasPlanBlock(after)) {
    return "[error] TODO.md has a ## PLAN block owned by the playing agent; preserve it (you may add a '> audit:' line) instead of deleting it.";
  }
  return "";
}

function resolvePath(rel: string): { full: string; rel: string } {
  const norm = String(rel ?? "").replace(/\\/g, "/").trim() || ".";
  if (norm.startsWith("/") || norm.split("/").includes("..")) throw new Error("illegal path: " + rel);
  const root = path.resolve(ROOT);
  const full = path.resolve(root, norm);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("path escapes memory root");
  return { full, rel: path.relative(root, full).replace(/\\/g, "/") };
}

function safeFile(rel: string): { full: string; rel: string } {
  const r = resolvePath(rel);
  if (r.full.toLowerCase().endsWith(".md")) return r;
  if (isAnalysisFile(r.rel)) return r;
  throw new Error("only .md memory files, or .py/.json/.txt/.csv under working/analysis");
}

function allFiles(): string[] {
  if (!fs.existsSync(ROOT)) return [];
  const out: string[] = [];
  const notesRoot = path.resolve(ROOT, NOTES_DIR);
  const workingRoot = path.resolve(ROOT, WORKING_DIR);
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const abs = path.resolve(p);
        if (abs === notesRoot || abs === workingRoot) continue;
        walk(p);
      } else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

function isNotePath(rel: string): boolean {
  const n = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
  return n === NOTES_DIR || n.startsWith(NOTES_DIR + "/");
}

// working/analysis is a scratch workbench, not long-term memory.  It is
// excluded from the caps/index, and the dream may keep Python scripts and
// derived tables there.  The normal read/write/edit tools can touch it; no
// separate analysis tool is needed.
function isAnalysisPath(rel: string): boolean {
  const n = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  return n === WORKING_DIR + "/analysis" || n.startsWith(WORKING_DIR + "/analysis/");
}

function isAnalysisFile(rel: string): boolean {
  return isAnalysisPath(rel) && /\.(py|json|txt|csv)$/i.test(rel);
}

function noteFiles(): string[] {
  const dir = path.join(ROOT, NOTES_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^note-\d{4}\.md$/.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

function noteStats(): { count: number; chars: number } {
  const files = noteFiles();
  let chars = 0;
  for (const f of files) {
    try { chars += fs.readFileSync(f, "utf8").length; } catch {}
  }
  return { count: files.length, chars };
}

function nextNoteId(): string {
  let max = 0;
  for (const f of noteFiles()) {
    const m = path.basename(f).match(/^note-(\d{4})\.md$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  // Keep ids monotonic even after the dream deletes old notes, so a TODO
  // reference to "note 0007" never points at a different note later.
  const seqPath = path.join(ROOT, NOTES_DIR, ".seq");
  try {
    if (fs.existsSync(seqPath)) max = Math.max(max, Number(fs.readFileSync(seqPath, "utf8").trim()) || 0);
  } catch {}
  const next = max + 1;
  fs.mkdirSync(path.dirname(seqPath), { recursive: true });
  fs.writeFileSync(seqPath, String(next), "utf8");
  return String(next).padStart(4, "0");
}

function notePath(id: string): { full: string; rel: string } {
  const clean = String(id ?? "").trim().replace(/\\/g, "/")
    .replace(/^notes\//, "").replace(/^note-/, "").replace(/\.md$/, "");
  if (!/^\d{1,4}$/.test(clean)) throw new Error("note id must look like 0001");
  const rel = NOTES_DIR + "/note-" + clean.padStart(4, "0") + ".md";
  const root = path.resolve(ROOT);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error("path escapes memory root");
  return { full, rel };
}

function noteWriteError(): string {
  return DREAM_CHILD
    ? "[error] notes/ is the playing agent's mailbox; read it with memory_notes and delete consumed notes with memory_note_delete. Do not write notes with write or edit."
    : "[error] notes/ is the dream mailbox; add a note with memory_note. Only the dream deletes notes.";
}

function totalChars(): number {
  return allFiles().reduce((n, p) => n + fs.readFileSync(p, "utf8").length, 0);
}

function capReport(): string {
  const files = allFiles();
  let total = 0;
  const over: string[] = [];
  for (const p of files) {
    let n = 0;
    try { n = fs.readFileSync(p, "utf8").length; } catch {}
    total += n;
    if (n > MAX_FILE) over.push(path.relative(ROOT, p).replace(/\\/g, "/") + " (" + n + " chars)");
  }
  const parts: string[] = [];
  if (over.length) parts.push("over " + MAX_FILE + " chars: " + over.join(", "));
  if (files.length > MAX_FILES) parts.push(files.length + " files > " + MAX_FILES);
  if (total > MAX_TOTAL) parts.push(total + " chars > " + MAX_TOTAL);
  return parts.join("; ");
}

function buildIndex(): string {
  if (BLINDED) return "";
  const files = allFiles();
  const notes = noteStats();
  if (!files.length && !notes.count) return "";
  let total = 0;
  const rows = files.map((p) => {
    const rel = path.relative(ROOT, p).replace(/\\/g, "/");
    let txt = "";
    try { txt = fs.readFileSync(p, "utf8"); } catch {}
    total += txt.length;
    const name = rel.length > 26 ? rel.slice(0, 25) + "~" : rel.padEnd(26);
    const desc = (txt.match(/^>\s*(.+)$/m) ?? [])[1] ?? "";
    const heads = (txt.match(/^#{1,3} .*$/gm) ?? [])
      .map((h) => h.replace(/^#+\s*/, "").trim())
      .slice(0, 7)
      .join(" / ")
      .slice(0, 130);
    const what = desc ? desc.trim().slice(0, 90) + (heads ? " | " + heads : "") : heads;
    return "  " + name + " " + String(txt.length).padStart(5) + "  " + what.slice(0, 170);
  });
  const head = "MEMORY INDEX (" + files.length + " files, " + total + " chars; read <path> for the full text)";
  const noteLine = notes.count
    ? "\nNOTES: " + notes.count + " open in notes/ (" + notes.chars + " chars); the dream reads and deletes them."
    : "";
  return head + (rows.length ? "\n" + rows.join("\n") : "") + noteLine;
}

function renderRecent(count: number): string {
  const p = path.join(DREAM_READ_DIR, "actions.jsonl");
  if (!DREAM_READ_DIR || !fs.existsSync(p)) return "no action log at " + p;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const start = Math.max(0, lines.length - count);
  const out = ["# last " + (lines.length - start) + " of " + lines.length + " game actions (oldest first)"];
  for (let i = start; i < lines.length; i++) {
    let o: any;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const steps = (o.steps ?? []).map((s: any) => {
      const pos = Array.isArray(s.pos) ? "(" + s.pos.join(",") + ")" : "";
      return s.button + ":" + s.outcome + "@" + (s.map ?? "?") + pos;
    }).join(" | ");
    let row = (i + 1) + ". " + (o.kind ?? "?") + ": " + steps;
    if (row.length > 420) row = row.slice(0, 417) + "...";
    out.push(row);
  }
  return out.join("\n");
}

function readJsonlFile(name: string): any[] {
  if (!DREAM_READ_DIR) return [];
  const p = path.join(DREAM_READ_DIR, name);
  if (!fs.existsSync(p)) return [];
  const out: any[] = [];
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Compact, machine-readable run summary.  The dream should use this before
 * paging the raw action log: it answers the common questions (where am I, what
 * maps exist, where did the map change, which probes repeat, what happened in
 * the last few actions) without replaying thousands of lines.
 */
function buildRunSummary(): any {
  const actions = readJsonlFile("actions.jsonl");
  const spatial = readJsonlFile("spatial.jsonl");
  const mapStats: Record<string, any> = {};
  const transitions: any[] = [];
  const blockedKeys: Record<string, number> = {};
  const lastActions: string[] = [];
  let lastStep: any = null;
  let prevMap: string | null = null;
  let blocked = 0;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const parts: string[] = [];
    for (const s of steps) {
      const map = String(s.map ?? "?");
      const pos = Array.isArray(s.pos) ? s.pos : [];
      if (!mapStats[map]) mapStats[map] = { steps: 0, firstAction: i + 1, lastPos: null };
      mapStats[map].steps++;
      mapStats[map].lastPos = pos;
      if (prevMap !== map) {
        transitions.push({ action: i + 1, map, pos });
        prevMap = map;
      }
      lastStep = { ...s, action: i + 1 };
      parts.push(String(s.button) + ":" + String(s.outcome) + "@" + map + "(" + pos.join(",") + ")");
      if (s.outcome === "blocked") {
        blocked++;
        const key = map + "(" + pos.join(",") + ") " + String(s.button);
        blockedKeys[key] = (blockedKeys[key] ?? 0) + 1;
      }
    }
    if (i >= Math.max(0, actions.length - 15)) {
      lastActions.push((i + 1) + ". " + (a.kind ?? "?") + ": " + parts.join(" | ").slice(0, 360));
    }
  }

  const repeated = Object.entries(blockedKeys)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([key, count]) => ({ key, count }));

  const spatialStats: Record<string, any> = {};
  for (const rec of spatial) {
    const map = String(rec.map ?? "");
    if (!map || !Array.isArray(rec.cells)) continue;
    if (!spatialStats[map]) spatialStats[map] = { records: 0, seen: new Set<string>() };
    spatialStats[map].records++;
    for (const c of rec.cells) {
      if (Array.isArray(c) && c.length >= 2) spatialStats[map].seen.add(String(c[0]) + "," + String(c[1]));
    }
  }
  const spatialOut: Record<string, any> = {};
  for (const [map, st] of Object.entries(spatialStats)) {
    spatialOut[map] = { records: st.records, seen: st.seen.size };
  }

  const d = loadDream(ROOT);
  return {
    run: RUN_NAME,
    actions: actions.length,
    dreams: d.dreams,
    current: lastStep
      ? { map: lastStep.map, pos: lastStep.pos, action: lastStep.action, button: lastStep.button, outcome: lastStep.outcome }
      : null,
    maps: mapStats,
    transitions,
    blocked,
    repeatedBlocked: repeated,
    spatial: spatialOut,
    notes: noteStats().count,
    lastActions,
  };
}

function summaryText(s: any): string {
  const lines: string[] = [];
  lines.push("RUN SUMMARY (compact; actions=" + s.actions + ", dreams=" + s.dreams + ", notes=" + s.notes + ")");
  if (s.current) {
    lines.push("current (last logged step): " + s.current.map + " (" + (s.current.pos ?? []).join(",") +
      ") action=" + s.current.action + " " + s.current.button + ":" + s.current.outcome);
  }
  lines.push("", "MAPS (logged steps):");
  for (const [map, v] of Object.entries(s.maps).sort((a: any, b: any) => a[1].firstAction - b[1].firstAction)) {
    lines.push("  " + map.padEnd(22) + " steps=" + String((v as any).steps).padStart(4) +
      " first=" + (v as any).firstAction + " last=(" + ((v as any).lastPos ?? []).join(",") + ")");
  }
  lines.push("", "MAP TRANSITIONS:");
  for (const t of s.transitions.slice(-20)) {
    lines.push("  action " + t.action + " -> " + t.map + " (" + (t.pos ?? []).join(",") + ")");
  }
  lines.push("", "BLOCKED: " + s.blocked + " steps");
  if (s.repeatedBlocked.length) {
    lines.push("repeated blocked probes:");
    for (const r of s.repeatedBlocked) lines.push("  " + r.count + "x " + r.key);
  }
  lines.push("", "SPATIAL (unique SIGHT cells):");
  for (const [map, v] of Object.entries(s.spatial)) {
    lines.push("  " + map.padEnd(22) + " seen=" + String((v as any).seen).padStart(5) + " records=" + (v as any).records);
  }
  lines.push("", "LAST ACTIONS:");
  lines.push(...s.lastActions);
  return lines.join("\n").slice(0, 8000);
}

function readRun(rel: string, offset: any, limit: any): string {
  if (!DREAM_READ_DIR) return "[error] no run log dir configured";
  const name = rel.replace(/^\/+/, "");
  if (name === "summary") return summaryText(buildRunSummary());
  if (name === "recent") return renderRecent(50);
  if (name === "dreams") {
    const p = path.join(DREAM_READ_DIR, "DREAM.md");
    if (!fs.existsSync(p)) return "(no DREAM.md yet)";
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    return lines.slice(-150).join("\n");
  }
  const root = path.resolve(DREAM_READ_DIR);
  const full = path.resolve(root, name || ".");
  if (full !== root && !full.startsWith(root + path.sep)) return "[error] path escapes the run dir";
  if (!fs.existsSync(full)) return "no such run file: " + name;
  if (fs.statSync(full).isDirectory()) {
    return fs.readdirSync(full, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? "/" : "")).join("\n");
  }
  const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
  const off = Math.max(1, Number(offset ?? 1));
  const lim = Math.max(1, Math.min(2000, Number(limit ?? 400)));
  const slice = lines.slice(off - 1, off - 1 + lim);
  const rest = lines.length - (off - 1 + slice.length);
  return slice.join("\n") + (rest > 0 ? "\n...(" + rest + " more lines; read with offset)" : "");
}

const read = defineTool({
  name: "read",
  label: "Read a memory file",
  description:
    "Read a file under the memory directory (path relative to it). A directory path lists its entries. " +
    "Optional offset (1-based line) and limit (default 400 lines) for long files. " +
    "In a dream session, paths starting with 'run:' read the run log instead: run:summary (compact counts, transitions and last actions), run:recent (last 50 game actions), run:dreams, run:actions.jsonl (raw log).",
  parameters: Type.Object({
    path: Type.String({ description: "Relative path, e.g. MEMORY.md or maps/ROUTE_1.md; '.' lists the memory root" }),
    offset: Type.Optional(Type.Number({ description: "First line (1-based)" })),
    limit: Type.Optional(Type.Number({ description: "Max lines to return (default 400)" })),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("(no such memory)");
    try {
      if (DREAM_CHILD && typeof params.path === "string" && params.path.startsWith("run:")) {
        return msg(readRun(params.path.slice(4), params.offset, params.limit));
      }
      const r = resolvePath(params.path);
      if (!fs.existsSync(r.full)) return msg("no such file: " + params.path);
      const stat = fs.statSync(r.full);
      if (stat.isDirectory()) {
        const analysis = isAnalysisPath(r.rel);
        const entries = fs.readdirSync(r.full, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.name.endsWith(".md") || (analysis && /\.(py|json|txt|csv)$/i.test(e.name)))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => {
            if (e.isDirectory()) return e.name + "/";
            return e.name + " (" + fs.statSync(path.join(r.full, e.name)).size + " bytes)";
          });
        return msg((r.rel || ".") + "/\n" + (entries.length ? entries.join("\n") : "(empty)"));
      }
      if (!r.full.toLowerCase().endsWith(".md") && !isAnalysisFile(r.rel)) {
        return msg("[error] only .md memory files, or analysis files under working/analysis");
      }
      const raw = fs.readFileSync(r.full, "utf8");
      if (!DREAM_CHILD && r.rel.toLowerCase() === "memory.md") {
        markRead(ROOT);
      }
      const lines = raw.split(/\r?\n/);
      const off = Math.max(1, Number(params.offset ?? 1));
      const lim = Math.max(1, Math.min(2000, Number(params.limit ?? 400)));
      const slice = lines.slice(off - 1, off - 1 + lim);
      const rest = lines.length - (off - 1 + slice.length);
      return msg(slice.join("\n") + (rest > 0 ? "\n...(" + rest + " more lines; read with offset)" : ""));
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const write = defineTool({
  name: "write",
  label: "Write a memory file",
  description:
    "Create or overwrite a file under the memory directory. Start each memory or map file with a one-line '>' description under the title. " +
    "Use this for the initial MEMORY.md, a new map file, or a new TODO.md; prefer edit for small changes. " +
    "In a dream session, .py/.json/.txt/.csv files under working/analysis are also allowed for data-analysis scripts.",
  parameters: Type.Object({
    path: Type.String({ description: "Relative .md path, e.g. MEMORY.md, maps/ROUTE_1.md, TODO.md" }),
    content: Type.String({ description: "Full new content" }),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("noted");
    try {
      const r = safeFile(String(params.path));
      if (isNotePath(r.rel)) return msg(noteWriteError());
      const body = String(params.content ?? "");
      const before = fs.existsSync(r.full) ? fs.readFileSync(r.full, "utf8") : "";
      const guard = planGuard(r.rel, before, body);
      if (guard) return msg(guard);
      if (body.length > MAX_FILE) return msg("[error] file too long (" + body.length + " > " + MAX_FILE + " chars); condense it");
      const others = totalChars() - before.length;
      if (others + body.length > MAX_TOTAL) return msg("[error] memory full (" + (others + body.length) + " > " + MAX_TOTAL + " chars); merge or clear notes first");
      if (!fs.existsSync(r.full) && allFiles().length >= MAX_FILES) return msg("[error] too many memory files (" + MAX_FILES + " max); merge or clear first");
      fs.mkdirSync(path.dirname(r.full), { recursive: true });
      fs.writeFileSync(r.full, body, "utf8");
      const st = noteWrite();
      return msg("wrote " + r.rel + " (" + body.length + " chars)" +
        (st && st.writes >= DREAM.writes ? dreamNote(st) : ""));
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const edit = defineTool({
  name: "edit",
  label: "Edit a memory file",
  description:
    "Replace an exact string in a memory file. oldString must occur exactly once unless replaceAll=true. " +
    "Use this for small corrections and for toggling TODO checkboxes ('- [ ] item' -> '- [x] item'); never rewrite a whole file to change one item.",
  parameters: Type.Object({
    path: Type.String({ description: "Relative .md path" }),
    oldString: Type.String({ description: "Exact text to replace" }),
    newString: Type.String({ description: "Replacement text" }),
    replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence (default false)" })),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("edited");
    try {
      const r = safeFile(String(params.path));
      if (isNotePath(r.rel)) return msg(noteWriteError());
      if (!fs.existsSync(r.full)) return msg("[error] no such file: " + r.rel + " (create it with write first)");
      const oldText = String(params.oldString ?? "");
      if (!oldText) return msg("[error] oldString is empty");
      const cur = fs.readFileSync(r.full, "utf8");
      const count = cur.split(oldText).length - 1;
      if (count === 0) return msg("[error] oldString not found in " + r.rel);
      if (count > 1 && !params.replaceAll) return msg("[error] oldString occurs " + count + " times in " + r.rel + "; add more context or set replaceAll");
      const next = params.replaceAll
        ? cur.split(oldText).join(String(params.newString ?? ""))
        : cur.replace(oldText, String(params.newString ?? ""));
      const guard = planGuard(r.rel, cur, next);
      if (guard) return msg(guard);
      if (next.length > MAX_FILE) return msg("[error] file too long (" + next.length + " > " + MAX_FILE + " chars); condense it");
      const others = totalChars() - cur.length;
      if (others + next.length > MAX_TOTAL) return msg("[error] memory full (" + (others + next.length) + " > " + MAX_TOTAL + " chars); merge or clear notes first");
      fs.writeFileSync(r.full, next, "utf8");
      const st = noteWrite();
      return msg("edited " + r.rel + " (" + count + " replacement" + (count === 1 ? "" : "s") + ", " + next.length + " chars)" +
        (st && st.writes >= DREAM.writes ? dreamNote(st) : ""));
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const planTool = defineTool({
  name: "plan",
  label: "Write a long-term plan",
  description:
    "Write a long-term strategic goal into memory/TODO.md. Calling it stops the action loop for a planning checkpoint and does not consume a game action. " +
    "Use it when the TODO queue is only short tactical moves, when the same loop repeats, after a blackout or a lost rival/gym battle, or when a lever is exhausted. " +
    "Write one measurable goal, 3-6 ordered strategic milestones (not single button presses), and optionally why the old plan is being replaced. " +
    "The PLAN block stays visible after every action; the tactical checklist below it is still the next 3-6 moves. Replace the plan with this tool when the evidence changes.",
  parameters: Type.Object({
    goal: Type.String({ description: "One measurable long-term goal, e.g. 'Reach L35 or learn a status move before Misty #18'." }),
    steps: Type.Optional(Type.Array(
      Type.String({ description: "One strategic milestone" }),
      { description: "3-6 ordered strategic steps; each should name a map/route, a resource, or a concrete test. Omit for a goal-only checkpoint." },
    )),
    why: Type.Optional(Type.String({ description: "Why the old plan is being replaced: the loop, loss, contradiction or exhausted lever." })),
    horizon: Type.Optional(Type.Number({ description: "Approximate number of game actions this plan covers (optional)." })),
    review_at: Type.Optional(Type.Number({ description: "Action number at which to review the plan (optional)." })),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("plan noted");
    if (DREAM_CHILD) return msg("[error] plan is for the playing agent; the dream maintains memory/TODO.md directly.");
    try {
      const block = planBlock(params);
      const r = resolvePath(TODO_FILE);
      const cur = fs.existsSync(r.full) ? fs.readFileSync(r.full, "utf8") : "";
      const next = upsertPlan(ensureTodo(cur), block);
      if (next.length > MAX_FILE) {
        return msg("[error] TODO.md too long (" + next.length + " > " + MAX_FILE + " chars); trim the tactical checklist first");
      }
      const others = totalChars() - (fs.existsSync(r.full) ? fs.readFileSync(r.full, "utf8").length : 0);
      if (others + next.length > MAX_TOTAL) {
        return msg("[error] memory full (" + (others + next.length) + " > " + MAX_TOTAL + " chars); merge or clear first");
      }
      fs.mkdirSync(path.dirname(r.full), { recursive: true });
      fs.writeFileSync(r.full, next, "utf8");
      // 战略写入不计入 dream 的 writes 触发：plan 是主动暂停，不是记忆抖动。
      const steps = block.split("\n").filter((l) => /^\d+\.\s+/.test(l));
      const resume = steps.length
        ? "Resume by executing step 1. If the evidence contradicts this plan, call plan again instead of repeating the old loop."
        : "Resume by choosing the first concrete action that serves this goal. If the evidence contradicts it, call plan again.";
      return msg(
        "[plan] Run paused at a planning checkpoint (no game action taken). Saved to memory/TODO.md.\n\n" +
        block +
        "\n\n" + resume + " The tactical checklist below the PLAN block is unchanged; edit it if step 1 needs a concrete first move." +
        (steps.length ? "\n(" + steps.length + " strategic step" + (steps.length === 1 ? "" : "s") + " saved.)" : ""),
      );
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const noteAdd = defineTool({
  name: "memory_note",
  label: "Leave a note for the dream",
  description:
    "Save one short note for the dream agent: a new inference from SIGHT, a contradiction with MEMORY.md, a question, or a verified answer. " +
    "One claim per note; include the map and tile or direction and the evidence. The dream reads notes/ and deletes each note after folding it into MEMORY.md, maps, or TODO.md. " +
    "Do not use write or edit on notes/ and do not delete notes yourself.",
  parameters: Type.Object({
    text: Type.String({ description: "Note text: one claim, with map, tile/direction and evidence" }),
    kind: Type.Optional(Type.String({ description: "Optional label: inference, question, answer, verified, contradiction" })),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("noted");
    if (DREAM_CHILD) return msg("[error] memory_note is for the playing agent; the dream reads notes with memory_notes.");
    try {
      const text = String(params.text ?? "").trim();
      if (!text) return msg("[error] note text is empty");
      if (text.length > MAX_NOTE_CHARS) {
        return msg("[error] note too long (" + text.length + " > " + MAX_NOTE_CHARS + " chars); keep one claim per note");
      }
      const st = noteStats();
      if (st.count >= MAX_NOTES) {
        return msg("[error] notes mailbox full (" + st.count + " notes); call memory_dream so the dream can consume them");
      }
      const id = nextNoteId();
      const kind = (String(params.kind ?? "note").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24)) || "note";
      const rel = NOTES_DIR + "/note-" + id + ".md";
      const full = path.resolve(ROOT, rel);
      const root = path.resolve(ROOT);
      if (!full.startsWith(root + path.sep)) throw new Error("path escapes memory root");
      const body = "# note " + id + "\n> " + kind + " at " + new Date().toISOString() + "\n\n" + text + "\n";
      if (st.chars + body.length > MAX_NOTES_TOTAL) {
        return msg("[error] notes mailbox full (" + st.chars + " chars); call memory_dream so the dream can consume them");
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, "utf8");
      const after = noteStats();
      const due = after.count >= DREAM.notes || after.chars >= DREAM.noteChars;
      return msg("note " + id + " saved (" + after.count + " open, " + after.chars + "/" + MAX_NOTES_TOTAL + " chars). The dream reads notes/ and deletes each note after folding it into memory." +
        (due ? "\n\nDREAM DUE: the notes mailbox now has " + after.count + " notes / " + after.chars + " chars (trigger " + DREAM.notes + " / " + DREAM.noteChars + "). Call memory_dream before the next game action; the action gate will refuse otherwise." : ""));
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const notesRead = defineTool({
  name: "memory_notes",
  label: "Read the playing agent's notes",
  description:
    "Return every open note in notes/ (the playing agent's mailbox). Each note is a claim from the playing agent, not verified map data. " +
    "Fold each note into MEMORY.md, maps, or TODO.md, then delete it with memory_note_delete.",
  parameters: Type.Object({}),
  async execute() {
    if (BLINDED) return msg("(no notes)");
    if (!DREAM_CHILD) return msg("[error] memory_notes is only for the dream agent");
    try {
      const files = noteFiles();
      if (!files.length) return msg("(no open notes)");
      const out = ["OPEN NOTES (" + files.length + ")"];
      for (const f of files) {
        let raw = "";
        try { raw = fs.readFileSync(f, "utf8").trim(); } catch {}
        out.push("--- " + path.basename(f) + " ---\n" + raw);
      }
      out.push("Fold each note into MEMORY.md, maps, or TODO.md; then delete it with memory_note_delete. Do not delete a note you have not addressed.");
      return msg(out.join("\n\n"));
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const noteDelete = defineTool({
  name: "memory_note_delete",
  label: "Delete a consumed note",
  description:
    "Delete one note from notes/ after you have folded it into MEMORY.md, a map file, or TODO.md. Only the dream can delete notes.",
  parameters: Type.Object({
    id: Type.String({ description: "Note id, e.g. 0001 or note-0001" }),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("deleted");
    if (!DREAM_CHILD) return msg("[error] memory_note_delete is only for the dream agent");
    try {
      const r = notePath(String(params.id ?? ""));
      if (!fs.existsSync(r.full)) return msg("[error] no such note: " + params.id);
      fs.unlinkSync(r.full);
      return msg("deleted " + r.rel + " (" + noteFiles().length + " open)");
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

const bash = defineTool({
  name: "bash",
  label: "Shell in the memory folder",
  description:
    "Run one bash command with the memory directory as the working directory. Use it to create, move, rename or delete folders (mkdir -p battle, mv old new, rm -rf old), list files, and check sizes. " +
    "Use read/write/edit for file contents so the caps and the notes mailbox stay enforced. Do not touch notes/ (use memory_notes and memory_note_delete) or anything outside the memory directory.",
  parameters: Type.Object({
    command: Type.String({ description: "Bash command, e.g. mkdir -p battle" }),
    timeout: Type.Optional(Type.Number({ description: "Seconds, default 20, max 120" })),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("ran");
    if (!DREAM_CHILD) return msg("[error] bash is only for the dream agent");
    const cmd = String(params.command ?? "").trim();
    if (!cmd) return msg("[error] command is empty");
    if (cmd.length > 2000) return msg("[error] command too long (2000 chars max)");
    if (/(^|[\s"'`=\/\\])\.\.($|[\s"'`\/\\;&|)])/.test(cmd)) return msg("[error] paths outside the memory dir are not allowed");
    if (/(^|[\s"'`=])(\/|~\/|\$HOME|\$\{HOME\})/.test(cmd)) return msg("[error] paths outside the memory dir are not allowed");
    if (/(^|[;&|]\s*)(cd|pushd)\s+(~|\/|-|\$HOME|\$\{HOME\})/.test(cmd)) return msg("[error] paths outside the memory dir are not allowed");
    if (/[A-Za-z]:[\\/]/.test(cmd)) return msg("[error] absolute paths are not allowed");
    if (/(^|[\s"'`/])notes([\\/]|$)/i.test(cmd)) return msg("[error] notes/ is the mailbox; use memory_notes and memory_note_delete");
    const timeoutMs = Math.max(1, Math.min(120, Number(params.timeout ?? 20))) * 1000;
    return await new Promise((resolve) => {
      execFile(BASH_PATH, ["-c", cmd], { cwd: ROOT, timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true }, (error: any, stdout: any, stderr: any) => {
        let text = String(stdout ?? "").trimEnd();
        const err = String(stderr ?? "").trimEnd();
        if (err) text += (text ? "\n" : "") + "[stderr]\n" + err;
        if (error) text += (text ? "\n" : "") + "[exit " + String(error.code ?? "?") + "] " + String(error.message ?? "");
        if (!text) text = "(no output)";
        if (text.length > 12000) text = text.slice(0, 12000) + "\n...(truncated)";
        const cap = capReport();
        if (cap) text += "\n\n[CAPS] " + cap;
        resolve(msg(text));
      });
    });
  },
});

function writeDreamEntry(prefix: string, params: any): number {
  const s = beginDream(ROOT, path.dirname(ROOT));
  const entry =
    "\n## Dream " + s.dreams + " - " + new Date().toISOString() + prefix + "\n" +
    String(params.summary ?? "") + "\n" +
    (params.corrections ? "Corrections: " + String(params.corrections) + "\n" : "");
  try {
    const logPath = path.join(path.dirname(ROOT), "DREAM.md");
    const old = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# DREAM LOG\n";
    let text = old + entry;
    if (text.length > 12000) text = "# DREAM LOG\n" + text.slice(-11000);
    fs.writeFileSync(logPath, text, "utf8");
  } catch {}
  return s.dreams;
}

// Dream-session tool: closes the pass and unblocks the playing agent.
let dreamFinished = false;
const dreamFinish = defineTool({
  name: "dream_finish",
  label: "Finish the dream pass",
  description:
    "Call this exactly once when the memory audit is finished. Records the summary in DREAM.md, resets the action and write counters and ends the dream session. " +
    "Do not call it before the corrections are written (or before you have decided that no correction is needed).",
  parameters: Type.Object({
    summary: Type.String({ description: "What the playing agent did in this block, which claims were wrong, and what you changed" }),
    corrections: Type.Optional(Type.String({ description: "Optional list of specific file edits" })),
  }),
  async execute(_id: any, params: any) {
    try {
      if (dreamFinished) {
        return { content: [{ type: "text" as const, text: "dream already finished; stop now." }], details: undefined, terminate: true };
      }
      const cap = capReport();
      if (cap) return msg("[error] memory is over caps: " + cap + ". Trim or merge files before dream_finish.");
      dreamFinished = true;
      const n = writeDreamEntry(" (separate dream agent)", params);
      const remaining = noteFiles().length;
      // Returning terminate:true only hints at the tool-call event layer and did
      // not stop the dream agent: it kept editing for minutes after finishing.
      // The dream is a child process, so end it explicitly once the files and
      // the counter are written.  A short delay lets the tool result flush.
      setTimeout(() => process.exit(0), 400);
      return {
        content: [{ type: "text" as const, text: "dream #" + n + " recorded." + (remaining ? " " + remaining + " note(s) still open in notes/; the next dream will read them." : " All notes were consumed.") + " The playing agent will read MEMORY.md before its next action." }],
        details: undefined,
        terminate: true,
      };
    } catch (e: any) {
      return msg("[error] " + e.message);
    }
  },
});

// Playing-session tool: spawns the separate dream agent and waits for it.
function runDreamAgent(reason: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const script = path.join(POKE_ROOT, "scripts", "dream_pass.ps1");
    if (!RUN_NAME) { resolve({ ok: false, text: "[error] POKE_RUN_NAME is not set; cannot start the dream agent." }); return; }
    if (!fs.existsSync(script)) { resolve({ ok: false, text: "[error] missing " + script }); return; }
    const before = loadDream(ROOT);
    const cleanReason = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 5000);
    const env = { ...process.env, POKE_DREAM_REASON: cleanReason || "scheduled or voluntary dream" };
    let out = "";
    const cap = (d: any) => { out = (out + String(d)).slice(-4000); };
    let child: any;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RunName", RUN_NAME], {
        cwd: POKE_ROOT, env, windowsHide: true,
        // pi blocks on stdin when it is a pipe that never closes, which made
        // every scheduled dream hang until the timeout killed it.  "ignore"
        // gives the child NUL, so it sees EOF immediately and starts working.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      resolve({ ok: false, text: "[error] could not start the dream agent: " + e.message });
      return;
    }
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    // A max/extra-high thinking dream can run for many minutes.  The old 15 min
    // cap killed it while it was still writing, leaving the playing agent blocked
    // and every retry starting over.  Default is 30 min, overridable.
    const timeoutMin = Math.max(5, Number(process.env.POKE_DREAM_TIMEOUT_MIN ?? "30"));
    const timer = setTimeout(() => {
      try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch {}
    }, timeoutMin * 60 * 1000);
    child.on("close", (code: number) => {
      clearTimeout(timer);
      const after = loadDream(ROOT);
      if (after.dreams <= before.dreams) {
        resolve({ ok: false, text: "[error] the dream agent did not finish (exit " + code + "); the dream is still due. Call memory_dream again to retry.\n" + out.slice(-800) });
        return;
      }
      let entry = "";
      try {
        const log = fs.readFileSync(path.join(path.dirname(ROOT), "DREAM.md"), "utf8").trim();
        entry = log.slice(-1500);
      } catch {}
      const remainingNotes = noteFiles().length;
      resolve({
        ok: true,
        text: "dream #" + after.dreams + " complete. A separate dream agent audited the action log and rewrote the memory files; you were not part of that review.\n\nLatest dream entry:\n" + entry +
          "\n\nOpen notes after the dream: " + remainingNotes + ". Read MEMORY.md before the next game action. Index rebuilt from the files it wrote:\n\n" + buildIndex(),
      });
    });
  });
}

const dream = defineTool({
  name: "memory_dream",
  label: "Run a dream pass",
  description:
    "Hand the memory audit to a separate dream agent and wait for it. Use it for a soft/hard DREAM DUE and for a voluntary dream; both run in the other agent, " +
    "which reads the action log and the notes/ mailbox and rewrites MEMORY.md / maps / TODO. You do not review or rewrite memory yourself here. " +
    "Pass reason so the dream knows why it was called, for example that you answered a TODO question. " +
    "A soft due can be deferred (for example to finish a battle); a hard due blocks poke_act / poke_program until the dream finishes.",
  parameters: Type.Object({
    reason: Type.Optional(Type.String({ description: "Optional: why you are dreaming now (scheduled, new note, answer to a TODO question). Up to 5000 chars; long batch summaries are kept." })),
  }),
  async execute(_id: any, params: any) {
    if (BLINDED) return msg("dream recorded");
    const r = await runDreamAgent(String(params.reason ?? ""));
    return msg(r.text);
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(read);
  pi.registerTool(write);
  pi.registerTool(edit);
  if (!DREAM_CHILD) {
    // 战略层不依赖 dreaming；A/B 关闭 dream 时 act 仍应能写长期计划。
    pi.registerTool(planTool);
  }
  if (DREAM_CHILD) {
    pi.registerTool(dreamFinish);
    pi.registerTool(notesRead);
    pi.registerTool(noteDelete);
    pi.registerTool(bash);
  } else if (DREAM_ENABLED) {
    pi.registerTool(dream);
    pi.registerTool(noteAdd);
  }
}
