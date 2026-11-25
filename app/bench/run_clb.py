"""
CLB 启动包装器：先给 litellm 配好 opencode-go 网关，再调用 clbench。

用法（仓库根目录）：
  uv run python bench/run_clb.py run --config <json> [其余 clbench 参数]

为什么需要它：CLB 内置基线系统（icl/icl_notepad/mem0）不认我们的 api_base 参数，
而网关又要求 x-opencode-session 头，所以在进程级别统一注入。
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(os.environ.get("CLB_ROOT", Path.home() / "continual-learning-bench"))
BENCH_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT))

API_BASE = os.environ.get("CLB_API_BASE", "https://opencode.ai/inference/go/v1")


def _export_child_env() -> None:
    """让 spawn 出来的 baseline worker 也带上网关配置（sitecustomize 在 bench 目录）。"""
    parts = [str(BENCH_ROOT)]
    existing = os.environ.get("PYTHONPATH")
    if existing:
        parts.append(existing)
    os.environ["PYTHONPATH"] = os.pathsep.join(parts)
    os.environ.setdefault("CLB_API_BASE", API_BASE)


def _configure() -> None:
    import litellm

    litellm.drop_params = True
    litellm.api_base = API_BASE
    litellm.headers = {"x-opencode-session": os.environ.get("CLB_SESSION", str(uuid.uuid4()))}
    from src.systems.dsh_memory.system import _resolve_api_key  # noqa: PLC0415

    key = _resolve_api_key("OPENAI_API_KEY", "OPENCODE_GO_API_KEY")
    if key:
        os.environ.setdefault("OPENAI_API_KEY", key)


def main() -> None:
    _export_child_env()
    _configure()
    from src.cli import main as clbench_main  # noqa: PLC0415

    sys.argv[0] = "clbench"
    clbench_main()


if __name__ == "__main__":
    main()
