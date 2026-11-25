/**
 * 共享的 .dream_state.json 状态机与触发策略。
 *
 * Option C：不再固定 50 个动作硬停，而是自适应触发。
 *   - softActions（默认 50）：软提醒，可以打完当前战斗或走完短路线
 *   - hardActions（默认 70）：硬上限，必须 dream
 *   - notes / noteChars / writes / new_map：信息量提前触发
 *   - sightCells：软窗口内新增 SIGHT 达到阈值时提前触发
 *   - battle：战斗内只推迟，不打断
 *   - low-info：软窗口没有新信息时允许跳过一次，下一次窗口必须 dream
 *
 * 文件 schema 向后兼容：旧 run 缺字段时用默认值；首次升级时把
 * sight_offset 基线设为当前 spatial.jsonl 大小，避免把历史格子算成新增。
 *
 * 写入方：
 * - poke_act / poke_program -> bumpAction()
 * - write / edit           -> bumpWrite()
 * 重置方：
 * - dream_finish（dream 子进程）-> beginDream()
 * - read MEMORY.md         -> markRead()
 */
import fs from "node:fs";
import path from "node:path";

export const DREAM_STATE_FILE = ".dream_state.json";

export function dreamStatePath(memoryDir) {
  return path.join(memoryDir, DREAM_STATE_FILE);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMap(v) {
  return String(v ?? "").trim().toUpperCase().replace(/\s+/g, "_");
}

function spatialSize(memoryDir) {
  try {
    const file = path.join(path.dirname(memoryDir), "spatial.jsonl");
    return fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    return 0;
  }
}

// 旧 run 没有 seen_maps 时，用 memory/maps/*.md 做种子，避免把已经写过的
// 地图重新当成“新地图”。文件名就是 STATE 里的地图名（例如 ROUTE_4.md）。
function knownMaps(memoryDir) {
  const dir = path.join(memoryDir, "maps");
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      const key = normalizeMap(e.name.replace(/\.md$/i, ""));
      if (key && !out.includes(key)) out.push(key);
    }
  } catch {}
  return out;
}

export function emptyDreamState() {
  return {
    writes: 0,
    actions: 0,
    due: false,
    dreams: 0,
    read_after_dream: true,
    // 自适应触发的新字段
    next_soft: 0,          // 下一次软提醒的动作数；跳过一轮后会推后
    skipped: 0,            // 连续低信息量跳过的次数
    last_map: "",          // 上一个动作所在地图，用于统计换图次数
    maps_since_dream: 0,   // 自上次 dream 以来的换图次数（仅统计）
    new_map: false,        // 是否进入了 memory 里还没有的新地图
    seen_maps: [],         // 已经见过的地图，跨 dream 保留
    sight_offset: 0,       // spatial.jsonl 的字节偏移，只统计 dream 之后的新格子
  };
}

function freshState(memoryDir) {
  const s = emptyDreamState();
  s.seen_maps = knownMaps(memoryDir);
  s.sight_offset = spatialSize(memoryDir);
  return s;
}

export function loadDream(memoryDir) {
  const file = dreamStatePath(memoryDir);
  try {
    if (!fs.existsSync(file)) return freshState(memoryDir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
    const seen = has("seen_maps") && Array.isArray(raw.seen_maps)
      ? raw.seen_maps.map(normalizeMap).filter(Boolean)
      : knownMaps(memoryDir);
    return {
      writes: num(raw.writes, 0),
      actions: num(raw.actions, 0),
      due: !!raw.due,
      dreams: num(raw.dreams, 0),
      read_after_dream: !!raw.read_after_dream,
      next_soft: num(raw.next_soft, 0),
      skipped: num(raw.skipped, 0),
      last_map: normalizeMap(raw.last_map),
      maps_since_dream: num(raw.maps_since_dream, 0),
      new_map: !!raw.new_map,
      seen_maps: seen,
      // 旧状态没有 offset 时，以当前文件大小为基线；否则会把整个历史 SIGHT
      // 都算成“上次 dream 之后新增”，第一次软窗口就误触发。
      sight_offset: has("sight_offset") ? num(raw.sight_offset, 0) : spatialSize(memoryDir),
    };
  } catch {
    return freshState(memoryDir);
  }
}

export function saveDream(memoryDir, state) {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(dreamStatePath(memoryDir), JSON.stringify(state), "utf8");
}

/**
 * 读取环境变量里的触发阈值。两个 agent 模块共用，避免各写一份默认值。
 */
export function dreamOptions(env = process.env) {
  // 0 表示关闭“按动作数”的触发，退回旧的“按写入数”模式。
  const softRaw = num(env.POKE_DREAM_EVERY_ACTIONS, 50);
  const soft = softRaw > 0 ? softRaw : 999999;
  const hard = Math.max(soft, num(env.POKE_DREAM_HARD_ACTIONS, 70));
  const everyWrites = Math.max(0, num(env.POKE_DREAM_EVERY, 0));
  return {
    softActions: soft,
    hardActions: hard,
    notes: Math.max(1, num(env.POKE_DREAM_NOTES, 8)),
    noteChars: Math.max(1, num(env.POKE_DREAM_NOTE_CHARS, 4000)),
    writes: Math.max(1, everyWrites > 0 ? everyWrites : num(env.POKE_DREAM_WRITES, 12)),
    sightCells: Math.max(1, num(env.POKE_DREAM_SIGHT_CELLS, 300)),
    maxSkips: Math.max(0, num(env.POKE_DREAM_MAX_SKIPS, 1)),
    newMap: env.POKE_DREAM_NEW_MAP ? env.POKE_DREAM_NEW_MAP !== "0" : true,
  };
}

/**
 * 统计 notes/ 邮箱。playing agent 每回合都会调用，文件最多 24 个，成本可接受。
 */
export function noteStats(memoryDir) {
  const dir = path.join(memoryDir, "notes");
  if (!fs.existsSync(dir)) return { count: 0, chars: 0 };
  let count = 0;
  let chars = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !/^note-\d{4}\.md$/.test(e.name)) continue;
      count += 1;
      try { chars += fs.readFileSync(path.join(dir, e.name), "utf8").length; } catch {}
    }
  } catch {}
  return { count, chars };
}

/**
 * 只统计 offset 之后新增的 SIGHT 格子（按 map+x+y 去重）。
 * 返回的 offset 指向最后一个完整行，避免读到服务器正在写的半行。
 */
export function sightCellsSince(memoryDir, offset = 0) {
  const file = path.join(path.dirname(memoryDir), "spatial.jsonl");
  if (!fs.existsSync(file)) return { cells: 0, offset: 0 };
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { cells: 0, offset: 0 }; }
  let start = Math.max(0, num(offset, 0));
  if (start > size) start = 0;
  if (start === size) return { cells: 0, offset: size };
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { cells: 0, offset: start }; }
  const text = buf.subarray(start).toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { cells: 0, offset: start };
  const complete = text.slice(0, lastNl + 1);
  const seen = new Set();
  for (const line of complete.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.kind !== "sight" || !Array.isArray(rec.cells)) continue;
      const map = rec.map ?? "?";
      for (const c of rec.cells) {
        if (!Array.isArray(c) || c.length < 2) continue;
        seen.add(map + ":" + c[0] + "," + c[1]);
      }
    } catch {}
  }
  return { cells: seen.size, offset: start + Buffer.byteLength(complete, "utf8") };
}

export function bumpAction(memoryDir, opts = {}) {
  const s = loadDream(memoryDir);
  s.actions += 1;
  const soft = Math.max(1, num(opts.softActions, 50));
  const hard = Math.max(soft, num(opts.hardActions, 70));
  if (!s.next_soft || s.next_soft <= 0) s.next_soft = soft;
  const map = normalizeMap(opts.map);
  // PALLET_TOWN (0,0) 是 warp 过程的瞬态，不算真的换图。
  const transient = map === "PALLET_TOWN" && num(opts.x, -1) === 0 && num(opts.y, -1) === 0;
  if (map && !transient) {
    if (!s.last_map) {
      s.last_map = map;
      if (!s.seen_maps.includes(map)) s.seen_maps.push(map);
    } else if (s.last_map !== map) {
      s.maps_since_dream += 1;
      s.last_map = map;
      if (!s.seen_maps.includes(map)) {
        s.seen_maps.push(map);
        s.new_map = true;
      }
    }
  }
  if (s.actions >= hard) s.due = true;
  saveDream(memoryDir, s);
  return s;
}

export function bumpWrite(memoryDir) {
  const s = loadDream(memoryDir);
  s.writes += 1;
  saveDream(memoryDir, s);
  return s;
}

export function markRead(memoryDir) {
  const s = loadDream(memoryDir);
  s.read_after_dream = true;
  saveDream(memoryDir, s);
  return s;
}

/**
 * 软窗口到期后，信息量不足时跳过一轮：把下一次软提醒推后，
 * 但不会超过硬上限。这样“最多跳过一次”不会把 hard cap 也绕过去。
 */
export function skipSoft(memoryDir, softActions, hardActions = 0) {
  const s = loadDream(memoryDir);
  s.skipped += 1;
  const step = Math.max(1, num(softActions, 50));
  const hard = Math.max(step, num(hardActions, 0) || (s.actions + step));
  s.next_soft = Math.min(s.actions + step, hard);
  saveDream(memoryDir, s);
  return s;
}

/**
 * 判断现在该不该 dream。
 * 返回 { force, skip, reason, state }：
 *   force=true  -> 拦住下一个游戏动作，要求 memory_dream
 *   skip=true   -> 本轮信息量低，允许继续，调用方应调用 skipSoft()
 *   reason      -> hard / notes / note-chars / writes / new-map / sight /
 *                  no-skip-left / battle / battle-hard / low-info / need-sight / not-due
 *
 * signals.sightCells 传 null/undefined 表示“还没算 SIGHT”，此时若软窗口已到，
 * 返回 need-sight，让调用方只在这一个时间点做一次较贵的 spatial.jsonl 解析。
 */
export function evaluateDream(memoryDir, opts = dreamOptions(), signals = {}) {
  const s = loadDream(memoryDir);
  const o = {
    softActions: Math.max(1, num(opts.softActions, 50)),
    notes: Math.max(1, num(opts.notes, 8)),
    noteChars: Math.max(1, num(opts.noteChars, 4000)),
    writes: Math.max(1, num(opts.writes, 12)),
    sightCells: Math.max(1, num(opts.sightCells, 300)),
    maxSkips: Math.max(0, num(opts.maxSkips, 1)),
    newMap: opts.newMap !== false,
  };
  o.hardActions = Math.max(o.softActions, num(opts.hardActions, 70));
  const next = s.next_soft > 0 ? s.next_soft : o.softActions;
  const battle = num(signals.battle, 0);
  const early =
    num(signals.notes, 0) >= o.notes ? "notes" :
    num(signals.noteChars, 0) >= o.noteChars ? "note-chars" :
    s.writes >= o.writes ? "writes" :
    (o.newMap && s.new_map) ? "new-map" : "";
  const hardDue = s.due || s.actions >= o.hardActions;
  const softDue = s.actions >= next;
  if (!hardDue && !early && !softDue) return { force: false, reason: "not-due", state: s };
  // 战斗内不打断：硬上限也只推迟到战斗结束。
  if (battle !== 0) return { force: false, reason: hardDue ? "battle-hard" : "battle", state: s };
  if (hardDue) return { force: true, reason: "hard", state: s };
  if (early) return { force: true, reason: early, state: s };
  if (signals.sightCells === undefined || signals.sightCells === null) {
    return { force: false, reason: "need-sight", state: s };
  }
  if (num(signals.sightCells, 0) >= o.sightCells) return { force: true, reason: "sight", state: s };
  if (s.skipped >= o.maxSkips) return { force: true, reason: "no-skip-left", state: s };
  return { force: false, reason: "low-info", skip: true, state: s };
}

export function beginDream(memoryDir, runDir) {
  const s = loadDream(memoryDir);
  s.dreams += 1;
  s.writes = 0;
  s.actions = 0;
  s.due = false;
  s.read_after_dream = false;
  s.next_soft = 0;
  s.skipped = 0;
  s.last_map = "";
  s.maps_since_dream = 0;
  s.new_map = false;
  try {
    const spatial = path.join(runDir || path.dirname(memoryDir), "spatial.jsonl");
    s.sight_offset = fs.existsSync(spatial) ? fs.statSync(spatial).size : 0;
  } catch {
    s.sight_offset = 0;
  }
  saveDream(memoryDir, s);
  return s;
}
