"""PyBoy 封装：符号寻址、文本解码、状态读取。

观测是 RAM-first：每个字段都通过 ROM 的 .sym 定位，不做截图 OCR。
一个 PokeEmu 实例对应一个常驻载体进程。

不变量：
- 所有 WRAM 读取都用 CPU 平坦地址（pyboy.memory[addr]），不能用 bank 切片。
- wXCoord/wYCoord 已经是 16px 格坐标，这里不做任何 //2。
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path
from typing import Any

from pyboy import PyBoy

# 允许 `python core/emulator.py` 直接运行：把 bench/poke 加进 sys.path。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.paths import DATA, ROM, SYM  # noqa: E402

CHARMAP = json.loads((DATA / "charmap.json").read_text(encoding="utf-8"))
MAP_NAMES = json.loads((DATA / "map_names.json").read_text(encoding="utf-8"))

# Game Boy button names accepted by PyBoy.
BUTTONS = {"up", "down", "left", "right", "a", "b", "start", "select"}


def _clean(text: str) -> str:
    return (
        text.replace("\u3000", " ")
        .replace("\n\n\n", "\n\n")
        .strip()
    )


class PokeEmu:
    def __init__(self, rom: Path = ROM, sym: Path = SYM, log_level: str = "ERROR", window: str = "null", scale: int = 3):
        self.rom = Path(rom)
        self.sym = Path(sym)
        self.window = window
        self.render = True  # always draw into the frame buffer; window=null just skips the OS window
        self.pyboy = PyBoy(str(self.rom), window=window, scale=scale, symbols=str(self.sym), sound=False, log_level=log_level)
        self.pyboy.set_emulation_speed(0)
        self.frames = 0
        # Presentation-only: keep the raw frames of the latest tick so the live
        # page can replay them as a smooth animation. Rendering never feeds back
        # into game state, so determinism is untouched.
        self.capture = True
        self.last_frames: list = []

    # ---------------------------------------------------------------- basics
    def tick(self, n: int = 1, capture: bool = False) -> None:
        if capture and self.capture:
            self.last_frames = []
            for _ in range(n):
                self.pyboy.tick(1, render=self.render)
                self.last_frames.append(self.pyboy.screen.image.convert("P").copy())
        else:
            self.pyboy.tick(n, render=self.render)
        self.frames += n

    def press(self, button: str, frames: int = 24) -> dict[str, Any]:
        button = button.lower()
        if button not in BUTTONS:
            raise ValueError(f"unknown button {button!r}")
        self.pyboy.button_press(button)
        self.tick(frames, capture=True)
        self.pyboy.button_release(button)
        self.tick(2)
        return {"button": button, "frames": frames, "total_frames": self.frames}

    # ---------------------------------------------------------------- symbols
    def addr(self, symbol: str) -> tuple[int, int]:
        return self.pyboy.symbol_lookup(symbol)

    def read(self, symbol: str, n: int = 1, offset: int = 0) -> list[int]:
        # Flat (CPU-mapped) addressing: WRAM bank-0 slices are NOT the live values
        # because the game switches SVBK. Symbol is used only to find the address.
        _bank, address = self.addr(symbol)
        return self.pyboy.memory[address + offset : address + offset + n]

    def byte(self, symbol: str, offset: int = 0) -> int:
        return self.read(symbol, 1, offset)[0]

    # ---------------------------------------------------------------- sprites
    def player_rect(self) -> tuple[int, int]:
        """Player sprite top-left on the 160x144 screen (16x16 sprite)."""
        y = self.read("wSpritePlayerStateData1YPixels", 1)[0]
        x = self.read("wSpritePlayerStateData1XPixels", 1)[0]
        return int(x), int(y)

    # ---------------------------------------------------------------- text
    def screen_text(self) -> str:
        """Decode the 20x18 BG tilemap (wTileMap) through the ROM's own charmap."""
        tiles = self.read("wTileMap", 20 * 18)
        rows: list[str] = []
        for r in range(18):
            row = "".join(CHARMAP.get(str(t), "") for t in tiles[r * 20 : (r + 1) * 20])
            rows.append(row.rstrip())
        return _clean("\n".join(rows))

    # ---------------------------------------------------------------- state
    def state(self) -> dict[str, Any]:
        badges = self.byte("wObtainedBadges")
        map_id = self.byte("wCurMap")
        # wXCoord/wYCoord are already the agent-facing 16px grid: one walking
        # press moves 1 unit and scrolls the camera 16px, and the warp entries
        # use the same units (start (14,35) is warp 0).  The map header's
        # 20x18 is in 32px Gen 1 blocks, i.e. 40x36 cells on this grid.
        # Dividing by 2 halved the whole map, made every other press look
        # swallowed and produced false 'blocked' walls.
        return {
            "frames": self.frames,
            "map_id": map_id,
            "map": MAP_NAMES.get(str(map_id), f"UNKNOWN_{map_id}"),
            "x": self.byte("wXCoord"),
            "y": self.byte("wYCoord"),
            "badges": [i for i in range(8) if badges >> i & 1],
            "badge_mask": badges,
            "money": self._bcd("wPlayerMoney", 3),
            "party_count": self.byte("wPartyCount"),
            "party": self._party(),
            "battle": self.byte("wIsInBattle"),
            "text": self.screen_text(),
        }

    def _bcd(self, symbol: str, n: int) -> int:
        raw = self.read(symbol, n)
        value = 0
        for b in raw:
            value = value * 100 + (b >> 4) * 10 + (b & 0x0F)
        return value

    def _party(self) -> list[dict[str, Any]]:
        count = min(6, self.byte("wPartyCount"))
        out = []
        for i in range(count):
            base = 0x2C * i
            out.append(
                {
                    "species": self.byte("wPartySpecies", i),
                    "level": self.byte("wPartyMon1Level", base),
                    "hp": self.byte("wPartyMon1HP", base) << 8 | self.byte("wPartyMon1HP", base + 1),
                }
            )
        return out

    # ---------------------------------------------------------------- state io
    def save(self, path: Path) -> str:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as fh:
            self.pyboy.save_state(fh)
        return str(path)

    def load(self, path: Path) -> None:
        with open(Path(path), "rb") as fh:
            self.pyboy.load_state(fh)

    def stop(self) -> None:
        self.pyboy.stop(save=False)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=400)
    ap.add_argument("--press", default="")
    args = ap.parse_args()

    rom_sha1 = hashlib.sha1(ROM.read_bytes()).hexdigest()
    print(f"rom={ROM.name} sha1={rom_sha1}")

    emu = PokeEmu()
    for s in ("wTileMap", "wOverworldMap", "wCurMap", "wXCoord", "wYCoord", "wObtainedBadges", "wPartyCount", "wPlayerMoney"):
        print(f"  sym {s}: {emu.addr(s)}")
    emu.tick(args.frames)
    if args.press:
        for ch in args.press:
            emu.press(ch, 12)
    print(json.dumps(emu.state(), ensure_ascii=False, indent=2))
    emu.stop()