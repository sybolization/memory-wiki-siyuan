# memory-wiki-siyuan

`dsh-agent-memory` 的公开源码快照：为 DeepSeek Harness 提供跨会话记忆笔记、索引注入和离线 dreaming，并包含离线 benchmark 与 Pokémon 实验工具。

## 目录

- `app/`：插件源码、配置、文档和 M1–M6 自检
- `app/bench/`：Continual Learning Bench 适配与 Pokémon 实验工具

本仓库不包含本机运行数据、凭据、SiYuan 源码工作树、依赖目录或构建产物。

## 快速开始

```bash
cd app
node scripts/selftest-m1.mjs
node scripts/selftest-m2.mjs
node scripts/selftest-m3.mjs
node scripts/selftest-m4.mjs
node scripts/selftest-m5.mjs
node scripts/selftest-m6.mjs
```

在 `app/` 目录中安装到 DeepSeek Harness profile：

```text
plugin_manager install_bundle target: .
```

更多设计、安装和实验说明见 [app/README.md](./app/README.md)、[app/DESIGN.md](./app/DESIGN.md) 和 [app/bench/README.md](./app/bench/README.md)。
