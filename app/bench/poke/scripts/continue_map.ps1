param(
  [string]$RunName = "",
  [string]$State = "",
  [int]$MaxActions = 0,
  [string]$Goal = "",
  [int]$ServerPort = 0,
  [string]$PrintPrompt = ""
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
$poke = Get-PokeRoot
# 不自动读取 config.state：续跑默认接着当前模拟器，只有显式 -State 才加载存档。
if (-not $RunName) { $RunName = Get-PokeRun }
if (-not $RunName) { throw "no run name: pass -RunName or set POKE_RUN_NAME / config/run.json" }
$cfg = Get-PokeConfig
if ($MaxActions -le 0) {
  $MaxActions = if ($cfg -and $cfg.max_actions) { [int]$cfg.max_actions } else { 5000 }
}
$dreamSoft = if ($cfg -and $cfg.dream_every_actions) { [int]$cfg.dream_every_actions } else { 50 }
$dreamHard = if ($cfg -and $cfg.dream_hard_actions) { [int]$cfg.dream_hard_actions } else { 70 }
if ($ServerPort -le 0) { $ServerPort = Get-PokePort }
if (-not $Goal) { $Goal = Get-PokeObjective }
$run = Join-PokeRun $RunName
if (-not (Test-Path $run)) { throw "run not found: $run" }
$n = (Get-Content (Join-Path $poke ("runs\" + $RunName + "\actions.jsonl")) | Measure-Object -Line).Lines
$rem = [Math]::Max(0, $MaxActions - $n)
$prompt = Get-PokePrompt "continue.md"
if ($Goal) { $prompt = $prompt + " RUN GOAL: " + $Goal }
$memDir = Join-Path $poke ("runs\" + $RunName + "\memory")
$idxLines = Get-PokeMemoryIndex -MemoryDir $memDir -ExcludeNotes -ExcludeWorking -NoteCount
$prompt = $prompt + "`n`n" + ($idxLines -join "`n") + "`n"

if ($PrintPrompt) {
  [IO.File]::WriteAllText($PrintPrompt, $prompt, (New-Object System.Text.UTF8Encoding($false)))
  "prompt written to $PrintPrompt"
  return
}

& (Join-Path $poke "run_resume.ps1") -RunName $RunName -MemoryMode full -MapMode structured -DreamEvery 0 -DreamEveryActions $dreamSoft -DreamHardActions $dreamHard -RemainingActions $rem -State $State -ServerPort $ServerPort -Prompt $prompt
