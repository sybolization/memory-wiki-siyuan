# DSH Agent Memory —— 设计定稿

> 来源：[The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)
> 形态：一个 **Host-only 的 DSH 插件包**（本目录即包体），通过 `plugin_manager install_bundle` 以 `link:` 方式装进当前 `web` profile。
> 本文是设计树收敛后的定稿：**在你确认 M0 之前不写任何代码**。所有"事实"都来自对已安装运行时 `0.2.1-rc.2-r1` 的只读调查，标 *待验证* 的是实现阶段用一次 spike 确认的点。

---

## 0. 一句话

以 session 为最小粒度提取"仓库读不出来的经验"，落成 **一行一条** 的 note；Host 定时/手动 dreaming，把 note 与原始转录对照，纠错、合并、升格成跨工作区的 wiki；每个会话只注入一份**小于 60 行/4KB 的索引**，正文由模型自己 `read`/`grep` 按需取。

对应文章的层次：

| 文章 | 本设计 | 落地 |
|---|---|---|
| injected context | 索引块 | `systemPrompt.context`（runtime-context，append-only）注入，60 行 / 4KB 上限 |
| memory representations (wiki) | 全局 wiki 页 | `$DSH_HOME/memory/wiki/*.md` + `[[链接]]` |
| memory notes | 每会话一个 note | `$DSH_HOME/memory/notes/<sessionId>.md` |
| transcripts | 会话原始日志 | `ctx.sessionQuery.readSession()`（压缩不删原文） |
| dreaming | Host 编排 + 子代理判断 | `/dream` + 空闲自动触发 |

---

## 1. 已定决策（逐条，来自对话确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 记忆边界 | 只记"仓库读不出来的经验"：验证过的规则、陷阱、失败路径、决策理由、跨会话模式。偏好归 `AGENTS.md`，仅当仓库不适用时才进 note |
| 2 | 副本数 | **正文只写一次**。索引是派生元数据，wiki 页是派生表示，都不是第二份拷贝 |
| 3 | 粒度 | 一个 session 一个 note 文件；**文件名 = `name`**（重名加 `-2`），session 只是文件里的字段；内部一行一条、无序号 |
| 4 | 写入时机 | 两段式：会话内立即 append candidate；dream 校验/正式化/合并/提升；`/remember` 立即写 `[U]` |
| 5 | 读取模型 | 索引进上下文（≤60 行/4KB），正文按需 `read`/`grep`；**不做向量检索** |
| 6 | 验收 | 注入 token 上限、wiki/原文体积比上限、污染率抽样；A/B 等攒够 10 个真实问题 |
| 7 | 执行形态 | Host 代码做机械活（扫描/读取/落盘/加锁/水位线），子代理只做判断 |
| 8 | 触发 | 有新内容**且空闲**时自动 + 手动 `/dream`；错过的合并到下一次；暂无预算上限；首次引导限制：最近 7 天 / 最近 20 个 session |
| 9 | 模型 | 默认跟随子代理配置（当前 `deepseek-v4.1-flash`）；预留 `dream.model`，默认不填=继承 |
| 10 | note 落点 | 中央 `$DSH_HOME/memory/notes/<sessionId>.md`；不建 `plugins/` 下的数据、不建工作区标记目录 |
| 11 | 身份键 | 项目标签 = git remote > 路径 hash；用户可覆盖；工作区无创建事件，懒初始化 + 启动对账 |
| 12 | 会话取舍 | fork 只取 `seq ≥ inheritedEventCount`；`origin:'subagent'` 默认排除；**Team 成员包含**；归档会话只索引不提取 |
| 13 | 水位线 | 每 session 记 `dreamedThroughSeq`；失败不推进；同段重跑靠内容去重保证幂等 |
| 14 | 工具面 | 只有 `memory_note append`；读/搜/改全部用内置 `read`/`grep`/`edit`/`write` |
| 15 | 行格式 | `- [V\|p] 内容 (s812)`；来源标记由工具自动盖，模型不填 |
| 16 | 写入不是义务 | 判定"本轮没有值得记录的东西"时，模型**直接结束、不调用工具**；注入块与工具描述都明说"多数回合不需要写"。dreaming 同样宁可少记，禁止为了留痕制造空话 |
| 17 | 记忆语言 | 笔记、判断提示词、dream 输出与报告**一律中文**（用户要能直接 review）；命令、文件名、代码标识符保留原文 |
| 18 | dream 全局性 | dream 是全局操作：扫描、候选、写入、水位线、索引都不依赖调用者会话。判断子会话固定 `cwd` 为记忆根目录；配置 `dreamModel` 时用固定 provider/model 路由，`dreamProvider` 只换 backend。未配置 `dreamModel` 时继承调用者模型（唯一残留差异） |
| 19 | 可观测与中断 | dream 运行期实时写 `dream-progress.json`（阶段 / 已完成 / 当前会话），doctor 直接读；每处理完一个会话立即 `saveState`，中断或异常也补记 `runs.jsonl`（`aborted`），已写笔记不丢、未完成会话下次重跑。`dreamConcurrency`（1..4，默认 1）控制并发：每会话一个判断子会话，笔记按会话分文件，天然无写冲突 |
| 20 | 范围与后台 | `dreamProjects` 是 cwd 前缀白名单（大小写不敏感，空数组=全量），默认只跑选定项目；`/dream` 后台运行并立即返回，`/dream all` 排空队列（`dreamAllMax` 上限），`/dream status|stop` 查看与中断 |
| 21 | 手动可选会话 | dream 支持显式会话列表（`only`）：绕过项目范围与水位线、按 id 精确定位，`/dream list` 编号、`/dream pick 1,3`/`/dream pick <id>` 触发。同一能力将作为可视化面板"勾选会话→开始"的底层入口 |
| 22 | 命令必须声明 input | 带参数的斜杠命令必须带 `input: { hint }`：客户端 `matchEnter` 对无 input 的 host 命令只接受裸 token，带参输入会原样发给模型。doctor 的 `commands:` 行做注册自检（missing / ok(bare-only) / ok） |
| 23 | wiki 实现取舍 | 页面文件名 = 可读前缀 + 内容哈希（中文/标点/长度安全）；candidates 每次重建、可再生、最多 40 个；体积闸门只量**升格页**（候选是临时缓存，不计入），超标则本轮不升格、旧页保留；冲突用"字面相似 + 极性相反"启发式标记，真正裁决留给下一次 dream |
| 24 | 笔记文件身份 | 文件名 = `name`（≤50 字，非法字符替换、重名加 `-2`）；文件头固定 `name`/`description`/`session` 三字段，**强制非空**（缺省时沿用旧值、再缺按内容派生）；dream 每次可改写 name/description，改名会连带重命名文件，但**只接受非空值**；注入块是紧凑树形目录（`notes/` + `wiki/`，一行一个文件，描述截断 40 字），不出现 session id、日期、条目数与完整路径 |

---

## 2. 数据布局

```
$DSH_HOME/memory/
  index.json                 # 中央索引（Host 原子写：temp + rename）
  runs.jsonl                 # dreaming 审计日志（append-only，可追溯每次改动）
  notes/
    <name>.md                # 一个会话一篇；文件名 = name，session 记在文件头
  wiki/
    index.md                 # 全局主题目录（由 host 生成）
    <slug>.md                # 主题页（正文 + [[链接]] + evidence）
    candidates/              # 未达证据门槛的结论
```

### 2.1 note 文件格式（定稿）

```
---
name: DSH 提示装配上下文排查
description: 记录 runtime context 在 assembly.contexts 而非 sections，以及插件重载与注入验证的判据
session: session-151fc59a-1e60-427c-bbe1-da05e2e93db8
---

- [V|p] 这个仓库的测试命令是 pnpm test，不是 npm test。(s812)
- [U|p] 提交前必须跑 pnpm build。(s1044)
- [I|g] DSH 本地插件用 junction 安装，运行数据不能写进包目录。(s913)
- [I|g] 插件数据目录只能放 $DSH_HOME 下。(d 2026-11-17)
```

- **文件名 = `name`**（`<name>.md`）：Windows 非法字符替换成 `-`、首尾点与空白去掉、截断 50 字；
  同名文件已存在时依次加 `-2`/`-3`。模型在注入块里看到的就是文件名。
- `session` 只存在文件里（与索引的会话记录对应），不参与命名。
- `name` / `description` / `session` **必须非空**：写入时没给就沿用旧值，旧值也没有就按会话 id + 内容派生；
  dream 可以改写，但空串一律视为"没给"，不会把已有值抹掉；**name 变了会连带重命名文件**。
  旧文件（没有 frontmatter）由下一次 dream 补写。
- `[V]` 已对照转录核实 · `[I]` 推断 · `[U]` 用户明确要求
- `[p]` 项目内有效 · `[g]` 全局候选（仍需证据门槛才进 wiki）
- 行尾来源标记三选一，**全部由工具盖**：`(s<seq>)` 有会话事件来源；`(u YYYY-MM-DD)` 用户手写无 seq；`(d YYYY-MM-DD)` dream 合成/合并
- 单行，禁止换行；内容就是这条笔记的身份（定位用 `grep`，修改用内置 `edit` 按文本匹配）
- Lint 正则：`^- \[(V|I|U)\|(p|g)\] .+ \((s\d+|u \d{4}-\d{2}-\d{2}|d \d{4}-\d{2}-\d{2})\)$`

### 2.2 wiki 页格式

```
---
title: DSH 插件持久化
scope: global
updated: 2026-11-17
evidence: ["session-f6f5…#812", "session-1454…#913"]
---
正文……见 [[dsh-plugin-install]]。
```

- 硬规则：**全局页不写绝对路径、机器名、用户名、任何凭据形态**（写入前 lint，命中即拒）
- 升格证据门槛：同一结论在 **≥2 个工作区** 或 **≥3 个 session** 独立出现；不满足 → `wiki/candidates/`
- 体积比闸门：`wiki/` 总字节数 / 来源 note 总字节数 > 0.7 时，dream 必须先 prune 再继续

### 2.3 index.json（Host 自管，不用 storageDomain）

```jsonc
{
  "version": 1,
  "updatedAt": "2026-11-17T10:12:00+08:00",
  "sessions": {
    "session-f6f52e60-…": {
      "cwd": "/path/to/project",
      "project": "path:9f2c1a7d4b6e",     // git:<remote> | path:<sha1(realpath):12>
      "createdAt": "2026-11-16T22:14:03+08:00",
      "dreamedThroughSeq": 4200,           // 水位线
      "noteEntries": 12,
      "file": "DSH 提示装配上下文排查.md",   // 笔记文件名（= name）
      "name": "DSH 提示装配上下文排查",       // 与文件 frontmatter 同源，注入块直接读
      "description": "记录 runtime context 在 assembly.contexts 而非 sections…",
      "session": "session-151fc59a-…",      // 笔记对应的会话（文件里的字段）
      "origin": null,                       // 'subagent' | null
      "team": false,                        // 是否 Team 成员会话
      "archived": false,
      "lastDreamedAt": "2026-11-17T03:00:12+08:00",
      "lastError": null
    }
  },
  "topics": {
    "dsh-plugin-persistence": {
      "title": "DSH 插件持久化",
      "page": "wiki/dsh-plugin-persistence.md",
      "status": "promoted",                 // promoted | candidate
      "updatedAt": "2026-11-17T03:00:12+08:00",
      "evidence": ["session-f6f52e60…#812", "session-1454e20e…#913"]
    }
  },
  "teamMembers": ["<sessionId>", "…"],      // 从 Lead 日志的 team/member 事件收集，带缓存
  "runs": [ { "id": "…", "startedAt": "…", "finishedAt": "…", "sessions": ["…"], "status": "ok", "model": "…" } ]
}
```

**为什么不用 `ctx.storageDomain`**：它的表结构要求 Zod schema，而插件以 `link:` 装进 profile 后 **import 不到任何 `@deepseek-ai/*` 包**（已实测 `MODULE_NOT_FOUND`），本地包也没有依赖安装步骤。因此索引走 `node:fs` + 原子写（先例：`@local/dsh-auto-compact` 就是这样写 `$DSH_HOME/storages/auto-compact/`）。代价是失去 schema 校验与 `domain/changed` 事件——本设计不需要它们。

---

## 3. 生命周期

### 3.1 会话内写入（candidate）

**写入是可选动作**：没有值得记的内容就什么都不做、正常结束——不写空话、不凑数、不为"留痕"而留痕。

1. 模型判断"这条值得记"，调 `memory_note`，参数只有 `text`、`confidence`、`scope`。
2. Host 侧工具：查重（归一化后同内容已存在 → 返回 `already recorded`）→ 校验单行 → 追加 `- [V|p] … (s<当前会话最新 seq>)`。
3. 同步更新 `index.json` 的 `noteEntries` / 文件路径映射（不推进水位线）。
4. 读取永远走内置 `read`/`grep`；手工编辑走内置 `edit`/`write`，事后 lint 只提醒不拦截。

### 3.2 `/remember`

走同一条 append 路径，标记 `[U]`，`s<seq>` 同样自动盖。**立即可见，不等 dream**（文章里"用户明确要求"的条目没有延迟的理由）。

### 3.3 dreaming

```
触发（空闲 + 有新内容，或 /dream）
  → 全局单飞锁（进程内 + index.json 里的 run 标记）
  → 取候选：listSessions() 过滤（fork 继承段 / subagent / 归档只索引 / 水位线）
  → 逐个 readSession()，取 seq > max(dreamedThroughSeq, inheritedEventCount)
  → 生成 digest（限预算；失败优先保留 tool/result 与 user/message）
  → 子代理判断，返回**结构化 JSON**（不写文件）
  → Host 校验并应用：name/description、append / replace 行、wiki 候选或升格、记录 runs.jsonl
  → 推进 dreamedThroughSeq（仅当该 session 应用成功）
  → 主批次结束后：为缺 name/description 的旧文件补一轮短判断（只读文件已有条目，不动水位线）
```

- 子代理**只输出 JSON**，所有写盘由 Host 做：避免它受自身会话沙箱、也避免不可审计的写。
- name/description：判断结果给了就复核改写，空串视为"没给"（沿用旧值），因此**不会放空**；
  旧文件补写单独统计（`metaFixed`/`metaFailed`），失败不影响主批次。
- 失败/中断：不推进水位线；指数退避；同一段重跑靠内容去重幂等。
- 并发：全局一把锁；有 agent 处于 running 时推迟，避免和正在工作的会话抢资源。
- 首次引导：只处理最近 7 天或最近 20 个 session（可配，跑过一次即失效）。

### 3.4 注入

每次请求装配时渲染索引块（≤60 行 / ≤4KB），是一棵紧凑的目录树：

```
## Agent memory
root: <DSH_HOME>/memory
notes/
├─ DSH 提示装配上下文排查.md — 记录 runtime context 在 PromptAssembly.con…
├─ pi CLI 多工具参数写法.md — 记录 pi CLI 的 -t/--tools 重复传入只保留最后一次…
└─ 插件改动后靠 set_plugin 触发重载.md — 记录源码级 HMR 未开启时，插件代码改动…
wiki/
└─ dsh-plugin-persistence.md — DSH 插件持久化
```

- 文件名 = `name`，描述截断 40 字；**不出现 session id、日期、条目数与完整路径**。
- 数据来自索引（`file`/`name`/`description`），索引是文件 frontmatter 的派生副本：
  refresh 时按 mtime 从文件回填，手写修改与改名都会生效（文件为准）。
- 正文永不进注入层（防慢性投毒）；0 条目的会话不列入（没有可读文件）。

裁剪顺序：全局主题（按更新时间倒序）→ 本工作区最近 10 个有内容的 note → 其余丢弃。没有 name/description 的
旧文件先显示 `（无描述，dream 会补写）`，下一次 `/dream` 补写并改名。

注入层是 **runtime-context（`systemPrompt.context`）**，不是 system prompt section：索引块每写一条 note 就会变，而 system prompt 在历史里是一段可变前缀——在不支持 mid-conversation system message 的路由上会被整段原地替换、前缀缓存全废（实测单次代价 = 整个上下文重新计费）。runtime context 是 append-only 快照（`surfaceOp: "append"`），变化只多一条消息，之前的 system prompt 与历史继续命中。同理，`memory_note` / `memory_status` 两个工具**常驻注册、不随 config 增删**：工具集变化会重写 tools 数组并开启新的 request series，代价同样是整段缓存失效。

### 3.5 冲突裁决

1. `[U]` 无条件优先于 `[V]`/`[I]`（权威优先级，与时间无关）；
2. 同会话内：seq 大者新；
3. 跨会话：绝对时间新者优先（`s<seq>` 反查 `event.time`，或 `(u/d YYYY-MM-DD)`）；
4. 无法裁决时两条都保留，并在 wiki 页标 `conflict`，等下一次 dream 用转录裁定。

---

## 4. 模块拆分（每块 ≤100 行左右，中文注释，超出即拆）

| 文件 | 职责 | 预算 |
|---|---|---|
| `package.json` / `cordis.patch.yml` | bundle 清单与行插入（disabled=false，Host 行） | 30 |
| `index.js` | 插件入口：apply、服务注入、装配子模块、Config 校验 | ~80 |
| `lib/paths.js` | `$DSH_HOME/memory` 路径解析、安全校验、原子写（temp+rename） | ~80 |
| `lib/state.js` | `index.json` 读写、水位线、sessions/topics/runs、版本号 | ~100 |
| `lib/notes.js` | note 行解析/格式化/查重/戳记/append + 文件头 name/description 读写 | ~100 |
| `lib/scan.js` | 会话枚举、过滤（fork/subagent/team/归档）、项目键（git remote/路径 hash） | ~100 |
| `lib/digest.js` | `readSession` → seq 水位线之后的事件 → 限预算文本摘要 | ~100 |
| `lib/index-block.js` | 注入块渲染 + 60 行/4KB 裁剪 | ~90 |
| `lib/inject.js` | `systemPrompt` 接线（动态按会话生成） | ~60 |
| `lib/tool-note.js` | `memory_note` 工具注册（append only） | ~70 |
| `lib/commands.js` | `/remember`、`/dream` 注册 | ~80 |
| `lib/judge.js` | 子代理激活、judge 提示词、JSON 输出解析 | ~100 |
| `lib/dream.js` | 编排：锁、候选、预算、应用、审计、退避 | ~120（拆 host-apply 后再压） |
| `lib/wiki.js` | wiki 渲染、index 生成、证据门槛、体积比闸门 | ~110 |
| `lib/lint.js` | `write`/`edit` 后格式提醒（warn-only）+ 全局页隐私扫描 | ~60 |
| `prompts/judge.md` | 判断阶段提示词（只给"记忆是干什么的"，不给细规则） | — |

---

## 5. 里程碑（每步装进 profile 后验证，不一次性写完）

| 里程碑 | 内容 | 验证方式 |
|---|---|---|
| **M0 骨架 + spike** | 包清单、patch 行、空插件挂载；spike 四个 API：动态 `systemPrompt`、`tools.register`、`commands.register`、`subagents` 激活 | `plugin_manager install_bundle`（link:）→ `cordis_inspect_query` 看到 Config/row；spike 结果回填本文 |
| **M1 路径与状态** | paths + state；index.json 读写与原子写 | 单测脚本 + 手写一条假 session 状态，重启后仍在 |
| **M2 写入通道** | notes + `memory_note` 工具 + `/remember` | 在当前会话里真实写一条 note，`grep` 能定位，index 更新 |
| **M3 注入** | index-block + inject | 新会话能看到索引块；超限时正确裁剪；token 预算实测 |
| **M4 扫描与水位线** | scan + digest（**不调模型**） | 输出"待处理清单 + digest 摘要"到文件，人工核对 fork/team/归档是否正确 |
| **M5 dream** | judge + dream + `/dream` | 手动跑一次：产出纠错/新增、run 记录、水位线推进；中断后不重复处理 |
| **M6 wiki + lint** | wiki 页与门槛、体积比、lint | 构造两条冲突 note，验证证据门槛与冲突裁决；全局页隐私扫描拦截绝对路径 |
| **M7 收口** | 空闲自动触发、团队/归档规则、验收判据测量 | 连续运行数天，看污染率/注入体积 |

---

## 6. 硬约束（来自运行时事实，不可违反）

1. **零 npm 依赖**：插件代码只用 `node:` 内置模块 + 注入的 `ctx` 服务；不 `import` 任何 `@deepseek-ai/*`（profile 解析不到）。
2. **Host 代码不受 sandbox 限制**，可以读写 `$DSH_HOME`；但**模型/子代理受各自会话沙箱限制**——所以写盘一律由 Host 做。
3. **会话原文永不删除**：compaction 只是 surface 替换；dream 任何时候都能读 raw log。无需"压缩前快照"。
4. **本机没有 FTS**（`session-query-sqlite` 是 `openAt: never`），`searchSessions/searchEvents` 会抛错；检索只能自己实现或用内置 `grep`。
5. **`sessionQuery` 无鉴权、覆盖全库、无切片 API**：作用域过滤与水印由本插件实现；`readSession` 全量 replay，候选必须限量。
6. **fork 子会话物理复制父前缀**：必须用 `inheritedEventCount` 截断，否则父历史重复入账。
7. **`parentSession` ≠ 继承**：只有 `isSeeded=true` 才是 fork；subagent 会话也有 `parentSession`。
8. **Team 成员识别**：`team/member` 事件只存在 Lead 日志，`member.id` 即成员 SessionId；缓存到 `index.teamMembers`，只重扫有变化的 Lead。
9. **归档不在 session 日志里**：读 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds`（防御性解析，失败按空处理）。
10. **没有"工作区创建"事件**：懒初始化（首个 session 落到该 cwd）+ 插件启动对账 `workspaceRegistry.list()`。

---

## 7. 待验证清单（M0 spike 必须回答，结果回填）

| 问题 | 备选方案（若不可行） |
|---|---|
| `ctx.systemPrompt.section()` 是否支持按会话动态文本？ | 改用 `ctx.systemPrompt.context()` / `variable()`；再不行用 `agent/created` + `agent.inject()` 注入基线消息（agent-instructions 的做法） |
| `ctx.tools.register()` 的 definition 形状与作用域 | 注册到 Host 全局层（与 session-search bundle 同法）；必要时按 `agent.ctx` 注册 |
| `ctx.commands.register()` 的 `CommandDefinition` 字段（参数解析、返回渲染） | 参考 `dsh-command-compact` 实现 |
| `ctx.subagents.startActivation()` 的 spec 能否以 `spawn` 起一个无 UI、仅返回结果的子会话 | 退回 `agentLoop.createAgent` 或"在当前会话里由模型调 `dream` 工具"（成本更高） |
| 无 Schema 的 Config 能否被 Loader 接受 | 若必须 Schema，则手写最小 `Schema`（`schemastery` 若不可解析就自己实现最小校验） |

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 注入层污染（错误笔记进每个会话） | 索引只放指针+日期+置信度；正文按需读；dream 用转录纠错；每次改动留 `runs.jsonl` 可回滚 |
| wiki 膨胀（Borges 地图） | 体积比 > 0.7 强制 prune；只对"跨文档综合"建页 |
| 首次 dream 成本失控 | 引导限制 7 天 / 20 session；之后水位线增量；暂无硬预算但可观测 |
| 并发写坏 note | 只允许 Host 写；单飞锁；append 用 `O_APPEND` 语义（Node `appendFile`）+ 查重 |
| 模型绕过工具直接 `write` 破坏格式 | lint 只提醒；dream 下一次会修正；格式破坏不阻断 |
| 跨项目隐私泄漏 | 全局页硬规则 + 证据门槛 + 隐私 lint；`[p]` 条目永不进全局页 |
| 会话被移动/工作区改动 | 身份用 sessionId 与 git remote/路径 hash，不依赖目录位置 |
| 运行时升级导致 API 漂移 | 依赖面刻意压到最小（4 个服务 + 内置工具）；每月自检一次 |

---

## 9. 验收判据（第一版就要量）

1. **注入预算**：每会话注入 ≤ 60 行且 ≤ 4KB（实测 token）。
2. **体积比**：`wiki/` 字节数 / 来源 note 字节数 ≤ 0.7，超限时 dream 拒绝升格并先 prune。
3. **污染率**：抽样 20 条 note，错误/过期比例 < 10%；每条 dream 改动可在 `runs.jsonl` 追溯。
4. **幂等**：同一段 seq 重跑两次，note 不产生重复行。
5. **记忆命中**：攒够 10 个"必须跨会话才知道"的真实问题后做开/关对比（后置）。

---

## 10. 非目标（明确不做）

- 向量/embedding 检索
- 修改 `AGENTS.md`（偏好仍归它）
- 跨机器同步、加密、云备份
- 首版 UI 面板（`/memory:open` 打开目录即可）
- 自动替用户做决策（memory 只提供证据与规则，不执行动作）
