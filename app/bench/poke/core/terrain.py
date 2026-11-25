"""ROM 地形 + tileset 碰撞表 -> 16px 格地形。

之前的地图是 SIGHT 截图按相机滚动拼接出来的，相机抖动会把相邻的墙
错写到走道格上，于是“明明走过却显示 #”。这里不再猜地形：

- ROM 里的 `<MAP>_Blocks` 是地图的 32px block 数组；
- tileset 的 block 表把每个 block 展开成 4x4 个 8px tile；
- 每个 16px 格取对应 2x2 tile 象限的左下 tile；
- 再用 tileset 的 collision 表判断这个 tile 能不能走。

SIGHT 仍然只负责“哪些格看见过”（迷雾）；地形本身来自游戏原始数据。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from core.emulator import PokeEmu

# WRAM 固定地址：tileset 表指针和室外草丛标志（Gen 1）。
_TILESET_BANK = 0xD52B
_TILESET_BLOCKS_PTR = 0xD52C
_TILESET_COLLISION_PTR = 0xD530
_GRASS_TILE = 0xD535
_OUTDOOR_FLAG = 0xFFD7

_BLOCK_TILES = 16  # 一个 32px block = 4x4 个 8px tile
_SYM_RE = re.compile(r"^([0-9a-fA-F]{2}):([0-9a-fA-F]{4})\s+(\S+)")


def load_symbols(path: Path) -> dict[str, tuple[int, int]]:
    """读 .sym，返回 name -> (bank, address)。"""
    out: dict[str, tuple[int, int]] = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        m = _SYM_RE.match(line)
        if m:
            out[m.group(3)] = (int(m.group(1), 16), int(m.group(2), 16))
    return out


def rom_offset(bank: int, addr: int) -> int:
    """CPU bank/address -> ROM 文件偏移。bank 0 是固定区。"""
    if bank == 0:
        return addr
    return bank * 0x4000 + (addr - 0x4000)


def symbol_offset(symbols: dict[str, tuple[int, int]], name: str) -> int:
    bank, addr = symbols[name]
    return rom_offset(bank, addr)


def _norm_symbol(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def find_symbol(symbols: dict[str, tuple[int, int]], wanted: str) -> str | None:
    """按名字找符号，允许 SS_ANNE_1F / SSAnne1F 这种缩写差异。"""
    if wanted in symbols:
        return wanted
    target = _norm_symbol(wanted)
    for name in symbols:
        if _norm_symbol(name) == target:
            return name
    return None


def _cap(part: str) -> str:
    # 1f/b1f/2f 这类要保留大写，其它按首字母大写。
    if re.fullmatch(r"\d+[a-z]?", part):
        return part.upper()
    return part[:1].upper() + part[1:]


def camel_map_name(map_name: str) -> str:
    """MT_MOON_1F -> MtMoon1F；ROUTE_4 -> Route4。"""
    return "".join(_cap(p) for p in str(map_name).lower().split("_") if p)


def map_header(symbols: dict[str, tuple[int, int]], rom: bytes, map_name: str) -> dict | None:
    """从 `<Map>_h` 读 tileset / 宽高 / block 数据位置。"""
    base = camel_map_name(map_name)
    h_name = find_symbol(symbols, base + "_h")
    blocks_name = find_symbol(symbols, base + "_Blocks")
    if not h_name or not blocks_name:
        return None
    h_off = symbol_offset(symbols, h_name)
    raw = rom[h_off : h_off + 5]
    if len(raw) < 5:
        return None
    width, height = int(raw[2]), int(raw[1])
    if width <= 0 or height <= 0:
        return None
    blocks_off = symbol_offset(symbols, blocks_name)
    if blocks_off + width * height > len(rom):
        return None
    return {
        "map": map_name,
        "base": base,
        "tileset": int(raw[0]),
        "width": width,
        "height": height,
        "blocks_off": blocks_off,
    }


def tileset_tables(emu: PokeEmu) -> dict:
    """当前 tileset 的 block 表和 collision 表。"""
    mem = emu.pyboy.memory
    blocks_ptr = mem[_TILESET_BLOCKS_PTR] | (mem[_TILESET_BLOCKS_PTR + 1] << 8)
    bank = mem[_TILESET_BANK]
    coll_ptr = mem[_TILESET_COLLISION_PTR] | (mem[_TILESET_COLLISION_PTR + 1] << 8)
    walk: set[int] = set()
    for i in range(0x180):
        tile = mem[coll_ptr + i]
        if tile == 0xFF:
            break
        walk.add(tile + 0x100)
    grass = -1
    if mem[_OUTDOOR_FLAG] > 0 and mem[_GRASS_TILE] != 0xFF:
        grass = mem[_GRASS_TILE] + 0x100
    return {
        "tileset": int(emu.byte("wCurMapTileset")),
        "bank": int(bank),
        "blocks_off": rom_offset(int(bank), int(blocks_ptr)),
        "walk": walk,
        "grass": grass,
    }


# `Tilesets` 是 12 字节一条：bank, blocks ptr, gfx ptr, collision ptr,
# 后面 5 字节是属性/名字；collision 表在 bank 0（固定区）。
_TILESET_ENTRY = 12


def tileset_tables_from_rom(rom: bytes, symbols: dict[str, tuple[int, int]], tileset_id: int) -> dict | None:
    """不加载存档，直接从 ROM 的 `Tilesets` 表读任意 tileset。

    这样 `tools/build_terrain.py` 可以生成当前没在跑的室内地图；只有 warp
    位置仍然需要该地图的存档（warp 不在 tileset 表里）。
    """
    base = symbol_offset(symbols, "Tilesets") + int(tileset_id) * _TILESET_ENTRY
    if base < 0 or base + 7 > len(rom):
        return None
    bank = rom[base]
    blocks = rom[base + 1] | (rom[base + 2] << 8)
    coll = rom[base + 5] | (rom[base + 6] << 8)
    coll_off = coll if coll < 0x4000 else rom_offset(bank, coll)
    if coll_off + 1 > len(rom):
        return None
    walk: set[int] = set()
    for i in range(0x180):
        tile = rom[coll_off + i]
        if tile == 0xFF:
            break
        walk.add(tile + 0x100)
    grass = rom[base + 10] if base + 10 < len(rom) else 0xFF
    return {
        "tileset": int(tileset_id),
        "bank": int(bank),
        "blocks_off": rom_offset(int(bank), int(blocks)),
        "walk": walk,
        "grass": (grass + 0x100) if grass != 0xFF else -1,
    }



def decode_map(rom: bytes, symbols: dict[str, tuple[int, int]], map_name: str,
               tables: dict, warps: list[tuple[int, int]] | None = None) -> dict | None:
    """把一张地图解码成 16px 格地形。"""
    h = map_header(symbols, rom, map_name)
    if not h:
        return None
    if h["tileset"] != tables["tileset"]:
        # 当前运行时只有当前 tileset 的表；不同 tileset 的地图等它变成
        # 当前地图时再生成，避免用错 collision 表。
        return None
    blocks = rom[h["blocks_off"] : h["blocks_off"] + h["width"] * h["height"]]
    table = rom[tables["blocks_off"] : tables["blocks_off"] + 0x100 * _BLOCK_TILES]
    walk = tables["walk"]
    grass = tables["grass"]
    cells: list[list] = []
    for by in range(h["height"]):
        for bx in range(h["width"]):
            bid = blocks[by * h["width"] + bx]
            base = bid * _BLOCK_TILES
            if base + _BLOCK_TILES > len(table):
                continue
            tiles = table[base : base + _BLOCK_TILES]
            for cy in range(2):
                for cx in range(2):
                    # 游戏用每个 2x2 tile 象限的左下 tile 做 16px 碰撞判断。
                    tid = tiles[(2 * cy + 1) * 4 + 2 * cx] + 0x100
                    if tid == grass:
                        ch = ","
                    elif tid in walk:
                        ch = "."
                    else:
                        ch = "#"
                    cells.append([bx * 2 + cx, by * 2 + cy, ch])
    if warps:
        wanted = {(int(x), int(y)) for y, x in warps}
        for cell in cells:
            if (cell[0], cell[1]) in wanted:
                cell[2] = "D"
    return {
        "map": map_name,
        "tileset": h["tileset"],
        "width": h["width"] * 2,
        "height": h["height"] * 2,
        "source": "rom-blocks+tileset-collision",
        "cells": cells,
    }


def _write_sidecar(run_dir: Path, name: str, data: dict) -> Path:
    out_dir = Path(run_dir) / "terrain"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / (name + ".json")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)
    return path


def write_terrain(run_dir: Path, emu: PokeEmu, map_name: str | None = None,
                  symbols: dict[str, tuple[int, int]] | None = None) -> Path | None:
    """把当前地图的完整地形写到 runs/<run>/terrain/<MAP>.json。"""
    if run_dir is None:
        return None
    st = emu.state()
    name = map_name or st.get("map")
    if not name:
        return None
    symbols = symbols or load_symbols(emu.sym)
    rom = Path(emu.rom).read_bytes()
    tables = tileset_tables(emu)
    # _warps 只描述当前地图；给别的图生成地形时不能借用它的门/梯子。
    from core.observation import _warps

    warps = _warps(emu) if name == st.get("map") else None
    data = decode_map(rom, symbols, name, tables, warps)
    if not data:
        return None
    return _write_sidecar(run_dir, name, data)


def write_terrain_rom(run_dir: Path, rom_path: Path, symbols: dict[str, tuple[int, int]],
                      map_name: str, warps: list[tuple[int, int]] | None = None) -> Path | None:
    """不加载存档，直接从 ROM 解码一张地图（没有 warp 时 `D` 会缺失）。"""
    if run_dir is None:
        return None
    rom = Path(rom_path).read_bytes()
    h = map_header(symbols, rom, map_name)
    if not h:
        return None
    tables = tileset_tables_from_rom(rom, symbols, h["tileset"])
    if not tables:
        return None
    data = decode_map(rom, symbols, map_name, tables, warps)
    if not data:
        return None
    return _write_sidecar(run_dir, map_name, data)
