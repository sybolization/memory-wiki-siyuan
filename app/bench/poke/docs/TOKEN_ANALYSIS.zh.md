# Token 分析方法与 map_01 / map_10 / map_14 对比

> 目标：回答“每步多少 token、平均每步怎么算”。数据源是各 run 的 `trace.jsonl`，
> 分析脚本是 `tools/token_analysis.py`。`summary.json` 里的 `cache_read_total` 不要用，原因见第 5 节。

## 1. 三种“步”的定义

先明确粒度，否则数字会差一个数量级：

| 名称 | 定义 | 数据来源 | map14 数量 |
|---|---|---|---:|
| turn（轮） | 一次 assistant 回复 = 一个 `message_end` 事件 | `trace.jsonl` | 1699 |
| action（游戏动作） | 一次 `poke_act` / `poke_program` 调用 | `actions.jsonl` 一行 | 1500 |
| step（按钮步） | `poke_program` 里的一条按钮指令 | `actions.jsonl` → `steps[]` | 5098 |

一次 action 平均包含 3.3–3.7 个 step；一次 turn 平均产生 0.88–0.91 个 action
（其余 turn 用来读记忆、dream、写 note、看地图）。

## 2. 怎么算

### 2.1 单轮 token

`trace.jsonl` 里每个 assistant 的 `message_end` 事件都带权威 usage：

```json
"usage": {
  "input": 4982,
  "output": 92,
  "cacheRead": 0,
  "cacheWrite": 0,
  "reasoning": 10,
  "totalTokens": 5074
}
```

恒等式（已用三个 run 全部验证）：

```text
totalTokens = input + output + cacheRead + cacheWrite
```

**`reasoning` 已经包含在 `output` 里，不能再加一次。**

### 2.2 每步 / 每动作平均

```text
每轮 token      = Σ totalTokens / turn 数
每动作 token    = Σ totalTokens / action 数      # 含上下文缓存，账单口径
每按钮步 token  = Σ totalTokens / step 数        # 含上下文缓存，账单口径
边际每动作      = Σ (input + output) / action 数  # 去掉每轮重复发送的 cacheRead
边际每按钮步    = Σ (input + output) / step 数
缓存占比        = Σ cacheRead / Σ totalTokens
```

“账单口径”是实际计费 token；“边际口径”回答“多走一步到底多花多少”。
两者差 30 倍，因为 `cacheRead` 是每轮都重新发送的同一份上下文前缀。

### 2.3 不能用的算法

`message_update` 事件也带 `usage`，但那是流式过程中的**累计快照**，每个 chunk 都重复一遍。
把它们全部相加会把 `cacheRead` 放大约 7 倍。`run_resume.ps1` 里的
`cache_read_total = 正则匹配所有 "cacheRead":N 求和` 正是这个错误。

## 3. 三个 run 的结果

### 账单口径（实际计费）

| run | turns | actions | steps | 总 token | 每轮 | 每动作 | 每按钮步 | cache 占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| gbc_map_01 | 5201 | 4752 | 15816 | 305,210,279 | 58,683 | 58,786（仅游戏轮）/ 64,228（全部） | 19,298 | 96.8% |
| gbc_map_10 | 2052 | 1866 | 6985 | 123,587,422 | 60,228 | 60,441 / 66,231 | 17,693 | 95.3% |
| gbc_map_14 | 1699 | 1500 | 5098 | 101,854,427 | 59,950 | 59,872 / 67,903 | 17,628 | 96.3% |

注：`按 action` 的分母是含 `poke_act`/`poke_program` 的 turn 里的工具调用数（4729 / 1865 / 1501），
`全部` 的分母是 `actions.jsonl` 行数（4752 / 1866 / 1500）。两者只差 1。

### 边际口径（去掉固定缓存前缀）

| run | input+output 合计 | 边际/动作 | 边际/按钮步 | cache/动作 |
|---|---:|---:|---:|---:|
| gbc_map_01 | 9,759,783 | 2,064 | 617 | 62,476 |
| gbc_map_10 | 5,821,278 | 3,121 | 833 | 63,145 |
| gbc_map_14 | 3,781,211 | 2,519 | 742 | 65,339 |

### 每轮分布

| run | mean | median | p90 | max |
|---|---:|---:|---:|---:|
| gbc_map_01 | 58,683 | 59,145 | 91,028 | 102,682 |
| gbc_map_10 | 60,228 | 60,215 | 91,925 | 100,722 |
| gbc_map_14 | 59,950 | 59,558 | 91,430 | 102,538 |

三个 run 的每轮分布几乎完全一致：中位数约 59k，p90 约 91k，说明上下文被压缩/截断在
约 60k 的固定窗口内。这是“每轮 token 几乎恒定”的根本原因。

## 4. 怎么解读

1. **每动作 token ≈ 每轮 token ≈ 6 万**，三个 run 都如此。因为绝大多数 turn 只产生一个游戏动作
   （actions/turn = 0.91 / 0.91 / 0.88）。
2. **总 token 几乎只由动作数决定**：4752 : 1866 : 1500 ≈ 3.17 : 1.24 : 1；
   总 token 305M : 124M : 102M ≈ 3.00 : 1.21 : 1。不是单步变贵了，而是步数变多了。
3. **真正“多走一步”的代价只有约 600–830 token**（边际按钮步），其余约 6.4 万是每轮都要
   重发的上下文。所以优化 token 的关键不是让单步更短，而是**减少 turn 数**——用
   `poke_program` 把一串按钮打包成一次调用。
4. **map14 的进展/token 最好**：1500 动作、101.9M token 走到 Cerulean、打完 Nugget Bridge，并把 Misty 循环拖到 16 负；
   map10 花 1866 动作、123.6M 只到 Route 3，没进月见山；map01 花 4752 动作、305M 停在
   Mt Moon B1F。map14 的浪费集中在后半段 Misty 循环，而不是探索效率。
5. **边际成本差异**：map10 边际最高（3121/动作），因为它每次动作的思考更多
   （reasoning/动作 = 523），且程序平均 3.74 步；map01 最低（2064/动作），但它的工具集不同，
   不能直接横线对比。

## 5. 注意事项 / 坑

- **不要用 `summary.json` 的 `cache_read_total`**：map_01/10/14 分别写成 1,106,256,512 /
  421,505,152 / 754,247,168，而真实 cacheRead 是 295,450,496 / 117,766,144 / 98,073,216。
- **工具名不一致**：map01 用 `memory_write` / `memory_read` / `map_update` / `dream_context`；
  map10/14 用 `read` / `write` / `edit` / `memory_note` / `explored_map`。工具调用次数不能直接比。
- **trace 是多次 resume 追加的**，同一个文件的所有 assistant `message_end` 都要计入；
  不要用 `max_actions` 反推动作数。
- **`actions.jsonl` 行数与 game tool call 数可能差 1**（最终 1500 vs 1501），差异来自最早/最后一次操作，
  不影响平均值。
- **reasoning 已在 output 内**，单独列出只是为了看思考量，不能加到 total 上。

## 6. 复现

```bash
python tools/token_analysis.py runs/gbc_map_01 runs/gbc_map_10 runs/gbc_map_14
```

输出包含三张表：账单口径、边际口径、每个 run 的明细（字段校验、每轮分布、工具调用次数）。

## 7. Dream 成本与 Option C

`tools/dream_analysis.py` 按 `DREAM.md` 的 dream 边界切分 `trace.jsonl`，单独统计 dream 子 agent 的 token 和墙钟时间：

| run | dream 次数 | dream token | 平均/dream | 平均墙钟 | dream 总墙钟 | 占该 run 总 token |
|---|---:|---:|---:|---:|---:|---:|
| gbc_map_10 | 37 | 13,095,177 | 353,924 | 159 s | 98.0 min | 10.6% |
| gbc_map_14 | 30 | 18,849,760 | 628,325 | 246.2 s | 123.1 min | 18.5% |

map14 最终 30 次 dream：旧 28 次是固定 50 动作硬停，0 次自愿；dream #29 是 Option C 的 new-map 触发（29 actions，因宿主超时中断后恢复），#30 是 50 动作软窗口。dream #3/#19/#26 在战斗中触发，打断了战斗。按每轮约 59.95k token 折算，一次 dream 平均约等于 10 轮正常对话，减少 dream 次数比压缩单轮更有效。

旧策略与 Option C 的对比：

| 项目 | 旧策略 | Option C |
|---|---|---|
| 触发 | 固定 50 动作硬停 | 50 动作软提醒，70 动作硬上限 |
| 战斗 | 照常打断 | 战斗内只推迟 |
| 低信息量 | 照常 dream | 最多跳过一次，下一次必须 dream |
| 高信息量 | 无提前触发 | notes 8 / 4000 字符、writes 12、新地图、SIGHT 300 格 |
| 计数 | 只按动作 | 动作 + 笔记 + 写入 + 地图 + SIGHT |

本次续跑的实测：28 → 30 次，dream token 17.2M → 18.8M，墙钟 116.3 → 123.1 min。原因是 70 动作的短续跑里，new-map 触发 #29 和 50 动作软窗口 #30 都发生了；Option C 没有减少次数，反而多了 2 次。短续跑不能验证长期收益；要判断“信息量够了才 dream”是否减少低价值 dream，需要下一局完整 run 用 `tools/dream_analysis.py` 复测。阈值集中在 `lib/dream_state.mjs` 的 `dreamOptions()`，可用 `POKE_DREAM_*` 环境变量覆盖。
