# 记忆模块 benchmark（Continual Learning Bench）

用开源 benchmark [pgasawa/continual-learning-bench](https://github.com/pgasawa/continual-learning-bench)（CLB）验证
`memory_wiki` 插件那套"笔记 → dream 巩固 → wiki 升格 → 注入"的架构是否真的带来跨实例学习收益。

## 架构映射（保持 DESIGN.md 不变）

| 插件概念 | CLB 中的对应物 |
|---|---|
| 会话 session | 一个 instance（一手牌 / 一个任务实例） |
| 工作区 workspace | 对手变体（calling_station / loose_aggressive / fit_or_fold） |
| dream（判断子会话提取笔记） | 每手结束调用一次判断模型，输出 `[g]/[p]` 笔记 |
| 笔记 notes/*.md | `memory_root/notes/<序号>-<id>.md` |
| 笔记格式 | `- [V|g] 内容 (s<instance>,<opponent>)` |
| 巩固 wiki | 同一结论证据 ≥ 3 个会话 或 ≥ 2 个对手 → 升格页；其余进 candidates |
| 体积闸门 | 升格页字节 / 笔记字节 ≤ `wiki_max_ratio` |
| 注入块 | 每次 respond 前拼接"已升格全局页 + 近期笔记"（≤ `max_inject_chars`） |
| 隐私闸门 | 命中绝对路径/UNC/邮箱/长密钥的笔记直接丢弃 |

与插件版本的已知差异：
- 面板/命令层没有移植，CLB 里只保留算法链路；
- 冲突裁决只做标记（与插件 M6 行为一致），真正合并留给下一轮；
- 评分来自 CLB（poor 的手牌收益 = `score`，单位 BB/手）。

## 隔离

- benchmark 仓库可克隆到任意目录，通过 `CLB_ROOT` 指向它（独立 `.venv`）；
- 本目录只放系统实现、配置与自检，文件都在 `bench/` 下；
- 记忆默认写到**临时目录**（每次构造一个新 system 就是一份空记忆），不碰
  `$DSH_HOME/memory`；签出产物通过 CLB 的 `system_artifacts` 读取；
- `dsh_memory` 系统声明 `parallel_safe = False`，基线会退化成顺序执行，避免并发写同一份记忆。

## 接入方式

CLB 只扫描自己的 `src/systems/`，所以用 junction 把本目录挂进去（一次性，可随时删）：

```powershell
$clb = $env:CLB_ROOT
New-Item -ItemType Junction `
  -Path  (Join-Path $clb "src\systems\dsh_memory") `
  -Target (Resolve-Path ./bench/dsh_memory).Path
```

## 环境

```powershell
Set-Location $env:CLB_ROOT
uv sync --all-extras
uv run clbench list         # 应当看到 dsh_memory
```

## 模型接入（opencode-go 网关）

凭据来自 DSH 自己的配置，benchmark 通过 opencode-go 网关调用模型：

- base：`https://opencode.ai/inference/go/v1`（OpenAI 兼容）
- model：`deepseek-v4.1-flash`
- key：DSH 凭据文件 `$DSH_HOME/.credentials.yaml` 的 `OPENCODE_GO_API_KEY`（本目录代码只读取、不打印）
- 必需头：`x-opencode-session`（任意 uuid，网关用来做会话路由）

`run_clb.py` 会在进程级别设置 `litellm.api_base` / `litellm.headers`，并把 `bench/`
加进 `PYTHONPATH`，让 CLB spawn 出来的 baseline worker 通过 `sitecustomize.py` 也拿到同样配置。
所以内置基线（icl / icl_notepad）也能直接跑，不需要另配 `.env`。

> 注意：内置 icl 系系统要加 `"provider_mode": "litellm_chat"`，否则会走 OpenAI Responses
> 原生路径并打到 api.openai.com（本地区会被 403 拒绝）。

## 运行

（`--config` 里的 `runs`/`max_workers` 已压到 1，便于观察；default 长跑用 8 并发跑基线）

```powershell
$bench = (Resolve-Path ./bench).Path
Set-Location $env:CLB_ROOT
uv run python (Join-Path $bench "run_clb.py") run `
  --config (Join-Path $bench "configs\dsh_memory_poker_default.json") `
  --no-live-dashboard
```

## 已知取舍

- `parallel_safe = True`：baseline 的每个 worker 是独立进程 + 独立临时记忆目录，安全；
  rollout 的 1 个 run 仍是单进程顺序。
- 体积闸门在笔记很少时容易把升格页压掉（笔记字节太小），所以首轮能看到升格页的前提是
  证据足够多；`RESULTS.md` 会记录每轮的 ratio。

## 离线自检（不需要模型 key）

```powershell
uv run python bench/selftest_offline.py
```

覆盖：判重与证据累积、隐私闸门、只升格 `[g]`、体积闸门、注入块、冲突启发式、审计文件。

## 产物

CLB 会把每次运行写到 `results/<task>/...json`（或 `--output` 指定），其中：

- `result.score`：平均每手收益（BB/手），主指标；
- `result.instance_outcomes`：逐手收益，可画学习曲线；
- `system_artifacts.notes` / `.wiki`：本次跑出来的笔记与升格页（每份截断 4000 字符）；
- `execution.usage`：respond/judge 的 token 与费用。
