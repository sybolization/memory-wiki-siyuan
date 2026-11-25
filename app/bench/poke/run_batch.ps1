param(
  [string]$Spec = "blind_01:blinded",
  [int]$MaxActions = 20,
  [string]$State = "start",
  [string]$Task = "You are in your house. Get out: go downstairs, walk out the front door, and stand on the grass outside. Look before each move. Call poke_done when you are outside."
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "scripts\lib\common.ps1")
$poke = Get-PokeRoot
$items = @($Spec.Split(",") | Where-Object { $_.Trim() } | ForEach-Object {
  $p = $_.Split(":")
  [pscustomobject]@{ Name = $p[0].Trim(); Mode = $p[1].Trim() }
})
Write-Output "BATCH start: $($items.Count) runs, maxActions=$MaxActions, mode-spec=$Spec"
$i = 0
foreach ($it in $items) {
  $i++
  $runDir = Join-Path $poke ("runs\" + $it.Name)
  $summaryPath = Join-Path $runDir "summary.json"
  if (Test-Path $summaryPath) { Write-Output "[$i/$($items.Count)] SKIP $($it.Name) (summary.json exists)"; continue }
  $t0 = Get-Date
  Write-Output "[$i/$($items.Count)] START $($it.Name) memory=$($it.Mode) at $(Get-Date -Format HH:mm:ss)"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $poke "run_episode.ps1") -RunName $it.Name -MemoryMode $it.Mode -MaxActions $MaxActions -State $State -Task $Task *>&1 | Out-File (Join-Path $poke ("runs\" + $it.Name + "_console.txt")) -Encoding utf8
  $sec = [int]((Get-Date) - $t0).TotalSeconds
  if (Test-Path $summaryPath) {
    try {
      $s = Get-Content $summaryPath -Raw | ConvertFrom-Json
      Write-Output "[$i/$($items.Count)] DONE $($it.Name) $sec s, map=$($s.final_map) pos=$($s.final_x),$($s.final_y) calls=$($s.tool_calls)"
    } catch { Write-Output "[$i/$($items.Count)] DONE $($it.Name) $sec s (summary unreadable)" }
  } else {
    Write-Output "[$i/$($items.Count)] FAILED $($it.Name) $sec s (no summary.json)"
  }
}
Write-Output "BATCH COMPLETE"
