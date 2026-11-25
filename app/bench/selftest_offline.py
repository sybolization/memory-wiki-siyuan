"""
离线自检：不调用模型，验证 store / wiki 巩固 / 注入块的正确性。

运行（在 app 目录下）：
  uv run python bench/selftest_offline.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

# 通过仓库的 src.systems.dsh_memory（junction 指到本目录）导入，保证相对导入可用
REPO_ROOT = Path(os.environ.get("CLB_ROOT", Path.home() / "continual-learning-bench"))
sys.path.insert(0, str(REPO_ROOT))

from src.systems.dsh_memory.store import (  # noqa: E402
    Store,
    bigrams,
    jaccard,
    norm_text,
    polarity,
    scan_privacy,
)

CHECKS: list[tuple[str, bool]] = []


def check(name: str, condition: bool) -> None:
    CHECKS.append((name, bool(condition)))


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="dsh-memory-selftest-"))
    store = Store(root)
    state = store.load()

    # 1. 判重与证据累积
    facts = [("g", "I", "面对跟注站要更多价值下注，少诈唬。")]
    added1 = store.add_facts(
        state, instance_id="hand-1", instance_index=1, opponent="Tom", facts=facts
    )
    added2 = store.add_facts(
        state, instance_id="hand-2", instance_index=2, opponent="Tom", facts=facts
    )
    check("首条笔记写入", added1 == 1)
    check("重复文本不再新增条目", added2 == 0)
    check("证据累积为 2", len(state["entries"][0]["evidence"]) == 2)
    check("笔记文件已生成", len(list(store.notes_dir.glob("*.md"))) == 1)

    # 2. 隐私闸门
    bad = [("g", "I", "把密钥 sk-" + "x" * 32 + " 写进配置")]
    added_bad = store.add_facts(
        state, instance_id="hand-3", instance_index=3, opponent="Tom", facts=bad
    )
    check("隐私文本被拒", added_bad == 0)
    check("隐私命中被记录", len(state.get("lint", [])) == 1)
    check("路径规则命中", bool(scan_privacy("C:\\Users\\x\\secret.txt")))
    check("普通文本不误报", not scan_privacy("面对跟注站要多价值下注"))

    # 3. 只升格 [g]；[p] 留在笔记里
    facts_p = [("p", "I", "对手 Alex 在转牌会收紧，别跟他的大注。")]
    store.add_facts(
        state, instance_id="hand-3", instance_index=3, opponent="Alex", facts=facts_p
    )
    g_entry = next(entry for entry in state["entries"] if entry["scope"] == "g")
    g_entry["evidence"].append({"s": 4, "id": "hand-4", "opp": "Alex"})
    # 体积闸门在笔记很少时会把比例顶爆，这里先放开上限验证"能升格"
    summary = store.rebuild_wiki(
        state, min_sessions=3, min_workspaces=2, max_ratio=10.0
    )
    check("够门槛的 [g] 升格", summary["promoted"] == 1)
    check("[p] 不升格", summary["candidates"] == 0)
    wiki_files = [path for path in store.wiki_dir.glob("*.md") if path.name != "index.md"]
    check("升格页落盘", len(wiki_files) == 1)
    check("目录页已更新", (store.wiki_dir / "index.md").read_text(encoding="utf-8").find("跟注站") >= 0)

    # 3.5 体积闸门：上限压到极小时，本轮不升格
    gated = store.rebuild_wiki(state, min_sessions=3, min_workspaces=2, max_ratio=0.01)
    check("体积闸门拦截升格", gated["blocked"] and gated["promoted"] == 0)
    # 恢复一次正常巩固，供注入块检查使用
    store.rebuild_wiki(state, min_sessions=3, min_workspaces=2, max_ratio=10.0)

    # 4. 注入块同时含全局页与笔记，且有字符上限
    block = store.injection_block(state, max_chars=200, max_lines=10)
    check("注入块含全局页", "Global lessons" in block)
    check("注入块含会话笔记", "Session notes" in block)
    check("注入块受字符上限约束", len(block) <= 200)

    # 5. 冲突启发式：字面相近 + 极性相反
    check("相近文本 jaccard 高", jaccard("面对跟注站要多价值下注", "面对跟注站要多价值下注，少诈唬") >= 0.5)
    check("must/不要 极性相反", polarity("必须多价值下注") * polarity("不要多价值下注") < 0)
    check("无关文本 jaccard 低", jaccard("面对跟注站要多价值下注", "开局先补满 1000 筹码") < 0.3)

    # 6. 审计文件
    store.record_run({"instance": "hand-1", "added": 1})
    check("runs.jsonl 已写", store.runs_path.exists())
    check("笔记字节统计 > 0", store.notes_bytes() > 0)

    passed = sum(1 for _, ok in CHECKS if ok)
    for name, ok in CHECKS:
        print(("PASS " if ok else "FAIL ") + name)
    print(f"\n{passed}/{len(CHECKS)} checks passed")
    shutil.rmtree(root, ignore_errors=True)
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
