$ErrorActionPreference = "Continue"
$poke = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
& (Join-Path $poke "run_resume.ps1") -RunName "gbc_map_01" -MemoryMode full -MapMode structured -RemainingActions 4002 -State "resume_map_5000" -ServerPort 8765 -Prompt "Continue from exactly where you left off in Viridian Forest. Do not restart the task. Use the saved map, keep FRONTIER current, and keep playing toward Pewter until the action budget is exhausted."
