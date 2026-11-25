"""Colorize by tile id for overworld tileset only; text/font and indoor maps stay grayscale."""
import colorsys, pathlib, sys

POKE_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(POKE_ROOT))
import numpy as np
from PIL import Image

_SHADE = np.zeros(256, dtype=np.uint8)
_SHADE[255], _SHADE[153], _SHADE[85], _SHADE[0] = 0, 1, 2, 3
OVERWORLD_TILESETS = {0}  # TILESET_OVERWORLD

def _ramp(hue, sat):
    out = []
    for l, s in ((0.96, 0.18), (0.78, 0.52), (0.58, 0.64), (0.38, 0.70)):
        r, g, b = colorsys.hls_to_rgb(hue / 360.0, l, min(0.92, sat * s * 1.7))
        out.append((int(r * 255), int(g * 255), int(b * 255)))
    return out

_C = {}
def ramp(hue, sat):
    k = (hue, sat)
    if k not in _C:
        _C[k] = _ramp(hue, sat)
    return _C[k]

# 先按“已知地形”手工定色，没覆盖到的 tile 用 id 分组的稳定色相
SEMANTIC = {
    0x2C: (42, 0.55),   # 地面/土路
    0x23: (105, 0.55),  # 草地
    0x0E: (115, 0.50),
    0x03: (65, 0.50),   # 花
    0x39: (135, 0.55),  # 树冠
    0x55: (28, 0.55),   # 树干
    0x56: (28, 0.50),
    0x57: (28, 0.45),
    0x2A: (210, 0.40),  # 台阶上
    0x2B: (210, 0.40),
    0x3A: (200, 0.45),  # 台阶下
    0x3B: (200, 0.45),
    0x46: (0, 0.03),    # 牌子
    0x47: (0, 0.03),
}
SPRITE = {"player": (2, 0.80), "npc": (220, 0.60)}

def tile_color(tid):
    if tid in SEMANTIC:
        return ramp(*SEMANTIC[tid])
    return ramp(((tid // 12) * 47) % 360, 0.45)

def colorize(emu, frame=None):
    base = frame if frame is not None else emu.pyboy.screen.image
    img = np.asarray(base.convert("RGB"), dtype=np.uint8).copy()
    h, w = img.shape[:2]
    shade = _SHADE[img[:, :, 0]]
    out = img.copy()
    tileset = emu.byte("wCurMapTileset")
    in_battle = emu.byte("wIsInBattle")
    tiles = emu.read("wTileMap", 360)
    if tileset in OVERWORLD_TILESETS and not in_battle:
        for row in range(h // 8):
            for col in range(w // 8):
                tid = tiles[row * 20 + col]
                if tid >= 0x80:      # 字体/UI，保持原样
                    continue
                r = tile_color(tid)
                ys, xs = slice(row * 8, row * 8 + 8), slice(col * 8, col * 8 + 8)
                cell_shade = shade[ys, xs]
                cell = out[ys, xs]
                for k in range(4):
                    cell[cell_shade == k] = r[k]
    if in_battle:
        return Image.fromarray(out)
    px, py = emu.player_rect()
    for i in range(40):
        try:
            s = emu.pyboy.get_sprite(i)
        except Exception:
            continue
        if not s.on_screen:
            continue
        sx, sy = int(s.x), int(s.y)
        x0, y0 = max(0, sx), max(0, sy)
        x1, y1 = min(w, sx + 8), min(h, sy + 8)
        if x1 <= x0 or y1 <= y0:
            continue
        kind = "player" if (abs(sx - px) < 8 and abs(sy - py) < 16) else "npc"
        r = ramp(*SPRITE[kind])
        cell_shade = shade[y0:y1, x0:x1]
        cell = out[y0:y1, x0:x1]
        for k in range(4):
            cell[cell_shade == k] = r[k]
    return Image.fromarray(out)

if __name__ == "__main__":
    from core.emulator import PokeEmu
    # 当前实验用 CGB ROM；没有 rom_gbc 时回退到 core.paths 的默认 DMG ROM。
    rom = POKE_ROOT / "rom_gbc" / "pokered.gbc"
    sym = POKE_ROOT / "rom_gbc" / "pokered.sym"
    emu = PokeEmu(rom=rom, sym=sym) if rom.exists() and sym.exists() else PokeEmu()
    name = (sys.argv[1] if len(sys.argv) > 1 else "color_probe") + ".state"
    emu.load(POKE_ROOT / "states" / name)
    emu.tick(3)
    im = colorize(emu)
    ts = emu.byte("wCurMapTileset")
    im.save(POKE_ROOT / "runs" / "color_v2.png")
    print("map", emu.state()["map"], "tileset", ts)
    emu.stop()
