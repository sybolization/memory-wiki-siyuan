# Legacy tools

这些工具绑定 2026-11-19 的 A/B 双臂（`gbc_map_01` / `gbc_full_02`，端口 8765/8766），
保留用于复现旧结果。当前实验请用：

- `tools/render_working.mjs`：从 SIGHT 生成 working/CURRENT.md
- `tools/watch20.py`：动作日志监控
- `tools/backfill_spatial.mjs`：补写 spatial.jsonl
- `tools/analyze.py` / `last_done.py` / `last_think.py`

旧脚本不保证和当前 run 名、端口、JSONL schema 一致。
