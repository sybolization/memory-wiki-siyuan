/**
 * M4 自检：过滤规则（归档/subagent/Team/migration）、fork 切点、水位线、
 * 首次引导限制、team 缓存复用、报告渲染。用假 ctx 模拟 sessionQuery。
 *
 * 运行：node scripts/selftest-m4.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPaths } from '../src/paths.js'
import { createDefaultState, upsertSession } from '../src/state.js'
import { buildScanPlan, formatScanReport, matchesProjects, readArchivedIds } from '../src/scan.js'

const results = []
/** 断言并记录一行结果。 */
function check(label, ok) {
  results.push([label, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const dir = await mkdtemp(join(tmpdir(), 'agent-memory-m4-'))
let disposed = 0

const records = [
  { id: 's-a', cwd: 'C:\\A', createdAt: now - 8 * DAY },
  { id: 's-b', cwd: 'C:\\A', createdAt: now - DAY, parentSession: 's-a', origin: 'subagent' },
  { id: 's-c', cwd: 'C:\\A', createdAt: now - DAY, parentSession: 's-a', origin: 'subagent' },
  { id: 's-d', cwd: 'C:\\D', createdAt: now - DAY },
  { id: 's-e', cwd: 'C:\\E', createdAt: now - 2 * DAY, isSeeded: true },
  { id: 's-f', cwd: 'C:\\F', createdAt: now - DAY },
  { id: 's-g', cwd: 'C:\\G', createdAt: now - DAY, formatStatus: 'migration-required' },
]
const cuts = new Map([
  ['s-a', { cursor: 50, inherited: 0 }],
  ['s-c', { cursor: 10, inherited: 0 }],
  ['s-e', { cursor: 12, inherited: 5 }],
  ['s-f', { cursor: 100, inherited: 0 }],
])
const fakeCtx = {
  sessionQuery: {
    listSessions: async () => records.map((header) => ({
      header, live: true, persisted: true, formatStatus: header.formatStatus,
    })),
    observeSession: async (id) => {
      const cut = cuts.get(id)
      if (!cut) throw new Error(`no cut for ${id}`)
      return {
        cursor: cut.cursor,
        inheritedEventCount: cut.inherited,
        revision: `r${cut.cursor}`,
        [Symbol.dispose]: () => { disposed += 1 },
      }
    },
    readSession: async (id) => ({
      events: id === 's-a' ? [{ type: 'team/member', data: { member: { id: 's-c' } } }] : [],
    }),
  },
}

try {
  // 归档集合来自 workspace 域文件
  await mkdir(join(dir, 'storages'), { recursive: true })
  await writeFile(join(dir, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: ['s-d'] } }))
  const layout = memoryPaths(join(dir, 'memory'))
  const archived = await readArchivedIds(dir)
  check('读到归档集合', archived.has('s-d') && archived.size === 1)

  const state = createDefaultState()
  upsertSession(state, 's-f', { cwd: 'C:\\F', dreamedThroughSeq: 100 })
  check('水位线就绪', state.sessions['s-f'].dreamedThroughSeq === 100)

  // ── 首次运行：引导限制（最近 7 天）+ 全部过滤规则 ──────────────────
  const first = await buildScanPlan({ ctx: fakeCtx, state, dshHome: dir, now })
  const ids = first.queue.map((item) => item.id)
  check('归档会话被排除', !ids.includes('s-d'))
  check('普通 subagent 被排除', !ids.includes('s-b'))
  check('Team 成员被收录', ids.includes('s-c'))
  check('migration 会话被排除', !ids.includes('s-g'))
  check('水位线之后的会话被排除', !ids.includes('s-f'))
  check('首次运行只取最近 7 天', !ids.includes('s-a') && ids.includes('s-c'))
  check('首次运行保留 deferred 计数', first.stats.deferred === 1)
  check('fork 从 inheritedEventCount 开始', first.queue.find((i) => i.id === 's-e')?.startSeq === 5)
  check('未处理会话从 0 开始', first.queue.find((i) => i.id === 's-c')?.startSeq === 0)
  check('统计口径正确', first.stats.total === 7 && first.stats.eligible === 4 && first.stats.archived === 1 && first.stats.subagent === 1)
  check('Team 成员被记录', first.teamMemberIds.includes('s-c'))
  check('Lead 被扫描一次', first.stats.leadsScanned === 1)

  // ── 缓存复用：同一 revision 不重读 Lead 日志 ──────────────────────
  state.teamScan = first.teamScan
  const second = await buildScanPlan({ ctx: fakeCtx, state, dshHome: dir, now })
  check('team 缓存复用不重扫', second.stats.leadsScanned === 0 && second.queue.map((i) => i.id).join() === ids.join())

  // ── 非首次运行：不再限制 7 天 ─────────────────────────────────────
  state.runs.push({ at: new Date(now).toISOString(), kind: 'dream' })
  const third = await buildScanPlan({ ctx: fakeCtx, state, dshHome: dir, now })
  const thirdIds = third.queue.map((item) => item.id)
  check('非首次运行收录老会话', thirdIds.includes('s-a') && thirdIds.length === 3)
  check('按创建时间倒序', thirdIds[0] === 's-c' && thirdIds[thirdIds.length - 1] === 's-a')

  const report = formatScanReport(third)
  check('报告含头部与候选数', report.includes('M4 scan') && report.includes('candidates: 3'))
  check('租约被释放', disposed > 0)

  // ── 项目范围过滤（cwd 前缀，Windows 大小写不敏感）─────────────────
  check('前缀匹配命中子目录', matchesProjects('C:\\work\\alpha\\src', ['C:\\work\\alpha']) === true)
  check('前缀匹配不含兄弟目录', matchesProjects('C:\\work\\alpha-python', ['C:\\work\\alpha']) === false)
  check('大小写与斜杠不敏感', matchesProjects('c:/Work/ALPHA/src', ['C:\\work\\alpha']) === true)
  check('空列表等于全量', matchesProjects('C:\\anything', []) === true)

  const scoped = await buildScanPlan({ ctx: fakeCtx, state, dshHome: dir, now, projects: ['C:\\E'] })
  check('范围外会话被排除', scoped.queue.length === 1 && scoped.queue[0].id === 's-e' && scoped.stats.excludedProjects === 6)
  check('报告显示范围', formatScanReport(scoped).includes('1 project prefix(es)'))

  // ── 手动勾选：绕过硬水位线/范围，按 id 精确定位 ────────────────────
  const picked = await buildScanPlan({ ctx: fakeCtx, state, dshHome: dir, now, only: ['s-f'] })
  check('显式选择绕过水位线', picked.queue.length === 1 && picked.queue[0].id === 's-f' && picked.queue[0].startSeq === 0)
  check('显式选择统计 selected', picked.stats.selected === 1)
  check('显式选择忽略项目范围', (await buildScanPlan({ ctx: fakeCtx, state, dshHome: dir, now, projects: ['C:\\Z'], only: ['s-f'] })).queue.length === 1)
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nSELFTEST M4 ${failed.length === 0 ? 'OK' : `FAILED (${failed.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
