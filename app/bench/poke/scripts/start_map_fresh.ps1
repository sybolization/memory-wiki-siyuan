param(
  [string]$RunName = "",
  [string]$State = "",
  [int]$MaxActions = 0,
  [int]$ServerPort = 0,
  [string]$Objective = "",
  [switch]$Force,
  [switch]$NoStart,
  [string]$PrintPrompt = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")
$poke = Get-PokeRoot
if (-not $RunName) { $RunName = Get-PokeRun }
if (-not $RunName) { throw "no run name: pass -RunName or set POKE_RUN_NAME / config/run.json" }
if (-not $State) { $State = Get-PokeState "start" }
if ($MaxActions -le 0) {
  $cfg = Get-PokeConfig
  $MaxActions = if ($cfg -and $cfg.max_actions) { [int]$cfg.max_actions } else { 5000 }
}
if ($ServerPort -le 0) { $ServerPort = Get-PokePort }
if (-not $Objective) { $Objective = Get-PokeObjective "Reach Cerulean City and defeat Misty." }
$run = Join-PokeRun $RunName
if (Test-Path $run) {
  if (-not $Force) { throw "run already exists: $run (pass -Force to reset it)" }
  Remove-Item $run -Recurse -Force
}
Initialize-PokeRun -RunName $RunName | Out-Null
$memDir = Join-Path $run "memory"

# Fresh memory seed. The '>' line is what the index shows first.
$memFile = Join-Path $memDir "MEMORY.md"
if (-not (Test-Path $memFile)) {
  $template = @(
    "# MEMORY",
    "> Master state: where you are, party and bag, verified rules. Read first every turn.",
    "",
    "## STATE (trust RAM)",
    "- location:",
    "- party:",
    "- bag:",
    "- badges: 0",
    "",
    "## NEXT 3 STEPS",
    "-",
    "-",
    "-"
  ) -join "`n"
  Set-Content $memFile $template -Encoding utf8
}

# Initialize-PokeRun 已经生成 session_id；这里只读取，避免同一局出现两个 id。
$sessionFile = Join-Path $run "session_id.txt"
if (-not (Test-Path $sessionFile)) { throw "run is missing session_id.txt: $run" }
$sessionId = (Get-Content $sessionFile -Raw).Trim()

$prompt = Get-PokePrompt "fresh.md"

$prompt = $prompt.Replace("__OBJECTIVE__", $Objective)

# Session-start memory index: prefer the '>' description, fall back to headings.
$idxLines = Get-PokeMemoryIndex -MemoryDir $memDir
$prompt = $prompt + "`n`n" + ($idxLines -join "`n") + "`n"

if ($PrintPrompt) {
  [IO.File]::WriteAllText($PrintPrompt, $prompt, (New-Object System.Text.UTF8Encoding($false)))
  "prompt written to $PrintPrompt"
  return
}

if ($NoStart) {
  "initialized $run (NoStart)"
  return
}

& (Join-Path $poke "run_resume.ps1") -RunName $RunName -MemoryMode full -MapMode structured -DreamEvery 0 -DreamEveryActions 50 -RemainingActions $MaxActions -State $State -ServerPort $ServerPort -Prompt $prompt
