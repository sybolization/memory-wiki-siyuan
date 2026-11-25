"""
dsh_memory/dream.py — 会话级判断器（对应插件 dream 的"判断子会话"阶段）。

输入：一个 instance（一个任务实例）的决策记录、结果反馈，以及当前已有笔记清单；
输出：新提取的可复用知识、对旧笔记的撤回/改写指令，以及一个 billable usage 事件。
本模块只做"提取与维护"，不做跨会话合并（那是 store.rebuild_wiki 的职责）。
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field

from ..utils import completion_with_structured_output


class JudgeFact(BaseModel):
    """一条待写入记忆的事实。"""

    text: str = Field(description="一条可复用的知识，≤ 60 字，中文短句")
    verified: bool = Field(
        default=False,
        description="是否能在本次的查询结果或裁判反馈里直接看到；推测必须为 false",
    )


class JudgeCorrection(BaseModel):
    """对某条已有笔记的改写。"""

    index: int = Field(description="已有笔记的编号（从 1 开始）")
    text: str = Field(description="改写后的完整内容，≤ 60 字")


class JudgeFacts(BaseModel):
    """判断器的结构化输出。"""

    facts: list[JudgeFact] = Field(
        default_factory=list,
        description="本次能提取的可复用知识，最多 6 条；没有就返回空列表",
    )
    retract: list[int] = Field(
        default_factory=list,
        description="本次结果证明是错的旧笔记编号（1-based）；没有就空",
    )
    corrections: list[JudgeCorrection] = Field(
        default_factory=list,
        description="方向对但需要修正的旧笔记；没有就空",
    )


JUDGE_SYSTEM = """\
你是一个谨慎的记忆整理器：从一个任务实例的过程与结果里，提取下一次同类任务能直接复用的知识，\
同时维护已有笔记，而不是复述过程。

判断标准只有一条：这条知识能不能让下一次少试错——少查一次表、少猜一次单位、避开一个已知的坑。

规则：
1. 优先记录结构级事实：表/列/字段的含义、单位、编码、所属分组、可用的连接键。
2. 只有能在本次查询结果或裁判反馈里直接看到的内容，才标 verified=true；任何推测标 verified=false。
3. 禁止把本题的最终答案、单次统计数字写成事实，除非它揭示了可复用的换算规则或命名规律。
4. 答错时写"错因 → 正确做法"，不要把错误答案或错误推理记成事实。
5. 不写文件路径、密钥、账号等隐私信息。
6. 每条 ≤ 60 字，中文短句；没有值得记的就返回空列表。最多 6 条。
7. 你会看到"已有笔记"的编号清单。如果本次结果明确证明某条旧笔记是错的，把编号写进 retract。
8. 如果某条旧笔记方向对但措辞/细节需要修正，在 corrections 里给出编号与改写后的完整文本。
9. 不要为了"整理"而撤回正确的笔记；没有把握就不改。
"""


def build_digest(
    turns: list[dict[str, Any]],
    observation: str,
    *,
    task_hint: str = "",
    memory_lines: list[str] | None = None,
    max_chars: int = 12000,
) -> str:
    """把一个实例的决策轨迹和结果压成判断器输入（头部 40%、尾部 60%）。"""
    parts: list[str] = []
    if task_hint:
        parts.append(f"[task] {task_hint}")
    if memory_lines:
        parts.append("[已有笔记]\n" + "\n".join(memory_lines))
    for index, turn in enumerate(turns[-8:], start=1):
        parts.append(
            f"[{index}] state: {turn.get('prompt', '')[:600]}\n"
            f"    action: {turn.get('action', '')}"
        )
    if observation:
        parts.append(f"[result] {observation[:1600]}")
    digest = "\n\n".join(parts)
    if len(digest) <= max_chars:
        return digest
    head = max_chars * 2 // 5
    tail = max_chars - head
    return f"{digest[:head]}\n…(middle omitted)…\n{digest[-tail:]}"


def run_judge(
    model: str,
    digest: str,
    *,
    task_hint: str = "",
) -> tuple[list[tuple[str, str, str]], dict[str, Any], Any | None, str | None]:
    """调用判断模型；返回 (facts, ops, usage_event, error)。

    facts 元素形如 (scope, confidence, text)：
    - scope: "g" 跨实例可复用 / "p" 只对当前上下文有效；
    - confidence: "V" 已验证 / "I" 推测 / "U" 未经验证。
    ops 形如 {"retract": [int], "corrections": [(int, str)]}。
    """
    if not digest.strip():
        return [], {"retract": [], "corrections": []}, None, "empty digest"
    messages = [
        {"role": "system", "content": JUDGE_SYSTEM},
        {
            "role": "user",
            "content": (f"任务类型：{task_hint}\n\n" if task_hint else "")
            + f"决策轨迹与结果：\n\n{digest}",
        },
    ]
    try:
        parsed, usage = completion_with_structured_output(
            model=model,
            messages=messages,
            response_schema=JudgeFacts,
        )
    except Exception as exc:  # 判断失败不影响主流程，下一题继续
        return [], {"retract": [], "corrections": []}, None, f"{type(exc).__name__}: {exc}"[:300]

    facts: list[tuple[str, str, str]] = []
    for fact in parsed.facts[:6]:
        text = (fact.text or "").strip()
        if not text:
            continue
        if fact.verified:
            facts.append(("g", "V", text))
        else:
            facts.append(("p", "I", text))
    ops = {
        "retract": [int(index) for index in parsed.retract[:10]],
        "corrections": [
            (int(item.index), (item.text or "").strip())
            for item in parsed.corrections[:10]
            if (item.text or "").strip()
        ],
    }
    return facts, ops, usage, None


def facts_to_json(facts: list[tuple[str, str, str]]) -> str:
    return json.dumps(facts, ensure_ascii=False)
