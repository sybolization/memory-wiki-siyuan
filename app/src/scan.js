/**
 * M4 扫描：会话枚举、过滤、Team 成员识别、候选队列（只读，不调模型）。
 *
 * 过滤规则（DESIGN.md §1 决策 12）：
 *  - fork 子会话只取 `seq >= inheritedEventCount` 的部分；
 *  - `origin:'subagent'` 默认排除，但 Team 成员例外（team/member 事件只在 Lead 日志里）；
 *  - 归档会话不提取（归档状态在 workspace 域，不在 session 日志里）；
 *  - 水位线之后没有新事件的会话跳过。
 */
import { join } from 'node:path'
import { readJson } from './paths.js'
import { dreamedThroughSeq } from './state.js'

/**
 * 有界并发 map：按传入顺序收集结果，抛错由调用方自己吞。
 *
 * observeSession 每次要打开一个会话日志、读头部，本机 163 个会话串行做要 ~20 秒；
 * 这是纯只读操作，8 路并发能把等待压到秒级，且不打爆文件句柄。
 * @param {readonly unknown[]} items
 * @param {number} limit
 * @param {(item: unknown, index: number) => Promise<unknown>} fn
 * @returns {Promise<unknown[]>}
 */
export async function mapLimit(items, limit, fn) {
  const output = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      output[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

/** 扫描并发度：日志观察是只读 IO，8 路是句柄与收益的折中。 */
const OBSERVE_CONCURRENCY = 8
/** Lead 日志并发度：每次是完整读取，压太高压不住瞬时内存，3 路是折中。 */
const TEAM_SCAN_CONCURRENCY = 3

const DAY_MS = 24 * 60 * 60 * 1000
/** 首次 dream 的引导限制：最近 7 天、最多 20 个会话。 */
export const FIRST_RUN_DAYS = 7
export const FIRST_RUN_LIMIT = 20

/** 从 workspace 域文件读归档集合；读不到就按空处理（防御性解析）。 */
export async function readArchivedIds(dshHome) {
  try {
    const document = await readJson(join(dshHome, 'storages', 'workspace.json'))
    const ids = document?.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * 路径比较用的归一化：统一分隔符、去尾部反斜杠、大小写折叠（Windows 语义）。
 * @param {unknown} value
 */
function normalizePath(value) {
  return String(value ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * cwd 是否落在任一项目前缀之下。空列表表示不限制（全量）。
 * @param {string|null} cwd - 会话工作目录。
 * @param {string[]} projects - 允许的项目根路径列表。
 */
export function matchesProjects(cwd, projects) {
  if (!projects?.length) return true
  const value = normalizePath(cwd)
  if (value === '') return false
  return projects.some((prefix) => {
    const target = normalizePath(prefix)
    return target !== '' && (value === target || value.startsWith(`${target}\\`))
  })
}

/**
 * 过滤出可参与提取的会话。
 * @param {object[]} records - 归一化后的会话记录。
 * @param {{archivedIds: Set<string>, teamMembers: Set<string>, projects?: string[]}} options
 * @returns {{kept: object[], stats: object}}
 */
export function eligibleSessions(records, { archivedIds, teamMembers, projects = [] }) {
  const kept = []
  const stats = { total: records.length, archived: 0, subagent: 0, migration: 0, excludedProjects: 0, eligible: 0 }
  for (const record of records) {
    if (!matchesProjects(record.cwd, projects)) {
      stats.excludedProjects += 1
      continue
    }
    if (record.formatStatus === 'migration-required') {
      stats.migration += 1
      continue
    }
    if (archivedIds.has(record.id)) {
      stats.archived += 1
      continue
    }
    if (record.origin === 'subagent' && !teamMembers.has(record.id)) {
      stats.subagent += 1
      continue
    }
    kept.push(record)
  }
  stats.eligible = kept.length
  return { kept, stats }
}

/**
 * 收集 Team 成员会话 id：只有"有子会话的根会话"才可能持有 team/member 事件。
 * 每个 Lead 按 revision/cursor 缓存，日志没变就不重读。
 * @returns {Promise<{members: Set<string>, cache: object, scanned: number}>}
 */
export async function collectTeamMembers(ctx, records, cache, signal) {
  const leadIds = [...new Set(records.map((record) => record.parentSession).filter((id) => typeof id === 'string'))]
  const members = new Set()
  const nextCache = { ...cache }
  let scanned = 0

  // Lead 日志是完整读取（本机单文件可达 18MB），串行会把首轮扫描拖到十几秒；
  // 只读、无共享写，按 3 路并发读，缓存命中时只做一次 observeSession。
  const results = await mapLimit(leadIds, TEAM_SCAN_CONCURRENCY, async (leadId) => {
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(leadId, { projectionMode: 'none', signal })
      const revision = String(observation.revision ?? observation.cursor ?? '')
      const cached = cache[leadId]
      if (cached && cached.revision === revision) {
        return { leadId, revision, members: cached.members, scanned: false }
      }
      const log = await ctx.sessionQuery.readSession(leadId)
      const found = [...new Set(
        log.events
          .filter((event) => event.type === 'team/member')
          .map((event) => event.data?.member?.id)
          .filter((id) => typeof id === 'string'),
      )]
      return { leadId, revision, members: found, scanned: true }
    } catch {
      // 单个 Lead 读失败不影响整体扫描
      return null
    } finally {
      observation?.[Symbol.dispose]?.()
    }
  })

  for (const result of results) {
    if (result === null) continue
    nextCache[result.leadId] = { revision: result.revision, members: result.members }
    for (const id of result.members) members.add(id)
    if (result.scanned) scanned += 1
  }
  return { members, cache: nextCache, scanned }
}

/**
 * 生成扫描计划：候选会话 + 每个会话的取用区间（起始 seq 到最新 seq）。
 *
 * `only` 用于"手动勾选会话"（未来面板的底层能力）：显式列出会话 id 时，
 * 绕过项目范围与水位线，按 id 精确定位；归档/subagent 也不再过滤。
 * @param {object} params
 * @returns {Promise<object>} { queue, stats, teamScan, teamMembers }
 */
export async function buildScanPlan({ ctx, state, dshHome, now = Date.now(), signal, projects = [], only = [] }) {
  const records = (await ctx.sessionQuery.listSessions(signal)).map(({ header, live, persisted, formatStatus }) => ({
    id: header.id,
    cwd: header.cwd ?? null,
    createdAt: Number(header.createdAt ?? 0),
    parentSession: header.parentSession ?? null,
    isSeeded: Boolean(header.isSeeded),
    origin: header.origin ?? null,
    live,
    persisted,
    formatStatus: formatStatus ?? null,
  }))

  const archivedIds = await readArchivedIds(dshHome)
  const team = await collectTeamMembers(ctx, records, state.teamScan ?? {}, signal)
  const base = eligibleSessions(records, { archivedIds, teamMembers: team.members, projects })
  const selected = only?.length ? new Set(only) : null
  // 手动勾选：不受项目范围/归档/subagent/水位线限制，只要求会话存在且格式可读
  const kept = selected
    ? records.filter((record) => selected.has(record.id) && record.formatStatus !== 'migration-required')
    : base.kept
  const stats = { ...base.stats, selected: selected ? kept.length : 0 }
  const firstRun = (state.runs?.length ?? 0) === 0

  // 并发观察每个会话的游标；顺序由下面的 sort 统一恢复，不依赖完成顺序
  const observed = await mapLimit(kept, OBSERVE_CONCURRENCY, async (record) => {
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(record.id, { projectionMode: 'none', signal })
      const cursor = Number(observation.cursor ?? -1)
      const inherited = Math.max(0, Number(observation.inheritedEventCount ?? 0))
      // 起始序号：显式选择时从头读；否则从"已 dream 的下一格"，且不早于 fork 切点
      const startSeq = selected
        ? inherited
        : Math.max(dreamedThroughSeq(state, record.id) + 1, inherited)
      if (cursor < startSeq) return null
      return { id: record.id, cwd: record.cwd, createdAt: record.createdAt, inherited, startSeq, endSeq: cursor }
    } catch {
      // 读不到的会话（权限/格式问题）静默跳过，统计里不算候选
      return null
    } finally {
      observation?.[Symbol.dispose]?.()
    }
  })
  const queue = observed.filter((item) => item !== null)
  queue.sort((left, right) => right.createdAt - left.createdAt)

  let limited = queue
  if (firstRun && !selected) {
    const since = now - FIRST_RUN_DAYS * DAY_MS
    limited = queue.filter((item) => item.createdAt >= since).slice(0, FIRST_RUN_LIMIT)
  }

  return {
    queue: limited,
    stats: {
      ...stats,
      teamMembers: team.members.size,
      leadsScanned: team.scanned,
      projects: projects.length,
      candidates: limited.length,
      deferred: queue.length - limited.length,
      firstRun,
    },
    teamScan: team.cache,
    teamMemberIds: [...team.members],
  }
}

/**
 * 把扫描计划渲染成可读报告（命令与诊断工具共用，最多 30 行）。
 * @param {object} plan - buildScanPlan 的结果。
 * @returns {string}
 */
export function formatScanReport(plan) {
  const { stats, queue } = plan
  const lines = [
    'Agent memory · M4 scan',
    `sessions: total=${stats.total} eligible=${stats.eligible} archived=${stats.archived} subagent=${stats.subagent} migration=${stats.migration}`,
    `scope: ${stats.projects ? `${stats.projects} project prefix(es), excluded=${stats.excludedProjects}` : 'all projects'}`,
    `team: members=${stats.teamMembers} leadsScanned=${stats.leadsScanned}`,
    `candidates: ${stats.candidates}${stats.firstRun ? ` (first run: last ${FIRST_RUN_DAYS} days, cap ${FIRST_RUN_LIMIT}; deferred=${stats.deferred})` : ''}`,
  ]
  for (const item of queue.slice(0, 25)) {
    lines.push(`- ${item.id}  ${item.cwd ?? '(no-cwd)'}  seq ${item.startSeq}..${item.endSeq}  inherited=${item.inherited}`)
  }
  if (queue.length > 25) lines.push(`… ${queue.length - 25} more`)
  return lines.join('\n')
}
