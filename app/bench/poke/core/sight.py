"""SIGHT：一次动作内所有屏幕的并集。

只记录游戏真正显示过的格子，按相机滚动对齐。它是“看见过什么”的账本，
不是 ROM 地图，也不是碰撞地图。
"""
from __future__ import annotations

from core.emulator import PokeEmu
from core.observation import grid_rows, screen_view

_PRIORITY = {"?": -1, ".": 0, ",": 1, "#": 2, "x": 3, "N": 4, "D": 5, "S": 6, "@": 7}


class ActionTrace:
    """Union of the game's own screen views during one tool call.

    Every sample is the 20x18 tilemap the emulator was showing, aligned by the
    camera scroll.  Nothing outside what appeared on screen is ever added, so
    this is a record of what the player saw, not a global map.  Terrain, NPCs
    and doors are read from RAM at each sample; the final position is drawn as
    '@' and the start as 'S'.
    """

    def __init__(self):
        self.cells: dict[tuple[int, int], str] = {}
        self.map_id = None
        self.map_name = None
        self.ox = self.oy = 0
        self.prev = None
        self.player: tuple[int, int] | None = None
        self.start = None
        self.last = None
        self.frames = 0

    def add(self, emu: PokeEmu) -> None:
        if emu.byte("wIsInBattle"):
            # The battle screen is not the map; do not feed its tiles into the trace.
            return
        v = screen_view(emu)
        if self.map_id != v["map_id"]:
            # A warp changed the map: views from two maps cannot be stitched.
            self.cells.clear()
            self.ox = self.oy = 0
            self.prev = None
            self.start = None
            self.map_id = v["map_id"]
            self.map_name = v["map"]
        pr, pc = v["player"]
        if self.prev is not None:
            # Camera shift = how far the player moved in the map minus how far the
            # sprite moved on screen.  A following camera keeps the sprite still
            # (shift = movement); a clamped camera moves the sprite instead
            # (shift = 0).  This needs only what the screen and RAM already show.
            px, py = self.prev["pos"]
            spr, spc = self.prev["player"]
            dx, dy = v["pos"][0] - px, v["pos"][1] - py
            dspr, dspc = pr - spr, pc - spc
            if abs(dx) > 8 or abs(dy) > 8:
                # A same-map teleport (door/warp) is a new view, not a scroll.
                self.cells.clear()
                self.ox = self.oy = 0
                self.start = None
            else:
                self.oy += dy - dspr
                self.ox += dx - dspc
        self.prev = v
        if self.start is None:
            # cells are keyed (x=column, y=row); keep the same convention here.
            self.start = (self.ox + pc, self.oy + pr)
        for r, row in enumerate(v["blocks"]):
            for c, ch in enumerate(row):
                if ch != "@":
                    self._put(self.ox + c, self.oy + r, ch)
        self.player = (self.ox + pc, self.oy + pr)
        self.last = (self.ox, self.oy, pr, pc)
        self.frames += 1

    def _put(self, x: int, y: int, ch: str) -> None:
        # 注意：这里和 lib/map_view.mjs 的累计合并策略不同，是有意的。
        # - 这里渲染“本次动作所有屏幕的并集”：普通地板可以覆盖 N/x（人走了），
        #   但不会抹掉同一动作里已经看到的墙/门，避免相机采样误差制造假通道。
        # - 累计雾图跨整个 run，用 floor/wall/ladder 计数投票，平票时墙获胜，
        #   避免一次错位采样把已经走过的通道永久封死。
        # 两边共同语义：? / x 不是地形证据；@ / S 算地板；D 是梯子/门。
        if len(self.cells) > 8000:
            return
        old = self.cells.get((x, y))
        # A later sighting of plain floor disproves an earlier "person was here"
        # or "this step was refused" mark: the obstacle moved away.
        if old in ("N", "x") and ch in (".", ","):
            self.cells[(x, y)] = ch
            return
        if old is None or _PRIORITY.get(ch, 0) >= _PRIORITY.get(old, 0):
            self.cells[(x, y)] = ch

    def mark_blocked(self, direction: str) -> None:
        if not self.last:
            return
        ox, oy, pr, pc = self.last
        dr, dc = {"up": (-1, 0), "down": (1, 0), "left": (0, -1), "right": (0, 1)}[direction]
        x, y = ox + pc + dc, oy + pr + dr
        if self.cells.get((x, y)) in (None, ".", ","):
            self.cells[(x, y)] = "x"

    def snapshot(self, end_xy, map_name: str | None = None) -> dict | None:
        """Absolute, machine-readable version of this action's SIGHT map.

        ActionTrace stores cells in its own start-relative frame: self.player
        is where the camera put the player, not the RAM map coordinate.  The
        caller must supply the real final (x, y) from emu.state(); every cell
        is translated by the same offset.  Only cells that the game actually
        showed are present.
        """
        if not self.cells or self.player is None or not end_xy:
            return None
        name = map_name or self.map_name
        if not name:
            return None
        ex, ey = int(end_xy[0]), int(end_xy[1])
        px, py = self.player
        dx, dy = ex - px, ey - py
        start = None
        if self.start:
            start = [self.start[0] + dx, self.start[1] + dy]
        return {
            "map": name,
            "map_id": self.map_id,
            "start": start,
            "end": [ex, ey],
            "cells": [[x + dx, y + dy, ch] for (x, y), ch in sorted(self.cells.items())],
            "samples": self.frames,
        }

    def render(self) -> list[str]:
        if not self.cells or self.player is None:
            return []
        ax, ay = self.player
        cells = {(x - ax, y - ay): ch for (x, y), ch in self.cells.items()}
        cells[(0, 0)] = "@"
        if self.start and (self.start[0] - ax, self.start[1] - ay) != (0, 0):
            sx, sy = self.start[0] - ax, self.start[1] - ay
            if cells.get((sx, sy)) in (None, ".", ","):
                cells[(sx, sy)] = "S"
        xs = [x for x, _ in cells]
        ys = [y for _, y in cells]
        minx, maxx = min(xs + [0]), max(xs + [0])
        miny, maxy = min(ys + [0]), max(ys + [0])
        # Keep the block bounded; normal calls are far inside these limits.
        minx, maxx = max(minx, -60), min(maxx, 60)
        miny, maxy = max(miny, -40), min(maxy, 40)
        blocks = [[cells.get((x, y), " ") for x in range(minx, maxx + 1)]
                  for y in range(miny, maxy + 1)]
        return grid_rows(blocks, -miny, -minx)
