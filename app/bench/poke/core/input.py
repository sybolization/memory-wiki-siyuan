"""移动与决策原语。

不变量（这是整局坐标 bug 的根因，改动前先读）：
- 1 格 = 16px；wXCoord/wYCoord 已经是格坐标，禁止再除以 2。
- 方向键按住 16 帧；落步后必须等 wWalkCounter 归零，否则下一次按键会被吞。
- 反向转身可能已经走完 1 格；调用方必须用 pre_turn() 的返回值扣减。
- `!` 走到底才算 blocked；裸方向键只记录 pressed。
"""
from __future__ import annotations

import re

import numpy as np

from core import runtime

SETTLE_MAX = 240     # cap on frames spent waiting for an animation to finish after a press
SETTLE_CHUNK = 4
SETTLE_STABLE = 3    # consecutive unchanged chunks needed
SETTLE_FRAC = 0.01   # a chunk counts as unchanged if <1% of pixels differ (blinking arrows)


AUTO_ADVANCE_MAX = 16      # at most this many automatic A presses per agent action
AUTO_ADVANCE_FRAMES = 720  # and at most this much extra game time

# One agent action should end at a *decision point*, not at an arbitrary frame.
# Field screens settle in a fraction of a second; a battle turn auto-plays for many
# seconds (animations, HP bars, printed text) before the player is asked anything.
BATTLE_SETTLE_MAX = 1800
DECISION_CAP_FIELD = 600
DECISION_CAP_BATTLE = 2400
BATTLE_STABLE_CHUNKS = 15  # 15 x 4 frames = 60 still frames before a battle counts as idle


ARROW_TILES = (127, 238)  # blank box corner / blinking down-arrow glyph


def waiting_for_a(emu, samples=44):
    """True while a text box shows its blinking down-arrow (tile (18,16) toggles 127<->238).

    Menus (start menu, party menu, yes/no prompts) never blink that tile, so they are safe.
    """
    seen = set()
    for _ in range(samples):
        tm = emu.read("wTileMap", 360)
        seen.add(tm[16 * 20 + 18])
        if seen == set(ARROW_TILES):
            return True
        if seen - set(ARROW_TILES):
            return False
        emu.tick(1)
    return False


def box_visible(emu):
    """A text box is on screen: its bottom-right corner holds the blank-box tile."""
    return emu.read("wTileMap", 360)[16 * 20 + 18] in ARROW_TILES


def auto_advance_text(emu):
    """Collapse a whole dialogue: keep pressing A until the box closes.

    While text is still printing there is no arrow yet, so each page gets a bounded
    wait; menus such as yes/no never blink the arrow and are left to the agent.
    """
    presses = 0
    spend = 0
    while presses < AUTO_ADVANCE_MAX and spend < AUTO_ADVANCE_FRAMES:
        if not box_visible(emu):
            break
        waiting = False
        for _ in range(8):
            if waiting_for_a(emu, samples=10):
                waiting = True
                break
            emu.tick(6)
            spend += 6
            if spend >= AUTO_ADVANCE_FRAMES or not box_visible(emu):
                break
        if not waiting:
            break
        emu.press("a", 12)
        settle(emu)
        presses += 1
    return presses


DIRS = ("up", "down", "left", "right")

# Facing values stored in wSpritePlayerStateData1FacingDirection.
FACING = {"down": 0, "up": 4, "left": 8, "right": 12}
OPPOSITE = {"up": "down", "down": "up", "left": "right", "right": "left"}


def pre_turn(emu, direction, trace=None) -> int:
    """Turn around before walking when the player faces the opposite way.

    In Gen 1 an 8-frame press in the opposite direction usually only turns the
    sprite; no block is walked.  Without this, walk_until reported "blocked" on
    an open tile and the agent wrote false walls into memory.  90-degree turns
    step in the same press, so only reversals need the extra press.  Returns the
    blocks walked by this press (normally 0; the animation can finish a step).
    """
    facing = emu.byte("wSpritePlayerStateData1FacingDirection")
    if facing != FACING[OPPOSITE[direction]]:
        return 0
    map0 = emu.byte("wCurMap")
    p0 = _pos(emu)
    emu.pyboy.button_press(direction)
    emu.tick(8)
    emu.pyboy.button_release(direction)
    emu.tick(2)
    walk_settle(emu)
    settle(emu)
    if trace is not None:
        trace.add(emu)
    if emu.byte("wCurMap") != map0:
        return 0
    p1 = _pos(emu)
    return abs(p1[0] - p0[0]) + abs(p1[1] - p0[1])


def parse_plan(text):
    """Agent-authored action script, one token per step.

    up | up:40 | up! (until blocked, max 10) | up!6 (max 6 blocks)
    a | a:48 | b | start | select | wait:60
    """
    steps = []
    for tok in re.split(r"[;,\n]+", str(text or "")):
        tok = tok.strip().lower()
        if not tok:
            continue
        m = re.match(r"^([a-z]+)\s*(?:(!)(\d*)|:(\d+))?\s*$", tok)
        if not m:
            steps.append({"button": tok, "outcome": "bad_token"})
            continue
        name, bang, bang_n, colon_n = m.groups()
        if name == "wait":
            steps.append({"button": "wait", "frames": int(bang_n or colon_n or 60)})
            continue
        step = {"button": name}
        if bang:
            step["until"] = "blocked"
            step["max_tiles"] = int(bang_n) if bang_n else 10
        elif colon_n:
            step["frames"] = int(colon_n)
        steps.append(step)
    return steps


def _block_pos(emu):
    """Player position in 16px map blocks.

    wXCoord/wYCoord are already this grid: one step moves 1 unit and scrolls
    the camera 16px, and warp entries share the units.  The map header's
    20x18 is in 32px Gen 1 blocks (= 40x36 cells here).  Never divide by two:
    that halved the map, ate every other press and fabricated 'blocked' walls.
    """
    return (emu.byte("wXCoord"), emu.byte("wYCoord"))


def _pos(emu):
    return _block_pos(emu)


def walk_settle(emu, limit=40):
    """Tick until the overworld step animation has fully finished.

    wWalkCounter counts 8..1 across the 16 frames of one 16px block.  A
    direction press that arrives while it is still counting is discarded by
    the game, so chaining presses without this gate dropped every other
    input: 'up;up' moved one block, and 'up!' reported open floor as
    'blocked' as soon as the second press was swallowed.  settle() alone
    cannot see a step that scrolls the camera only 1px per 2 frames, so it
    declares the screen idle and returns mid-step.
    """
    waited = 0
    while emu.byte("wWalkCounter") and waited < limit:
        emu.tick(2)
        waited += 2
    return waited


def walk_until(emu, direction, until="blocked", limit=10, trace=None):
    """One decision, several steps: hold a direction until the world answers.

    until: blocked | battle | map_change | dialogue | limit
    Returns (blocks_moved, outcome).
    """
    tiles = pre_turn(emu, direction, trace)
    start_map = emu.byte("wCurMap")
    start = _pos(emu)
    if tiles >= limit:
        return tiles, "limit"
    retried = False
    while tiles < limit:
        if until == "battle" and emu.byte("wIsInBattle"):
            return tiles, "battle"
        emu.pyboy.button_press(direction)
        # 16 frames = one full 16px step.  8 frames starts the animation but
        # releases before the coordinate commits, so the step is canceled on
        # some frames and the same press looks "eaten".  17+ frames can start
        # a second step, so 16 is the exact value.
        emu.tick(16)
        emu.pyboy.button_release(direction)
        emu.tick(2)
        walk_settle(emu)
        settle(emu)
        now = _pos(emu)
        if emu.byte("wCurMap") != start_map:
            if trace is not None:
                trace.add(emu)
            return tiles, "map_change"
        if emu.byte("wIsInBattle"):
            if trace is not None:
                trace.add(emu)
            return tiles, "battle"
        if now == start:
            if tiles == 0 and not retried:
                # First press may only have turned the sprite (a reversal whose
                # facing byte was stale).  One retry distinguishes turn from wall.
                retried = True
                continue
            if trace is not None:
                trace.add(emu)
                trace.mark_blocked(direction)
            return tiles, "blocked"
        tiles += abs(now[0] - start[0]) + abs(now[1] - start[1])
        start = now
        # Presentation only: keep one frame per tile so /anim.json can replay the
        # walk. Movement steps used to tick without capture, which left the live
        # page replaying an old frame forever.
        if emu.capture:
            emu.last_frames.append(emu.pyboy.screen.image.convert("P").copy())
        if trace is not None:
            trace.add(emu)
        if until == "dialogue" and box_visible(emu):
            return tiles, "dialogue"
    return tiles, "limit"


def run_program(emu, steps, trace=None):
    """Execute an agent-authored plan: a list of {button, frames?, until?, max_tiles?}.

    A plan that starts inside a battle runs to the end of the script: each press is
    followed by advance_to_decision, so one step means one battle decision (pick a move,
    clear a text page, answer a prompt). A plan that starts in the field still stops as
    soon as a wild encounter or trainer battle interrupts it, because the remaining
    steps were written for walking, not for a menu.
    """
    log = []
    start_in_battle = bool(emu.byte("wIsInBattle"))
    if trace is not None:
        trace.add(emu)
    for i, st in enumerate(steps[:40]):
        btn = str(st.get("button") or "").lower()
        frames = int(st.get("frames") or (16 if btn in DIRS else 24))
        until = st.get("until")
        if emu.capture:
            emu.last_frames = []
        entry = {"step": i, "button": btn}
        before = _sig(emu)
        p0 = _pos(emu)
        map0 = emu.byte("wCurMap")
        in_battle = bool(emu.byte("wIsInBattle"))
        if btn in DIRS and until in ("blocked", "battle", "map_change", "dialogue", "limit") and not in_battle:
            max_tiles = st.get("max_tiles")
            limit = 10 if max_tiles is None else max(0, int(max_tiles))
            tiles, outcome = walk_until(emu, btn, until, limit, trace=trace)
            entry.update({"tiles": tiles, "outcome": outcome})
            if outcome == "battle":
                used, auto = advance_to_decision(emu)
                entry.update({"frames_used": used, "auto_advance": auto})
                if trace is not None:
                    trace.add(emu)
        elif btn == "wait":
            # waiting must never sit on a text box that is waiting for A
            left = frames
            pressed = 0
            while left > 0:
                if waiting_for_a(emu, samples=10):
                    emu.press("a", 12)
                    settle(emu)
                    left -= 20
                    pressed += 1
                    continue
                chunk = min(8, left)
                emu.tick(chunk)
                left -= chunk
            entry.update({"tiles": 0, "outcome": "waited" + (("+advanced" + str(pressed)) if pressed else "")})
            if trace is not None:
                trace.add(emu)
        elif btn in DIRS or btn in ("a", "b", "start", "select"):
            turned = 0
            if btn in DIRS:
                turned = pre_turn(emu, btn, trace)
            # pre_turn 的 8 帧转身可能已经走完 1 格。旧的 `frames <= 8`
            # 判断在默认 16 帧后永远为假，会让单次方向键多走一格。
            # 按“转身已经走了几格”扣减剩余按住时间。
            remaining = max(0, frames - 16 * turned) if btn in DIRS else frames
            if remaining <= 0:
                used, auto = 0, 0
            else:
                emu.press(btn, remaining)
                if btn in DIRS:
                    walk_settle(emu)
                used, auto = advance_to_decision(emu)
            entry.update({"tiles": 0, "outcome": "advanced_dialogue" if auto else "pressed",
                          "auto_advance": auto, "frames_used": used})
            if btn in DIRS and emu.byte("wCurMap") == map0:
                p1 = _pos(emu)
                entry["tiles"] = abs(p1[0] - p0[0]) + abs(p1[1] - p0[1])
            if trace is not None:
                trace.add(emu)
        else:
            entry.update({"tiles": 0, "outcome": "bad_button"})
            log.append(entry)
            break
        entry["changed"] = round(_diff_ratio(before, _sig(emu)), 4)
        entry["map"] = emu.state().get("map")
        entry["pos"] = list(_pos(emu))
        log.append(entry)
        if not start_in_battle and emu.byte("wIsInBattle"):
            break
    if len(steps) > 40:
        # 不要静默丢掉多余 token：agent 会以为脚本全部执行了。
        log.append({"step": 40, "button": "", "tiles": 0,
                    "outcome": "truncated", "dropped": len(steps) - 40})
    return log


def _sig(emu):
    return np.asarray(emu.pyboy.screen.image.convert("RGB"), dtype=np.uint8)


def settle(emu, max_frames=None):
    """Advance until the screen stops moving, so one action always yields a settled frame.

    The emulator only advances when something is asked of it, so without this the agent
    sees half-drawn text boxes and mid-fade frames and mistakes them for a stuck game.
    """
    budget = SETTLE_MAX if max_frames is None else max_frames
    prev = _sig(emu)
    used = 0
    stable = 0
    while used < budget:
        emu.tick(SETTLE_CHUNK)
        used += SETTLE_CHUNK
        cur = _sig(emu)
        stable = stable + 1 if _diff_ratio(prev, cur) < SETTLE_FRAC else 0
        prev = cur
        if stable >= SETTLE_STABLE:
            break
    return used


def advance_to_decision(emu):
    """Keep making progress until the game actually needs the player to choose.

    A press inside a battle turn does not "do nothing": it lands in an animation that
    plays itself for several seconds (attack, HP bars, printed text). Stopping after one
    settle() left the agent staring at frozen mid-turn frames and pressing buttons into
    the void, so one action now runs until the screen really is idle and nothing is
    waiting for A. Battle screens need a longer stillness test: mid-animation pauses of
    a few frames are common, a real decision point stays still for about a second.
    Returns (frames_used, auto_presses).
    """
    battle = bool(emu.byte("wIsInBattle"))
    cap = DECISION_CAP_BATTLE if battle else DECISION_CAP_FIELD
    need = BATTLE_STABLE_CHUNKS if battle else SETTLE_STABLE
    total = 0
    presses = 0
    stable = 0
    prev = _sig(emu)
    while total < cap:
        emu.tick(SETTLE_CHUNK)
        total += SETTLE_CHUNK
        cur = _sig(emu)
        if _diff_ratio(prev, cur) < SETTLE_FRAC:
            stable += 1
        else:
            stable = 0
        prev = cur
        if stable < need:
            continue
        # Battle text is auto-advanced on DMG too: a battle step should end at the
        # FIGHT/move menu, not after every printed line. auto_advance_text is a no-op
        # when the blinking text arrow is never seen, so a detection failure costs nothing.
        if (runtime.CGB or battle) and auto_advance_text(emu):
            presses += 1
            total += SETTLE_MAX
            prev = _sig(emu)
            stable = 0
            continue
        break
    return total, presses


def _diff_ratio(before, after):
    """Fraction of screen channel values that changed between two signatures."""
    if before is None or after is None or before.shape != after.shape:
        return 1.0
    return float(np.count_nonzero(before != after)) / float(before.size)
