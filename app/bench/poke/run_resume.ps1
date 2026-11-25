param(
  [Parameter(Mandatory=$true)][string]$RunName,
  [ValidateSet("full","blinded")][string]$MemoryMode = "full",
  [ValidateSet("none","structured")][string]$MapMode = "none",
  [int]$RemainingActions = 900,
  [string]$State = "",
  [int]$ServerPort = 0,
  [int]$DreamEvery = 0,
  [int]$DreamEveryActions = 50,
  [int]$DreamHardActions = 70,
  [ValidateSet("off","minimal","low","medium","high","xhigh","max")][string]$Thinking = "low",
  [string]$Prompt = "Continue from exactly where you left off. Do not restart the task - keep playing toward the staged goal until your action budget runs out.",
  [string]$PrintPrompt = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\lib\common.ps1")
$poke = Get-PokeRoot
if ($ServerPort -le 0) { $ServerPort = Get-PokePort }
$run = Join-PokeRun $RunName
$memDir = Join-Path $run "memory"

Initialize-PokeCredentials

$sessionFile = Join-Path $run "session_id.txt"
if (-not (Test-Path $sessionFile)) { throw "run is missing session_id.txt: $run" }
$sessionId = (Get-Content $sessionFile -Raw).Trim()
$env:POKE_SESSION_ID = $sessionId
$env:POKE_URL = "http://127.0.0.1:$ServerPort"
$env:POKE_RUN_NAME = $RunName
$env:POKE_ROOT = $poke
$env:POKE_MEMORY_DIR = $memDir
$env:POKE_MEMORY_MODE = $MemoryMode
$env:POKE_MAX_ACTIONS = "$RemainingActions"
$env:POKE_DREAM_EVERY = "$DreamEvery"
$env:POKE_DREAM_EVERY_ACTIONS = "$DreamEveryActions"
$env:POKE_DREAM_HARD_ACTIONS = "$DreamHardActions"
$dreamEnabled = ($DreamEvery -gt 0 -or $DreamEveryActions -gt 0)
$env:POKE_DREAM_ENABLED = if ($dreamEnabled) { "1" } else { "0" }

if ($MemoryMode -eq "full" -and $dreamEnabled) {
  $rule = if ($DreamEveryActions -gt 0) {
    "soft due after " + $DreamEveryActions + " successful game actions (poke_act or poke_program) and a hard stop at " + $DreamHardActions + "; notes, memory writes, a new map and new SIGHT can trigger it earlier"
  } else {
    "every " + $DreamEvery + " successful memory writes (write or edit)"
  }
  # 规则正文在 scripts/prompts/resume_rules.md，这里只替换 dream 周期。
  $rules = (Get-PokePrompt "resume_rules.md").Replace("__DREAM_RULE__", $rule)
  $Prompt = $Prompt + " " + $rules
}

if ($State) {
  $body = @{ name = $State } | ConvertTo-Json
  $null = Invoke-WebRequest "http://127.0.0.1:$ServerPort/load" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 60
} else {
  # 不传 -State 表示接着当前模拟器继续；不要偷偷加载旧默认存档。
  Write-Output "no -State given: continuing from the live emulator state"
}

try {
  $obs = Invoke-RestMethod "http://127.0.0.1:$ServerPort/observe" -TimeoutSec 20
  $party = Format-PokeParty -Party $obs.party -Separator " | " -MaxHP when-present
  $badges = Format-PokeBadges -Badges $obs.badges
  $Prompt = $Prompt + "`n`nCURRENT STATE (snapshot taken right after loading the save; the live STATE block in each tool result is authoritative): " + $obs.map + " (" + $obs.x + "," + $obs.y + "), party: " + $party + ", money " + $obs.money + ", badges: " + $badges + "."
} catch {}

if ($PrintPrompt) {
  [IO.File]::WriteAllText($PrintPrompt, $Prompt, (New-Object System.Text.UTF8Encoding($false)))
  "prompt written to $PrintPrompt"
  return
}

# The current Pi build drops extension tools named read/write/edit when -t is
# combined with --no-builtin-tools, so do not use a tool allowlist here.
# --no-extensions still loads the explicit -e paths and nothing else.
$argList = @("-p","--mode","json","--session-dir",(Join-Path $run "pi-sessions"),"--session-id",$sessionId,"--no-extensions","--extension",(Join-Path $poke "agent\poke_tools.ts"),"--extension",(Join-Path $poke "agent\memory_tools.ts"),"--extension",(Join-Path $poke "agent\explored_map_tool.ts"),"--provider","opencode-go","--model","deepseek-v4.1-flash","--thinking",$Thinking,"--no-builtin-tools")
$argList += $Prompt

$tracePath = Join-Path $run "trace.jsonl"

# The watcher follows this agent session and keeps writing +20 artifacts to
# runs/<run>/watch20.log. It is stopped when pi exits, so no manual re-arming.
$watcher = $null
try {
  $actionFile = Join-Path $run "actions.jsonl"
  $actionCount = 0
  if (Test-Path $actionFile) { $actionCount = (Get-Content $actionFile | Measure-Object -Line).Lines }
  Set-Content (Join-Path $run ".watch20_baseline") $actionCount -Encoding ascii
  $py = Join-Path $poke ".venv\Scripts\python.exe"
  $watchScript = Join-Path $poke "tools\watch20.py"
  if ((Test-Path $py) -and (Test-Path $watchScript)) {
    $watcher = Start-Process -FilePath $py -ArgumentList @($watchScript, "--run", $RunName, "--port", "$ServerPort", "--every", "20", "--reports", "0", "--timeout-min", "1440") -WorkingDirectory $poke -RedirectStandardOutput (Join-Path $run "watch20.out.log") -RedirectStandardError (Join-Path $run "watch20.err.log") -WindowStyle Hidden -PassThru
  }
} catch {}

# Refresh the shared working-memory fog map from spatial.jsonl.  This is a
# read-only sidecar for act and dream; it never gates an action.
$workingWatcher = $null
try {
  $workingScript = Join-Path $poke "scripts\watch_working.ps1"
  if (Test-Path $workingScript) {
    $workingWatcher = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $workingScript, "-RunDir", $run, "-Port", "$ServerPort") -WorkingDirectory $poke -RedirectStandardOutput (Join-Path $run "working_watch.out.log") -RedirectStandardError (Join-Path $run "working_watch.err.log") -WindowStyle Hidden -PassThru
  }
} catch {}

Push-Location $poke
$ErrorActionPreference = "Continue"
try {
  & pi @argList 2>&1 | Out-File -FilePath $tracePath -Append -Encoding utf8
  $piExit = $LASTEXITCODE
} finally {
  Pop-Location
  $ErrorActionPreference = "Stop"
  if ($watcher) { Stop-Process -Id $watcher.Id -Force -ErrorAction SilentlyContinue }
  if ($workingWatcher) { Stop-Process -Id $workingWatcher.Id -Force -ErrorAction SilentlyContinue }
}
"resume exit=$piExit" | Add-Content (Join-Path $run "resume_log.txt")

$obs = (Invoke-WebRequest "http://127.0.0.1:$ServerPort/observe" -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
$out = (Get-Content $tracePath -Raw)
$toolCalls = ([regex]::Matches($out, '"name":"(poke_act|poke_observe|poke_program|read|write|edit|plan|memory_dream|memory_note|memory_notes|memory_note_delete|explored_map|poke_done)"')).Count
$cacheReads = [regex]::Matches($out, '"cacheRead":(\d+)') | ForEach-Object { [int]$_.Groups[1].Value }
$summary = [ordered]@{
  run = $RunName; memory_mode = $MemoryMode; map_mode = $MapMode; max_actions = $RemainingActions; session_id = $sessionId;
  tool_calls = $toolCalls;
  cache_read_total = ($cacheReads | Measure-Object -Sum).Sum;
  final_map = $obs.map; final_x = $obs.x; final_y = $obs.y; badges = ($obs.badges -join ","); party = $obs.party_count;
  trace = $tracePath
}
$summary | ConvertTo-Json | Set-Content (Join-Path $run "summary.json")
