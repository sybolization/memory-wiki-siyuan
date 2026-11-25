# dsh-agent-memory

给 DeepSeek Harness 的**跨会话记忆**插件：以 session 为粒度沉淀"仓库读不出来的经验"，
注入一份极小的索引，再通过离线 dreaming 把笔记对照原始转录纠错、合并成跨工作区的 wiki。

设计定稿见 [DESIGN.md](./DESIGN.md)。灵感来自 Anthropic 的
[The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)。

## 当前状态：M0–M6（M6 wiki + lint 已实现，真机 dream 已跑通）

已实现：

- bundle 清单与 `cordis.patch.yml`（插入一行 Host 插件 `agent-memory`）
- 配置归一化（不依赖 schemastery，纯 JS 校验）与路径解析
- 诊断工具 `memory_status` 与命令 `/memory doctor | open | scan`
- **M1**：`index.json` 原子读写、版本校验、会话记录/水位线/runs 追加
- **M2**：`memory_note` 工具 + `/remember` 命令；单行格式、自动来源标记、内容查重。
  **文件名 = name**（`<name>.md`，非法字符替换、重名加 `-2`）；文件头固定
  `name` / `description` / `session` 三字段且强制非空——工具入参给了就用，没给则沿用旧值、
  再缺按会话 id + 内容派生。session 只作为文件字段存在，不参与命名。
  **写入是可选的**：判定没有值得记的内容时，模型直接结束、不调用工具（工具描述与注入块都明说"多数回合不需要写"）。
- **M3**：按 cwd 过滤的索引注入块（≤60 行 / 4KB），写后即时刷新。渲染成紧凑的树形目录：
  `notes/` 下一行一个 `文件名 — 短描述（截断 40 字）`，`wiki/` 下是已升格主题；
  不出现 session id、日期、条目数与完整路径。索引里的 file/name/description 是文件
  frontmatter 的派生副本（refresh 时按 mtime 回填，手写修改与改名都生效），0 条目会话不列入
- **M4**：会话扫描与候选队列——归档/subagent/migration 过滤、Team 成员经
  `team/member` 事件收录、fork 从 `inheritedEventCount` 起算、水位线跳过、
  首次运行限最近 7 天 × 20 个会话；结果只读可预览
- **M5**：`/dream` dreaming——扫描队列 → 每会话摘录（默认 12k 字符）→ spawn 判断子会话
  （JSON 结构化输出，含 `name`/`description`）→ Host 校验/查重/落盘（`(d 日期)` 标记）→ **成功才推进水位线**，
  失败下次重试；单飞锁；`runs.jsonl` 审计；单次最多 `dreamBatchSize`（默认 5）个会话。
  主批次结束后会为**缺少 name/description 的旧文件**补一轮短判断（只读该文件已有条目、不重读转录，
  不动水位线，单次最多 30 个）；name/description 可以被 dream 改写（改 name 会连带重命名文件），
  但空串不会覆盖已有值。
  命令已改为**后台运行**：`/dream`（单批）、`/dream all`（排空队列）、`/dream list`（列候选）、
  `/dream pick 1,3` 或 `/dream pick <sessionId>`（手动勾选会话，为后续面板预留底层能力）、
  `/dream status` / `/dream stop`
- **M6**：wiki 与 lint——笔记聚合后按证据门槛（≥2 工作区 或 ≥3 会话）升格为全局页，
  不够的进 `wiki/candidates/`；页面写前过隐私扫描（绝对路径/用户名/凭据），命中即拒；
  体积比 `wiki/notes > wikiMaxRatio` 时先弃候选、仍超则本轮不升格；冲突（极性相反且字面相似）
  在页面标 `conflict` 待裁定；`/memory wiki` 手动同步，`/dream` 结束自动同步；`/memory lint` 检查格式与隐私

**语言约定**：笔记与 dream 产出一律中文（命令、文件名、代码标识符保留原文），方便人工 review。

**dream 的全局性**：扫描、写入、水位线、索引都与在哪个 session 触发无关；判断子会话的 `cwd` 固定为记忆根目录。要连判断模型也固定，给行配置加 `dreamModel`（如 `dreamModel: deepseek-v4.1-flash`），配合 `dreamProvider`（默认 `spawn`）。

**dream 的可见性与中断**：运行期间实时写 `dream-progress.json`（阶段 / 已完成数 / 当前会话），`memory_status`、`/memory doctor` 直接可读；每个会话处理完立刻保存水位线，中断或异常也会补记一条 `runs.jsonl`（`aborted: true`）。已写入的笔记不丢，未完成的会话下次重跑（查重不会重复写）。并发用 `dreamConcurrency`（1..4，默认 1）控制——每个会话一个独立判断子会话，笔记文件天然按会话隔离。

**dream 的范围与后台运行**：`dreamProjects` 是项目根路径白名单（cwd 前缀匹配，大小写不敏感），留空 `[]` 表示全量，也可按需填写本机项目根路径。`/dream` 现在**立即返回、后台运行**：裸 `/dream` 跑单批（≤`dreamBatchSize`），`/dream all` 排空队列（≤`dreamAllMax`，默认 100），`/dream status` 看进度，`/dream stop` 中断。

**斜杠命令的参数**：DSH 客户端只把**声明了 `input: { hint }`** 的命令当作"可带参数"；没有 input 的命令只认裸调用，带参输入会被当成普通消息发给模型（`/dream list` 曾因此漏进模型）。三个命令都已补 `input`，`memory_status` 的 `commands:` 行可直接自检。

自检脚本：`node scripts/selftest-m1.mjs` / `-m2` / `-m3` / `-m4` / `-m5` / `-m6`（共 173 项）。

**热重载**：源码级 HMR 未开启，改完代码需要 `plugin_manager set_plugin`
把 `include:agent-memory` 关再开一次。

## 安装（在本机 profile `web` 中）

在 `app/` 目录中执行：

```
plugin_manager install_bundle  target: .
```

本地目录安装使用 `link:`，代码改动只需重启 Host（或等 HMR 重新加载该行）。

## 验证

- 让任意会话调用工具 `memory_status`，或输入 `/memory doctor`；
- 输出应包含：`services: ...=ok`、`api: ...=ok`、`sessions: <n>`、`memory dir: ...`。

## 目录结构

```
index.js              入口（薄）：只转出 name / inject / apply
src/plugin.js         装配层：注册诊断工具与命令
src/config.js         配置默认值与校验
src/home.js           DSH_HOME / 记忆目录解析
src/doctor.js         诊断报告（工具与命令共用）
locale/               en / zh 元数据
icon.svg              插件图标
cordis.patch.yml      插入 Host 行
```

后续里程碑（M1–M7）见 DESIGN.md 第 5 节。
