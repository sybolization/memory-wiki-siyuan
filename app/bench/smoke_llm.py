"""
最小连通性烟测：验证 opencode-go 网关 + 结构化输出 helper 可用。

用法（仓库根目录）：
  uv run python bench/smoke_llm.py

只打印回复摘要与 token 用量，不打印 key。
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(os.environ.get("CLB_ROOT", Path.home() / "continual-learning-bench"))
sys.path.insert(0, str(REPO_ROOT))

import litellm  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from src.systems.dsh_memory.system import _resolve_api_key  # noqa: E402
from src.systems.utils import completion_with_structured_output  # noqa: E402

API_BASE = "https://opencode.ai/inference/go/v1"
MODEL = "openai/deepseek-v4.1-flash"


class Probe(BaseModel):
    answer: str


def main() -> int:
    litellm.drop_params = True
    litellm.api_base = API_BASE
    litellm.headers = {"x-opencode-session": str(uuid.uuid4())}
    key = _resolve_api_key("OPENAI_API_KEY", "OPENCODE_GO_API_KEY")
    if not key:
        print("FAIL: 找不到 OPENCODE_GO_API_KEY（环境变量和 DSH 凭据文件都没有）")
        return 1
    os.environ.setdefault("OPENAI_API_KEY", key)
    parsed, usage = completion_with_structured_output(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You answer briefly."},
            {"role": "user", "content": "Reply as JSON with answer='pong'."},
        ],
        response_schema=Probe,
    )
    print(f"answer: {parsed.answer}")
    print(f"usage: in={usage.input_tokens} out={usage.output_tokens} model={usage.model}")
    return 0 if parsed.answer else 2


if __name__ == "__main__":
    raise SystemExit(main())
