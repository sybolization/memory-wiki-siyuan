# Benchmark 记录（exploitable_poker）

模型：`deepseek-v4.1-flash`（opencode-go 网关，共享 DSH 的 `OPENCODE_GO_API_KEY`）。
每次运行都是 1 run / replicate；基线是 CLB 的 stateless baseline（每个 instance 单独起 system）。

## quick_test（5 手，单阶段 Tom，仅连通性/烟测，噪声大）

| 系统 | score (BB/hand) | 基线总奖励 | 累计 gain | 调用数 | tokens |
|---|---|---|---|---|---|
| `dsh_memory` | 0.00 | -0.50 | **+0.50** | 19 | 24,584 |
| `icl` | 0.50 | +10.50 | **-8.00** | 17 | 56,463 |
| `icl_notepad` | 0.60 | +1.00 | **+2.00** | 20 | 37,544 |

解读：5 手样本太小，三者差异基本是噪声/发牌顺序差异；`icl` 的 gain 为负说明把全部
历史塞进上下文未必有帮助（上下文污染）。真要比较要看 `default` 的 5 阶段 120 手。

产物：
- `results/exploitable_poker/`（CLB 输出，含逐手 outcome 与 trace）
- `bench/*.log`（各次运行的完整 stdout/stderr）

## default（5 阶段 / 120 手：跟注站 → 松凶 → 回到跟注站 → 紧弱弃牌 → 回到松凶）

状态：**运行中**（2026-11-17 13:29 启动，预计 1.5–2 小时）。完成后把 score、分阶段
收益和升格页数量补到上表。

关键观察点：
1. 阶段 3 和阶段 5 是"回到旧对手"的 retention 测试——`dsh_memory` 的 wiki 升格页
   （证据 ≥2 个对手或 ≥3 个会话）应该在这里体现价值；
2. `system_artifacts.memory_files` 里能看到每手笔记和升格页；
3. 对比 `icl` / `icl_notepad` 的同阶段曲线，才能判断"笔记+巩固"是否优于"把历史塞上下文"。
