"""
sitecustomize.py — 让每个由 CLB 派生的 Python 子进程（含 spawn 的 baseline worker）
在启动时就带上 opencode-go 网关配置。

run_clb.py 会把本目录加入 PYTHONPATH；Python 启动时会自动 import sitecustomize。
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

API_BASE = os.environ.get("CLB_API_BASE", "https://opencode.ai/inference/go/v1")


def _resolve_key() -> str | None:
    value = os.environ.get("OPENAI_API_KEY")
    if value:
        return value
    home = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh-cline"))
    credentials = home / ".credentials.yaml"
    if not credentials.exists():
        return None
    for line in credentials.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.strip().startswith("OPENCODE_GO_API_KEY:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return None


def _install() -> None:
    try:
        import litellm
    except Exception:  # litellm 还没装好时不要影响解释器启动
        return
    litellm.drop_params = True
    litellm.api_base = API_BASE
    litellm.headers = {
        "x-opencode-session": os.environ.get("CLB_SESSION") or str(uuid.uuid4())
    }
    key = _resolve_key()
    if key:
        os.environ.setdefault("OPENAI_API_KEY", key)


_install()
