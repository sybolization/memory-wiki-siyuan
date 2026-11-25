# 脚本公共配置与路径。
#
# 所有入口脚本 dot-source 这个文件，不要再各自写
# `bench/poke`。目录移动、换机器、开 worktree 都不需要改这里。
#
# 配置优先级：环境变量 > config/run.json > 函数默认值。
# 环境变量：
#   POKE_RUN_NAME, POKE_PORT, POKE_STATE, POKE_OBJECTIVE

$script:PokeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Get-PokeRoot {
    return $script:PokeRoot
}

function Get-PokeConfig {
    $path = Join-Path $script:PokeRoot "config\run.json"
    if (Test-Path $path) {
        try { return Get-Content $path -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $null }
    }
    return $null
}

function Get-PokeRun {
    param([string]$Default = "")
    if ($env:POKE_RUN_NAME) { return $env:POKE_RUN_NAME }
    $cfg = Get-PokeConfig
    if ($cfg -and $cfg.run) { return [string]$cfg.run }
    return $Default
}

function Get-PokePort {
    param([int]$Default = 8765)
    if ($env:POKE_PORT) { return [int]$env:POKE_PORT }
    $cfg = Get-PokeConfig
    if ($cfg -and $cfg.port) { return [int]$cfg.port }
    return $Default
}

function Get-PokeState {
    param([string]$Default = "")
    if ($env:POKE_STATE) { return $env:POKE_STATE }
    $cfg = Get-PokeConfig
    if ($cfg -and $cfg.state) { return [string]$cfg.state }
    return $Default
}

function Get-PokeObjective {
    param([string]$Default = "")
    if ($env:POKE_OBJECTIVE) { return $env:POKE_OBJECTIVE }
    $cfg = Get-PokeConfig
    if ($cfg -and $cfg.objective) { return [string]$cfg.objective }
    return $Default
}

function Get-PokeRomPath {
    param([string]$Default = "rom/pokered.gbc")
    if ($env:POKE_ROM) { return $env:POKE_ROM }
    $cfg = Get-PokeConfig
    if ($cfg -and $cfg.rom) {
        $p = [string]$cfg.rom
        if ([IO.Path]::IsPathRooted($p)) { return $p }
        return (Join-Path $script:PokeRoot $p)
    }
    return (Join-Path $script:PokeRoot $Default)
}

function Get-PokeSymPath {
    param([string]$Default = "rom/pokered.sym")
    if ($env:POKE_SYM) { return $env:POKE_SYM }
    $cfg = Get-PokeConfig
    if ($cfg -and $cfg.sym) {
        $p = [string]$cfg.sym
        if ([IO.Path]::IsPathRooted($p)) { return $p }
        return (Join-Path $script:PokeRoot $p)
    }
    return (Join-Path $script:PokeRoot $Default)
}

function Join-PokeRun {
    param([Parameter(Mandatory = $true)][string]$RunName)
    return (Join-Path (Join-Path $script:PokeRoot "runs") $RunName)
}

function Get-PokePython {
    $py = Join-Path $script:PokeRoot ".venv\Scripts\python.exe"
    if (Test-Path $py) { return $py }
    return "python"
}

function Initialize-PokeCredentials {
    # run_resume / dream_pass 共用：已有环境变量就不覆盖；
    # 否则从 POKE_CREDENTIALS 或默认的 ~/.dsh-next/.credentials.yaml 读取。
    if ($env:OPENCODE_GO_API_KEY) { return }
    $cred = if ($env:POKE_CREDENTIALS) { $env:POKE_CREDENTIALS } else { Join-Path $HOME ".dsh-next\.credentials.yaml" }
    if (-not (Test-Path $cred)) { return }
    $line = (Get-Content $cred) | Where-Object { $_ -match "OPENCODE_GO_API_KEY" } | Select-Object -First 1
    if ($line) { $env:OPENCODE_GO_API_KEY = (($line -split ":", 2)[1].Trim().Trim('"').Trim("'")) }
}

function Format-PokeParty {
    # 三个入口的 party 文案：分隔符和 HP 展示方式不同，用参数保持输出不变。
    param(
        $Party,
        [string]$Separator = " | ",
        [ValidateSet("always", "when-present", "never")][string]$MaxHP = "never"
    )
    if (-not $Party -or @($Party).Count -eq 0) { return "(none)" }
    $items = foreach ($p in @($Party)) {
        $hp = "" + $p.hp
        if ($MaxHP -eq "always") { $hp = $hp + "/" + $p.maxhp }
        elseif ($MaxHP -eq "when-present" -and $p.maxhp) { $hp = $hp + "/" + $p.maxhp }
        "#" + $p.species + " L" + $p.level + " " + $hp + "hp"
    }
    return ($items -join $Separator)
}

function Format-PokeBadges {
    # badges 是已获得徽章的 id 数组：[0] 表示 1 枚 Boulder，不是 0 枚。
    param($Badges)
    $badgeNames = @("Boulder Badge", "Cascade Badge", "Thunder Badge", "Rainbow Badge", "Soul Badge", "Marsh Badge", "Volcano Badge", "Earth Badge")
    $got = @($Badges)
    if ($got.Count -eq 0) { return "0 (none)" }
    return "$($got.Count) (" + (($got | ForEach-Object { $badgeNames[[int]$_] }) -join ", ") + ")"
}

function Get-PokePrompt {
    # 提示词放在 scripts/prompts/*.md，脚本只负责填充变量和拼接索引。
    # 统一转成 LF 并去掉末尾换行，避免 CRLF 与 here-string 的差异改变渲染结果。
    param([Parameter(Mandatory = $true)][string]$Name)
    $path = Join-Path (Join-Path $script:PokeRoot "scripts\prompts") $Name
    if (-not (Test-Path $path)) { throw "prompt not found: $path" }
    $text = [IO.File]::ReadAllText($path).Replace("`r`n", "`n")
    return $text.TrimEnd([char[]]"`r`n")
}

function Get-PokeMemoryIndex {
    # MEMORY INDEX 的唯一实现。continue 会排除 notes/working 并额外报 notes 数量；
    # 新开局没有这些目录，直接用全量列表。改格式时两边会一起变。
    param(
        [Parameter(Mandatory = $true)][string]$MemoryDir,
        [switch]$ExcludeNotes,
        [switch]$ExcludeWorking,
        [switch]$NoteCount
    )
    $idxLines = @("MEMORY INDEX (snapshot at session start; rebuilt after every dream; read <path> for the full text)")
    $files = Get-ChildItem -Path $MemoryDir -Recurse -Filter *.md -ErrorAction SilentlyContinue
    if ($ExcludeNotes) { $files = $files | Where-Object { $_.FullName -notmatch '\\notes\\' } }
    if ($ExcludeWorking) { $files = $files | Where-Object { $_.FullName -notmatch '\\working\\' } }
    $files = $files | Sort-Object @{Expression = { if ($_.Name -eq "MEMORY.md") { 0 } else { 1 } } }, FullName
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($MemoryDir.Length + 1).Replace("\", "/")
        $txt = Get-Content $f.FullName -Raw
        if ($null -eq $txt) { $txt = "" }
        $d = ([regex]::Match($txt, '(?m)^>\s*(.+)$')).Groups[1].Value
        $heads = @()
        foreach ($ln in ($txt -split "`r?`n")) {
            if ($ln -match '^#{1,3}\s+(.+)$') { $heads += $Matches[1].Trim() }
            if ($heads.Count -ge 7) { break }
        }
        $h = ($heads -join " / ")
        if ($h.Length -gt 130) { $h = $h.Substring(0, 130) }
        $what = if ($d) { $d.Substring(0, [Math]::Min(90, $d.Length)) + $(if ($h) { " | " + $h } else { "" }) } else { $h }
        if ($what.Length -gt 170) { $what = $what.Substring(0, 170) }
        $name = if ($rel.Length -gt 26) { $rel.Substring(0, 25) + "~" } else { $rel.PadRight(26) }
        $idxLines += ("  " + $name + " " + ("{0,5}" -f $txt.Length) + "  " + $what)
    }
    if ($NoteCount) {
        $noteDir = Join-Path $MemoryDir "notes"
        if (Test-Path $noteDir) {
            $noteFiles = @(Get-ChildItem $noteDir -Filter 'note-*.md' -File -ErrorAction SilentlyContinue)
            if ($noteFiles.Count -gt 0) {
                $idxLines += ("  NOTES: " + $noteFiles.Count + " open in notes/ (the dream reads and deletes them)")
            }
        }
    }
    return $idxLines
}

function Initialize-PokeRun {
    param(
        [Parameter(Mandatory = $true)][string]$RunName,
        [switch]$Force
    )
    $run = Join-PokeRun $RunName
    if ((Test-Path $run) -and -not $Force) {
        throw "run already exists: $run (pass -Force to reset it)"
    }
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $run "memory\maps"), `
        (Join-Path $run "memory\notes"), `
        (Join-Path $run "pi-sessions"), `
        (Join-Path $run "dream-sessions") | Out-Null
    foreach ($f in @("actions.jsonl", "spatial.jsonl", "trace.jsonl")) {
        Set-Content (Join-Path $run $f) "" -NoNewline -Encoding ascii
    }
    Set-Content (Join-Path $run "DREAM.md") "# DREAM LOG`n" -Encoding utf8
    Set-Content (Join-Path $run "memory\.dream_state.json") `
        '{"writes":0,"actions":0,"due":false,"dreams":0,"read_after_dream":false}' -Encoding ascii
    Set-Content (Join-Path $run "memory\notes\.seq") "0" -NoNewline -Encoding ascii
    # 每个 run 从创建起就必须有 session id；续跑脚本靠它恢复同一个 pi session。
    $sidFile = Join-Path $run "session_id.txt"
    if (-not (Test-Path $sidFile)) {
        ("ses_" + [guid]::NewGuid().ToString("N").Substring(0, 20)) | Set-Content $sidFile
    }
    return $run
}
