param(
  [string]$RunName = ("smoke_" + (Get-Date -Format "yyyyMMdd_HHmmss")),
  [ValidateSet("full","blinded")][string]$MemoryMode = "full",
  [ValidateSet("none","structured")][string]$MapMode = "none",
  [int]$MaxActions = 8,
  [string]$State = "start",
  [string]$Task = "",
  [int]$ServerPort = 0,
  [int]$DreamEvery = 0,
  [int]$DreamEveryActions = 50,
  [int]$DreamHardActions = 70
)
$ErrorActionPreference = "Stop"
# Legacy entrypoint: current experiments use scripts/continue_map.ps1 +
# run_resume.ps1 (they load explored_map.ts and the 16px prompt).
. (Join-Path $PSScriptRoot "scripts\lib\common.ps1")
$NL = [string][char]10
$poke = Get-PokeRoot
if ($ServerPort -le 0) { $ServerPort = Get-PokePort }
$run = Join-PokeRun $RunName
New-Item -ItemType Directory -Force -Path $run | Out-Null
$memDir = Join-Path $run "memory"
New-Item -ItemType Directory -Force -Path $memDir | Out-Null
if ($MapMode -eq "structured") {
  New-Item -ItemType Directory -Force -Path (Join-Path $memDir "maps") | Out-Null
}

if ($MemoryMode -eq "full") {
  $memFile = Join-Path $memDir "MEMORY.md"
  if (-not (Test-Path $memFile)) {
    $template = @(
      "# Pokemon Red - working memory",
      "> Master state: where you are, party and bag, verified rules. Read first every turn.",
      "",
      "## Now",
      "- location:",
      "- party:",
      "- stage:",
      "",
      "## Next 3 steps",
      "-",
      "-",
      "-",
      "",
      "## Verified rules and routes",
      "-"
    ) -join $NL
    $template | Set-Content $memFile -Encoding utf8
  }
}

Initialize-PokeCredentials

$sessionId = "ses_" + [guid]::NewGuid().ToString("N").Substring(0, 20)
$env:POKE_SESSION_ID = $sessionId
$env:POKE_URL = "http://127.0.0.1:$ServerPort"
$env:POKE_MEMORY_DIR = $memDir
$env:POKE_MEMORY_MODE = $MemoryMode
$env:POKE_MAX_ACTIONS = "$MaxActions"
$env:POKE_DREAM_EVERY = "$DreamEvery"
$env:POKE_DREAM_EVERY_ACTIONS = "$DreamEveryActions"
$env:POKE_DREAM_HARD_ACTIONS = "$DreamHardActions"
$sessionId | Set-Content (Join-Path $run "session_id.txt")

$body = @{ name = $State } | ConvertTo-Json
$null = Invoke-WebRequest "http://127.0.0.1:$ServerPort/load" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 60

if (-not $Task) { $Task = "Get out of your house and stand outside on the grass south of it. Use poke_observe and poke_act. Call poke_done when you are outside or out of budget." }

$memoryBlock = ""
if ($MemoryMode -eq "full") {
  $memoryBlock = $NL + $NL + "You have a persistent memory directory with read / write / edit. It survives context compaction, and once compaction happens it is the only record of earlier turns. Keep MEMORY.md current: (1) the staged goal with DONE/PENDING marks, (2) where you are and what your party is, (3) the next 1-3 concrete steps, (4) rules and routes you verified (what worked and what failed). Write it early, and update it whenever a stage changes or you learn a new rule - do not wait until the end." + $NL + $NL + "TODO LIST: keep memory/TODO.md as a checklist. Create it once with write; update it with edit by toggling one line at a time ('- [ ] task' -> '- [x] task'). It is shown after every game action, so make each item one concrete next step." + $NL + $NL + "STRATEGY: plan writes a long-term goal and 3-6 milestones into the '## PLAN' block of TODO.md; it does not consume a game action and is a deliberate pause. Use it when the TODO is only short moves, the same loop repeats, or a battle/lever is exhausted. The PLAN block is shown after every action; replace it with plan when the evidence changes."
}

$mapBlock = ""
if ($MapMode -eq "structured" -and $MemoryMode -eq "full") {
  $mapBlock = $NL + $NL + "SPATIAL MEMORY: use write to create and edit to update one sparse file per map under maps/<MAP_ID>.md. The tool result gives you the current map, coordinates and a 10x9 local view of 16px blocks; that view is only what is visible now, not a global map. Record only observed facts: EXITS (coordinate -> destination/condition), LANDMARKS, BLOCKED, FRONTIER (known but unexplored branches), and ROUTES (verified multi-tile paths). Update the map when you enter a new map, find a warp/exit, or hit a dead end. Keep FRONTIER current so you know where to go next. Do not store every tile; keep each map sparse and readable."
}

$dreamBlock = ""
if ($MemoryMode -eq "full" -and ($DreamEvery -gt 0 -or $DreamEveryActions -gt 0)) {
  $rule = if ($DreamEveryActions -gt 0) {
    "soft due after $DreamEveryActions game actions, hard stop at $DreamHardActions; notes, memory writes, a new map and new SIGHT can trigger it earlier"
  } else {
    "every $DreamEvery successful memory writes (write or edit)"
  }
  $dreamBlock = $NL + $NL + "DREAMING: $rule. A soft due is advisory: finish the current battle or short route, then call memory_dream. Battle turns never block; the dream waits for the battle to end. A low-information window may be deferred once. poke_act and poke_program refuse only at the hard cap or when notes, writes, a new map or SIGHT cross their trigger. When a dream runs, it audits the action log and rewrites MEMORY.md in a separate agent; immediately after it finishes, call read MEMORY.md and check the rewritten notes before the next game action. Dreaming does not consume game actions."
}

$missionBlock = $NL + $NL + "MISSION (fixed for the whole episode - never forget it): " + $Task
$habitBlock = $NL + $NL + "Habit: open every turn with one short line - 'stage N | now: where you are and what you have | next: one concrete step'. If a step's log says the screen did not change, do not repeat it: change the plan."

$basePrompt = "You are playing Pokemon Red on a Game Boy. poke_observe gives you a screenshot plus current map, coordinates and a 10x9 local view of 16px blocks; poke_act presses one button and returns the next screenshot plus that state; poke_program runs a whole plan of actions in one turn and returns the final screenshot, one log line per step, plus that state. Plan tokens: up/down/left/right one step, up:40 hold, up! walk until blocked, up!6 walk until blocked or 6 tiles, a/b/start/select, wait:60 let time pass. The local collision view is only the current screen - it is not a map of the whole area." + $NL + $NL + "Every action ends at a decision point: after your press the game keeps playing until the screen is idle and nothing is waiting for A, so one action can cover a whole dialogue or battle turn. The log says when a step changed nothing (screen unchanged) or auto-advanced a dialogue - never repeat a step the log marks unchanged; try another button or direction. Script the boring parts: use poke_program for routines you already understand (walk a corridor until blocked, mash A through a doorway, sweep a room), and poke_act when you want to look after every single button. When the episode ends or your action budget runs out, call poke_done with a summary of what you did and what you learned worth remembering." + $missionBlock + $habitBlock + $memoryBlock + $mapBlock + $dreamBlock
$basePrompt | Set-Content (Join-Path $run "system_prompt.txt")

$toolNames = @("poke_observe","poke_act","poke_program","poke_done")
if ($MemoryMode -eq "full") { $toolNames += @("read","write","edit","plan") }
if ($MemoryMode -eq "full" -and ($DreamEvery -gt 0 -or $DreamEveryActions -gt 0)) { $toolNames += @("memory_dream") }
$toolList = ($toolNames -join ",")

$argList = @("-p","--mode","json","--session-dir",(Join-Path $run "pi-sessions"),"--session-id",$sessionId,"--extension",(Join-Path $poke "agent\poke_tools.ts"),"--extension",(Join-Path $poke "agent\memory_tools.ts"),"--provider","opencode-go","--model","deepseek-v4.1-flash","--no-builtin-tools","--system-prompt",$basePrompt)
$argList += "-t"; $argList += $toolList
$argList += $Task

Push-Location $poke
$ErrorActionPreference = "Continue"
try {
  $tracePath = Join-Path $run "trace.jsonl"
  & pi @argList 2>&1 | Out-File -FilePath $tracePath -Encoding utf8
  $piExit = $LASTEXITCODE
  $out = (Get-Content $tracePath -Raw)
} finally {
  Pop-Location
  $ErrorActionPreference = "Stop"
}
# trace already streamed to disk above
"pi exit=$piExit traceChars=$($out.Length)" | Set-Content (Join-Path $run "pi_exit.txt")

$obs = (Invoke-WebRequest "http://127.0.0.1:$ServerPort/observe" -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
$toolCalls = ([regex]::Matches($out, '"name":"(poke_act|poke_observe|memory_[a-z]+|poke_done)"')).Count
$cacheReads = [regex]::Matches($out, '"cacheRead":(\d+)') | ForEach-Object { [int]$_.Groups[1].Value }
$summary = [ordered]@{
  run = $RunName; memory_mode = $MemoryMode; max_actions = $MaxActions; session_id = $sessionId;
  tool_calls = $toolCalls;
  cache_read_total = ($cacheReads | Measure-Object -Sum).Sum;
  final_map = $obs.map; final_x = $obs.x; final_y = $obs.y; badges = ($obs.badges -join ","); party = $obs.party_count;
  trace = (Join-Path $run "trace.jsonl")
}
$summary | ConvertTo-Json | Set-Content (Join-Path $run "summary.json")
$summary | ConvertTo-Json