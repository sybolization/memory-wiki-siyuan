/**
 * M0/M1 诊断报告：插件加载状态、服务与 API 探针、路径、索引状态。
 *
 * 同时服务两个入口：工具 `memory_status` 与命令 `/memory doctor`。
 * 只读：不会创建目录，也不会写索引。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadState } from './state.js'
import { formatDreamProgress, readDreamProgress, readLastRun } from './progress.js'
import { readWikiStats } from './wiki.js'

/** 需要确认存在的宿主服务（与 plugin.js 的 inject 对齐）。 */
const REQUIRED_SERVICES = ['systemPrompt', 'tools', 'commands', 'sessionQuery', 'subagents', 'agents']

/** 需要确认可用的具体函数，区分"服务在但方法不在"的版本差异。 */
const API_PROBES = [
  ['systemPrompt.section', (ctx) => typeof ctx.systemPrompt?.section === 'function'],
  ['systemPrompt.context', (ctx) => typeof ctx.systemPrompt?.context === 'function'],
  ['tools.register', (ctx) => typeof ctx.tools?.register === 'function'],
  ['commands.register', (ctx) => typeof ctx.commands?.register === 'function'],
  ['subagents.startActivation', (ctx) => typeof ctx.subagents?.startActivation === 'function'],
  ['sessionQuery.listSessions', (ctx) => typeof ctx.sessionQuery?.listSessions === 'function'],
]

/** 本地时间（带偏移），比裸 UTC 更便于人读。 */
function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 进程时区名（Intl 不可用时退回 unknown）。 */
function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'unknown'
  }
}

/** 读取自身 package.json，避免版本号手写漂移。 */
async function readPluginVersion() {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(await readFile(path, 'utf8'))
    return `${pkg.name} ${pkg.version}`
  } catch {
    return '(unknown)'
  }
}

/** 索引状态：不存在是正常的（首次写入发生在第一条笔记时）。 */
async function indexStatus(layout) {
  try {
    const { state, existed } = await loadState(layout)
    if (!existed) return 'index: absent (first write happens on the first note)'
    return `index: ok (sessions=${Object.keys(state.sessions).length}, topics=${Object.keys(state.topics).length}, runs=${state.runs.length}, updatedAt=${state.updatedAt ?? 'n/a'})`
  } catch (error) {
    return `index: error (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * 注入验证：真的调用一次 assemble，确认 section 在装配结果里，
 * 并报告当前 cwd 的块大小与缓存状态（这比"注册没抛错"更接近事实）。
 */
async function injectionStatus({ ctx, indexStore, agent, signal }) {
  const cwd = agent?.session?.header?.cwd ?? ''
  const block = indexStore?.textFor(cwd) ?? ''
  const shape = block === ''
    ? 'block=empty'
    : `block=${block.split('\n').length} lines/${Buffer.byteLength(block, 'utf8')} bytes`
  const stats = indexStore?.stats?.() ?? {}
  const scopeInfo = `scopes=${stats.scopes ?? '?'} refreshedAt=${stats.lastRefreshAt ?? 'n/a'}`
  if (!agent) return `injection: unverified (no agent); ${shape}; ${scopeInfo}`
  try {
    const assembly = await ctx.systemPrompt.assemble({ agent, signal })
    // 索引块注册的是 runtime context（systemPrompt.context），不是 section：
    // 装配结果里它在 assembly.contexts，不是 assembly.sections。
    const entry = assembly?.contexts?.find((item) => item.name === 'agent-memory:index')
    if (!entry) return `injection: context missing from assembly; ${shape}; ${scopeInfo}`
    return `injection: present as runtime context (${entry.text.length} chars); ${shape}; ${scopeInfo}`
  } catch (error) {
    return `injection: error (${error instanceof Error ? error.message : String(error)}); ${shape}`
  }
}

/**
 * 生成诊断报告文本。
 * @param {object} params
 * @param {import('@deepseek-ai/cordis').Context} params.ctx - 插件上下文。
 * @param {{ memoryDir: string, dshHome: string }} params.paths - 已解析路径。
 * @param {object} params.layout - memoryPaths() 结果。
 * @param {object} params.config - 归一化后的配置。
 * @param {object} [params.indexStore] - 注入块缓存。
 * @param {object} [params.agent] - 发起诊断的 Agent（用于 assemble 验证）。
 * @param {AbortSignal} [params.signal] - 调用方取消信号。
 * @returns {Promise<string>} 多行纯文本报告。
 */
export async function buildDoctorReport({ ctx, paths, layout, config, indexStore, agent, signal, commandErrors }) {
  const lines = []
  lines.push('Agent memory · doctor')
  lines.push(`plugin: ${await readPluginVersion()}`)
  lines.push(`time: ${localTimestamp()} [${timeZoneName()}]`)
  lines.push(`DSH_HOME: ${paths.dshHome}`)
  lines.push(`memory dir: ${paths.memoryDir} (exists: ${existsSync(paths.memoryDir) ? 'yes' : 'no'})`)

  // 服务层：逐项报 ok/missing，缺失不影响报告本身
  lines.push(`services: ${REQUIRED_SERVICES.map((key) => `${key}=${ctx[key] ? 'ok' : 'missing'}`).join(' ')}`)

  // API 层：方法级探针
  const apis = API_PROBES.map(([label, probe]) => {
    try {
      return `${label}=${probe(ctx) ? 'ok' : 'missing'}`
    } catch {
      return `${label}=error`
    }
  })
  lines.push(`api: ${apis.join(' ')}`)

  // 命令注册检查：名称解析不到 = 客户端不会把它当命令，输入会直接发给模型
  try {
    const names = ['memory', 'remember', 'dream']
    const resolved = names.map((name) => {
      if (!agent || typeof ctx.commands?.find !== 'function') return `${name}=?`
      const definition = ctx.commands.find(agent, name)
      return `${name}=${definition ? (definition.input ? 'ok' : 'ok(bare-only)') : 'missing'}`
    })
    lines.push(`commands: ${resolved.join(' ')}`)
  } catch (error) {
    lines.push(`commands: error (${error instanceof Error ? error.message : String(error)})`)
  }
  if (commandErrors?.length) lines.push(`command errors: ${commandErrors.join('; ')}`)

  // 索引层：真实读一次 index.json（不存在不报错）
  lines.push(await indexStatus(layout))

  // wiki 层：页数/候选数与体积比（M6）
  try {
    const wiki = await readWikiStats(layout)
    lines.push(`wiki: pages=${wiki.pages} candidates=${wiki.candidates} volume=${wiki.ratio.toFixed(2)} (limit ${config.wikiMaxRatio}; promoted pages only)`)
  } catch (error) {
    lines.push(`wiki: error (${error instanceof Error ? error.message : String(error)})`)
  }

  // 注入层：真的 assemble 一次，确认 section 在且缓存可渲染
  lines.push(await injectionStatus({ ctx, indexStore, agent, signal }))

  // dreaming：有进度文件就看实时进度，否则回退到 runs.jsonl 的最近一次
  const progress = await readDreamProgress(layout)
  lines.push(formatDreamProgress(progress) ?? (await readLastRun(layout)) ?? 'dream: never run (use /dream)')

  // 会话可见性：真正调一次 listSessions，验证服务能工作（只读）
  try {
    const sessions = await ctx.sessionQuery.listSessions(signal)
    const sample = sessions.slice(0, 3).map((record) => {
      const header = record.header ?? {}
      return `${header.id ?? '?'}@${header.cwd ?? '(no-cwd)'}`
    })
    lines.push(`sessions: ${sessions.length}${sample.length ? ` sample: ${sample.join(', ')}` : ''}`)
  } catch (error) {
    lines.push(`sessions: error (${error instanceof Error ? error.message : String(error)})`)
  }

  lines.push(`config: ${JSON.stringify(config)}`)
  lines.push('next: M6 wiki pages/lint · M7 idle trigger')
  return lines.join('\n')
}
