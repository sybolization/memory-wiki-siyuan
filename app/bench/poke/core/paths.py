"""bench/poke 下的统一路径。

不要在其它模块里用 `Path(__file__).parent / ".."` 各自拼路径：
重构目录时路径会跟着文件位置漂移。所有目录都从这里取。
"""
from __future__ import annotations

from pathlib import Path

# core/ 的上一级就是 bench/poke。
ROOT = Path(__file__).resolve().parent.parent

DATA = ROOT / "data"
ROM = ROOT / "rom" / "pokered.gbc"
SYM = ROOT / "rom" / "pokered.sym"
STATES = ROOT / "states"
RUNS = ROOT / "runs"
CONFIG = ROOT / "config"

# 保证目录存在；states/runs 也可能由脚本提前创建。
STATES.mkdir(exist_ok=True)
CONFIG.mkdir(exist_ok=True)


def state_file(name: str) -> Path:
    """把存档名（不带 .state）转成绝对路径。"""
    return STATES / f"{name}.state"


def run_dir(name: str) -> Path:
    """把 run 名转成 runs/<name> 绝对路径。"""
    return RUNS / name
