param(
    [Parameter(Mandatory=$true)][string]$RunDir,
    [int]$IntervalSeconds = 2,
    [int]$Port = 0
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
$poke = Get-PokeRoot
if ($Port -le 0) { $Port = Get-PokePort }
$spatial = Join-Path $RunDir "spatial.jsonl"
$actions = Join-Path $RunDir "actions.jsonl"
$render = Join-Path $poke "tools\render_working.mjs"
$log = Join-Path $RunDir "working_watch.log"

function Render {
    & node $render --run $RunDir --port $Port 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
}
"WORKING_WATCH start $((Get-Date).ToString('HH:mm:ss')) run=$RunDir" | Out-File -FilePath $log -Append -Encoding utf8
Render
$stampS = $null
$stampA = $null
if (Test-Path $spatial) { $stampS = (Get-Item $spatial).LastWriteTimeUtc.Ticks }
if (Test-Path $actions) { $stampA = (Get-Item $actions).LastWriteTimeUtc.Ticks }
while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    $changed = $false
    if (Test-Path $spatial) {
        $t = (Get-Item $spatial).LastWriteTimeUtc.Ticks
        if ($t -ne $stampS) { $stampS = $t; $changed = $true }
    }
    if (Test-Path $actions) {
        $t = (Get-Item $actions).LastWriteTimeUtc.Ticks
        if ($t -ne $stampA) { $stampA = $t; $changed = $true }
    }
    if ($changed) { Render }
}
