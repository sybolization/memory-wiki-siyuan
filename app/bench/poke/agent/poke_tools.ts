/**
 * poke_tools.ts - 游戏侧 pi 扩展。
 *
 * 工具：poke_observe / poke_act / poke_program / poke_done。
 * 观测是 RAM-first：STATE / PARTY / MENU 通过 .sym 读取，SIGHT 只记录屏幕
 * 实际显示过的格子。动作预算由 POKE_MAX_ACTIONS 控制，不向 agent 暴露剩余数量。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  bumpAction,
  dreamOptions,
  evaluateDream,
  loadDream,
  noteStats,
  sightCellsSince,
  skipSoft,
} from "../lib/dream_state.mjs";

const BASE = process.env.POKE_URL ?? "http://127.0.0.1:8765";
const MAX_ACTIONS = Number(process.env.POKE_MAX_ACTIONS ?? "0");
const MEMORY_DIR = process.env.POKE_MEMORY_DIR ?? "";
const DREAM = dreamOptions();
// 关闭 dreaming 的 A/B run（POKE_DREAM_ENABLED=0）不应该被动作门禁拦住：
// 这时 memory_tools 不注册 memory_dream，拦住只会让 agent 无路可走。
const DREAM_ENABLED = process.env.POKE_DREAM_ENABLED ? process.env.POKE_DREAM_ENABLED === "1" : true;
let actions = 0;
// 上一次动作结束时的战斗状态。null = 本进程还没观测过，按 0 处理但先查一次 /observe。
let lastBattle: number | null = null;

async function currentBattle(): Promise<number> {
  if (lastBattle !== null) return lastBattle;
  try {
    const st = await call("/observe");
    lastBattle = Number(st?.battle ?? 0);
  } catch {
    lastBattle = 0;
  }
  return lastBattle;
}

function noteSignals(): { notes: number; noteChars: number } {
  if (!MEMORY_DIR) return { notes: 0, noteChars: 0 };
  try {
    const n = noteStats(MEMORY_DIR);
    return { notes: n.count, noteChars: n.chars };
  } catch {
    return { notes: 0, noteChars: 0 };
  }
}

const DREAM_WHY: Record<string, string> = {
  notes: "the notes mailbox reached its trigger",
  "note-chars": "the notes mailbox reached its character trigger",
  writes: "you have written a lot of memory since the last dream",
  "new-map": "you entered a new map that is not in memory yet",
  sight: "you have seen many new map cells since the last dream",
  hard: "the hard action cap was reached",
  "no-skip-left": "the low-information window was already deferred once",
};

function dreamBlockText(reason: string, s: any): string {
  const why = DREAM_WHY[reason] ?? reason;
  const head = reason === "hard"
    ? "DREAM REQUIRED at " + s.actions + " game actions (hard cap " + DREAM.hardActions + "): " + why + "."
    : reason === "no-skip-left"
      ? "DREAM REQUIRED at " + s.actions + " game actions: " + why + "."
      : "DREAM DUE at " + s.actions + " game actions: " + why + ".";
  return "[dream] " + head + " Call memory_dream now. A separate dream agent (no game tools) audits the action log and rewrites MEMORY.md and the map files; you do not review memory yourself. No game action was taken.";
}

async function dreamGate(): Promise<{ block: boolean; note: string }> {
  if (!MEMORY_DIR || !DREAM_ENABLED) return { block: false, note: "" };
  const s = loadDream(MEMORY_DIR);
  const ns = noteSignals();
  // 先做便宜的探测（notes / writes / new map / 动作数）。SIGHT 解析只在
  // 软窗口真正到期时做一次，避免每个动作都重扫 spatial.jsonl。
  const probe = evaluateDream(MEMORY_DIR, DREAM, {
    battle: 0, notes: ns.notes, noteChars: ns.noteChars, sightCells: null,
  });
  if (probe.reason === "not-due") return { block: false, note: "" };
  const battle = await currentBattle();
  let ev = evaluateDream(MEMORY_DIR, DREAM, {
    battle, notes: ns.notes, noteChars: ns.noteChars, sightCells: null,
  });
  if (ev.reason === "need-sight") {
    const sight = sightCellsSince(MEMORY_DIR, s.sight_offset).cells;
    ev = evaluateDream(MEMORY_DIR, DREAM, {
      battle, notes: ns.notes, noteChars: ns.noteChars, sightCells: sight,
    });
  }
  if (ev.force) return { block: true, note: dreamBlockText(ev.reason, ev.state) };
  if (ev.skip) {
    const skipped = skipSoft(MEMORY_DIR, DREAM.softActions, DREAM.hardActions);
    return {
      block: false,
      note: "[dream] low-info window: no new notes, memory writes, map or SIGHT since the last dream. Deferred once; next soft check at " + skipped.next_soft + " actions, hard stop at " + DREAM.hardActions + ".",
    };
  }
  if (ev.reason === "battle-hard") {
    return { block: false, note: "[dream] hard cap reached, but you are in a battle. Finish it, then call memory_dream before the next field action." };
  }
  // reason === "battle"：只推迟，不打断，也不每回合重复提示。
  return { block: false, note: "" };
}

function noteAction(st: any): any {
  if (!MEMORY_DIR || !DREAM_ENABLED) return null;
  return bumpAction(MEMORY_DIR, { ...DREAM, map: st?.map ?? "", x: st?.x, y: st?.y });
}

function dreamHint(s: any): string {
  if (!s || !DREAM_ENABLED) return "";
  if (s.due || s.actions >= DREAM.hardActions) {
    return "[dream] HARD DUE at " + s.actions + " actions. Call memory_dream before the next game action.";
  }
  if (s.new_map) {
    return "[dream] new map entered. Call memory_dream after this result so the dream can record it; the hard cap is " + DREAM.hardActions + " actions.";
  }
  if (s.actions === s.next_soft) {
    return "[dream] soft due at " + s.actions + " actions. You may finish the current fight or route, but call memory_dream before the hard cap (" + DREAM.hardActions + " actions).";
  }
  return "";
}

async function call(path: string, init?: any): Promise<any> {
  const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error("poke server " + res.status + ": " + (await res.text()).slice(0, 300));
  return res.json();
}

async function screen(): Promise<any> {
  const res = await fetch(BASE + "/screen.png?t=" + Date.now());
  if (!res.ok) throw new Error("screen " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return { type: "image", data: buf.toString("base64"), mimeType: "image/png" };
}

function describe(did: any): string {
  const parts: string[] = [];
  if (did.auto_advance) parts.push("dialogue auto-advanced x" + did.auto_advance);
  if (typeof did.changed === "number") {
    if (did.changed < 0.005) parts.push("the screen did not change - that press had no visible effect, try something else");
    else parts.push("screen changed " + Math.round(did.changed * 100) + "%");
  }
  return parts.join("; ");
}

function stateText(st: any): string {
  if (!st) return "";
  const badges = Array.isArray(st.badges) ? JSON.stringify(st.badges) : "?";
  const lines = [
    "STATE " + (st.map ?? "?") + " (" + (st.x ?? "?") + "," + (st.y ?? "?") + ")" +
      " badges=" + badges + " party=" + (st.party_count ?? "?") +
      (st.battle ? (Number(st.battle) === 2 ? " BATTLE(trainer)" : " BATTLE(wild)") : "") +
      " (x,y are 16px blocks)",
    "LOCAL VIEW (10x9 blocks of 16px; offsets from you: . floor , grass # wall D door N person ? hidden by a text box)",
  ];
  if (Array.isArray(st.party) && st.party.length) {
    const p = st.party.map((m: any) =>
      "#" + m.species + " L" + m.level + " " + m.hp + "hp" +
      (m.status ? " " + m.status : "")
    );
    lines.push("PARTY: " + p.join(" | "));
  }
  if (Array.isArray(st.map_view)) lines.push(...st.map_view);
  const menu = menuBlock(st);
  return lines.join("\n") + (menu ? "\n" + menu : "");
}

function traceText(trace: any, samples: any): string {
  if (!Array.isArray(trace) || !trace.length) return "";
  return "SIGHT DURING THIS ACTION (" + (samples ?? "?") + " screen samples stitched; only what the game showed; offsets from you)\n" +
    "S start @ you . floor , grass # wall D door N person x blocked attempt ? hidden; blank = not seen\n" +
    trace.join("\n");
}

function menuBlock(st: any): string {
  const m = st?.menu;
  if (!m || typeof m.row !== "number" || !st?.screen) return "";
  const lines = String(st.screen).split(/\r?\n/);
  if (m.row < 0 || m.row >= lines.length) return "";
  const from = Math.max(0, m.row - 3);
  const to = Math.min(lines.length - 1, m.row + 3);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    let line = lines[i].replace(/\s+$/, "");
    if (i === m.row && typeof m.col === "number") {
      const col = Math.max(0, Math.min(m.col, line.length - 1));
      line = line.slice(0, col) + ">" + line.slice(col + 1);
    }
    out.push("  " + line);
  }
  return "MENU (row " + m.row + (typeof m.col === "number" ? ", col " + m.col : "") + "):\n" + out.join("\n");
}

function memoryTag(): string {
  if (!MEMORY_DIR) return "";
  const s = loadDream(MEMORY_DIR);
  if (Number(s.dreams ?? 0) > 0 && !s.read_after_dream) {
    return "[memory] MEMORY NOT RE-READ SINCE DREAM #" + Number(s.dreams) +
      ": call read MEMORY.md and check the rewritten notes before relying on them. This notice clears after that read.";
  }
  return "";
}

function planTag(): string {
  if (!MEMORY_DIR) return "";
  try {
    const p = path.join(MEMORY_DIR, "TODO.md");
    if (!fs.existsSync(p)) return "";
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s+PLAN\b/i.test(l.trim()));
    if (start < 0) return "";
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i].trim())) { end = i; break; }
    }
    const block = lines.slice(start + 1, end).map((l) => l.trim()).filter(Boolean);
    if (!block.length) return "";
    const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 3) + "..." : s;
    const goal = block.find((l) => /^>\s*goal:/i.test(l));
    const steps = block.filter((l) => /^\d+\.\s+/.test(l)).slice(0, 3).map((l) => clip(l, 140));
    const head = clip(goal ? goal.replace(/^>\s*goal:\s*/i, "") : block[0], 160);
    return "PLAN memory/TODO.md: " + head + (steps.length ? "\n" + steps.join("\n") : "");
  } catch {
    return "";
  }
}

function todoTag(): string {
  if (!MEMORY_DIR) return "";
  try {
    const p = path.join(MEMORY_DIR, "TODO.md");
    if (!fs.existsSync(p)) return "";
    const items = fs.readFileSync(p, "utf8").split(/\r?\n/)
      .filter((l) => /^\s*[-*]\s+\[[ xX]\]/.test(l))
      .map((l) => l.trim());
    if (!items.length) return "";
    const open = items.filter((l) => /\[ \]/.test(l)).length;
    const pick: string[] = [];
    for (const l of items) if (/\[ \]/.test(l) && pick.length < 6) pick.push(l);
    for (const l of items) if (/\[[xX]\]/.test(l) && pick.length < 6) pick.push(l);
    const more = items.length > pick.length ? "\n(+" + (items.length - pick.length) + " more; read TODO.md)" : "";
    return "TODO memory/TODO.md " + open + "/" + items.length + " open\n" + pick.join("\n") + more;
  } catch {
    return "";
  }
}

function tags(): string {
  return [memoryTag(), planTag(), todoTag()].filter(Boolean).join("\n\n");
}

const observe = defineTool({
  name: "poke_observe",
  label: "Look at the screen",
  description: "Take a fresh screenshot plus current map/coords/local collision view. This is your only view of the game.",
  parameters: Type.Object({}),
  async execute() {
    const [img, st] = await Promise.all([screen(), call("/observe")]);
    const tag = tags();
    return { content: [img, { type: "text", text: stateText(st) + (tag ? "\n\n" + tag : "") }], details: undefined };
  },
});

const act = defineTool({
  name: "poke_act",
  label: "Press a button",
  description: "Press one Game Boy button and return the resulting screen. button: up/down/left/right/a/b/start/select. A d-pad press moves one 16px block (16 frames); pass frames to hold longer. The game keeps playing after the press until it needs a decision from you, so a battle turn resolves inside one call.",
  parameters: Type.Object({
    button: Type.String({ description: "up, down, left, right, a, b, start or select" }),
    frames: Type.Optional(Type.Number({ description: "Hold duration in frames (default: 16 for a d-pad block, 24 for other buttons)" })),
  }),
  async execute(_id: any, params: any) {
    const gate = await dreamGate();
    if (gate.block) return { content: [{ type: "text", text: gate.note }], details: undefined };
    actions += 1;
    if (MAX_ACTIONS > 0 && actions > MAX_ACTIONS) {
      return { content: [{ type: "text", text: "[budget] action budget exhausted. Call poke_done with your summary now." }], details: undefined };
    }
    const dir = ["up", "down", "left", "right"].includes(String(params.button).toLowerCase());
    const body = { button: params.button, frames: params.frames ?? (dir ? 16 : 24) };
    const res = await call("/act", { method: "POST", body: JSON.stringify(body) });
    const did = res.did ?? {};
    const note = describe(did);
    lastBattle = Number(res.state?.battle ?? 0);
    const due = noteAction(res.state);
    const hint = dreamHint(due);
    const tag = tags();
    const sight = traceText(res.trace, res.samples);
    return {
      content: [
        await screen(),
        ...(note ? [{ type: "text", text: note }] : []),
        ...(sight ? [{ type: "text", text: sight }] : []),
        ...(res.state ? [{ type: "text", text: stateText(res.state) }] : []),
        ...(gate.note ? [{ type: "text", text: gate.note }] : []),
        ...(hint ? [{ type: "text", text: hint }] : []),
        ...(tag ? [{ type: "text", text: tag }] : []),
      ],
      details: { button: body.button, frames: body.frames },
    };
  },
});

const program = defineTool({
  name: "poke_program",
  label: "Run an action script",
  description:
    "Run a script of Game Boy actions in one turn and see the result. Tokens are separated by ';' or newlines.\n" +
    "  up / down / left / right   one 16px block (16 frames)\n" +
    "  up:40                      hold that direction 40 frames (can cross several blocks)\n" +
    "  up!                        keep walking one block at a time until blocked (max 10 blocks)\n" +
    "  up!6                       same, at most 6 blocks\n" +
    "  Only a token with '!' walks until the world answers and can report 'blocked'; a bare direction press (or dir:N) is a single press and reports 'pressed' even when the step was refused.\n" +
    "  a / b / start / select     press a button (A also auto-advances the rest of a dialogue)\n" +
    "  wait:60                    let 60 frames pass (auto-advances a dialogue that is waiting for A)\n" +
    "BATTLE: a plan that starts inside a battle runs every token, and each token ends at the next decision point, so battle text is cleared automatically. \"a\" picks FIGHT (then the first move), \"down;down;a\" navigates the move list, \"b;b\" backs out. A turn is usually \"a\" once the cursor is on the move you want.\n" +
    "FIELD: a plan that starts in the field stops at the first wild or trainer battle, because the rest of the script was written for walking.\n" +
    "Example: \"up!;a;a;right!4;down!\". Returns the final screenshot, one log line per step (blocks moved, why it stopped, map, position), a SIGHT map stitched from every screen the game showed during the script (terrain, doors and people, not just the path), and the current map/coords/local view.",
  parameters: Type.Object({
    plan: Type.String({ description: "Script text, e.g. 'up!;a;a;right!4'" }),
  }),
  async execute(_id: any, params: any) {
    const gate = await dreamGate();
    if (gate.block) return { content: [{ type: "text", text: gate.note }], details: undefined };
    actions += 1;
    if (MAX_ACTIONS > 0 && actions > MAX_ACTIONS) {
      return { content: [{ type: "text", text: "[budget] action budget exhausted. Call poke_done with your summary now." }], details: undefined };
    }
    const res = await call("/program", { method: "POST", body: JSON.stringify({ plan: params.plan }) });
    const log = (res.log ?? [])
      .map((s: any) => {
        const head = "#" + s.step + " " + s.button + " " + s.outcome +
          (s.tiles ? " " + s.tiles + " blocks" : "") +
          (s.auto_advance ? " (dialogue advanced x" + s.auto_advance + ")" : "") +
          (typeof s.changed === "number" && s.changed < 0.005 ? " [screen unchanged]" : "");
        return head + " -> " + (s.map ?? "?") + " (" + ((s.pos ?? []).join(",")) + ")";
      })
      .join("\n");
    const body = [log || "script finished"];
    const sight = traceText(res.trace, res.samples);
    if (sight) body.push(sight);
    if (res.state) body.push(stateText(res.state));
    lastBattle = Number(res.state?.battle ?? 0);
    const due = noteAction(res.state);
    if (gate.note) body.push(gate.note);
    const hint = dreamHint(due);
    if (hint) body.push(hint);
    const tag = tags();
    if (tag) body.push(tag);
    return { content: [await screen(), { type: "text", text: body.join("\n\n") }], details: undefined };
  },
});

const done = defineTool({
  name: "poke_done",
  label: "Finish episode",
  description: "Call this when the episode is over or your action budget is spent. Summarize what you did and what you learned that is worth remembering.",
  parameters: Type.Object({ summary: Type.String({ description: "What you did and what you learned" }) }),
  async execute(_id: any, params: any) {
    return { content: [{ type: "text", text: "episode finished: " + params.summary }], details: undefined, terminate: true };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(observe);
  pi.registerTool(act);
  pi.registerTool(program);
  pi.registerTool(done);
}