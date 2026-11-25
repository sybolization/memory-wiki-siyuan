"""画面渲染：给 agent 的 PNG、玩家标记、背景裁剪。

只依赖 PyBoy 画面和 runtime 里的缩放状态，不读游戏 RAM 的移动状态。
"""
from __future__ import annotations

from PIL import Image, ImageDraw, ImageFont

from core.colorize import colorize
from core import runtime

_FONT = ImageFont.load_default()
_MARK = (220, 30, 30)


def annotate(img, rect):
    """Mark the player sprite so the agent can tell which sprite is itself."""
    if not rect:
        return img
    x, y = rect
    d = ImageDraw.Draw(img)
    d.rectangle([x - 1, y - 1, x + 16, y + 16], outline=_MARK, width=1)
    label = "YOU"
    bbox = d.textbbox((0, 0), label, font=_FONT)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    lx = min(max(0, x + 8 - w // 2), img.width - w - 2)
    ly = y - h - 6
    if ly < 1:
        ly = y + 18
    if ly + h + 1 > img.height:
        ly = max(1, y - h - 6)
    d.rectangle([lx - 1, ly - 1, lx + w + 1, ly + h + 1], fill=(255, 255, 255), outline=_MARK)
    d.text((lx, ly), label, fill=_MARK, font=_FONT)
    return img


def is_cgb_rom(path) -> bool:
    with open(path, "rb") as fh:
        fh.seek(0x143)
        flag = fh.read(1)
    return bool(flag and (flag[0] & 0x80))


def render(emu, frame=None):
    """The frame the agent sees: authentic colour on a CGB build, synthetic palette on DMG."""
    if runtime.CGB:
        img = frame if frame is not None else emu.pyboy.screen.image
        return img.convert("RGB")
    return colorize(emu, frame)


def trim_void(img):
    """Crop pure-backdrop border bands (map smaller than the viewport) so those
    grey pixels do not cost image tokens. Only whole 8px tile bands are removed,
    and only when the colour is a flat dark backdrop covering the outer ring."""
    from collections import Counter

    w, h = img.size
    px = img.load()
    ring = Counter()
    for x in range(w):
        ring[px[x, 0]] += 1
        ring[px[x, h - 1]] += 1
    for y in range(h):
        ring[px[0, y]] += 1
        ring[px[w - 1, y]] += 1
    color, n = ring.most_common(1)[0]
    if n / (2 * w + 2 * h - 4) < 0.6:  # no uniform border: normal scrolling map
        return img
    r, g, b = color
    if not (r == g == b and r < 120):  # only flat dark backdrops, never white menus
        return img
    cnt = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if px[x, y] == color:
                cnt += 1
    if cnt / ((h // 2 + 1) * (w // 2 + 1)) < 0.25:
        return img

    def col_all(x0):
        return all(px[x0, y] == color for y in range(0, h, 2))

    def row_all(y0):
        return all(px[x, y0] == color for x in range(0, w, 2))

    left, top, right, bottom = 0, 0, w, h
    step = 8
    min_w, min_h = 112, 88  # never crop below most of the native viewport
    while right - left - step >= min_w and col_all(right - 1):
        right -= step
    while right - left - step >= min_w and col_all(left):
        left += step
    while bottom - top - step >= min_h and row_all(bottom - 1):
        bottom -= step
    while bottom - top - step >= min_h and row_all(top):
        top += step
    if (left, top, right, bottom) == (0, 0, w, h):
        return img
    return img.crop((left, top, right, bottom))


def shot(emu, frame=None):
    """One agent-facing frame: rendered, YOU marker drawn, then upscaled.

    No cropping: the ASCII view is the same 160x144 screen, so pixel counting and
    block counting must share one coordinate system.
    """
    rect = None if emu.byte("wIsInBattle") else emu.player_rect()
    img = annotate(render(emu, frame), rect)
    if runtime.IMG_SCALE > 1:
        img = img.resize((img.width * runtime.IMG_SCALE, img.height * runtime.IMG_SCALE), Image.NEAREST)
    runtime.LAST_SHOT[0], runtime.LAST_SHOT[1] = img.width, img.height
    return img
