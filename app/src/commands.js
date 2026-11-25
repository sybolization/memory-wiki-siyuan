/**
 * 人类命令：`/memory`（诊断与打开目录）与 `/remember`（显式记录一条记忆）。
 *
 * 命令与工具共用 note-service，唯一区别是 `/remember` 固定使用 [U] 置信度，
 * 并立即落盘（不等 dreaming）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildDoctorReport } from './doctor.js'
import { saveEntry } from './note-service.js'
import { parseNote } from './notes.js'
import { formatPrivacyIssues, scanPrivacy } from './lint.js'
import { buildScanPlan, formatScanReport } from './scan.js'
import { runDream } from './dream.js'
import { formatDreamProgress, readDreamProgress, readLastRun } from './progress.js'
import { formatWikiSummary, syncWiki } from './wiki.js'
import { loadState, saveState } from './state.js'

/**
 * 注册本插件提供的斜杠命令。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{layout: object, config: object, paths: object}} deps
 */
export function registerCommands(ctx, deps) {
  const { layout, config, paths } = deps

  // 注册失败的兜底：命令没注册上时不要让整个插件挂掉，但要留下证据给 doctor
  function safeRegister(definition, label) {
    return ctx.effect(() => {
      try {
        return ctx.commands.register(definition)
      } catch (error) {
        deps.commandErrors ??= []
        deps.commandErrors.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }, label)
  }

  // /dream 的后台运行状态：命令立即返回，运行继续；单飞由 dream.js 的 inFlight 兜底
  let active = null
  let lastError = null

  /** 渲染 /dream status：正在跑什么、进度、上次结果。 */
  async function dreamStatusText() {
    const latest = await readDreamProgress(layout)
    const last = await readLastRun(layout)
    const lines = ['Agent memory · dream status']
    lines.push(active ? `running: ${active.mode} since ${active.startedAt}` : 'running: no')
    lines.push(formatDreamProgress(latest) ?? last ?? 'no run yet')
    if (lastError && !active) lines.push(`last error: ${lastError}`)
    return lines.join('\n')
  }

  /** 全部笔记的 lint 报告：格式错误 + 隐私形态（warn-only，只提醒）。 */
  async function lintReport() {
    let names = []
    try {
      names = await readdir(layout.notesDir)
    } catch {
      return 'Agent memory · lint\nno notes yet'
    }
    const lines = ['Agent memory · lint']
    let checked = 0
    let described = 0
    const issues = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      checked += 1
      const content = await readFile(join(layout.notesDir, name), 'utf8')
      const parsed = parseNote(content)
      // 文件头必须有 name/description/session：缺少的旧文件由下一次 dream 补写
      if (parsed.meta?.name && parsed.meta?.description && parsed.meta?.session) described += 1
      else issues.push(`${name}: 缺少 name/description/session（下一次 /dream 会补写）`)
      for (const invalid of parsed.invalid) issues.push(`${name}:${invalid.lineNumber} 行格式不合法`)
      for (const entry of parsed.entries) {
        for (const issue of scanPrivacy(entry.text)) issues.push(`${name}: ${issue.rule} (${issue.match})`)
      }
    }
    lines.push(`notes: ${checked} files (${described} with name/description/session), ${issues.length} issue(s)`)
    lines.push(...issues.slice(0, 15))
    if (issues.length > 15) lines.push(`… ${issues.length - 15} more`)
    return lines.join('\n')
  }

  // /memory doctor | open | scan | wiki | lint —— 诊断、目录直达、扫描预览、wiki 同步、lint
  safeRegister({
    name: 'memory',
    description: 'Agent memory: `/memory doctor`, `/memory open`, `/memory scan`, `/memory wiki` (sync wiki pages), `/memory lint` (check note format and privacy).',
    input: { hint: 'doctor | open | scan | wiki | lint' },
    handler: async ({ rawInput, signal }) => {
      const action = String(rawInput ?? '').trim() || 'doctor'
      if (action === 'doctor') {
        return { kind: 'success', text: await buildDoctorReport({ ...deps, signal }) }
      }
      if (action === 'open') {
        return { kind: 'success', text: `memory dir: ${paths.memoryDir}\nnotes: ${layout.notesDir}\nwiki: ${layout.wikiDir}` }
      }
      if (action === 'scan') {
        const { state } = await loadState(layout)
        const plan = await buildScanPlan({ ctx: deps.ctx, state, dshHome: paths.dshHome, signal, projects: config.dreamProjects ?? [] })
        // 缓存 team 扫描结果，但不写水位线（扫描不是 dream）
        if (JSON.stringify(plan.teamScan) !== JSON.stringify(state.teamScan ?? {})) {
          state.teamScan = plan.teamScan
          await saveState(layout, state)
        }
        return { kind: 'success', text: formatScanReport(plan) }
      }
      if (action === 'wiki') {
        const { state } = await loadState(layout)
        const summary = await syncWiki({ layout, state, config })
        await deps.indexStore?.refresh?.()
        return { kind: 'success', text: formatWikiSummary({ ...summary, maxRatio: config.wikiMaxRatio }) }
      }
      if (action === 'lint') {
        return { kind: 'success', text: await lintReport() }
      }
      return { kind: 'error', text: 'Usage: /memory doctor | open | scan | wiki | lint' }
    },
  }, 'agent-memory.commands.memory')

  /**
   * 列出当前候选（供手动勾选）。
   *
   * team 扫描要读 Lead 的完整日志（本机单文件可达 18MB），不落盘缓存的话
   * 每次 /dream list 都重下一遍，命令就会卡十几秒——宿主在 handler 返回前
   * 一直冻结输入框。这里把 teamScan 缓存写回 index.json，和 /memory scan 一致。
   */
  async function candidatePlan() {
    const { state } = await loadState(layout)
    const plan = await buildScanPlan({ ctx: deps.ctx, state, dshHome: paths.dshHome, projects: config.dreamProjects ?? [] })
    if (JSON.stringify(plan.teamScan) !== JSON.stringify(state.teamScan ?? {})) {
      state.teamScan = plan.teamScan
      await saveState(layout, state)
    }
    return plan
  }

  /** 渲染候选清单（编号供 `/dream pick` 使用）。 */
  async function listCandidatesText() {
    const plan = await candidatePlan()
    const scope = config.dreamProjects?.length ? config.dreamProjects.join(', ') : 'all projects'
    const lines = [
      `Agent memory · dream candidates (${plan.stats.candidates})`,
      `scope: ${scope}`,
      '选择方式：`/dream pick 1,3,5` 或 `/dream pick <sessionId>`',
    ]
    plan.queue.slice(0, 20).forEach((item, index) => {
      lines.push(`${index + 1}. ${item.id}  ${item.cwd ?? '(no-cwd)'}  seq ${item.startSeq}..${item.endSeq}`)
    })
    if (plan.queue.length > 20) lines.push(`… ${plan.queue.length - 20} more`)
    return lines.join('\n')
  }

  /** `/dream pick`：编号或 id 前缀 → 明确会话列表，丢给后台运行。 */
  async function startFromPick(agent, spec) {
    if (!spec) return { kind: 'error', text: 'Usage: /dream pick 1,3 | /dream pick <sessionId>' }
    const plan = await candidatePlan()
    const ids = []
    const unmatched = []
    for (const token of spec.split(/[\s,，]+/).filter(Boolean)) {
      if (/^\d+$/.test(token)) {
        const item = plan.queue[Number(token) - 1]
        if (item) ids.push(item.id)
        else unmatched.push(token)
      } else {
        // 允许指定不在候选里的 id（例如水位线已推进、想强制重跑的会话）
        ids.push(plan.queue.find((item) => item.id === token || item.id.startsWith(token))?.id ?? token)
      }
    }
    if (ids.length === 0) return { kind: 'error', text: `没有匹配到候选：${unmatched.join(', ')}` }
    return startDream(agent, 'pick', [...new Set(ids)])
  }

  /** 启动后台 dream；`only` 非空表示手动勾选的会话列表。 */
  function startDream(agent, mode, only = null) {
    if (active) return { kind: 'error', text: `dream 正在后台运行（${active.mode}），先 /dream stop 或等它结束。` }
    if (!agent) return { kind: 'error', text: 'No agent session for dream.' }

    const runConfig = { ...config, dreamBatchSize: mode === 'all' ? config.dreamAllMax : config.dreamBatchSize }
    const controller = new AbortController()
    lastError = null
    active = { controller, mode: only ? `pick(${only.length})` : mode, startedAt: new Date().toISOString() }

    // 真正跑在后台：命令先返回，进度写入 dream-progress.json
    void (async () => {
      try {
        const { state } = await loadState(layout)
        await runDream({
          ctx: deps.ctx, paths, layout, config: runConfig, state, agent,
          signal: controller.signal, only: only ?? [],
        })
        // M6：dream 收尾顺带同步 wiki（升格页 / 候选 / 中央索引 topics）
        await syncWiki({ layout, state, config: runConfig })
        await deps.indexStore?.refresh?.()
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        active = null
      }
    })()

    const batchText = only
      ? `手动选择 ${only.length} 个会话`
      : mode === 'all'
        ? `全量，最多 ${config.dreamAllMax} 个会话`
        : `单批 ${config.dreamBatchSize} 个会话`
    const scope = only ? '手动选择' : (config.dreamProjects?.length ? `${config.dreamProjects.length} 个项目` : '全部项目')
    return { kind: 'success', text: `dream 已在后台启动（${batchText}，范围：${scope}）。\n进度：/dream status 或 memory_status · 中断：/dream stop` }
  }

  // /dream [all|pick|list|status|stop] —— 后台触发 dreaming（Host 编排，子会话只做判断）
  safeRegister({
    name: 'dream',
    description: 'Agent memory dreaming. Bare `/dream` starts a background batch (at most config.dreamBatchSize sessions); `/dream all` drains the queue (cap config.dreamAllMax); `/dream list` numbers the candidates; `/dream pick 1,3` or `/dream pick <sessionId>` runs exactly those sessions; `/dream status` shows progress; `/dream stop` aborts.',
    // 带参数的命令必须声明 input，否则客户端只认裸命令，参数会被当成普通消息发给模型
    input: { hint: 'all | list | pick <index|id> | status | stop' },
    handler: async ({ agent, rawInput }) => {
      if (!config.enabled) return { kind: 'error', text: 'agent-memory is disabled (config.enabled=false).' }
      const input = String(rawInput ?? '').trim()
      const [verb = '', ...rest] = input.split(/\s+/)
      const arg = verb.toLowerCase()

      if (arg === 'status') return { kind: 'success', text: await dreamStatusText() }
      if (arg === 'stop') {
        if (!active) return { kind: 'success', text: '没有正在运行的 dream。' }
        active.controller.abort()
        return { kind: 'success', text: '已请求中断：已完成的笔记和水位线保留，未完成的下次重跑。' }
      }
      if (arg === 'list') return { kind: 'success', text: await listCandidatesText() }
      if (arg === 'pick') return startFromPick(agent, rest.join(' ').trim())
      if (arg !== '' && arg !== 'all') return { kind: 'error', text: 'Usage: /dream [all|pick <ids>|list|status|stop]' }
      return startDream(agent, arg === 'all' ? 'all' : 'batch')
    },
  }, 'agent-memory.commands.dream')

  // /remember <text> —— 用户显式要求记住，立即落盘并标 [U]
  safeRegister({
    name: 'remember',
    description: 'Record an explicit memory note from this session. Immediately durable, highest authority ([U]).',
    input: { hint: '<what should be remembered>' },
    handler: async ({ agent, rawInput }) => {
      const text = String(rawInput ?? '').trim()
      if (text === '') return { kind: 'error', text: 'Usage: /remember <what should be remembered>' }
      if (!config.enabled) return { kind: 'error', text: 'agent-memory is disabled (config.enabled=false).' }
      const session = agent?.session
      if (!session) return { kind: 'error', text: 'No agent session for this command.' }
      try {
        const result = await saveEntry({ layout, session, text, confidence: 'U', scope: 'p' })
        await deps.indexStore?.refresh?.()
        if (result.duplicate) {
          const head = result.metaChanged ? 'Metadata updated; the note itself was already recorded' : 'Already recorded; nothing written.'
          return { kind: 'success', text: `${head} (${result.entryCount} entries in ${result.path})` }
        }
        return { kind: 'success', text: `Remembered [U]: ${result.line}\nfile: ${result.path}` }
      } catch (error) {
        return { kind: 'error', text: `Failed to record: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }, 'agent-memory.commands.remember')
}
