$ErrorActionPreference = "Continue"
$poke = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$task = @'
You are playing Pokemon Red on a Game Boy, and this is a long session. Staged goal: (1) leave your house, (2) get a starter Pokemon from Professor Oak in Pallet Town, (3) reach Viridian City, (4) keep exploring and making progress. Keep playing until the action budget runs out - you will get a budget message when it is gone. Do not call poke_done before that. You can open the in-game menu with start to check your party and items; everything you need is on the screen. Use poke_program to script routine movement and dialogue, so your actions go into decisions rather than single button presses.
'@
& (Join-Path $poke "run_episode.ps1") -RunName "gbc_map_01" -MemoryMode full -MapMode structured -MaxActions 1000 -State start -ServerPort 8765 -Task $task
