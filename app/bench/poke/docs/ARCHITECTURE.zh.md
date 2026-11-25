# poke 架构（中文）

> 目标：把“模拟器 / 观测 / 移动 / 记忆 / 实验脚本”分开，避免改一个实验参数要动十几个文件。
> 这份文档只描述当前结构和不变量；具体 bug 历史见 `README.md` 的踩坑记录。

## 1. 依赖方向

```text
scripts/  ──►  run_resume / start_server  ──►  server/app.py  ──►  core/*
                                                   │
                                                   └──►  lib/*（Node 工具/扩展共用）

agent/*   ──►  lib/dream_state.mjs
          └──►  lib/map_view.mjs
tools/*   ──►  lib/map_view.mjs

core/*    ✗──►  server / agent / tools
lib/*     ✗──►  pi 扩展 API
```

规则：

- `core/` 不 import HTTP、不 import pi、不读环境变量里的 run 名。
- `server/` 只做路由和动作编排；移动/观测/SIGHT 算法在 `core/`。
- `lib/` 是 TS/JS 共享层，不能 import `@earendil-works/*`。
- `tools/` 不能 import `agent/`；需要地图就 import `lib/map_view.mjs`。

## 2. 模块职责

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `core/emulator.py` | PyBoy 封装、符号寻址、状态/队伍/金钱读取 | 不做 HTTP、不做移动策略 |
| `core/input.py` | `pre_turn` / `walk_until` / `run_program` / `settle` / 对话框 | 不读地图文件 |
| `core/observation.py` | 10x9 局部视图、屏幕文字、菜单光标 | 不写 SIGHT 账本 |
| `core/sight.py` | 一次动作内多屏拼接、`spatial.jsonl` 的 snapshot | 不推断未看见的格子 |
| `core/terrain.py` | 从 ROM `<MAP>_Blocks` + tileset collision 解码 16px 地形，写 `terrain/<MAP>.json` | 不决定哪些格看见过 |
| `core/rendering.py` | PNG、玩家标记、背景裁剪、缩放 | 不改游戏状态 |
| `core/transcript.py` | trace.jsonl -> `/live` 轮次 | 不参与对局 |
| `server/app.py` | HTTP、锁、动作日志、SIGHT 落盘、地形 sidecar | 不放移动算法 |
| `agent/poke_tools.ts` | 游戏工具、STATE/SIGHT 呈现、budget 与 dream 门禁、PLAN 摘要注入 | 不实现记忆状态机 |
| `agent/memory_tools.ts` | read / write / edit、memory_dream、notes、`plan`（长期战略写入 TODO.md） | 不直接读模拟器 |
| `agent/explored_map_tool.ts` | explored_map 工具 | 不实现地形解码 |
| `lib/map_view.mjs` | SIGHT seen mask + terrain sidecar -> 雾图、边界/坐标轴 | 不推断未看见的格子 |
| `lib/dream_state.mjs` | `.dream_state.json` 唯一状态机 | 不读记忆文件内容 |

## 3. 坐标与时间不变量

这是整局实验最容易错的地方，改任何移动代码前先读：

1. **1 格 = 16px**。`wXCoord/wYCoord` 已经是格坐标，禁止 `//2`。
2. **地图头 20x18 是 32px block**，即 40x36 个 16px 格；不要拿它当 16px 网格。
3. **方向键 16 帧**。8 帧会在坐标提交前松开，按键被取消。
4. **落步后等 `wWalkCounter == 0`**，否则下一次按键被吞。
5. **反向转身可能已经走完 1 格**；`pre_turn()` 返回实际步数，调用方必须扣减。
6. **`!` 才是 blocked 证据**；裸方向键只记录 `pressed`，不代表墙。
7. **`badges` 是 id 数组**：`[0]` = 1 枚 Boulder，不是 0 枚；显示数量时用 `Count`，
   不要用 `-join` 后的字符串判断。

## 4. 地图语义

- SIGHT 是 16px 视觉层：`. , # D N x S @`。
- `#` 是“这一屏看起来是墙”，不是 32px 碰撞墙。
- 只有 `outcome == "blocked"` 能证明碰撞；`pressed` / `advanced_dialogue` /
  `waited` / `map_change` 都是输入被文本、菜单、NPC 或战斗吃掉。
- `memory/working/CURRENT.md` 和 `explored_map` 的 seen mask 只从 `spatial.jsonl` 来；
  有 `terrain/<MAP>.json` 时，seen 格的地形字符改用 ROM 的 `.` / `#` / `,` / `D`，
  但绝不增加格子；空白 = 没看过，不是地板。
- 玩家实际站过的格子（`stand > 0`）即使 ROM collision 说 `#` 也画 `.`：
  Gen 1 的 ledge / warp / script tile 可能碰撞表不可走，但玩家能站上去或跳过去。
- 合并策略有两套，**是有意的**：
  - `core/sight.py` 的 `_put` 是单次动作的屏幕并集，普通地板可以覆盖 `N`/`x`，
    但不会抹掉同一动作里已看到的墙/门，保证即时 SIGHT 不出现假通道。
  - `lib/map_view.mjs` 是跨 run 的累计雾图，用 floor/wall/ladder 计数投票，
    平票时墙获胜，避免一次错位采样把走过的通道封死。
  两者共同的语义：`?`/`x` 不是地形，`@`/`S` 算地板，`D` 是门/梯。

## 5. 地形 sidecar

SIGHT 只回答“哪些格看见过”；`.` / `#` / `,` / `D` 的地形来自 ROM：

- `core/terrain.py` 读 `<Map>_h` 的 tileset/宽高和 `<Map>_Blocks` 的 32px block 数组。
- 当前 tileset 的 block / collision 表在 WRAM（`wTilesetBlocksPtr` /
  `wTilesetCollisionPtr`），运行时由游戏从 ROM 载入；每个 32px block 展开成 4x4 个 8px tile。
- 每个 16px 格取对应 2x2 tile 象限的左下 tile，查 collision 表得到 `.` / `#` / `,`。
- 生成时的当前地图用 `wWarpEntries` 标出 `D`；用别的存档生成的历史地图没有 `D`。
- `write_terrain()` 原子写到 `runs/<run>/terrain/<MAP>.json`。server 在启动、
  `/load`、`/reset` 和每次动作后调用 `ensure_terrain()`，每张图只写一次。
- 历史地图用 `tools/build_terrain.py` 生成：优先用运行时 tileset（当前地图可带 `D`），
  tileset 不匹配时退回 ROM 的 `Tilesets` 表，所以不需要同 tileset 的存档；只有 warp
  位置仍然需要该地图的存档。
- `lib/map_view.mjs` 的 `loadTerrain()` / `applyTerrain()` 只覆盖 seen mask 里已有的格；
  地图外由相机抖动产生的格子会被丢弃，不会画成假墙。玩家实际站过的格（`stand > 0`）
  即使 collision 说 `#` 也画 `.`。
- 某张图没有 sidecar（旧 run、没生成、tileset 不匹配）时，`explored_map` 自动退回
  SIGHT-only，并在输出里标注 `terrain: SIGHT-only`。

验证方法：用存档的 `screen_view` 和 terrain 在当前位置逐格对齐；再用 `actions.jsonl`
里 `tiles > 0` 的路径检查走过的格不是 `#`。ledge 跳转会跨过 collision 为 `#` 的格，
这类路径不能直接当墙证据；NPC/文本/菜单造成的 `blocked` 也不是墙证据。

## 6. Dream 状态机（Option C 自适应触发）

`.dream_state.json` 字段：

```json
{"writes":0,"actions":0,"due":false,"dreams":0,"read_after_dream":true,
 "next_soft":0,"skipped":0,"last_map":"","maps_since_dream":0,
 "new_map":false,"seen_maps":[],"sight_offset":0}
```

- `poke_act` / `poke_program` -> `bumpAction`：`actions++`，记录地图变化；
  `actions >= hardActions` 时置 `due`。
- `write` / `edit` -> `bumpWrite`：`writes++`。
- `read MEMORY.md` -> `markRead`：清掉 “MEMORY NOT RE-READ” 提示。
- `memory_dream` 成功后 -> `beginDream`：`dreams++`，清零
  `writes/actions/due/skipped/new_map`，`read_after_dream=false`，把
  `sight_offset` 推到当前 `spatial.jsonl` 末尾。

触发策略（`lib/dream_state.mjs` 的 `dreamOptions` / `evaluateDream`）：

| 信号 | 默认阈值 | 行为 |
|---|---:|---|
| `softActions` | 50 | 软提醒，可以打完当前战斗/短路线 |
| `hardActions` | 70 | 硬上限，`poke_act` / `poke_program` 拒绝 |
| `notes` / `noteChars` | 8 / 4000 | 邮箱信息量提前触发 |
| `writes` | 12 | 记忆写入量提前触发 |
| `new_map` | 首次进入 | 新地图提前触发 |
| `sightCells` | 300 | 软窗口内新增 SIGHT 格子提前触发 |
| `maxSkips` | 1 | 低信息量窗口最多跳过一次 |

战斗内（`battle != 0`）只推迟，不打断；低信息量窗口跳过时 `next_soft` 推到
`hardActions`，不会超过硬上限。只有 `lib/dream_state.mjs` 能读写这个文件；
不要在别的扩展里再实现一份。

## 6.1 战略层（plan）

`plan` 是 act 的长程战略工具，和 dream 的记忆维护分开：

- 写入 `memory/TODO.md` 顶部的 `## PLAN` 块：`goal`、`why`、`written`、
  `horizon`、3-6 个编号 milestone。
- **不消耗游戏动作**，也不增加 `.dream_state.json` 的 `writes`；调用它等于
  act 主动暂停一次行动循环。
- `poke_tools.ts` 的 `planTag()` 在每个 `poke_act` / `poke_program` /
  `poke_observe` 结果后注入 PLAN 摘要（goal + 前 3 个 milestone）。
- 只替换 `## PLAN` 块，保留下面的 `- [ ]` 战术 checklist。
- dream 必须保留 PLAN；如果证据矛盾，加一行 `> audit: <fact>`，不能删除或替换。
- 关闭 dreaming（`POKE_DREAM_ENABLED=0`）时 `plan` 仍然注册。

## 7. 配置与实验入口

`config/run.json` 是当前实验的单一配置源：

```json
{
  "run": "gbc_map_14",
  "port": 8765,
  "state": "gbc_map11_start",
  "objective": "...",
  "max_actions": 1500,
  "dream_every_actions": 50,
  "dream_hard_actions": 70,
  "rom": "rom_gbc/pokered.gbc",
  "sym": "rom_gbc/pokered.sym"
}
```

优先级：环境变量 > `config/run.json` > 函数默认值。

脚本规则：

- 所有入口先 dot-source `scripts/lib/common.ps1`，从 `Get-PokeRoot` 取根目录。
- 不在脚本里写死本机绝对路径。
- 不在脚本里写死 `gbc_map_01` / `gbc_map_10`；要默认值就读配置。
- 静态提示词放 `scripts/prompts/*.md`，脚本用 `Get-PokePrompt` 读取；不要再内联长段落。
- MEMORY INDEX 由 `common.ps1` 的 `Get-PokeMemoryIndex` 生成，continue/fresh 共用同一格式。
- 凭据读取用 `Initialize-PokeCredentials`；party / 徽章文案用 `Format-PokeParty` / `Format-PokeBadges`。
- 所有 `.ps1` 必须是 **UTF-8 with BOM**。Windows PowerShell 5.1 会把无 BOM 的中文注释按 ANSI
  解码，某些 UTF-8 尾字节会吞掉换行，导致下一行代码被当成注释。
- 新建 run 用 `Initialize-PokeRun`；`start_map_fresh.ps1` 默认拒绝覆盖，`-Force` 才删。

## 8. 兼容层

重构期间的薄 shim 已删除：

- `emu.py` -> 统一从 `core.emulator` import
- `pi_ext/*` -> 已迁到 `agent/*`
- `server.py` -> 统一用 `python -m server`

旧 run 的数据格式没有变，仍然可以直接读；只有脚本入口改成了上面的新路径。
`scripts/legacy/`、`tools/legacy/` 里的一次性入口保留，但不再保证与新路径一致。

## 9. 验证清单

改完 `core/` 或 `server/` 后至少跑：

```powershell
# 1) 导入
.\.venv\Scripts\python.exe -c "import server; import core.input; import core.observation; print('ok')"

# 2) 临时服务（不要占用 8765）
.\scripts\start_server.ps1 -Port 8767 -RunName _walktest -State gbc_map11_start

# 3) 单步 / 连走 / 转身
#    up 后应只 +1；down 转身后 up 也只能 +1；up:32 最多 +2

# 4) 地形 sidecar
.\.venv\Scripts\python.exe tools\build_terrain.py --run gbc_map_14 --state gbc_map11_start `
    --map MT_MOON_1F --map MT_MOON_B1F --map MT_MOON_B2F
.\.venv\Scripts\python.exe tools\build_terrain.py --run gbc_map_14 --from-live --map ROUTE_4

# 5) 战略层 plan
#    plan(goal, steps) 后 TODO.md 只能有一个 ## PLAN，下面的 - [ ] checklist 必须保留；
#    poke_observe 的结果里应出现 "PLAN memory/TODO.md: <goal>"。
```

SIGHT 检查：`spatial.jsonl` 最后一条的 `map` 必须是当前地图，`end` 必须等于 RAM 坐标；
不应出现 `PALLET_TOWN (0,0)` 这种 warp 瞬态记录。

地形检查：`explored_map` 输出应出现 `terrain: ROM <MAP>_Blocks + tileset collision`；
玩家走过的格不能是 `#`，从未 seen 的格必须仍是空白。没有 sidecar 的图会显示
`terrain: SIGHT-only`，这是回退，不是错误。
