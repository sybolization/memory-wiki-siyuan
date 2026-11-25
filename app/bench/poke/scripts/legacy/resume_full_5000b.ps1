$ErrorActionPreference = "Continue"
$poke = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
& (Join-Path $poke "run_resume.ps1") -RunName "gbc_full_02" -MemoryMode full -MapMode none -RemainingActions 3841 -State "resume_full_5000b" -ServerPort 8766 -Prompt "Continue from exactly where you left off. This leg's action budget is explicitly 3841 actions (the overall episode target is 5000 total). The budget is NOT exhausted. Do not call poke_done until a poke tool reports that the budget is exhausted. Keep playing toward the staged goals until then."
