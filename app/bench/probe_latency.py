"""测量一次真实结构化调用（含决策 schema）的往返耗时。"""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, os.environ.get("CLB_ROOT", str(Path.home() / "continual-learning-bench")))


def main() -> None:
    home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh-cline"))
    key = None
    for line in (home / ".credentials.yaml").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.strip().startswith("OPENCODE_GO_API_KEY:"):
            key = line.split(":", 1)[1].strip().strip('"').strip("'")
    os.environ["OPENAI_API_KEY"] = key or ""

    import litellm

    litellm.drop_params = True
    litellm.api_base = "https://opencode.ai/inference/go/v1"
    litellm.headers = {"x-opencode-session": str(uuid.uuid4())}

    from typing import Optional

    from pydantic import BaseModel

    from src.systems.utils import completion_with_structured_output

    class Action(BaseModel):
        thinking: str
        action: str
        amount: Optional[int] = None

    prompt = (
        "Hand #3 FLOP. Opponent Tom called your bet. Board Ks 7d 2c. Pot 60. "
        "Your hand Ad 9c. Choose FOLD/CALL/CHECK/RAISE with amount."
    )
    for label, messages in (
        (
            "small",
            [
                {"role": "system", "content": "You are a poker agent."},
                {"role": "user", "content": prompt},
            ],
        ),
        (
            "with-memory-block",
            [
                {"role": "system", "content": "You are a poker agent."},
                {
                    "role": "user",
                    "content": "=== Global lessons ===\n" + "- " + "x" * 60 + "\n" * 20 + prompt,
                },
            ],
        ),
    ):
        started = time.time()
        try:
            parsed, usage = completion_with_structured_output(
                model="openai/deepseek-v4.1-flash",
                messages=messages,
                response_schema=Action,
            )
            print(
                f"{label}: {time.time() - started:.1f}s action={parsed.action} "
                f"tokens={usage.input_tokens}/{usage.output_tokens}",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"{label}: FAILED after {time.time() - started:.1f}s: {type(exc).__name__}: {exc}", flush=True)


if __name__ == "__main__":
    main()
