param(
  [Parameter(Mandatory=$true)][string]$RunName,
  [string]$PrintPrompt = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")
$poke = Get-PokeRoot
$run = Join-PokeRun $RunName
$mem = Join-Path $run "memory"

Initialize-PokeCredentials

$statePath = Join-Path $mem ".dream_state.json"

$dreams = 0
if (Test-Path $statePath) {
  try { $dreams = [int](Get-Content $statePath -Raw | ConvertFrom-Json).dreams } catch {}
}
$n = $dreams + 1
$sess = Join-Path $run ("dream-sessions\d{0:d3}" -f $n)
New-Item -ItemType Directory -Force -Path $sess | Out-Null
$sid = "ses_dream_" + [guid]::NewGuid().ToString("N").Substring(0, 12)

# Dream session: same memory dir, plus read-only access to the run log.
# It gets no game tools and no POKE_URL, so it cannot act in the game.
$env:POKE_MEMORY_DIR = $mem
$env:POKE_MEMORY_MODE = "full"
$env:POKE_DREAM_CHILD = "1"
$env:POKE_DREAM_READ_DIR = $run
$env:POKE_RUN_NAME = $RunName
$env:POKE_ROOT = $poke
# The provider config maps the x-opencode-session header to POKE_SESSION_ID;
# it must be the dream session, not the playing session.
$env:POKE_SESSION_ID = $sid
$env:POKE_DREAM_EVERY = "0"
$env:POKE_DREAM_EVERY_ACTIONS = "999999"
$env:POKE_DREAM_HARD_ACTIONS = "999999"
$env:POKE_DREAM_ENABLED = "1"

$prompt = Get-PokePrompt "dream.md"

$prompt = $prompt.Replace("__OBJECTIVE__", (Get-PokeObjective "Reach Cerulean City and defeat Misty."))

$live = "LIVE STATE: unavailable (the emulator server did not answer)."
try {
  $base = if ($env:POKE_URL) { $env:POKE_URL.TrimEnd([char]"/") } else { "http://127.0.0.1:" + (Get-PokePort) }
  $o = Invoke-RestMethod "$base/observe" -TimeoutSec 20
  $party = Format-PokeParty -Party $o.party -Separator " | "
  $badges = Format-PokeBadges -Badges $o.badges
  $live = "LIVE STATE: " + $o.map + " (" + $o.x + "," + $o.y + "), party: " + $party + ", money " + $o.money + ", badges: " + $badges + " (count and names of obtained badges)."
} catch {}
$prompt = $prompt + "`n" + $live + "`n"
$reason = ($env:POKE_DREAM_REASON -replace "\s+", " ").Trim()
if ($reason.Length -gt 5000) { $reason = $reason.Substring(0, 5000) }
if ($reason) { $prompt = $prompt + "`nTRIGGER: " + $reason + "`n" }

if ($PrintPrompt) {
  [IO.File]::WriteAllText($PrintPrompt, $prompt, (New-Object System.Text.UTF8Encoding($false)))
  "prompt written to $PrintPrompt"
  return
}

# The current Pi build drops extension tools named read/write/edit when -t is
# combined with --no-builtin-tools, so do not use a tool allowlist here.
# --no-extensions still loads the explicit -e path and nothing else.
$piArgs = @(
  "-p", "--mode", "json",
  "--session-dir", $sess,
  "--session-id", $sid,
  "--no-extensions",
  "--extension", (Join-Path $poke "agent\memory_tools.ts"),
  "--extension", (Join-Path $poke "agent\explored_map_tool.ts"),
  "--provider", "opencode-go",
  "--model", "deepseek-v4.1-flash",
  "--thinking", "high",
  "--no-builtin-tools",
  $prompt
)

Push-Location $poke
$ErrorActionPreference = "Continue"
try {
  & pi @piArgs 2>&1 | Out-File -FilePath (Join-Path $sess "trace.jsonl") -Encoding utf8
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
}
"dream=$n exit=$exit session=$sid" | Set-Content (Join-Path $sess "exit.txt") -Encoding utf8
exit $exit
