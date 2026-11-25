$poke = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$files = @(
  (Join-Path $poke "run_episode.ps1"),
  (Join-Path $poke "run_batch.ps1"),
  (Join-Path $poke "run_resume.ps1")
)
$bad = 0
foreach ($f in $files) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) {
    $bad++
    Write-Output "FAIL $f"
    $errors | ForEach-Object { Write-Output ("  " + $_.Message) }
  } else {
    Write-Output "OK $f"
  }
}
exit $bad
