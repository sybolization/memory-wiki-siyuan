# gbc_map_14 运行复盘

> 记录 `gbc_map_14` 这一局的完整经过：月见山探索、出洞、Cerulean 与 Misty 循环、记忆/dream 机制的实际表现，以及“用碰撞体积绘制地图”功能的当前状态。数据来自 `runs/gbc_map_14/actions.jsonl`、`spatial.jsonl`、`DREAM.md`、`memory/` 和当时的 live RAM 观测。

## 1. 基本信息

| 项目 | 内容 |
|---|---|
| run 名 | `gbc_map_14` |
| 起始存档 | `gbc_map11_start`，位置 `MT_MOON_1F (14,35)` |
| 目标 | 从月见山入口重新探索，前往 Cerulean City 并击败 Misty |
| 动作数（结束） | **1500**（达到 config 上限） |
| 地图切换 | 40+ |
| 到过地图 | 14 张（不含 warp 瞬态误报的 PALLET_TOWN） |
| 结束状态 | `CERULEAN_GYM (4,3)`，BATTLE(trainer) vs Starmie L21，Charmeleon L31 50/92 HP，金钱 ¥1，1 枚 Boulder Badge |
| Misty 战绩 | **0 胜 16 负** |
| Dream 次数 | **30** |
| act 结束方式 | 1500 动作预算用尽，agent 调用 `poke_done`，`resume exit=0`，不是崩溃 |

## 2. 时间线

### 阶段 A：月见山内部（动作 1–327）

- 起点在 1F 西侧洞口 `(14,35)`；早期记忆曾把它误写成 Route 3 ladder，后来用临时 server 验证：从 `(14,35)` 按 `down` 会到 `ROUTE_4 (18,7)`，即 Route 4 西侧洞口。
- 1F、B1F、B2F 都被大幅探索：
  - `MT_MOON_1F`：1628 个已见格
  - `MT_MOON_B1F`：836 个已见格
  - `MT_MOON_B2F`：1414 个已见格
- 出洞路线不是旧的 1F 梯子，而是一条新洞：
  ```text
  B2F (12,3) -> left (3,3) -> down (3,6) -> right (5,6)
  B2F (5,6) down -> B1F (23,3)          # 单向洞
  B1F (25,3) right -> ROUTE_4 (24,6)    # 东侧洞口
  ```
- 这条路线绕开了 1F，是从 B2F 西北角一路向西、向下踩到的隐藏洞；动作 327/329 完成出洞。

### 阶段 B：Route 4 东段与 Cerulean（动作 329–520）

- Route 4 东半张地图 x=24..89 被走通，动作 368 从 `(89,10)` 进入 `CERULEAN_CITY (0,18)`。
- Cerulean 内探索了：
  - Pokecenter、Mart、Bike Shop、Trade House、Badge House、Gym
  - 南出口被 `blocked` 证据确认封闭：`(16,28)` 南边是 signpost，Route 5 不可达
  - 东侧 `(31,12..15)` 是死口袋
- 这一阶段多次挑战 Misty，全部 blackout；金钱从初始 **¥3523** 一路掉到 **¥48**。
- 为了买药曾卖掉 TM04 并买 Potion；这段还出现了“反复走 y=26/27、反复开 Mart 菜单、反复进 Gym”的循环，Dream #10 做过诊断。

### 阶段 C：rival 与 Nugget Bridge（动作 550–723）

- Route 4 草地打了 4 场野生战，升到 L25，再回 Cerulean 回血。
- `CERULEAN_CITY (20,6)` 的 rival 战：
  - Pidgeotto L18 用 BIDE 倒塌
  - 第二只是 **Abra L15**，不断 Teleport，造成严重死循环
  - Dream #12 记录：同一 tile 上 114 步、43 次 A、零状态变化
  - 修正输入规则后，动作 613–614 打赢
- 从 `(21,6)` 往上进入 `ROUTE_24 (10,35)`。
- Nugget Bridge 五名训练家 #1–#5 全部打完：
  - L25 → L27
  - 在 `(10,5)` 拿到 **Nugget + TM45**
  - 金钱一度回到约 ¥2778
- 从 Route 24 北端 `(10,6) → (10,8) → (19,8) → ROUTE_25 (0,8)`，再走到 `(9,5)` 打赢 Route 25 Hiker（Machop L15 + Geodude L15）。

### 阶段 D：Misty 循环（动作 723–1400+）

这是整局最严重的问题段。

- 第 1–7 次 Misty：反复“多买 Potion + Ember”，全部失败。
  - 第 7 次曾升到 L29，Staryu 被 Ember 烧伤且残血，但 Starmie L21 满血出场后仍然落败。
  - 黑屏后金钱从 ¥2619 减半到 ¥1309，再减半到 ¥654。
- 决定改为刷到 **L30 学 Slash**；但 L30 并没有出现学招式提示。
- 之后继续刷到 **L31，最大 HP 92**，仍无 Slash。
- 第 11–15 次 Misty：
  - 试过 BIDE 开局、GROWL 降攻、Ember、Potion 消耗
  - Dream/notes 记录了精确机制：
    - Staryu 的 SWIFT 可打 34–37，Staryu 单独就能把 92 HP 打到 6
    - Starmie 被 Ember 抵抗，且更快、Bubblebeam/Water Gun 伤害 22–61
    - BIDE 需要在敌方攻击后跨 3 个行动才释放，Starmie 的伤害让它在 L31 不可行
    - GROWL 对 Staryu 伤害没有可测影响
    - Potion 回复 20，但一回合会被打掉约 24，净收益为负
- 每次黑屏金钱减半：81 → 40 → 20 → 10 → **¥2**。
- 最终结论写入 `battle/MISTY.md`：要再挑战 Misty，需要 **最大 HP ≥110（约 L35）**，且进入 Starmie 时 **HP ≥45**。**dream #29 已判定这个 gate 在 Route 4 草里不可达（5 杀无升级、~5%/步），retry criterion 已替换为“先找新 lever（TM45/Route 25 东侧），没有新 lever 不打第 16 次”。**

### 阶段 E：刷级死路与主动结束（动作 1400–1423）

- 它改到 Route 4 草地 `x=65..74, y=10..15` 刷级。
- 连杀 5 只野生（Spearow L10 ×2、Rattata L12、Ekans L6 ×2），**没有升级**。
- 22 格扫荡零遭遇，估算遭遇率约 **5%/步**；L35 需要 30–40 只/级（约 120 次调用）。
- 结论：**刷级在普通 session 内不可行**。
- 它写入两条 note（0051、0052）、更新 TODO，然后调用 `poke_done` 主动结束。
- act 结束后游戏/server 仍然存活，停在 `ROUTE_4 (65,15)`。

## 3. 探索效率

### 总体

| 指标 | 数值 |
|---|---:|
| 动作数 | 1500 |
| 实际移动步数 | 约 2500+ |
| SIGHT 唯一格（act 752 时） | 7828 |
| 到过地图 | 14 |
| 平均新增格 | 约 10 格/动作 |
| 无新增格的动作占比 | 约 72% |

551 条 SIGHT 记录里只有 213 条带来至少 1 个新格子；其余是战斗、菜单、回血、重复走和 probe。上表除动作数/地图数外，SIGHT 数据是 act 752 快照；最终 SIGHT 记录 893 条。

### 分地图效率（act 752 快照）

| 地图 | 步数 | 唯一格 | 格/步 | 冲突格 |
|---|---:|---:|---:|---:|
| MT_MOON_B2F | 511 | 1414 | 2.8 | 418（29.6%） |
| MT_MOON_1F | 429 | 1628 | 3.8 | 292（17.9%） |
| MT_MOON_B1F | 94 | 836 | 8.9 | 70（8.4%） |
| ROUTE_4 | 277 | 1268 | 4.6 | 94（7.4%） |
| CERULEAN_CITY | 428 | 853 | 2.0 | 286（33.5%） |
| CERULEAN_GYM | 232 | 393 | 1.7 | 14（3.6%） |
| ROUTE_24 | 243 | 567 | 2.3 | 179（31.6%） |
| ROUTE_25 | 104 | 225 | 2.2 | 23（10.2%） |

SIGHT 的 x 抖动导致约 **20% 的已见格字符冲突**（B2F 30%、Cerulean 33%、Route 24 32%）。因此原始“格数”会被噪声抬高，不能作为纯探索质量的唯一指标。

### 与 gbc_map_10 对比

| | gbc_map_10 | gbc_map_14 |
|---|---:|---:|
| act 752 时位置 | ROUTE_3 (16,8)，尚未进月见山 | ROUTE_25/ROUTE_24，已过 Cerulean |
| 最终动作 | 1866 | 1500（预算用尽） |
| 最终地图数 | 25 | 14 |
| 最终唯一格 | 13240 | 7828（act 752 快照） |
| 是否到 Cerulean | 否 | 是 |
| 是否打 Misty | 否 | 16 次，全败 |

月见山内部 map14 明显更高效：

| 地图 | map10 格/步 | map14 格/步 |
|---|---:|---:|
| MT_MOON_1F | 0.64 | 3.79 |
| MT_MOON_B1F | 0.99 | 8.89 |
| MT_MOON_B2F | 1.01 | 2.77 |

map10 在 1F 花了 2560 步看 1649 格；map14 只花 429 步看 1628 格。map14 的问题是后半段被 Misty 循环拖住，而不是探索能力差。

## 4. 记忆与 dream 机制

- `memory/battle/` 不是初始目录：
  - **Dream #11（本机 17:54:08）** 创建 `battle/MISTY.md`
  - **Dream #12（18:01:44）** 添加 `battle/RIVAL.md`
  - 这是 dream agent 按提示词自主整理记忆的结果
- 目录结构演化为：
  - `maps/`：地形、路线、门
  - `battle/`：Misty / rival 战斗数据
  - `notes/`：agent 给 dream 的 mailbox
  - `working/`：watch_working 生成的 fog-of-war 视图
- note 0041–0050 是 19:48–19:52 之间写的，记录 Misty try #11–#15 和战斗机制；**Dream #28（19:56:19）把它们全部折叠进 MEMORY/maps/battle 后删除**。
- `poke_done` 前写的 note 0051、0052 已在 dream #29 折叠删除；预算耗尽时又留下 note 0053–0055（TM45、BIDE、POTION），等待下一次 dream。
- 共 30 次 dream。旧 28 次是固定 50 动作硬停；run 结束后改为 Option C。dream #29 由进入 `CERULEAN_POKECENTER` 的新地图触发（29 actions），因宿主 120s 超时中断后恢复；dream #30 是 50 动作软窗口。dream 不消耗游戏动作，但会暂停游戏并重写记忆，墙钟开销较大。

## 5. 关键事实与踩坑

1. **SIGHT 的 `#` 不可信**：相机滚动拼接会把墙写到走过的走廊上；真正地形应来自 ROM 块与碰撞表。
2. **SIGHT x 抖动**：B2F 948 格中 163 格在不同记录里字符冲突；单列/单行雾图不能当证据。
3. **`PALLET_TOWN (0,0)` 是 warp 瞬态误报**，不是真的回 Pallet Town。
4. **badges 是 id 数组**：`[0]` 表示 1 枚 Boulder；`badge_mask=1` 也是 1 枚。显示数量时不能用 `-join` 的字符串判断。
5. **只有 `!` token 的 `blocked`、且没有文本/NPC/菜单/脚本时才是墙证据**；裸方向键只记录 `pressed`。ledge 跳跃会跨过 collision 为 `#` 的格。
6. **战斗菜单记住上一次招式**：每场战斗开始时 FIGHT 列表重置到 BIDE，之后记住本场最后使用的招式。确认前必须读 TYPE/PP 行。
7. **黑屏会回满 HP/PP、清空战斗，但金钱减半**；地图进度保留。
8. **Cerulean 南出口与东口袋都已用 `blocked` 证据确认封闭**，不要再测。

## 6. “按碰撞体积绘制地图”功能状态

**结论：已实现。`gbc_map_14` 的 14 张已访问地图都已生成 terrain sidecar；server 启动、`/load`、`/reset` 和换图后的第一次动作会自动补写当前地图。**

已完成的部分：

- `core/terrain.py`：
  - 从 ROM 的 `<MAP>_Blocks` 读取 32px block 数组
  - 用当前 tileset 的 block 表展开成 4×4 个 8px tile
  - 用 tileset collision 表判断每个 16px 格是 `.` / `#` / `,`
  - 生成时的当前地图用 `wWarpEntries` 标出 `D`
- `lib/map_view.mjs`：
  - `loadTerrain()` / `applyTerrain()` 只覆盖 SIGHT seen mask 中已有的格子
  - 地图外由抖动产生的格子会被丢弃，不会画成假墙
  - 玩家实际站过的格（`stand > 0`）即使 collision 说 `#` 也保留 `.`
  - 输出新增 `terrain: ROM ...` / `terrain: SIGHT-only` 行
- `server/app.py`：`ensure_terrain()` 在启动、`/load`、`/reset` 和每次动作后检查当前地图，每张图只写一次
- `tools/build_terrain.py`：从存档或 ROM 批量生成历史地图的 sidecar，支持 `--from-live` 直接抓当前 server 状态
- `agent/explored_map_tool.ts` 和 `tools/render_working.mjs` 的描述已改成“SIGHT 决定 seen mask，ROM 决定地形”

验证结果：

- `gbc_map11_start`（MT_MOON_1F）和 `route4_east`（ROUTE_4）的 `screen_view` 与 terrain 逐格对齐：地图内 0 差异；MT_MOON_1F 的 40 个差异全部是地图外的屏幕边缘。
- MT_MOON_B2F 有 8 个 SIGHT `#` 格被 ROM 判为地板，MT_MOON_B1F 也有 8 个；`explored_map` 现在画 `.`。
- B2F 有 3 个玩家实际站过的格在 collision 表里是 `#`（ledge / warp / script tile），`applyTerrain` 保留为 `.`，不会把走过的格封成墙。
- 从未 seen 的 ROM 格仍然空白；已 seen 的 warp 格画 `L`。
- 已生成全部 14 张 seen 地图：MT_MOON_1F / B1F / B2F、ROUTE_4、CERULEAN_CITY、ROUTE_24、ROUTE_25、CERULEAN_GYM、CERULEAN_POKECENTER、CERULEAN_MART、VIRIDIAN_CITY、BIKE_SHOP、CERULEAN_BADGE_HOUSE、CERULEAN_TRADE_HOUSE。
- 14 张图逐一跑 `map_view` 断言：8 个 `stand` 格（collision 为 `#`）全部画 `.`，8 个 unseen 格保持空白，4 个 seen warp 画 `L`。

限制：

- `tools/build_terrain.py` 现在可以直接从 ROM 的 `Tilesets` 表生成任意 tileset；只有 `D`（warp）仍然需要该地图的存档，没有存档时地形仍然正确，只是不画 `D`。
- 用别的存档生成的历史地图没有 `D` 标记（warp 数据只属于生成时的当前地图）。
- ledge 跳转会跨过 collision 为 `#` 的格；`actions.jsonl` 的路径不能直接当墙证据。

## 7. 当前状态与后续选择

- 2026-11-23 19:56 dream #28 后 act 自愿结束；当时 live 是 `ROUTE_4 (65,15)`，Charmeleon L31 81/92，¥2，1 枚 Boulder，Misty 0–15。
- 2026-11-24 09:30 从 `states/map14_pre_terrain_20261124.state` 重启 server；重启前后逐项核对 map / x / y / battle / money / badges / party 一致。
- Option C 已上线。live smoke test 用一次 `b` 确认 23 actions 不触发 gate；随后 act agent 继续，最终动作 1500/1500，预算用尽。
- 第一次真实 new-map 触发：进入 `CERULEAN_POKECENTER` 时（29 actions）gate 提前要求 dream，而不是等到 50；这是 Option C 与旧固定 50 的直接差异。
- 2026-11-24 09:38 dream #29 完成（恢复被宿主 120s 超时打断的 dream）：修正了 FIGHT 列表每场重置到 BIDE、PC 治疗是 `(3,3)` 面向 `up` 后 `a`×2、旧 retry criterion 不可达；notes 0051/0052 已折叠删除。
- dream #29 把 TODO 换成：完成治疗 → 识别 TM45（`ROUTE_24 (10,5)` 捡到，未测试；麻痹可翻转 Starmie 速度差）→ 报告 → 探索 `ROUTE_25` 东侧（x=24..28, y=9..11）作为唯一剩余 EXP 来源 → 没有新 lever 不打第 16 次 Misty。
- 09:47 dream #30（50 动作软窗口）完成；之后最后 20 动作（1481–1500）打到 Misty try #17，最终 live `CERULEAN_GYM (4,3)` BATTLE vs Starmie L21，Charmeleon L31 50/92，¥1，16 负。
- 最终状态已保存为 `states/gbc_map_14_final_20261124.state`；加载后核对为 `CERULEAN_GYM (4,3)`、battle 2、money 1、badges `[0]`、Charmeleon L31 50 HP。
- notes 0053–0055 在预算耗尽时仍 open，尚未被 dream 折叠：
  - TM45 = Thunder Wave，但 Charmeleon “NOT ABLE”，TM45 lever 死，只能卖。
  - BIDE 释放是第 4 次 bide 输入（约 3 回合 store）；进 Starmie 时 52/92，一次 store 被打 22。
  - BIDE store 期间用 POTION 不中断战斗；BIDE 存量是否保留未验证，是唯一高价值实验。
- 因此最终 MEMORY/TODO 仍把 TM45 当下一步，但 notes 0053 已推翻；下次 dream 应先折叠 0053–0055，再决定是否继续。
- 旧的“卖 TM34 / Dome Fossil、买球”方案不再作为主计划：bag 里没有 TM34，Dome Fossil 也不是可卖的关键道具；以 dream #30 的 TODO 为准，但 TM45 已被 note 0053 推翻。
- 不重启月见山；用户已明确要求保留当前 run，除非再次明确要求。
- 2026-11-24 之后新增战略层 `plan` 工具：把长期目标写进 `TODO.md` 的 `## PLAN` 块，不消耗游戏动作，act 每个动作后都会看到摘要；dream 只维护下面的战术 checklist，不删除 PLAN。本局未使用，下一局开始生效。
