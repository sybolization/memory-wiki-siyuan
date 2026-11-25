/**
 * map_view.mjs - fog-of-war view with ROM terrain.
 *
 * 旧的 explored_map 扩展迁到这里后，agent/explored_map_tool.ts 和
 * tools/render_working.mjs 共用同一份渲染逻辑，tools 不再反向依赖 agent。
 *
 * The playing agent only knows which cells the game has shown it.  The
 * structured SIGHT records in spatial.jsonl are that seen mask.  For every
 * seen cell this module overlays the game's own terrain from
 * runs/<run>/terrain/<MAP>.json, decoded by core/terrain.py from the ROM block
 * map plus the tileset collision table.  That fixes camera-stitching errors: a
 * corridor the player walked through is drawn from collision data, not from a
 * possibly misaligned screenshot.
 *
 * Terrain never reveals a cell: only cells already in the SIGHT mask are
 * drawn, and a blank cell still means "never seen", not "floor".  A map with
 * no terrain sidecar yet (different tileset, older run) falls back to the
 * evidence-count view built from SIGHT alone.
 */
import fs from "node:fs";
import path from "node:path";

// Terrain is decided by evidence counts, not by a last-write-wins priority.
// A wall observation used to overwrite every earlier floor observation for
// the same tile, so one misaligned stitched screen could seal a corridor the
// player had already walked through.  A person 'N' is floor (the person moves,
// the tile does not); a refused step 'x' is not terrain evidence at all.
function decideCell(e) {
  if (e.ladder > 0) return "D";
  if (e.stand > 0) return ".";
  // A tie stays wall: never invent a passage from a single ambiguous screen.
  if (e.floor > 0 && e.wall > 0) return e.floor > e.wall ? "." : "#";
  if (e.floor > 0) return ".";
  if (e.wall > 0) return "#";
  return e.ch || "?";
}
const DIRS = [
  ["up", 0, -1],
  ["right", 1, 0],
  ["down", 0, 1],
  ["left", -1, 0],
];

function key(x, y) {
  return x + "," + y;
}

function validCell(c) {
  return Array.isArray(c) && c.length >= 3
    && Number.isInteger(Number(c[0])) && Number.isInteger(Number(c[1]))
    && typeof c[2] === "string";
}

function normalize(ch) {
  // @ and S are the player/start markers, both drawn on a floor tile.
  if (ch === "@" || ch === "S") return ".";
  return ch;
}

function validPos(p) {
  return Array.isArray(p) && p.length >= 2
    && Number.isInteger(Number(p[0])) && Number.isInteger(Number(p[1]));
}

function zeroPos(p) {
  return validPos(p) && Number(p[0]) === 0 && Number(p[1]) === 0;
}

export function resolveRunDir(env = process.env) {
  if (env.POKE_DREAM_READ_DIR) return env.POKE_DREAM_READ_DIR;
  if (env.POKE_RUN_NAME && env.POKE_ROOT) {
    return path.join(env.POKE_ROOT, "runs", env.POKE_RUN_NAME);
  }
  if (env.POKE_MEMORY_DIR) return path.dirname(env.POKE_MEMORY_DIR);
  return null;
}

/**
 * Load spatial.jsonl and merge every SIGHT observation into one cell map per
 * game map.  Later observations win where the game's own view updated a tile;
 * plain floor clears an older person/refused marker, as in ActionTrace.
 */
export function loadSight(runDir) {
  const file = path.join(runDir, "spatial.jsonl");
  const maps = new Map();
  let records = 0;
  let lastMap = null;
  let error = null;
  if (!fs.existsSync(file)) {
    return { maps, records, lastMap, file, error: "missing " + file };
  }
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { maps, records, lastMap, file, error: String(e.message || e) };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec.map !== "string" || !rec.map || !Array.isArray(rec.cells)) continue;
    // Old server builds could log a warp transient as PALLET_TOWN (0,0): the
    // map id and coordinates were read for one frame before the warp committed.
    // No real action can start and end at (0,0), so drop that record from the
    // view without rewriting the append-only log.
    if (Number(rec.map_id) === 0 && zeroPos(rec.start) && zeroPos(rec.end)) continue;
    const map = rec.map;
    let m = maps.get(map);
    if (!m) {
      m = { cells: new Map(), last: null, records: 0, lastT: 0 };
      maps.set(map, m);
    }
    let placed = 0;
    const t = Number(rec.t) || 0;
    for (const c of rec.cells) {
      if (!validCell(c)) continue;
      const x = Number(c[0]);
      const y = Number(c[1]);
      let ch = normalize(c[2]);
      // '?' means covered by a text box: the game is explicitly telling us
      // that this cell was not seen.  Never turn it into terrain.
      if (ch === "?") continue;
      // 'x' is a refused step, not a terrain observation.  The refused
      // direction is already in actions.jsonl; drawing it would invent a
      // feature the map convention says not to show.
      if (ch === "x") continue;
      const k = key(x, y);
      let e = m.cells.get(k);
      if (!e) {
        e = { ch: "?", t: 0, floor: 0, wall: 0, ladder: 0, stand: 0 };
        m.cells.set(k, e);
      }
      if (ch === "D") e.ladder++;
      else if (ch === "#") e.wall++;
      else if (ch === "." || ch === "," || ch === "N") e.floor++;
      else continue;
      if (t >= e.t) e.t = t;
      e.ch = decideCell(e);
      placed++;
    }
    // A position the player actually occupied is hard floor evidence.  It
    // also covers a tile the player stepped on immediately before a warp,
    // where no SIGHT record of that map may exist.
    for (const p of [rec.start, rec.end]) {
      if (!validPos(p)) continue;
      const k = key(Number(p[0]), Number(p[1]));
      let e = m.cells.get(k);
      if (!e) {
        e = { ch: "?", t: 0, floor: 0, wall: 0, ladder: 0, stand: 0 };
        m.cells.set(k, e);
      }
      e.stand++;
      if (t >= e.t) e.t = t;
      e.ch = decideCell(e);
    }
    if (placed > 0) {
      records++;
      m.records++;
      m.lastT = Math.max(m.lastT, t);
      lastMap = map;
    }
    if (validPos(rec.end)) {
      m.last = [Number(rec.end[0]), Number(rec.end[1])];
      lastMap = map;
    }
  }
  return { maps, records, lastMap, file, error };
}

/**
 * Load the ROM terrain sidecar for one map.  It contains the full map, but the
 * caller must only draw the cells that are also present in the SIGHT mask.
 */
export function loadTerrain(runDir, mapName) {
  const file = path.join(runDir, "terrain", mapName + ".json");
  const empty = { cells: new Map(), file, width: 0, height: 0, error: null };
  if (!fs.existsSync(file)) {
    return { ...empty, error: "missing " + file };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const cells = new Map();
    for (const c of data.cells || []) {
      if (!validCell(c)) continue;
      cells.set(key(Number(c[0]), Number(c[1])), c[2]);
    }
    return {
      cells,
      file,
      width: Number(data.width) || 0,
      height: Number(data.height) || 0,
      tileset: data.tileset,
      source: data.source,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: String(e.message || e) };
  }
}

/**
 * Replace the guessed SIGHT character of every seen cell with the ROM terrain
 * at that coordinate.  Seen cells outside the ROM map are camera jitter, not
 * real terrain, so they are dropped rather than drawn as phantom walls.
 */
function applyTerrain(map, terrain) {
  if (!terrain.cells.size) return { map, terrain: null };
  const cells = new Map();
  for (const [k, e] of map.cells) {
    const ch = terrain.cells.get(k);
    if (ch === undefined) continue;
    // The player's own RAM position is hard evidence that the cell is
    // standable.  Gen 1 ledges, warp tiles and scripted tiles can be marked
    // non-walkable in the collision table even though the player stepped on
    // or jumped over them.  Never draw a cell the player actually occupied
    // as a wall; keep the SIGHT floor instead.
    const final = ch === "#" && e.stand > 0 ? "." : ch;
    cells.set(k, { ...e, ch: final });
  }
  return { map: { ...map, cells }, terrain };
}

function walkable(ch) {
  return ch === "." || ch === ",";
}

function bfs(cells, start) {
  const dist = new Map();
  if (!start) return dist;
  const [sx, sy] = start;
  const sk = key(sx, sy);
  const startWalk = cells.has(sk) && walkable(cells.get(sk).ch);
  dist.set(sk, 0);
  const q = [[sx, sy]];
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    const d = dist.get(key(x, y));
    for (const [, dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nk = key(nx, ny);
      if (dist.has(nk)) continue;
      const c = cells.get(nk);
      if (!c || !walkable(c.ch)) continue;
      dist.set(nk, d + 1);
      q.push([nx, ny]);
    }
  }
  if (!startWalk) {
    // If the player is standing on a door/person marker, the four adjacent
    // floor tiles are the first reachable steps.
    for (const [, dx, dy] of DIRS) {
      const nk = key(sx + dx, sy + dy);
      if (cells.has(nk) && walkable(cells.get(nk).ch) && !dist.has(nk)) {
        dist.set(nk, 1);
        q.push([sx + dx, sy + dy]);
      }
    }
    // Re-run the queue over those seeds.
    for (let i = 1; i < q.length; i++) {
      const [x, y] = q[i];
      const d = dist.get(key(x, y));
      for (const [, dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        const nk = key(nx, ny);
        if (dist.has(nk)) continue;
        const c = cells.get(nk);
        if (!c || !walkable(c.ch)) continue;
        dist.set(nk, d + 1);
        q.push([nx, ny]);
      }
    }
  }
  return dist;
}

function fmt(n) {
  return (n >= 0 ? "+" : "") + n;
}

// Fog-of-war presentation: floor, wall, ladder/warp, player.  People are
// drawn as the floor they stand on; grass is floor; refused attempts and
// text-box holes stay blank because their underlying tile is not known.
// 'D' is the game's warp tile marker; in the cave maps used here those are
// ladders/holes, so it is shown as 'L'.
function fogChar(ch) {
  if (ch === "#") return "#";
  if (ch === "D") return "L";
  // A person stands on a walkable tile, but the person itself is not drawn.
  if (ch === "." || ch === "," || ch === "@" || ch === "S" || ch === "N") return ".";
  return " ";
}

function drawWindow(map, center, radius) {
  const [cx, cy] = center;
  const xs = [];
  for (let x = cx - radius; x <= cx + radius; x++) xs.push(x);
  const header = "     " + xs.map((x) => fmt(x - cx).padStart(3)).join("");
  const rows = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    let line = fmt(y - cy).padStart(3) + "  ";
    for (const x of xs) {
      const c = map.cells.get(key(x, y));
      let ch = c ? fogChar(c.ch) : " ";
      if (x === cx && y === cy) ch = "@";
      line += (ch.length === 1 ? " " + ch + " " : ch.slice(0, 3));
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return [header, ...rows];
}

function chunkIndex(map, size = 12) {
  const chunks = new Map();
  for (const [k, c] of map.cells) {
    const [x, y] = k.split(",").map(Number);
    const ox = Math.floor(x / size) * size;
    const oy = Math.floor(y / size) * size;
    const id = ox + "," + oy;
    let ch = chunks.get(id);
    if (!ch) {
      ch = { ox, oy, n: 0, minx: x, maxx: x, miny: y, maxy: y, sx: 0, sy: 0 };
      chunks.set(id, ch);
    }
    ch.n++;
    ch.minx = Math.min(ch.minx, x);
    ch.maxx = Math.max(ch.maxx, x);
    ch.miny = Math.min(ch.miny, y);
    ch.maxy = Math.max(ch.maxy, y);
    ch.sx += x;
    ch.sy += y;
    // Keep one real seen cell near the mean for a useful center= argument.
    ch.cells = ch.cells || [];
    ch.cells.push([x, y]);
  }
  const out = [...chunks.values()].map((ch) => {
    const mx = ch.sx / ch.n;
    const my = ch.sy / ch.n;
    let best = ch.cells[0];
    let bestD = Infinity;
    for (const p of ch.cells) {
      const d = Math.abs(p[0] - mx) + Math.abs(p[1] - my);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return { ...ch, center: best, cells: undefined };
  });
  out.sort((a, b) => a.oy - b.oy || a.ox - b.ox);
  return out;
}

function frontierEdges(map, center, limit, bounds = null) {
  const [cx, cy] = center;
  const dist = bfs(map.cells, center);
  const out = [];
  const b = bounds || { minx: cx, maxx: cx, miny: cy, maxy: cy };
  for (let y = b.miny; y <= b.maxy; y++) {
    for (let x = b.minx; x <= b.maxx; x++) {
      const c = map.cells.get(key(x, y));
      if (!c || !walkable(c.ch)) continue;
      const d = dist.has(key(x, y)) ? dist.get(key(x, y)) : null;
      for (const [dir, dx, dy] of DIRS) {
        const nk = key(x + dx, y + dy);
        if (map.cells.has(nk)) continue;
        out.push({ x, y, dir, d });
      }
    }
  }
  out.sort((a, b) => {
    const ad = a.d == null ? 1e9 : a.d;
    const bd = b.d == null ? 1e9 : b.d;
    if (ad !== bd) return ad - bd;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
  return { total: out.length, shown: out.slice(0, limit) };
}

function boundsOf(map) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const k of map.cells.keys()) {
    const [x, y] = k.split(",").map(Number);
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    miny = Math.min(miny, y);
    maxy = Math.max(maxy, y);
  }
  return { minx, maxx, miny, maxy };
}

function drawAbsolute(map, bounds, center) {
  const { minx, maxx, miny, maxy } = bounds;
  const xs = [];
  for (let x = minx; x <= maxx; x++) xs.push(x);
  const header = "     " + xs.map((x) => String(x).padStart(3)).join("");
  const rows = [];
  for (let y = miny; y <= maxy; y++) {
    let line = String(y).padStart(3) + "  ";
    for (const x of xs) {
      const c = map.cells.get(key(x, y));
      let ch = c ? fogChar(c.ch) : " ";
      if (center && x === center[0] && y === center[1]) ch = "@";
      line += (ch.length === 1 ? " " + ch + " " : ch.slice(0, 3));
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return [header, ...rows];
}

export function viewExplored(runDir, opts = {}) {
  const loaded = loadSight(runDir);
  const { maps, records, lastMap, file, error } = loaded;
  if (!maps.size) {
    return [
      "EXPLORED MAP: no SIGHT history yet.",
      "file: " + file,
      error ? "(" + error + ")" : "(run an action first; the emulator server records SIGHT after each action)",
    ].join("\n");
  }

  // The live RAM position is authoritative for the map you are standing on.
  // The SIGHT ledger is written after an action, so it can be one action
  // behind; using its last record as '@' made the working map look stale
  // during map-change readout glitches (for example a one-frame PALLET_TOWN).
  const live = opts.live && typeof opts.live === "object" ? opts.live : null;
  const liveMap = live && typeof live.map === "string" && live.map ? live.map : null;
  const liveX = live == null ? NaN : Number(live.x);
  const liveY = live == null ? NaN : Number(live.y);
  const livePos = Number.isFinite(liveX) && Number.isFinite(liveY) ? [liveX, liveY] : null;
  const sameMap = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

  const want = String(opts.map ?? "current").trim();
  if (want.toLowerCase() === "all" || want.toLowerCase() === "summary") {
    const names = [...maps.keys()].sort((a, b) => maps.get(b).lastT - maps.get(a).lastT || a.localeCompare(b));
    const lines = [
      "EXPLORED MAP SUMMARY (SIGHT seen mask + ROM terrain sidecars; no global map, no inferred blocks)",
      "current: " + (liveMap ?? lastMap ?? "?"),
      "live: " + (liveMap ? liveMap + (livePos ? " (" + livePos[0] + "," + livePos[1] + ")" : "") : "(server state unavailable)"),
      "maps: " + maps.size + "  SIGHT records: " + records,
    ];
    for (const name of names) {
      const m = maps.get(name);
      const pos = m.last ? "(" + m.last[0] + "," + m.last[1] + ")" : "?";
      const terrain = loadTerrain(runDir, name);
      // With a terrain sidecar, cells outside the ROM map are camera jitter and
      // are not drawn; show the clipped count so it matches the full view.
      let seen = m.cells.size;
      let dropped = 0;
      if (terrain.cells.size) {
        let n = 0;
        for (const k of m.cells.keys()) if (terrain.cells.has(k)) n++;
        dropped = m.cells.size - n;
        seen = n;
      }
      lines.push("  " + name.padEnd(24) + " seen=" + String(seen).padStart(4) +
        " last=" + pos + " records=" + m.records +
        " terrain=" + (terrain.cells.size ? "rom" : "sight") +
        (dropped ? " jitter=" + dropped : ""));
    }
    lines.push("Use explored_map(map=\"NAME\") for a local window around that map's last seen position.");
    return lines.join("\n");
  }

  let name = want;
  if (want.toLowerCase() === "current") name = liveMap ?? lastMap;
  if (!name) name = liveMap ?? lastMap;
  let map = maps.get(name);
  if (!map) {
    const ci = [...maps.keys()].find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (ci) {
      name = ci;
      map = maps.get(ci);
    }
  }
  if (!map && sameMap(name, liveMap)) {
    return [
      "FOG MAP " + liveMap + " @ (" + (livePos ? livePos.join(",") : "?") + ")  |  no SIGHT cells recorded yet",
      "live position comes from RAM; the next action will add this map's first SIGHT record.",
    ].join("\n");
  }
  if (!map) {
    return "EXPLORED MAP: unknown map '" + want + "'.\nknown maps: " +
      [...maps.keys()].sort().join(", ");
  }
  // ROM terrain replaces the guessed SIGHT char, but only for cells already
  // in the seen mask; applyTerrain never adds a cell.
  const overlay = applyTerrain(map, loadTerrain(runDir, name));
  map = overlay.map;
  const terrain = overlay.terrain;
  // Only use the live position when the requested map is the map being
  // played.  Looking back at another floor still uses that floor's last
  // recorded position.
  let center = sameMap(name, liveMap) && livePos ? livePos : map.last;
  if (typeof opts.center === "string" && opts.center.trim()) {
    const m = opts.center.trim().match(/^\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?$/);
    if (!m) return "EXPLORED MAP: center must be 'x,y', for example center=\"37,19\".";
    center = [Number(m[1]), Number(m[2])];
  }
  if (!center) {
    return "EXPLORED MAP " + name + ": SIGHT cells exist but no final position was recorded.";
  }
  const radius = Math.max(1, Math.min(12, Number(opts.radius ?? 6) || 6));
  const limit = Math.max(0, Math.min(40, Number(opts.edges ?? 12)));
  const [cx, cy] = center;
  const full = !!opts.full;
  const bounds = full ? boundsOf(map) : {
    minx: cx - radius, maxx: cx + radius,
    miny: cy - radius, maxy: cy + radius,
  };
  const lines = [];
  // Tell the agent whether this view is using ROM terrain or SIGHT-only
  // fallback.  Terrain never adds cells: it only replaces the guessed char of
  // cells already in the seen mask.
  const terrainNote = terrain
    ? "terrain: ROM <MAP>_Blocks + tileset collision (SIGHT only marks seen cells; blank = never seen)"
    : "terrain: SIGHT-only (no ROM sidecar for this map; # may include camera-stitch errors)";
  if (full) {
    lines.push(
      "FOG MAP " + name + " @ (" + cx + "," + cy + ")  |  FULL explored map: seen=" +
        map.cells.size + " blocks, SIGHT records=" + map.records,
      "extent x=" + bounds.minx + ".." + bounds.maxx + " y=" + bounds.miny + ".." + bounds.maxy +
        "  (the x/y axes grow as new SIGHT cells appear)",
      "absolute axes: x right, y down. Only 16px blocks that have appeared on screen are drawn; blank = never seen; no inferred blocks.",
      "# wall  L ladder/warp  . seen floor  @ current/center",
      terrainNote,
      ...drawAbsolute(map, bounds, center),
    );
  } else {
    lines.push(
      "FOG MAP " + name + " @ (" + cx + "," + cy + ")  |  seen=" + map.cells.size +
        " blocks, SIGHT records=" + map.records + ", radius=" + radius,
      "window x=" + (cx - radius) + ".." + (cx + radius) + " y=" + (cy - radius) + ".." + (cy + radius) +
        "  (the offsets below are relative to @; add the center to get absolute (x,y))",
      "# wall  L ladder/warp  . seen floor  @ you  blank = never seen; no other features are drawn",
      terrainNote,
      ...drawWindow(map, center, radius),
    );
  }
  if (limit > 0) {
    const f = frontierEdges(map, center, limit, bounds);
    lines.push("", "UNEXPLORED BOUNDARY (seen floor beside never-seen cells; entries only, not map facts)");
    if (!f.total) {
      lines.push("  (none in this view)");
    } else {
      for (const e of f.shown) {
        const d = e.d == null ? "?" : String(e.d);
        lines.push("  d=" + d.padEnd(2) + " (" + e.x + "," + e.y + ") " + e.dir + " -> " + e.dir + "!");
      }
      if (f.total > f.shown.length) {
        lines.push("  (+" + (f.total - f.shown.length) + " more in this view)");
      }
    }
  }
  // Even with a full map, keep a coordinate index so a long map can be
  // addressed by absolute chunk centers and compared with the agent's (x,y).
  const chunks = chunkIndex(map, 12);
  lines.push("", "EXPLORED CHUNKS (12x12; absolute coordinate ranges; only seen cells are counted)");
  if (!chunks.length) {
    lines.push("  (none)");
  } else {
    for (const ch of chunks.slice(0, 24)) {
      lines.push("  x=" + ch.minx + ".." + ch.maxx + " y=" + ch.miny + ".." + ch.maxy +
        "  seen=" + ch.n + "  center=(" + ch.center[0] + "," + ch.center[1] + ")");
    }
    if (chunks.length > 24) lines.push("  (+" + (chunks.length - 24) + " more chunks)");
  }
  const otherMaps = [...maps.entries()]
    .filter(([n]) => n !== name)
    .sort((a, b) => b[1].lastT - a[1].lastT)
    .slice(0, 8)
    .map(([n, m]) => n + " seen=" + m.cells.size + " last=(" + (m.last ? m.last.join(",") : "?") + ")");
  if (otherMaps.length) {
    lines.push("", "OTHER SEEN MAPS (not drawn; use map=NAME): " + otherMaps.join("; "));
  }
  lines.push("", "How to read: 'd' is steps over seen floor, not a guaranteed route. A blank neighbor is unexplored, not a wall; probe with the shown '!' form. Walls and ladders are the only features drawn.");
  return lines.join("\n");
}
