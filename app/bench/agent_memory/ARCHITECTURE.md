# agent_memory 架构说明（与 Anthropic "Dreaming" cookbook 对照）

> 适用对象：`bench/agent_memory/`（CLB 的 `dsh_agent_memory` 系统）。
> 插件本身的规格见仓库根 `DESIGN.md`，这一份只描述 benchmark 里的实现。

## 流水线

```
每道题（实例）
  ├─ 答题：模型可调 memory_list/read/write/delete，最后 submit
  ├─ 结束：维护者 agent 读「本实例动作 + 每步工具结果 + 最终反馈」→ 改写笔记
  └─ 每 N 题或容量 ≥75%：dream agent 合并/删除/重写 MEMORY.md，并先把旧版本快照到 <root>-history/
下一题
  └─ 只注入 MEMORY.md 索引 + 文件清单（memory_trust=true 时标注为「已验证」）
```

## 与 Anthropic cookbook 的对应关系

| 环节 | Anthropic（CMA dreaming cookbook） | 我们 | 状态 |
|---|---|---|---|
| 输入 | 导出每个已结束 session 的完整 transcript（含工具结果） | 本题的动作 + 每步工具结果 + 最终反馈 | ✅ 对齐（2026-11-18 补齐工具结果） |
| 分析 | 每个 transcript 一个 analyzer，并行蒸馏 | 每题结束一次维护（单实例串行） | ✅ 等价，未并行 |
| 整理 | 一个 organizer 统一整理全库 | dream agent 周期性整理 | ✅ 对齐 |
| 索引 | `_index.md` wiki 式小文件 | `MEMORY.md` + `notes/*.md` | ✅ 对齐 |
| 时间 | 事实带日期，旧事实标注被取代 | 维护者要求标 instance 编号；dream 保留最新日期版本 | ✅ 对齐（2026-11-18 新增） |
| 版本 | memory store 每次写入有版本，可审计 | dream 前快照到 `<root>-history/<stamp>/`，runs.jsonl 记录 | ✅ 部分对齐 |
| 挂载 | 未来会话只读挂载 | 答题时可读写（保留“agent 自己改记忆”） | ⚠️ 有意不同 |
| 触发 | cron 每晚批量 | 每 N 题 / 容量阈值（可配） | ⚠️ 在线增量 |
| 模型 | analyzer/organizer 可用 Haiku 降本 | 全部同一模型 | ⚠️ 未拆分 |

## 关键参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `memory_enabled` | true | 关掉即无记忆对照臂 |
| `memory_trust` | false | true 时系统提示词声明记忆为已验证事实，记忆块加 `### Verified memory` 标题 |
| `dream_every` | 10 | 每 N 次维护触发一次 dream |
| `dream_ratio` | 0.75 | 容量达到上限比例时也触发 |
| `dream_target_ratio` | 0.5 | dream 目标压缩比例 |
| `max_total_chars` | 16000 | 记忆总字数上限（超出拒绝写入） |
| `request_retries` | 3 | 网络超时/限流退避重试 |

## 离线自测

```
uv run python bench/agent_memory/selftest.py
```

覆盖：路径/容量守卫、答题工具循环、维护者、无记忆臂、实例复位、dream、transcript 输入、日期事实、memory_trust。
