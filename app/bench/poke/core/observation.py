"""观测：屏幕文字、10x9 局部视图、菜单光标。

SIGHT 的 10x9 视图在这里生成：它只描述“这一屏看起来是什么”，
不是全局地图，也不等于 32px 碰撞块。真正的碰撞证据只有 blocked。
"""
from __future__ import annotations

from core.emulator import CHARMAP, PokeEmu
from core.input import box_visible

SCREEN_W, SCREEN_H = 20, 18


def decode_screen(emu: PokeEmu) -> str:
    tiles = emu.read("wTileMap", SCREEN_W * SCREEN_H)
    rows, seen = [], 0
    for r in range(SCREEN_H):
        chars = []
        for t in tiles[r * SCREEN_W : (r + 1) * SCREEN_W]:
            ch = CHARMAP.get(str(t), "")
            if t in (0x00, 0x50, 0x7F):
                chars.append(" ")
            elif ch and ch not in {"\n"} and ch.isascii():
                chars.append(ch)
            else:
                chars.append(" ")
        line = "".join(chars).rstrip()
        if line.strip():
            seen += 1
        rows.append(line)
    # trim all-blank borders
    while rows and not rows[0].strip():
        rows.pop(0)
    while rows and not rows[-1].strip():
        rows.pop()
    return "\n".join(rows)


# ------------------------------------------------------------------ local view
#
# One game screen is 20x18 8px tiles = 10x9 cells of 16px, which is exactly the
# size of one walking step.  wXCoord/wYCoord use those 16px cells (the map
# header's 20x18 is in 32px Gen 1 blocks).  The view below is therefore 10x9
# cells, one character per cell, and the player marker comes from the sprite's
# real screen position instead of the grid centre.

VIEW_W, VIEW_H = 10, 9

# Sprite structs live at wSpriteStateData1: 16 entries of 16 bytes.  The player is
# entry 0; XPixels/YPixels are at +6/+4.  A sprite's 16x16 picture sits 4px above
# the 16px block it occupies, hence the +4 when converting to a block row.
_SPRITE_BASE_SYM = "wSpritePlayerStateData1XPixels"

def _signed_byte_delta(a: int, b: int) -> int:
    """Shortest signed difference between two 8-bit scroll values."""
    d = (b - a) & 0xFF
    return d - 256 if d > 127 else d


def _walkable_ids(emu: PokeEmu) -> set[int]:
    """引擎认为可走的 tile id。

    0xD530/0xD531 是当前 tileset 的碰撞表指针，0xFFD7 是室外标志，
    0xD535 是草丛 tile。这些是 Gen1 的固定 WRAM 地址；换 ROM 构建时要
    和 .sym 一起核对。
    """
    mem = emu.pyboy.memory
    ptr = mem[0xD530] | (mem[0xD531] << 8)
    ids: set[int] = set()
    if mem[0xFFD7] > 0:  # outdoor tileset: tall grass is walkable
        grass = mem[0xD535]
        if grass != 0xFF:
            ids.add(grass + 0x100)
    for i in range(0x180):
        tid = mem[ptr + i]
        if tid == 0xFF:
            break
        ids.add(tid + 0x100)
    return ids


def _sprites(emu: PokeEmu) -> list[dict]:
    base = emu.addr(_SPRITE_BASE_SYM)[1] - 6
    mem = emu.pyboy.memory
    out = []
    for i in range(16):
        b = base + 16 * i
        pic = mem[b]
        if not pic or mem[b + 2] == 0xFF:  # empty or hidden sprite slot
            continue
        x, y = mem[b + 6], mem[b + 4]
        if x >= 160 or y >= 144:  # off-screen
            continue
        out.append({"i": i, "pic": pic, "x": x, "y": y,
                    "block": ((y + 4) // 16, x // 16)})
    return out


def _warps(emu: PokeEmu) -> list[tuple[int, int]]:
    """Current map's warp tiles in map-block coordinates (y, x), read from RAM."""
    n = min(32, emu.byte("wNumberOfWarps"))
    if n <= 0:
        return []
    data = emu.read("wWarpEntries", 4 * n)
    return [(data[4 * i], data[4 * i + 1]) for i in range(n)]


def screen_view(emu: PokeEmu) -> dict:
    """What the game itself is showing right now, as one 10x9 block grid."""
    st = emu.state()
    wrap = emu.pyboy.game_wrapper
    tiles = wrap._get_screen_background_tilemap()
    walk_ids = _walkable_ids(emu)
    mem = emu.pyboy.memory
    grass = mem[0xD535] + 0x100 if mem[0xFFD7] > 0 and mem[0xD535] != 0xFF else -1

    blocks = []
    # A text box covers the lower half of the map with glyph tiles that are not
    # terrain.  Mark those cells unknown instead of inventing walls there.
    covered = box_visible(emu)
    for br in range(VIEW_H):
        row = []
        for bc in range(VIEW_W):
            if covered:
                row.append("?")
                continue
            tid = int(tiles[2 * br + 1][2 * bc])  # engine samples the block's bottom-left tile
            if tid == grass:
                row.append(",")
            elif tid in walk_ids:
                row.append(".")
            else:
                row.append("#")
        blocks.append(row)

    sprites = _sprites(emu)
    player = next((s for s in sprites if s["i"] == 0), None)
    pr, pc = player["block"] if player else (VIEW_H // 2, VIEW_W // 2)

    # Warp tiles are map-local data; only draw the ones inside this screen.
    for wy, wx in _warps(emu):
        r = pr + (wy - st["y"])
        c = pc + (wx - st["x"])
        if 0 <= r < VIEW_H and 0 <= c < VIEW_W:
            blocks[r][c] = "D"

    for s in sprites:
        if s["i"] == 0:
            continue
        r, c = s["block"]
        if 0 <= r < VIEW_H and 0 <= c < VIEW_W:
            blocks[r][c] = "N"

    if 0 <= pr < VIEW_H and 0 <= pc < VIEW_W:
        blocks[pr][pc] = "@"

    return {
        "scx": mem[0xFF43],
        "scy": mem[0xFF42],
        "map_id": st["map_id"],
        "map": st["map"],
        "pos": (st["x"], st["y"]),
        "player": (pr, pc),
        "blocks": blocks,
    }


def grid_rows(blocks: list[list[str]], pr: int, pc: int) -> list[str]:
    """Render a block grid with offsets relative to the player."""
    lines = ["     " + "".join(f"{c - pc:+3d}" for c in range(len(blocks[0])))]
    for r, row in enumerate(blocks):
        lines.append(f"{r - pr:+3d}  " + "".join(f"{ch:^3}" for ch in row))
    return lines


def ascii_view(emu: PokeEmu) -> list[str]:
    if emu.byte("wIsInBattle"):
        return ["(battle screen: no local map)"]
    v = screen_view(emu)
    return grid_rows(v["blocks"], *v["player"])


def menu_state(emu: PokeEmu) -> dict | None:
    """Describe the visible menu cursor, if a menu cursor is on screen."""
    try:
        base = emu.addr("wTileMap")[1]
        lo, hi = emu.read("wMenuCursorLocation", 2)
        loc = (hi << 8) | lo
        if not (base <= loc < base + SCREEN_W * SCREEN_H):
            return None
        tile = emu.read("wTileMap", 1, loc - base)[0]
        if tile not in (236, 237):  # menu arrow glyphs
            return None
        return {
            "top_y": emu.byte("wTopMenuItemY"),
            "top_x": emu.byte("wTopMenuItemX"),
            "index": emu.byte("wCurrentMenuItem"),
            "row": (loc - base) // SCREEN_W,
            "col": (loc - base) % SCREEN_W,
            "tile": tile,
        }
    except Exception:
        return None


def observe(emu: PokeEmu, radius: int | None) -> dict:
    st = emu.state()
    st["screen"] = decode_screen(emu)
    st["map_view"] = ascii_view(emu)
    st["menu"] = menu_state(emu)
    return st


# 兼容旧名字；新代码用 screen_view / grid_rows。
_screen_view = screen_view
_grid_rows = grid_rows
