"""bench/poke/tools/build_terrain.py - 生成 runs/<run>/terrain/<MAP>.json。

地形来自 ROM 的 `<MAP>_Blocks` 和当前 tileset 的 block / collision 表，
不是 SIGHT 截图。SIGHT 仍然只决定“哪些格看见过”。

用法：
    # 从已有存档生成（当前地图还能带上 warp D）
    python tools/build_terrain.py --run gbc_map_14 --state gbc_map11_start \
        --map MT_MOON_1F --map MT_MOON_B1F --map MT_MOON_B2F
    python tools/build_terrain.py --run gbc_map_14 --state route4_east_20261123_164644 \
        --map ROUTE_4 --map CERULEAN_CITY --map ROUTE_24 --map ROUTE_25

    # 不需要存档：直接从 ROM 的 Tilesets 表解码（没有 D，但地形完整）
    python tools/build_terrain.py --run gbc_map_14 \
        --map CERULEAN_GYM --map CERULEAN_POKECENTER --map CERULEAN_MART

    # 从正在运行的 server 抓一份当前状态再生成
    python tools/build_terrain.py --run gbc_map_14 --from-live \
        --map ROUTE_4 --map CERULEAN_CITY

    # 只看每个存档当前在哪张图
    python tools/build_terrain.py --state gbc_map11_start --list

注意：tileset 表优先用游戏运行时从 ROM 读进 WRAM 的那份（当前地图可带
warp D）；tileset 不匹配或没有存档时，自动退回 ROM 的 `Tilesets` 表。
只有 `D`（warp）仍然需要该地图的存档。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.emulator import PokeEmu  # noqa: E402
from core.paths import CONFIG, RUNS, STATES  # noqa: E402
from core.terrain import load_symbols, write_terrain, write_terrain_rom  # noqa: E402


def run_config() -> dict:
    path = CONFIG / "run.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def default_run() -> str:
    cfg = run_config()
    return str(cfg.get("run") or "gbc_map_14")


def rom_paths(args) -> tuple[Path, Path]:
    cfg = run_config()
    rom = Path(args.rom or cfg.get("rom") or "rom_gbc/pokered.gbc")
    sym = Path(args.sym or cfg.get("sym") or "rom_gbc/pokered.sym")
    if not rom.is_absolute():
        rom = ROOT / rom
    if not sym.is_absolute():
        sym = ROOT / sym
    return rom, sym


def resolve_state(value: str) -> Path:
    p = Path(value)
    if p.exists():
        return p
    if p.suffix != ".state":
        p = STATES / (value + ".state")
    return p


def save_live(url: str, name: str | None = None) -> Path:
    """让 server 把当前模拟器状态写到 states/，返回文件路径。"""
    name = name or ("terrain_live_" + datetime.now().strftime("%Y%m%d_%H%M%S"))
    body = json.dumps({"name": name}).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/save",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    if not data.get("path"):
        raise RuntimeError(f"server did not return a save path: {data}")
    return Path(data["path"])


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate ROM terrain sidecars for a poke run.")
    ap.add_argument("--run", default=default_run(), help="run name under runs/ (default: config/run.json)")
    ap.add_argument("--run-dir", default="", help="override the run directory")
    ap.add_argument("--state", action="append", default=[], help="state name or .state path; repeatable")
    ap.add_argument("--from-live", action="store_true", help="save the live server state first, then use it")
    ap.add_argument("--url", default="http://127.0.0.1:8765", help="server base URL for --from-live")
    ap.add_argument("--save-name", default="", help="state name for --from-live (default: timestamp)")
    ap.add_argument("--map", action="append", default=[], help="target map name; repeatable (default: state's current map)")
    ap.add_argument("--force", action="store_true", help="overwrite existing sidecars")
    ap.add_argument("--list", action="store_true", help="only print each state's current map")
    ap.add_argument("--rom", default="", help="ROM path override")
    ap.add_argument("--sym", default="", help="symbol path override")
    args = ap.parse_args()

    run_dir = Path(args.run_dir) if args.run_dir else RUNS / args.run
    if not run_dir.is_absolute():
        run_dir = ROOT / run_dir
    rom, sym = rom_paths(args)

    states = [resolve_state(s) for s in args.state]
    if args.from_live:
        live = save_live(args.url, args.save_name or None)
        print(f"live state saved: {live}")
        states.append(live)
    if not states and not args.map:
        ap.error("pass --state/--from-live and/or --map")
    if args.list and not states:
        ap.error("--list needs --state/--from-live")

    symbols = load_symbols(sym)
    out_dir = run_dir / "terrain"
    total = skipped = 0

    def emit(target: str, path) -> None:
        nonlocal total, skipped
        if not path:
            print(f"  {target}: skipped (no map header / tileset table)")
            skipped += 1
            return
        data = json.loads(path.read_text(encoding="utf-8"))
        print(f"  {target}: {len(data['cells'])} cells, "
              f"{data['width']}x{data['height']} -> {path}")
        total += 1

    if states:
        for state in states:
            if not state.exists():
                print(f"MISSING {state}")
                skipped += 1
                continue
            emu = PokeEmu(rom=rom, sym=sym)
            try:
                emu.load(state)
                emu.tick(2)
                st = emu.state()
                current = st["map"]
                print(f"{state.name}: current={current} ({st['x']},{st['y']}) "
                      f"battle={st['battle']} party={st['party_count']}")
                if args.list:
                    continue
                for target in (args.map or [current]):
                    out = out_dir / (target + ".json")
                    if out.exists() and not args.force:
                        print(f"  {target}: exists, skip (use --force to overwrite)")
                        continue
                    # 先试运行时 tileset（当前地图还能带上 warp D）；tileset
                    # 不匹配时退回 ROM 的 Tilesets 表，仍然能生成地形。
                    path = write_terrain(run_dir, emu, map_name=target, symbols=symbols)
                    if not path:
                        path = write_terrain_rom(run_dir, rom, symbols, target)
                    emit(target, path)
            finally:
                emu.stop()
    else:
        for target in args.map:
            out = out_dir / (target + ".json")
            if out.exists() and not args.force:
                print(f"  {target}: exists, skip (use --force to overwrite)")
                continue
            emit(target, write_terrain_rom(run_dir, rom, symbols, target))

    if not args.list:
        print(f"done: {total} written, {skipped} skipped, run={args.run}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
