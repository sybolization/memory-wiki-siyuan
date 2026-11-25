# Stop the map-arm run at a fixed wall-clock time: freeze the agent, snapshot the
# emulator state, then stop the watchers, autosave and both poke servers.
# Launched detached so it survives the shell that started it.
param(
  [string]$At = "2026-11-19 21:30:00",
  [string]$Run = "gbc_map_01",
  [string]$StateName = "shutdown_2130",
  [int]$Port = 8765
)

$ErrorActionPreference = "Continue"
$poke = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$runDir = Join-Path $poke "runs\$Run"
$logPath = Join-Path $runDir "shutdown_2130.log"
$summaryPath = Join-Path $runDir "SHUTDOWN_2130.md"

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logPath -Value $line -Encoding utf8
}

function Obs {
  try {
    return Invoke-RestMethod "http://127.0.0.1:$Port/observe" -TimeoutSec 15
  } catch {
    return $null
  }
}

function Kill-Matching([string]$pattern, [string]$label) {
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern }
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

$target = [datetime]::ParseExact($At, 'yyyy-MM-dd HH:mm:ss', $null)
Log ("scheduler started; target={0}" -f $target)

while ((Get-Date) -lt $target) {
  Start-Sleep -Seconds 10
}
Log "target reached: stopping the map arm"

$pre = Obs
if ($pre) {
  Log ("pre-stop: {0} ({1},{2}) battle={3} money={4}" -f $pre.map, $pre.x, $pre.y, $pre.battle, $pre.money)
} else {
  Log "pre-stop observe failed"
}

# 1. Freeze the agent first so nothing new happens during the snapshot.
Kill-Matching 'pi-coding-agent.*gbc_map_01' 'agent'
Kill-Matching 'continue_map\.ps1' 'agent wrapper'
Start-Sleep -Seconds 3

# 2. Snapshot the emulator while the server is still alive.
$saved = $false
try {
  $body = @{ name = $StateName } | ConvertTo-Json
  $res = Invoke-RestMethod "http://127.0.0.1:$Port/save" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 90
  $stateFile = Join-Path $poke ("states\" + $StateName + ".state")
  if (Test-Path $stateFile) {
    $size = (Get-Item $stateFile).Length
    Log ("saved state {0} ({1} bytes) -> {2}" -f $StateName, $size, $stateFile)
    $saved = $true
  } else {
    Log ("save returned but {0} is missing" -f $stateFile)
  }
} catch {
  Log ("save failed: {0}" -f $_.Exception.Message)
}

# 3. Stop the watchers and the autosave watchdog.
Kill-Matching 'watch20\.py' 'watch20'
Kill-Matching 'autosave\.py' 'autosave'

# 4. Final snapshot for the record, then stop the emulator servers.
$post = Obs
$nActions = 0
$actionsPath = Join-Path $runDir "actions.jsonl"
if (Test-Path $actionsPath) {
  $nActions = (Get-Content $actionsPath | Measure-Object -Line).Lines
}

Kill-Matching 'server\.py --port 8765' 'server 8765'
Kill-Matching 'server\.py --port 8767' 'server 8767'

# 5. Human-readable close-out note.
$lines = @()
$lines += "# Shutdown 21:30 - map arm"
$lines += ""
$lines += ("- stopping time: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines += ("- actions: {0}/5000" -f $nActions)
$lines += ("- state saved: {0} (ok={1})" -f $StateName, $saved)
if ($post) {
  $party = ($post.party | ForEach-Object { "#$($_.species) L$($_.level) $($_.hp)hp" }) -join ', '
  $lines += ("- position: {0} ({1},{2}) battle={3} money={4}" -f $post.map, $post.x, $post.y, $post.battle, $post.money)
  $lines += ("- party: {0}" -f $party)
}
$lines += "- stopped: agent, watcher, autosave, servers 8765/8767"
$lines += ""
$lines += "Resume with: scripts/continue_map.ps1 -State $StateName"
$lines | Set-Content -Path $summaryPath -Encoding utf8
Log ("done; actions={0} state_ok={1}" -f $nActions, $saved)
