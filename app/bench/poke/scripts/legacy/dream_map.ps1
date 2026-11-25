$ErrorActionPreference = "Continue"
$poke = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$n = (Get-Content (Join-Path $poke "runs\gbc_map_01\actions.jsonl") | Measure-Object -Line).Lines
$rem = 5000 - $n
$prompt = "Continue from exactly where you left off. This is the action-based dreaming phase: every 50 successful game actions (poke_act or poke_program), poke_act and poke_program will refuse with DREAM DUE. When that happens: review the recent actions from your own context, compare MEMORY.md and maps/*.md against what actually happened, correct wrong or stale claims, merge duplicates, update FRONTIER, then call memory_dream with a summary. Treat absolute claims such as SEALED, NOT FOUND, unreachable or solid as hypotheses: keep them only if the action log supports them, otherwise mark them unverified. Keep playing toward the staged goals until the action budget runs out."
& (Join-Path $poke "run_resume.ps1") -RunName "gbc_map_01" -MemoryMode full -MapMode structured -DreamEvery 0 -DreamEveryActions 50 -RemainingActions $rem -State "dream50_map_$n" -ServerPort 8765 -Prompt $prompt
