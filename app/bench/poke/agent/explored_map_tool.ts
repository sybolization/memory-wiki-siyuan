/**
 * explored_map_tool.ts - shared read-only view of what the game has actually shown.
 *
 * The seen mask comes only from structured SIGHT records (spatial.jsonl).
 * For maps that have a terrain sidecar, the guessed SIGHT character of every
 * seen cell is replaced by the game's own collision terrain decoded from the
 * ROM (<MAP>_Blocks + tileset collision tables).  A blank cell still means
 * "never seen", not "known floor"; terrain never adds a cell.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { viewExplored, resolveRunDir } from "../lib/map_view.mjs";

const BASE = process.env.POKE_URL ?? "http://127.0.0.1:8765";

function msg(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

// Read the live RAM state so the working map centers on the tile the player
// is on right now, not on the last SIGHT record (which is written after an
// action and can lag by one step or carry a map-change readout glitch).
// A dream has no server, so a failed fetch simply falls back to the ledger.
async function liveState(): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(BASE + "/observe", { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const explored = defineTool({
  name: "explored_map",
  label: "Show the explored map",
  description:
    "Draw the cumulative map of 16px blocks the game has actually shown you, in the same ASCII convention as the SIGHT block. " +
    "Only blocks that appeared on screen are drawn; blank = never seen, not floor. " +
    "When a ROM terrain sidecar exists for the map, every seen block is drawn with the game's own collision terrain decoded from <MAP>_Blocks + the tileset collision table; SIGHT only decides which cells are seen. " +
    "A cell the player actually stood on is never drawn as a wall, because ledges/warps/script tiles can be non-walkable in the collision table. " +
    "A map without a sidecar falls back to SIGHT evidence, where # may include camera-stitch errors. " +
    "The view is a local window around the current position, not a global map. " +
    "When the emulator server is reachable, 'current' and '@' come from the live RAM position; otherwise they fall back to the last SIGHT record. " +
    "It also lists seen floor blocks whose cardinal neighbor has never been seen, so those are concrete unexplored edges to probe. " +
    "By default it renders the full cumulative map of every seen cell, with absolute (x,y) axes that grow as exploration grows; set full=false for a small local window. " +
    "A 12x12 explored-chunk index maps absolute (x,y) ranges to useful center= coordinates. " +
    "map: 'current' (default), a map name, or 'all' for a summary. center: optional 'x,y' to inspect a seen area away from the current position. " +
    "radius: 1..12 for the local mode (default 6). edges: how many boundary entries to list (default 12, 0 disables).",
  parameters: Type.Object({
    map: Type.Optional(Type.String({ description: "'current' (default), a map name such as MT_MOON_1F, or 'all'" })),
    center: Type.Optional(Type.String({ description: "Optional 'x,y' center (use a coordinate from your own map notes); only seen cells are drawn" })),
    full: Type.Optional(Type.Boolean({ description: "Render the full explored map (default true); false gives a local radius window" })),
    radius: Type.Optional(Type.Number({ description: "Half-width of the local window when full=false, 1..12 (default 6)" })),
    edges: Type.Optional(Type.Number({ description: "Max unexplored-boundary entries to list (default 12; 0 disables)" })),
  }),
  async execute(_id: any, params: any) {
    const runDir = resolveRunDir();
    if (!runDir) {
      return msg("[error] explored_map: no run directory (POKE_RUN_NAME/POKE_ROOT or POKE_DREAM_READ_DIR is not set).");
    }
    const live = await liveState();
    return msg(viewExplored(runDir, {
      map: params.map,
      center: params.center,
      full: params.full !== false,
      radius: params.radius,
      edges: params.edges,
      live: live ? { map: live.map, x: live.x, y: live.y } : null,
    }));
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(explored);
}
