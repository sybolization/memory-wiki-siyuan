param(
  [int]$Port = 0,
  [string]$RunName = "",
  [string]$State = "",
  [string]$Rom = "",
  [string]$Sym = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")
$poke = Get-PokeRoot
if ($Port -le 0) { $Port = Get-PokePort }
if (-not $RunName) { $RunName = Get-PokeRun "" }
if (-not $State) { $State = Get-PokeState "start" }
if (-not $Rom) { $Rom = Get-PokeRomPath }
if (-not $Sym) { $Sym = Get-PokeSymPath }
$py = Get-PokePython
$sargs = @("-m", "server", "--port", "$Port", "--state", $State)
if ($RunName) { $sargs += @("--run", (Join-Path "runs" $RunName)) }
if ($Rom) { $sargs += @("--rom", $Rom) }
if ($Sym) { $sargs += @("--sym", $Sym) }
$out = Join-Path $poke ("runs\server_" + $Port + ".out.log")
$err = Join-Path $poke ("runs\server_" + $Port + ".err.log")
$p = Start-Process -FilePath $py -ArgumentList $sargs -WorkingDirectory $poke -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
for ($i = 0; $i -lt 60; $i++) {
  try {
    $h = Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
    Write-Output ("server " + $Port + " up pid=" + $p.Id + " health=" + $h.Content)
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
Write-Output ("server " + $Port + " FAILED; see " + $err)
exit 1
