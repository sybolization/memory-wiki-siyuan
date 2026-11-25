# agent/

pi 扩展的正式位置。`run_resume.ps1` 和 `scripts/dream_pass.ps1` 用绝对路径
`--extension` 加载这里，不再依赖 `pi_ext/`。

| 文件 | 注册的工具 |
|---|---|
| `poke_tools.ts` | `poke_observe` / `poke_act` / `poke_program` / `poke_done` |
| `memory_tools.ts` | `read` / `write` / `edit`、notes、`plan`、`memory_dream`、`dream_finish` |
| `explored_map_tool.ts` | `explored_map` |

依赖方向：`agent/ -> lib/`。共享状态机在 `lib/dream_state.mjs`，地图渲染在
`lib/map_view.mjs`；`agent/` 不 import `core/` 或 `server/`。

主要环境变量：

- `POKE_URL`：模拟器地址
- `POKE_MEMORY_DIR` / `POKE_MEMORY_MODE`：记忆目录与 full/blinded 模式
- `POKE_RUN_NAME` / `POKE_ROOT`：run 名与 bench/poke 根目录
- `POKE_MAX_ACTIONS`：本 session 的动作预算
- `POKE_DREAM_EVERY_ACTIONS`：dream 周期
- `POKE_DREAM_CHILD` / `POKE_DREAM_READ_DIR`：dream 子进程标记与只读 run 目录

改完这里后，至少用 `jiti` 或一次临时 pi session 验证三个扩展都能加载。
