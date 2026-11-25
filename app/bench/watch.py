"""CL-Bench 运行进度监视器（中文终端界面）。

在 continual-learning-bench 仓库目录下运行：

    uv run python bench/watch.py
    uv run python bench/watch.py --once     # 只打印一屏
    uv run python bench/watch.py --lines    # 每完成一题追加一行

数据来源：results/<task>/live/<run_group>/ 下的 manifest.json 与 run_*.json，
外加最新 dsh-memory 临时目录里的 runs.jsonl / notes / index.json。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

CLB_ROOT = Path(os.environ.get("CLB_ROOT", Path.home() / "continual-learning-bench"))
TEMP_ROOT = Path(os.environ.get("TEMP", Path.home() / "AppData" / "Local" / "Temp"))


# ---------------------------------------------------------------- 读取快照
def _newest_dir(parent: Path, pattern: str) -> Path | None:
    if not parent.is_dir():
        return None
    items = [p for p in parent.glob(pattern) if p.is_dir()]
    return max(items, key=lambda p: p.stat().st_mtime) if items else None


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def latest_live(task: str, group: str | None = None) -> Path | None:
    parent = CLB_ROOT / "results" / task / "live"
    if group:
        candidate = parent / group
        return candidate if candidate.is_dir() else None
    return _newest_dir(parent, "*")


def find_run_file(live_dir: Path, manifest: dict) -> Path | None:
    for entry in manifest.get("runs") or []:
        rel = entry.get("trace_path")
        if rel:
            path = CLB_ROOT / rel
            if path.is_file():
                return path
    candidates = sorted(live_dir.glob("run_*.json"))
    return candidates[0] if candidates else None


def memory_stats() -> dict:
    dirs = []
    if TEMP_ROOT.is_dir():
        for pattern in ("dsh-memory-*", "agent-memory-*"):
            dirs.extend(p for p in TEMP_ROOT.glob(pattern) if p.is_dir())
    if not dirs:
        return {}
    newest = max(dirs, key=lambda p: p.stat().st_mtime)
    stats = {"dreams": 0, "notes": 0, "entries": 0, "candidates": 0}
    runs_file = newest / "runs.jsonl"
    if runs_file.is_file():
        lines = [ln for ln in runs_file.read_text(encoding="utf-8", errors="ignore").splitlines() if ln.strip()]
        stats["dreams"] = len(lines)
        if lines:
            try:
                last = json.loads(lines[-1])
                stats["candidates"] = int(last.get("candidates") or 0)
            except json.JSONDecodeError:
                pass
    notes_dir = newest / "notes"
    if notes_dir.is_dir():
        stats["notes"] = len(list(notes_dir.glob("*.md")))
    index_file = newest / "index.json"
    if index_file.is_file():
        data = _load_json(index_file) or {}
        stats["entries"] = len(data.get("entries") or [])
    return stats


# ---------------------------------------------------------------- 渲染
BAR_FULL = "▇"
BAR_EMPTY = "·"


def bar(value: float, width: int = 8) -> str:
    filled = max(0, min(width, round(value * width)))
    return BAR_FULL * filled + BAR_EMPTY * (width - filled)


def fmt_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds} 秒"
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes} 分 {sec:02d} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes:02d} 分"


def render(task: str, group: str | None = None) -> str:
    live_dir = latest_live(task, group)
    if live_dir is None:
        return f"还没有找到 {task} 的 live 快照，等运行开始后再试。"

    manifest = _load_json(live_dir / "manifest.json") or {}
    run_file = find_run_file(live_dir, manifest)
    run = _load_json(run_file) if run_file else {}
    run = run or {}

    task_cfg = (manifest.get("task") or {}).get("params") or {}
    total = int(task_cfg.get("expected_num_instances") or task_cfg.get("num_questions") or 0)
    model = ((manifest.get("system") or {}).get("params") or {}).get("model") or "?"

    outcomes = run.get("instance_outcomes") or []
    rewards = [float(o.get("reward") or 0.0) for o in outcomes]
    queries = [
        int(((o.get("metadata") or {}).get("num_queries")) or 0) for o in outcomes
    ]
    regrets = [
        float(((o.get("metadata") or {}).get("regret")) or 0.0) for o in outcomes
    ]
    latencies = [float(o.get("latency_seconds") or 0.0) for o in outcomes]
    successes = [bool(o.get("success")) for o in outcomes]

    done = len(outcomes)
    mean_reward = sum(rewards) / done if done else 0.0
    accuracy = (sum(1 for s in successes if s) / done) if done else 0.0
    total_regret = sum(regrets)
    mean_latency = sum(latencies) / done if done else 0.0
    status = manifest.get("status") or run.get("status") or "?"
    phase = manifest.get("phase") or run.get("phase") or "?"
    mem = memory_stats()

    lines: list[str] = []
    lines.append("CL-Bench 实时进度 · 数据库探查")
    lines.append("═" * 58)
    lines.append(f"任务 {task}    模型 {model.split('/')[-1]}")
    lines.append(f"状态 {status}    阶段 {phase}")
    lines.append("")
    lines.append(f"已完成   {done} / {total if total else '?'} 题")
    interactions = run.get("interactions") or []
    used_actions = sum(
        int(((o.get("metadata") or {}).get("num_actions")) or 0) for o in outcomes
    )
    pending_steps = max(0, len(interactions) - used_actions)
    if done < total and pending_steps:
        lines.append(f"进行中   第 {done + 1} 题，已查询 {pending_steps} 次（预算 15 次）")
    if done:
        lines.append(f"平均得分 {mean_reward:.3f} {bar(mean_reward)}")
        lines.append(f"正确率   {accuracy * 100:.1f}%    累计后悔值 {total_regret:.1f}")
        lines.append(f"平均耗时 {fmt_duration(mean_latency)} / 题")
        if total and done < total and mean_latency > 0:
            remain = mean_latency * (total - done)
            lines.append(f"预计剩余 约 {fmt_duration(remain)}")
    lines.append("")
    if mem:
        lines.append(
            f"记忆   dream {mem.get('dreams', 0)} 次 · 笔记 {mem.get('notes', 0)} 篇 "
            f"· 事实 {mem.get('entries', 0)} 条 · 候选 {mem.get('candidates', 0)} 条"
        )
    else:
        lines.append("记忆   （还没找到本次运行的记忆目录）")
    lines.append("─" * 58)

    if not done:
        lines.append("还没有完成任何实例，模型正在探索第一题……")
        return "\n".join(lines)

    lines.append("逐题明细（最近 10 题）")
    lines.append(" 序号   得分   查询   难度   耗时        结果")
    recent = list(range(max(0, done - 10), done))
    difficulty_cn = {"hard": "难", "medium": "中", "easy": "易"}
    for idx in recent:
        outcome = outcomes[idx]
        num = int(outcome.get("instance_index") or idx) + 1
        reward = rewards[idx]
        raw_difficulty = str(((outcome.get("metadata") or {}).get("difficulty")) or "-").lower()
        difficulty = difficulty_cn.get(raw_difficulty, raw_difficulty[:2])
        result = "答对" if successes[idx] else "答错/超时"
        lines.append(
            f" {num:>4}  {reward:+.3f}  {queries[idx]:>4}   {difficulty:<2}   "
            f"{fmt_duration(latencies[idx]):<10} {result}"
        )
    if done > len(recent):
        lines.append(f" （更早的 {done - len(recent)} 题已省略）")
    lines.append("─" * 58)
    lines.append("得分 = 1 − 查询次数 / 15；答错或超过查询预算计 0 分。")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="CL-Bench 中文进度监视器")
    parser.add_argument("--task", default="database_exploration")
    parser.add_argument("--group", default=None, help="指定 live 分组目录名（同时跑多个实验时用）")
    parser.add_argument("--interval", type=float, default=3.0)
    parser.add_argument("--once", action="store_true", help="打印一屏后退出")
    parser.add_argument("--lines", action="store_true", help="每完成一题追加一行")
    args = parser.parse_args()

    is_tty = sys.stdout.isatty() and not args.lines and not args.once
    seen: set[str] = set()
    started = time.time()

    while True:
        text = render(args.task, args.group)
        if args.lines:
            live_dir = latest_live(args.task, args.group)
            manifest = (_load_json(live_dir / "manifest.json") if live_dir else None) or {}
            run_file = find_run_file(live_dir, manifest) if live_dir else None
            run = (_load_json(run_file) if run_file else {}) or {}
            for outcome in run.get("instance_outcomes") or []:
                key = str(outcome.get("instance_id") or outcome.get("instance_index"))
                if key in seen:
                    continue
                seen.add(key)
                num = int(outcome.get("instance_index") or 0) + 1
                reward = float(outcome.get("reward") or 0.0)
                nq = int(((outcome.get("metadata") or {}).get("num_queries")) or 0)
                mark = "正确" if outcome.get("success") else "错误"
                print(
                    f"[{time.strftime('%H:%M:%S')}] 第 {num} 题 {mark}  "
                    f"得分 {reward:+.3f}  查询 {nq} 次  累计 {len(seen)} 题",
                    flush=True,
                )
        elif is_tty:
            print("\x1b[2J\x1b[H" + text, flush=True)
        else:
            print(text, flush=True)
        if args.once:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
