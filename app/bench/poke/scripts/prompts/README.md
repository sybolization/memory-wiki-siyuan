# prompts/

静态提示词放在这里，脚本只负责变量替换和索引拼接：

- `continue.md` — 续跑提示词（不含 `RUN GOAL` 和 `MEMORY INDEX`）
- `fresh.md` — 新开局提示词，含 `__OBJECTIVE__` 占位符
- `dream.md` — dream 提示词，含 `__OBJECTIVE__` 占位符
- `resume_rules.md` — 续跑时追加的 EVIDENCE / LOOP / PLAN / DREAM / NOTES / BIDIRECTIONAL 规则，
  含 `__DREAM_RULE__` 占位符

读取统一走 `scripts/lib/common.ps1` 的 `Get-PokePrompt`：转成 LF、去掉末尾换行。
`continue_map.ps1`、`start_map_fresh.ps1`、`dream_pass.ps1`、`run_resume.ps1` 都支持
`-PrintPrompt <path>`，只渲染提示词、不启动 pi，方便改前改后 diff。

改提示词时：

1. `.\scripts\continue_map.ps1 -PrintPrompt old.txt`（fresh / dream 同理）
2. 修改对应的 `.md`
3. 再渲染一次并 diff，确认只是想改的语义变了
