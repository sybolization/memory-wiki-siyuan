# Stop the map-arm run immediately: freeze the agent, snapshot the emulator state,
# then stop the watchers, autosave, leftover servers and any pending 21:30 scheduler.
param(
  [string]$Run = "",
  [string]$StateName = "",
  [int]$Port = 0,
  [string]$Reason = "manual stop",
  [string]$Note = ""
)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
$poke = Get-PokeRoot
if (-not $Run) { $Run = Get-PokeRun }
if (-not $StateName) { $StateName = "shutdown_" + $Run + "_" + (Get-Date -Format "yyyyMMdd_HHmmss") }
if ($Port -le 0) { $Port = Get-PokePort }
$cfg = Get-PokeConfig
$maxActions = if ($cfg -and $cfg.max_actions) { [int]$cfg.max_actions } else { 0 }
$runDir = Join-PokeRun $Run
$logPath = Join-Path $runDir "shutdown.log"
$summaryPath = Join-Path $runDir ("SHUTDOWN_" + (Get-Date -Format "yyyy-MM-dd_HHmmss") + ".md")
$self = $PID

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logPath -Value $line -Encoding utf8
}

function Obs {
  try { return Invoke-RestMethod "http://127.0.0.1:$Port/observe" -TimeoutSec 15 }
  catch { return $null }
}

function Kill-Matching([string]$pattern, [string]$label) {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $self -and $_.CommandLine -and $_.CommandLine -match $pattern
  }
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Log ("killed {0} pid={1}" -f $label, $p.ProcessId)
    } catch {
      Log ("kill failed {0} pid={1}: {2}" -f $label, $p.ProcessId, $_.Exception.Message)
    }
  }
  if (-not $procs) { Log ("no process matched {0}" -f $label) }
}

Log ("stop requested: {0}" -f $Reason)

$pre = Obs
if ($pre) {
  Log ("pre-stop: {0} ({1},{2}) battle={3} money={4}" -f $pre.map, $pre.x, $pre.y, $pre.battle, $pre.money)
}

# 1. Stop the scheduled stop first so it cannot fire later against dead servers.
Kill-Matching 'stop_at_2130\.ps1' 'stop scheduler'

# 2. Freeze the agent so nothing moves during the snapshot.
Kill-Matching ('pi-coding-agent.*' + $Run) 'agent'
Kill-Matching ('continue_map\.ps1.*' + $Run) 'agent wrapper'
Kill-Matching ('dream_pass\.ps1.*' + $Run) 'dream wrapper'
Start-Sleep -Seconds 3

# 3. Snapshot the emulator while the server is still alive.
$saved = $false
try {
  $body = @{ name = $StateName } | ConvertTo-Json
  $null = Invoke-RestMethod "http://127.0.0.1:$Port/save" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 90
  $stateFile = Join-Path $poke ("states\" + $StateName + ".state")
  if (Test-Path $stateFile) {
    $size = (Get-Item $stateFile).Length
    Log ("saved state {0} ({1} bytes)" -f $StateName, $size)
    $saved = $true
  } else {
    Log ("save returned but {0} is missing" -f $stateFile)
  }
} catch {
  Log ("save failed: {0}" -f $_.Exception.Message)
}

# 4. Stop watchers and the autosave watchdog.
Kill-Matching 'watch20\.py' 'watch20'
Kill-Matching 'watch_working\.ps1' 'working watcher'
Kill-Matching 'autosave\.py' 'autosave'

# 5. Record final state, then stop the emulator servers.
$post = Obs
$nActions = 0
$actionsPath = Join-Path $runDir "actions.jsonl"
if (Test-Path $actionsPath) { $nActions = (Get-Content $actionsPath | Measure-Object -Line).Lines }

Kill-Matching ('(server\.py|-m server) --port ' + $Port) ('server ' + $Port)
Kill-Matching '(server\.py|-m server) --port 8767' 'server 8767'

$dream = "?"
$dreamPath = Join-Path $runDir "memory\.dream_state.json"
if (Test-Path $dreamPath) { $dream = (Get-Content $dreamPath -Raw).Trim() }

$lines = @()
$lines += ("# Shutdown {0} - {1}" -f (Get-Date -Format 'yyyy-MM-dd'), $Run)
$lines += ""
$lines += ("- stopped at: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines += ("- reason: {0}" -f $Reason)
if ($maxActions -gt 0) {
  $lines += ("- actions: {0}/{1} (remaining {2})" -f $nActions, $maxActions, [Math]::Max(0, $maxActions - $nActions))
} else {
  $lines += ("- actions: {0}" -f $nActions)
}
$lines += ("- state saved: {0} (ok={1})" -f $StateName, $saved)
if ($post) {
  $party = Format-PokeParty -Party $post.party -Separator ", " -MaxHP always
  $lines += ("- position: {0} ({1},{2}) battle={3} money={4}" -f $post.map, $post.x, $post.y, $post.battle, $post.money)
  $lines += ("- party: {0}" -f $party)
  # badges 是数组，统一走 Format-PokeBadges，避免把 [0] 显示成 0 枚。
  $badges = Format-PokeBadges -Badges $post.badges
  $lines += ("- badges: {0}" -f $badges)
}
$lines += ("- dream state: {0}" -f $dream)
$lines += ""
$lines += "## Next session"
$lines += ""
$lines += "1. Start the server: ``scripts/start_server.ps1`` on port $Port."
$lines += "2. Resume from the saved snapshot: ``scripts/continue_map.ps1 -State $StateName``."
$lines += "3. Resume from the live emulator (if the server was left running): ``scripts/continue_map.ps1``."
$lines += "4. Re-arm the reporter: ``.venv\Scripts\python.exe tools\watch20.py --run $Run --port $Port --every 20 --reports 1 --timeout-min 90``."
$lines += ""
$lines += "## Where it left off"
$lines += ""
if ($Note) {
  $lines += $Note
} else {
  $lines += "- See ``memory/MEMORY.md`` and ``memory/TODO.md`` for the current state and next moves."
}
$lines | Set-Content -Path $summaryPath -Encoding utf8
Log ("done; actions={0} state_ok={1}" -f $nActions, $saved)
