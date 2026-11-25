# bench/poke — 宝可梦红 · 长程空间记忆实验环境

用一个**常驻**的 Game Boy 模拟器 + 细粒度工具，把 Pokémon Red 变成可复现的长程记忆评测环境。
观测以 RAM 为主，动作只有少量原语；记忆目录由 agent 自己维护。

## 目录

```
bench/poke/
├── config/
│   ├── run.json              当前实验配置（run / port / state / objective / rom）
│   └── run.example.json      新实验模板
├── core/                     纯 Python 逻辑，可单独 import / 单测
│   ├── paths.py              所有 data/rom/states/runs 路径
│   ├── emulator.py           PyBoy 封装
│   ├── input.py              移动、对话、settle、poke_program
│   ├── observation.py        10x9 局部视图、屏幕文字、菜单
│   ├── sight.py              一次动作内的 SIGHT 并集
│   ├── terrain.py            ROM <MAP>_Blocks + collision -> 16px 地形 sidecar
│   ├── rendering.py          PNG、玩家标记、背景裁剪
│   ├── colorize.py           tile id 调色（CGB/DMG 画面）
│   ├── transcript.py         trace.jsonl -> /live 对话
│   └── runtime.py            CGB / 缩放 / 最近截图尺寸
├── server/
│   ├── app.py                HTTP 路由与动作编排
│   ├── __main__.py           python -m server 入口
│   ├── live.html             /live 实时画面页
│   └── __init__.py
├── lib/
│   ├── map_view.mjs          SIGHT seen mask + terrain sidecar -> 雾图（agent 与 tools 共用）
│   └── dream_state.mjs       .dream_state.json 唯一状态机
├── agent/
│   ├── poke_tools.ts         poke_observe / poke_act / poke_program / poke_done
│   ├── memory_tools.ts       read / write / edit / plan / memory_dream / notes
│   └── explored_map_tool.ts  explored_map 工具
├── scripts/
│   ├── lib/common.ps1        根目录 / 端口 / run / objective 的唯一来源
│   ├── start_server.ps1      起常驻模拟器
│   ├── start_map_fresh.ps1   新建一局（拒绝覆盖旧 run，除非 -Force）
│   ├── continue_map.ps1      续跑并注入记忆索引
│   ├── dream_pass.ps1        dream 子进程
│   ├── prompts/              静态提示词（continue / fresh / dream）
│   ├── watch_working.ps1     刷新 working/CURRENT.md
│   ├── watch_dream.ps1       观察 dream 完成
│   ├── stop_now.ps1          停局、存档、写 SHUTDOWN
│   └── legacy/               2026-11-19 之前的一次性入口
├── tools/
│   ├── render_working.mjs    生成 working/CURRENT.md + analysis 快照
│   ├── watch20.py            动作日志监控
│   ├── backfill_spatial.mjs  从旧 trace 补 spatial.jsonl
│   ├── analyze.py / last_done.py / last_think.py
│   └── legacy/               旧 A/B 监控工具
├── data/                     charmap.json、map_names.json
├── rom/ rom_gbc/             ROM + .sym（必须成对）
├── states/                   开局锚点与中途存档
├── runs/<run>/               actions.jsonl、spatial.jsonl、trace.jsonl、memory/
└── archive/                  旧实验快照（只读）
```

## 快速开始

```powershell
cd bench\poke

# 1) 按 config/run.json 起模拟器（当前是 gbc_map_14 / 8765）
.\scripts\start_server.ps1

# 2) 新建一局（会拒绝已存在的 run；-Force 才会重置）
.\scripts\start_map_fresh.ps1 -RunName gbc_map_15 -State gbc_map11_start

# 3) 续跑当前模拟器（不传 -State 就不加载存档）
.\scripts\continue_map.ps1
#    要从快照恢复：.\scripts\continue_map.ps1 -State <name>

# 4) 另开窗口看雾图
node .\tools\render_working.mjs --run gbc_map_14 --port 8765

# 5) 停局并存档
.\scripts\stop_now.ps1
```

`config/run.json` 是当前实验的单一配置源；环境变量 `POKE_RUN_NAME` / `POKE_PORT` /
`POKE_STATE` / `POKE_OBJECTIVE` / `POKE_ROM` / `POKE_SYM` 可以临时覆盖。

## 核心契约

- **坐标单位**：`STATE` 和 SIGHT 的 `x,y` 是 16px 格。`wXCoord/wYCoord` 已经是格坐标，
  不再除以 2。ROM 地图头的 `20x18` 是 32px block，对应 40x36 个 16px 格。
- **移动**：方向键按住 16 帧；落步后等 `wWalkCounter` 归零。反向转身可能已经走完 1 格，
  调用方要按 `pre_turn()` 的返回值扣减。
- **SIGHT**：一次 `poke_act` / `poke_program` 内所有屏幕的并集，按相机滚动对齐。
  `.` 地板、`,` 草、`#` 视觉墙、`D` 门/梯、`N` 人物、`x` 被拒绝的一步、`S` 起点、`@` 玩家。
  它只代表“看见过什么”，不是全局地图。`explored_map` 在 seen 格上用
  `runs/<run>/terrain/<MAP>.json` 的 ROM 地形覆盖 `.` / `#` / `,` / `D`，但绝不增加格子。
- **碰撞**：只有带 `!` 的 `blocked`、且没有文本/NPC/菜单/脚本时才是墙证据；
  `#` 是 16px 视觉判断，不等于 32px 碰撞块。ROM collision 里的 ledge / warp / script tile
  也可能被玩家站上去或跳过去。
- **`poke_program`**：一次调用执行整段计划；每个 token 停在下一个决策点。
  `up!` 走到撞墙，`up!N` 最多 N 格，`up:32` 按住 32 帧。
- **预算**：`POKE_MAX_ACTIONS` 由 `run_resume.ps1` 计算剩余值；act 看不到剩余动作总数。
- **徽章**：`badges` 是已获得徽章的 id 数组，例如 `[0]` 表示 1 枚 Boulder Badge；
  不要把它 `-join` 后的 `0` 当成 0 枚。

## 记忆与 dreaming

- `memory/MEMORY.md`：入口，当前状态 + 已验证路线。
- `memory/TODO.md`：顶部 `## PLAN` 是长期战略（`plan` 写入，act 每回合都能看到），下面是 3-6 条下一步物理动作。
- `memory/maps/*.md`：按地图拆分的稀疏地图。
- `memory/notes/`：act -> dream 的邮箱；dream 读完后删除。
- `memory/working/CURRENT.md`：自动生成的当前层雾图，只读，不在记忆配额内。
- Dream 触发是自适应的：50 个动作软提醒，70 个动作硬停；notes 8 条 / 4000 字符、
  12 次记忆写入、进入新地图或新增 300 格 SIGHT 会提前触发。战斗内只推迟，低信息量
  窗口最多跳过一次。dream 是独立 agent，没有游戏工具；它读 action log / SIGHT /
  notes，重写记忆，然后 `dream_finish`。

## 兼容与 legacy

- 重构期间的 `emu.py` / `server.py` / `pi_ext/explored_map.mjs` 薄 shim 已删除。
  当前入口是 `scripts/start_server.ps1`（内部 `python -m server`）和 `agent/*.ts`。
- `scripts/legacy/`、`tools/legacy/` 是 2026-11-19 之前的 A/B 入口，保留用于复现，不再保证
  与当前 run 名/端口/提示词一致。
- `run_episode.ps1` / `run_batch.ps1` 是旧入口；当前实验优先用 `continue_map.ps1` +
  `run_resume.ps1`。

## 踩坑记录（都踩过，别再踩）

1. **`wXCoord/wYCoord` 不能除以 2**。除 2 会让地图缩小一半、每隔一次按键才“看起来移动”，
   并把正常按键误判成 `blocked`，写出假墙。16px 格就是 agent 坐标。
2. **8 帧按键会被取消**。方向键必须 16 帧，并在落步后等 `wWalkCounter == 0`。
3. **WRAM 必须按 CPU 平坦地址读**，不能按 bank-0 切片；游戏会切 SVBK。
4. **`.sym` 与 `.gbc` 必须成对**；混用会读出“看似正常的垃圾”。
5. **后台 SDL 窗口不会出现在桌面**；用 `/live` 看画面。
6. **`tick(capture=True)` 必须重置 `last_frames`**；半截属性名曾导致按钮卡住。
7. **PowerShell 脚本必须 UTF-8 with BOM**。Windows PowerShell 5.1 会把无 BOM 的中文注释
   按 ANSI 解码，某些 UTF-8 尾字节会吞掉换行，让下一行代码变成注释的一部分。

## 观测页与端点

- `/live` 实时画面（读缓冲，不推进帧）
- `/observe` 当前 RAM 状态 + 10x9 局部视图 + 屏幕文字
- `/act` 单次按键；`/program` 执行一段计划
- `/save` `/load` `/reset` `/states`
- `/health` 帧数、动作数、CGB、缩放、当前地图

## 已关闭实验：2026-11-19 · 50 动作 dream A/B

- 最终动作数：地图组 **2266**、对照组 **2059**（预算 5000，提前关闭）。
- 地图组 **1 枚徽章（Boulder）**，位置 `ROUTE_3 (14,6)`；对照组 0 徽章。
- 两组各 **9 次 dream**；地图组解决了 Pewter 东出口，对照组在 dream 后把“森林北出口封死”
  降级为“未验证”。
- 偏差：对照组 8766 server 崩溃并回档 241 动作（1784 → 2025）。
- 存档：`archive/experiment_2026-11-19_dream50/`、`states/shutdown_map_2266.state`。
