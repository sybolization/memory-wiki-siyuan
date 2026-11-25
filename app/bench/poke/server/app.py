"""HTTP 控制通道：只做路由和动作编排，具体逻辑在 core/。

端点保持不变，旧脚本和 pi 扩展都不需要改协议。
"""
from __future__ import annotations

import base64
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import runtime
from core.emulator import PokeEmu
from core.input import (
    DIRS,
    _diff_ratio,
    _sig,
    advance_to_decision,
    parse_plan,
    pre_turn,
    run_program,
    walk_until,
)
from core.observation import observe
from core.paths import STATES
from core.rendering import is_cgb_rom, shot
from core.sight import ActionTrace
from core.terrain import write_terrain
from core.transcript import read_transcript

_lock = threading.Lock()

# 地形 sidecar 每张图只生成一次。tileset 表在游戏运行时从 ROM 读进 WRAM，
# 所以只有当前地图的 tileset 可用；换图后第一次动作会补写新地图。
_terrain_maps: set[str] = set()


def ensure_terrain(emu: PokeEmu, run_dir: Path | None, state: dict | None) -> None:
    if not run_dir or not state:
        return
    name = state.get("map")
    if not name or name in _terrain_maps:
        return
    try:
        path = write_terrain(run_dir, emu, map_name=name)
        if path:
            _terrain_maps.add(name)
    except Exception as exc:  # 地形失败不能阻断游戏动作
        print(f"terrain: {name}: {exc}", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    emu: PokeEmu = None  # set by serve()
    actions: list = []
    run_dir: Path = None
    quiet = True

    def log_message(self, *args):  # silence default logging
        if not self.quiet:
            super().log_message(*args)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _record_sight(self, trace: ActionTrace, t: float, state: dict) -> None:
        """Append the absolute SIGHT cells for this action, if any."""
        if not self.run_dir or not state:
            return
        ensure_terrain(self.emu, self.run_dir, state)
        # warp 瞬间 wCurMap 可能短暂为 0（PALLET_TOWN），此时用 (0,0) 平移
        # SIGHT 会写出假记录。只跳过这个瞬态，不要跳过整个 Pallet Town
        # （map_id 0 是合法的 Pallet Town）。
        if state.get("map_id") is None or trace.map_id != state.get("map_id"):
            return
        if state.get("map_id") == 0 and (state.get("x"), state.get("y")) == (0, 0):
            return
        snap = trace.snapshot((state.get("x"), state.get("y")), state.get("map"))
        if not snap:
            return
        rec = {"kind": "sight", **snap, "t": round(t, 3)}
        with open(self.run_dir / "spatial.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self._json({"ok": True, "frames": self.emu.frames, "actions": len(self.actions), "rom": self.emu.rom.name, "cgb": runtime.CGB, "img_scale": runtime.IMG_SCALE, "shot": runtime.LAST_SHOT, "state": self.emu.state().get("map")})
        if url.path == "/states":
            return self._json({"states": sorted(p.stem for p in STATES.glob("*.state"))})
        if url.path == "/screen.png":
            with _lock:
                buf = io.BytesIO()
                shot(self.emu).save(buf, "PNG")
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if url.path == "/anim.gif":
            with _lock:
                frames = [f.copy() for f in self.emu.last_frames]
                if not frames:
                    frames = [self.emu.pyboy.screen.image.convert("P").copy()]
            if not frames:
                return self._json({"error": "no frames captured yet"}, 404)
            frames = [shot(self.emu, f) for f in frames]
            buf = io.BytesIO()
            frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=45, loop=0)
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if url.path == "/transcript":
            q = parse_qs(url.query)
            run = q["run"][0] if "run" in q else None
            return self._json(read_transcript(run))
        if url.path == "/anim.json":
            with _lock:
                frames = [f.copy() for f in self.emu.last_frames]
                if not frames:
                    frames = [self.emu.pyboy.screen.image.convert("P").copy()]
                seq = self.emu.frames
            out = []
            for f in frames:
                buf = io.BytesIO()
                shot(self.emu, f).save(buf, "PNG")
                out.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
            return self._json({"seq": seq, "frames": out})
        if url.path == "/live":
            page_file = Path(__file__).resolve().parent / "live.html"
            page = (page_file.read_text(encoding="utf-8") if page_file.exists()
                    else "<!doctype html><meta charset='utf-8'><h1>server/live.html missing</h1>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return
        if url.path == "/observe":
            with _lock:
                q = parse_qs(url.query)
                radius = int(q["radius"][0]) if "radius" in q else None
                return self._json(observe(self.emu, radius))
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            body = self._read_body()
        except Exception as exc:
            return self._json({"error": f"bad json: {exc}"}, 400)
        if url.path == "/tick":
            with _lock:
                frames = int(body.get("frames", 60))
                self.emu.tick(frames)
                return self._json({"ok": True, "frames": self.emu.frames})
        if url.path == "/act":
            return self._act(body)
        if url.path == "/program":
            with _lock:
                if body.get("plan"):
                    steps = parse_plan(body["plan"])
                else:
                    steps = body.get("steps") or []
                if not isinstance(steps, list) or not steps:
                    return self._json({"error": "send {plan: \"up!;a;right!6\"} or {steps: [...]}"}, 400)
                trace = ActionTrace()
                log = run_program(self.emu, steps, trace=trace)
                now = round(time.time(), 3)
                if self.run_dir:
                    with open(self.run_dir / "actions.jsonl", "a", encoding="utf-8") as fh:
                        fh.write(json.dumps({"kind": "program", "steps": log, "t": now, "frames_total": self.emu.frames}, ensure_ascii=False) + "\n")
                self._record_sight(trace, now, self.emu.state())
                # Give the agent the current RAM state and local collision view too.
                # poke_program used to return only a screenshot + log, so the agent
                # had no material from which to maintain a spatial map.
                return self._json({"ok": True, "log": log, "frames": self.emu.frames,
                                   "trace": trace.render(), "samples": trace.frames,
                                   "state": observe(self.emu, None)})
        if url.path == "/save":
            with _lock:
                name = body.get("name") or f"snap_{int(time.time())}"
                path = self.emu.save(STATES / f"{name}.state")
                return self._json({"ok": True, "path": path})
        if url.path == "/load":
            with _lock:
                path = STATES / f"{body['name']}.state"
                if not path.exists():
                    return self._json({"error": f"no state {path.name}"}, 404)
                self.emu.load(path)
                self.emu.tick(1)
                ensure_terrain(self.emu, self.run_dir, self.emu.state())
                return self._json({"ok": True, "loaded": path.stem, "state": observe(self.emu, None)})
        if url.path == "/reset":
            with _lock:
                self.emu.stop()
                self.emu = new_emu()
                self.actions.clear()
                ensure_terrain(self.emu, self.run_dir, self.emu.state())
                return self._json({"ok": True, "frames": 0})
        return self._json({"error": "not found"}, 404)

    def _act(self, body: dict):
        with _lock:
            emu = self.emu
            trace = ActionTrace()
            trace.add(emu)
            before = _sig(emu)
            if "walk" in body:
                direction = body["walk"]
                tiles = max(0, int(body.get("tiles", 1)))
                moved, outcome = walk_until(emu, direction, "limit", limit=tiles, trace=trace) if tiles else (0, "limit")
                rec = {"kind": "walk", "dir": direction, "tiles": moved,
                       "outcome": outcome, "frames": 16 * moved}
            else:
                button = (body.get("button") or "").lower()
                frames = int(body.get("frames") or (16 if button in DIRS else 24))
                turned = pre_turn(emu, button, trace) if button in DIRS else 0
                # pre_turn 可能已经走完 1 格；按实际转身步数扣减剩余按住时间。
                remaining = max(0, frames - 16 * turned) if button in DIRS else frames
                if remaining > 0:
                    emu.press(button, remaining)
                rec = {"kind": "press", "button": button, "frames": frames}
            settled, auto = advance_to_decision(emu)
            trace.add(emu)
            changed = round(_diff_ratio(before, _sig(emu)), 4)
            now = round(time.time(), 3)
            rec.update({"t": now, "frames_total": emu.frames, "settled_frames": settled, "auto_advance": auto, "changed": changed})
            self.actions.append(rec)
            if self.run_dir:
                with open(self.run_dir / "actions.jsonl", "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self._record_sight(trace, now, self.emu.state())
            return self._json({"ok": True, "did": rec, "trace": trace.render(),
                               "samples": trace.frames, "state": observe(emu, None)})


_EMU_KW: dict = {}


def new_emu(**over):
    kw = dict(_EMU_KW)
    kw.update(over)
    return PokeEmu(**kw)


def serve(host="127.0.0.1", port=8765, state: str | None = None, run_dir: Path | None = None, window: str = "null", scale: int = 3, rom: str | None = None, sym: str | None = None, img_scale: int = 1):
    runtime.IMG_SCALE = max(1, int(img_scale))
    _EMU_KW.clear()
    _EMU_KW.update({"window": window, "scale": scale})
    if rom:
        _EMU_KW["rom"] = Path(rom)
    if sym:
        _EMU_KW["sym"] = Path(sym)
    emu = new_emu()
    runtime.CGB = is_cgb_rom(emu.rom)
    if state:
        p = STATES / f"{state}.state"
        if p.exists():
            emu.load(p)
    emu.tick(2)  # make sure the first screenshot has content
    Handler.emu = emu
    Handler.run_dir = run_dir
    if run_dir:
        run_dir.mkdir(parents=True, exist_ok=True)
        ensure_terrain(emu, run_dir, emu.state())
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"poke server on http://{host}:{port} rom={emu.rom.name} cgb={runtime.CGB} img_scale={runtime.IMG_SCALE} states={len(list(STATES.glob('*.state')))}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        emu.stop()


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--state", default=None)
    ap.add_argument("--run", default=None)
    ap.add_argument("--window", default="null", choices=["null", "SDL2", "OpenGL"])
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("--rom", default=None, help="ROM path (default: rom/pokered.gbc, the DMG build)")
    ap.add_argument("--sym", default=None, help="symbol file for that ROM")
    ap.add_argument("--img-scale", type=int, default=1, help="upscale agent-facing frames N times (nearest neighbour)")
    a = ap.parse_args()
    serve(port=a.port, state=a.state, run_dir=Path(a.run) if a.run else None,
          window=a.window, scale=a.scale, rom=a.rom, sym=a.sym, img_scale=a.img_scale)


if __name__ == "__main__":
    main()
