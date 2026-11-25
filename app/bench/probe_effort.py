"""探测网关是否支持 reasoning_effort / max_tokens 约束，以及耗时。"""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, os.environ.get("CLB_ROOT", str(Path.home() / "continual-learning-bench")))


def _key() -> str:
    home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh-cline"))
    for line in (home / ".credentials.yaml").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.strip().startswith("OPENCODE_GO_API_KEY:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def main() -> None:
    import litellm

    litellm.drop_params = True
    litellm.api_base = "https://opencode.ai/inference/go/v1"
    litellm.headers = {"x-opencode-session": str(uuid.uuid4())}
    api_key = _key()
    messages = [
        {"role": "system", "content": "你是扑克 agent，thinking 最多两句话。"},
        {"role": "user", "content": "Hand #3 FLOP, opponent Tom called. Board Ks 7d 2c. Hand Ad 9c. FOLD/CALL/CHECK/RAISE?"},
    ]
    variants = [
        ("plain-max600", {"max_tokens": 600}),
        ("effort-low", {"max_tokens": 600, "reasoning_effort": "low"}),
        ("effort-low-max300", {"max_tokens": 300, "reasoning_effort": "low"}),
        ("thinking-disabled", {"max_tokens": 600, "extra_body": {"thinking": {"type": "disabled"}}}),
    ]
    for label, kwargs in variants:
        started = time.time()
        try:
            response = litellm.completion(
                model="openai/deepseek-v4.1-flash",
                messages=messages,
                api_key=api_key,
                **kwargs,
            )
            usage = getattr(response, "usage", None)
            out = usage.completion_tokens if usage else "?"
            content = (response.choices[0].message.content or "")[:80].replace("\n", " ")
            print(f"{label}: {time.time() - started:.1f}s out={out} {content}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"{label}: FAILED {time.time() - started:.1f}s {type(exc).__name__}: {str(exc)[:160]}", flush=True)


if __name__ == "__main__":
    main()
