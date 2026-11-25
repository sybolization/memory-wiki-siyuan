"""agent_memory/selftest.py — 离线自测（不联网，用脚本化的假 LLM）。

运行（在 app 目录下）：
    uv run python bench/agent_memory/selftest.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

from pydantic import BaseModel

CLB = Path(os.environ.get("CLB_ROOT", Path.home() / "continual-learning-bench"))
sys.path.insert(0, str(CLB))

from src.interface import Observation, Query  # noqa: E402
from src.systems.dsh_agent_memory.system import AgentMemorySystem  # noqa: E402


class FakeAction(BaseModel):
    action: str
    content: str


def _tool_call(name: str, args: dict, call_id: str = "call_1"):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps(args, ensure_ascii=False)),
    )


def _response(content: str = "", tool_calls: list | None = None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls or [])
    usage = SimpleNamespace(prompt_tokens=12, completion_tokens=6, total_tokens=18)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


class FakeSystem(AgentMemorySystem):
    def __init__(self, script: list, **kwargs):
        kwargs.setdefault("memory_root", tempfile.mkdtemp(prefix="agent-memory-test-"))
        super().__init__(model="fake-model", **kwargs)
        self.script = list(script)
        self.calls: list[dict] = []

    def _complete(self, messages, tools, *, purpose):
        self.calls.append(
            {"purpose": purpose, "tools": [t["function"]["name"] for t in tools], "messages": messages}
        )
        if not self.script:
            raise AssertionError("脚本化的假 LLM 已经用完，但系统还在请求")
        return self.script.pop(0)


def _query(prompt: str, index: int = 0, instance_id: str = "inst-1") -> Query:
    return Query(
        prompt=prompt,
        response_schema=FakeAction,
        instance_id=instance_id,
        instance_index=index,
        metadata={},
    )


def check_guards() -> None:
    system = FakeSystem([])
    fs = system.fs
    assert "[错误]" in fs.write("notes/big.md", "x" * (fs.max_file_chars + 1))
    assert "[错误]" in fs.write("../escape.md", "x")
    assert "[错误]" in fs.delete("MEMORY.md")
    assert "[错误]" in fs.read("notes/missing.md")
    fs.write("notes/ok.md", "# 标题\n内容")
    assert "记忆文件" in fs.index_text()
    assert "notes/ok.md" in fs.index_text()
    print("ok  guards")


def check_answer_loop() -> None:
    script = [
        _response(tool_calls=[_tool_call("memory_write", {"path": "notes/schema.md", "content": "# schema\nprc 是美分"})]),
        _response(tool_calls=[_tool_call("memory_read", {"path": "notes/schema.md"}, "call_2")]),
        _response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "42"}, "call_3")]),
    ]
    system = FakeSystem(script)
    response = system.respond(_query("价格是多少？"))
    assert response.action.content == "42"
    assert (system.memory_root / "notes" / "schema.md").exists()
    assert response.metadata["memory_tool_calls"] == 2
    assert system.calls[-1]["purpose"] == "answer"
    print("ok  answer loop")


def check_maintainer() -> None:
    system = FakeSystem([])
    system._pending = [{"prompt": "Q1", "action": '{"action":"ANSWER","content":"20.9"}'}]
    system._current_instance = {"id": "inst-1", "index": 0}
    system.script = [
        _response(
            tool_calls=[
                _tool_call(
                    "memory_write",
                    {
                        "path": "MEMORY.md",
                        "content": "# MEMORY\n- 价格列是美分，过滤前先 /100\n- 见 notes/price.md",
                    },
                ),
                _tool_call("memory_write", {"path": "notes/price.md", "content": "# 价格\nprc 是美分；prc_usd 是美元"}, "call_2"),
                _tool_call("finish", {"summary": "记录价格单位"}, "call_3"),
            ]
        )
    ]
    system.observe(Observation(content="INCORRECT. Correct answer: 21.99. 你用了美分当美元", instance_complete=True))
    text = (system.memory_root / "MEMORY.md").read_text(encoding="utf-8")
    assert "美分" in text
    assert (system.memory_root / "notes" / "price.md").exists()
    runs = (system.memory_root / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert runs and json.loads(runs[-1])["summary"] == "记录价格单位"
    assert system.maintain_count == 1
    print("ok  maintainer")


def check_no_memory_arm() -> None:
    system = FakeSystem(
        [_response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "0"})])],
        memory_enabled=False,
    )
    response = system.respond(_query("Q"))
    assert response.action.content == "0"
    assert "memory_write" not in system.calls[0]["tools"]
    system._pending = [{"prompt": "Q", "action": "x"}]
    system.observe(Observation(content="wrong", instance_complete=True))
    assert system.maintain_count == 0
    print("ok  no-memory arm")


def check_instance_reset() -> None:
    script = [
        _response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "1"})]),
        _response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "2"}, "call_2")]),
    ]
    system = FakeSystem(script)
    system.respond(_query("Q1", index=0, instance_id="a"))
    system._messages.append({"role": "user", "content": "FEEDBACK: x"})
    system.respond(_query("Q2", index=1, instance_id="b"))
    assert system._messages == [{"role": "user", "content": "Q2"}, {"role": "assistant", "content": '{"action":"ANSWER","content":"2"}'}]
    print("ok  instance reset")


def check_dream() -> None:
    system = FakeSystem(
        [],
        max_total_chars=800,
        max_files=5,
        dream_every=1000,
        dream_ratio=0.0,  # 总是触发 dream
    )
    fs = system.fs
    fs.write("MEMORY.md", "# MEMORY\n- a\n- b")
    fs.write("notes/a.md", "x" * 200)
    fs.write("notes/b.md", "y" * 200)
    system.script = [
        _response(tool_calls=[_tool_call("memory_delete", {"path": "notes/b.md"})]),
        _response(
            tool_calls=[
                _tool_call("memory_write", {"path": "MEMORY.md", "content": "# MEMORY\n- a"}, "call_2")
            ]
        ),
        _response(tool_calls=[_tool_call("finish", {"summary": "删掉重复的 b"}, "call_3")]),
    ]
    before = fs.stats()
    system._dream("x")
    after = fs.stats()
    assert after["files"] < before["files"], (before, after)
    assert after["total_chars"] < before["total_chars"], (before, after)
    records = [
        json.loads(line)
        for line in (system.memory_root / "runs.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert records[-1]["type"] == "dream"
    assert records[-1]["summary"] == "删掉重复的 b"
    assert records[-1]["stats_after"]["files"] == after["files"]
    history = list(system.memory_root.parent.glob(f"{system.memory_root.name}-history/*"))
    assert history and (history[0] / "MEMORY.md").exists()
    print("ok  dream")


def check_transcript_input() -> None:
    system = FakeSystem([])
    system.script = [
        _response(tool_calls=[_tool_call("submit", {"action": "QUERY", "content": "SELECT 1"})]),
        _response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "7"}, "call_2")]),
        _response(
            tool_calls=[
                _tool_call("memory_write", {"path": "MEMORY.md", "content": "# MEMORY\n- x"}, "call_3")
            ]
        ),
        _response(tool_calls=[_tool_call("finish", {"summary": "ok"}, "call_4")]),
    ]
    q = _query("Q1", index=0, instance_id="a")
    system.respond(q)
    system.observe(Observation(content="Query result (1/15): 7", instance_complete=False))
    system.respond(q)
    system.observe(Observation(content="CORRECT! answer 7", instance_complete=True))
    maintain = next(c for c in system.calls if c["purpose"] == "maintain")
    digest = maintain["messages"][1]["content"]
    assert "Query result (1/15): 7" in digest, digest[:400]
    assert "动作:" in digest and "结果:" in digest
    print("ok  transcript input")


def check_dated_facts() -> None:
    from src.systems.dsh_agent_memory.system import DREAM_SYSTEM, MAINTAINER_SYSTEM

    assert "Date each fact" in MAINTAINER_SYSTEM
    assert "newest dated version" in DREAM_SYSTEM
    print("ok  dated facts")


def check_grace_submit() -> None:
    script = [
        _response(tool_calls=[_tool_call("memory_read", {"path": "MEMORY.md"}, f"c{i}")])
        for i in range(5)
    ]
    script.append(
        _response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "42"}, "c9")])
    )
    system = FakeSystem(script)
    system.fs.write("MEMORY.md", "# MEMORY\n- x\n")
    response = system.respond(_query("Q"))
    assert response.action.content == "42"
    assert len(system.calls) == 6
    print("ok  grace submit")


def check_trust() -> None:
    plain = FakeSystem([])
    assert "verified in earlier instances" not in plain.system_prompt

    trusted = FakeSystem([], memory_trust=True)
    assert "verified in earlier instances" in trusted.system_prompt
    trusted.fs.write("MEMORY.md", "# MEMORY\n- a\n")
    trusted.script = [
        _response(tool_calls=[_tool_call("submit", {"action": "ANSWER", "content": "1"})])
    ]
    trusted.respond(_query("Q", index=0, instance_id="a"))
    user_content = next(
        m["content"] for m in trusted.calls[0]["messages"] if m.get("role") == "user"
    )
    assert user_content.startswith("### Verified memory"), (user_content or "")[:60]
    assert "# MEMORY" in user_content
    print("ok  memory trust")


if __name__ == "__main__":
    check_guards()
    check_answer_loop()
    check_maintainer()
    check_no_memory_arm()
    check_instance_reset()
    check_dream()
    check_transcript_input()
    check_dated_facts()
    check_grace_submit()
    check_trust()
    print("all agent_memory selftests passed")
