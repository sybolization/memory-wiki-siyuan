param(
  [Parameter(Mandatory=$true)][string]$SessionPath,
  [Parameter(Mandatory=$true)][string]$Label,
  [Parameter(Mandatory=$true)][string]$QuestionFile,
  [string]$OutRoot = "",
  [string]$Thinking = "high"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\lib\common.ps1")
$poke = Get-PokeRoot
if (-not $OutRoot) { $OutRoot = Join-Path $poke "runs\gbc_map_10\interviews" }
Initialize-PokeCredentials
New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null

# Snapshot only complete JSONL lines, so a concurrently-written live session
# cannot leave a half-written last event in the fork source.
$snap = Join-Path $OutRoot ("$Label.snapshot.jsonl")
$snapHelper = Join-Path $env:TEMP "snap_session.cjs"
@'
const fs = require("fs");
const src = process.argv[2], dst = process.argv[3];
const lines = fs.readFileSync(src, "utf8").split(/\r?\n/);
while (lines.length && lines[lines.length - 1] === "") lines.pop();
while (lines.length) {
  try { JSON.parse(lines[lines.length - 1]); break; } catch { lines.pop(); }
}
fs.writeFileSync(dst, lines.join("\n") + "\n");
'@ | Set-Content $snapHelper -Encoding utf8
node $snapHelper $SessionPath $snap

$question = Get-Content $QuestionFile -Raw -Encoding UTF8
$out = Join-Path $OutRoot ("$Label.jsonl")
$sessDir = Join-Path $OutRoot ("$Label.sessions")
New-Item -ItemType Directory -Force -Path $sessDir | Out-Null

& pi -p --mode json --fork $snap --session-dir $sessDir --no-tools --provider opencode-go --model deepseek-v4.1-flash --thinking $Thinking $question 2>&1 |
  Out-File -FilePath $out -Encoding utf8

"exit=$LASTEXITCODE label=$Label out=$out" |
  Set-Content (Join-Path $OutRoot ("$Label.status.txt")) -Encoding utf8
