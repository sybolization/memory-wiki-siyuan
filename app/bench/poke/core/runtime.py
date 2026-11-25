"""进程级可变状态。

HTTP 服务启动时写入，渲染/观测只读。单独放一个模块，是为了避免
`core.rendering` 和 `server` 之间互相 import 才能共享 CGB/缩放状态。
"""
from __future__ import annotations

# 当前 ROM 是否为 CGB 构建；serve() 启动时设置。
CGB = False

# agent 看到的画面放大倍数；1 = 原生 160x144。
IMG_SCALE = 1

# 最近一帧的输出尺寸，/health 会返回，便于确认缩放是否生效。
LAST_SHOT = [0, 0]
