param(
    [string]$RunDir = "",
    [int]$PollSeconds = 5,
    [int]$StallMinutes = 30,
    [int]$TimeoutMinutes = 240
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
if (-not $RunDir) {
    $runName = Get-PokeRun
    if (-not $runName) { throw "no run directory: pass -RunDir or set POKE_RUN_NAME / config/run.json" }
    $RunDir = Join-PokeRun $runName
}

$statePath   = Join-Path $RunDir "memory\.dream_state.json"
$actionsPath = Join-Path $RunDir "actions.jsonl"

function Read-State {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            return Get-Content $statePath -Raw -ErrorAction Stop | ConvertFrom-Json
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $null
}

$st0 = Read-State
$baseline = if ($st0) { [int]$st0.dreams } else { 0 }
$start = Get-Date
"WATCH_START baseline_dreams=$baseline at $($start.ToString('HH:mm:ss'))"

while ($true) {
    Start-Sleep -Seconds $PollSeconds
    $st = Read-State
    if ($null -eq $st) { continue }

    if ([int]$st.dreams -gt $baseline) {
        $n = [int]$st.dreams
        $dir = Join-Path $RunDir ("dream-sessions\d{0:D3}" -f $n)
        $total = (Get-Content $actionsPath | Measure-Object -Line).Lines
        "DREAM_COMPLETE dreams=$n actions_since=$($st.actions) due=$($st.due) total_actions=$total at $((Get-Date).ToString('HH:mm:ss'))"
        "dream_dir=$dir"
        if (Test-Path $dir) {
            Get-ChildItem $dir -File | ForEach-Object {
                "  file $($_.Name) size=$($_.Length) mtime=$($_.LastWriteTime.ToString('HH:mm:ss'))"
            }
        }
        "memory_files:"
        Get-ChildItem (Join-Path $RunDir "memory") -Recurse -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 12 |
            ForEach-Object { "  $($_.Name) size=$($_.Length) mtime=$($_.LastWriteTime.ToString('HH:mm:ss'))" }
        "last_actions:"
        Get-Content $actionsPath -Tail 3 | ForEach-Object { $_ }
        exit 0
    }

    $mtime = (Get-Item $actionsPath).LastWriteTime
    if (((Get-Date) - $mtime).TotalMinutes -gt $StallMinutes) {
        "RUN_STALLED last_action=$($mtime.ToString('HH:mm:ss')) dreams=$($st.dreams) actions_since=$($st.actions)"
        exit 3
    }

    if (((Get-Date) - $start).TotalMinutes -gt $TimeoutMinutes) {
        "WATCH_TIMEOUT dreams=$($st.dreams) actions_since=$($st.actions)"
        exit 2
    }
}
