/**
 * M5 自检：摘录、判断结果规范化、dreaming 编排（写入/水位线/查重/失败/单飞）。
 * 用假 ctx 与假 judge，不花模型额度。
 *
 * 运行：node scripts/selftest-m5.mjs
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPaths } from '../src/paths.js'
import { createDefaultState, upsertSession, loadState } from '../src/state.js'
import { buildDigest, describeEvent } from '../src/digest.js'
import { normalizeNotes, runDream, formatDreamSummary, spawnJudge } from '../src/dream.js'
import { normalizeConfig } from '../src/config.js'
import { parseNote } from '../src/notes.js'

const results = []
/** 断言并记录一行结果。 */
function check(label, ok) {
  results.push([label, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

/** 断言某段代码会抛错。 */
function throws(fn) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

function event(seq, type, data) {
  return { seq, type, data, time: Date.now() }
}

const EVENTS = {
  's-a': [
    event(0, 'user/message', { content: [{ type: 'text', text: '请修一下构建' }], source: { kind: 'human' } }),
    event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '我先看构建日志' }] } }),
    event(2, 'tool/call', { name: 'pwsh', arguments: '{"command":"pnpm build"}' }),
    event(3, 'tool/result', { message: { content: [{ type: 'text', text: 'error TS2322' }], isError: true } }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ],
  's-b': [
    event(0, 'user/message', { content: [{ type: 'text', text: '看看测试' }], source: { kind: 'human' } }),
    event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '好' }] } }),
  ],
  's-c': [
    event(0, 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'human' } }),
  ],
}
const CUTS = {
  's-a': { cursor: 4, inherited: 0 },
  's-b': { cursor: 1, inherited: 0 },
  's-c': { cursor: 0, inherited: 0 },
}

const records = ['s-a', 's-b', 's-c'].map((id) => ({ id, cwd: 'C:\\proj', createdAt: Date.now() - 60_000 }))
function makeCtx() {
  return {
    sessionQuery: {
      listSessions: async () => records.map((header) => ({ header, live: true, persisted: true })),
      observeSession: async (id) => ({
        cursor: CUTS[id].cursor,
        inheritedEventCount: CUTS[id].inherited,
        revision: `r${CUTS[id].cursor}`,
        [Symbol.dispose]: () => {},
      }),
      readSession: async (id) => ({ session: { id }, inheritedEventCount: 0, events: EVENTS[id] }),
    },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'agent-memory-m5-'))
try {
  const layout = memoryPaths(join(dir, 'memory'))
  const paths = { dshHome: dir, memoryDir: layout.root }
  const config = { dreamBatchSize: 5, dreamMaxChars: 12000, dreamProvider: null }
  const now = new Date()

  // ── 摘录 ──────────────────────────────────────────────────────────
  check('用户消息带来源', describeEvent(EVENTS['s-a'][0]).includes('[用户] 请修一下构建'))
  check('工具失败被标注', describeEvent(EVENTS['s-a'][3]).includes('[失败]'))
  check('结构性事件被跳过', describeEvent(EVENTS['s-a'][4]) === null)
  const digest = buildDigest({ events: EVENTS['s-a'], startSeq: 0, endSeq: 4 })
  check('摘录包含四类有效行', digest.lines === 4 && digest.considered === 5)
  const clipped = buildDigest({ events: EVENTS['s-a'], startSeq: 0, endSeq: 4, maxChars: 30 })
  check('超长摘录保留头尾', clipped.truncated && clipped.text.includes('中间省略'))

  // ── 判断结果规范化 ────────────────────────────────────────────────
  const normalized = normalizeNotes({ notes: [
    { text: '- 一条足够长的经验，值得记录', confidence: 'X', scope: 'z' },
    { text: '短', confidence: 'V' },
    { text: 42 },
  ] })
  check('去前缀并收敛枚举', normalized.length === 1 && normalized[0].confidence === 'I' && normalized[0].scope === 'p')
  check('丢弃过短内容', normalizeNotes({ notes: [{ text: '太短' }] }).length === 0)
  check('容忍空输出', normalizeNotes({}).length === 0)

  // ── 判断环境固定化：dreamModel + 固定 cwd ─────────────────────────
  check('dreamModel 默认继承', normalizeConfig({}).dreamModel === null)
  check('dreamModel 拒绝空串', throws(() => normalizeConfig({ dreamModel: '  ' })))
  check('dreamModel 接受模型名', normalizeConfig({ dreamModel: 'deepseek-v4.1-flash' }).dreamModel === 'deepseek-v4.1-flash')
  check('dreamProjects 默认空数组', normalizeConfig({}).dreamProjects.length === 0)
  check('dreamProjects 拒绝非数组', throws(() => normalizeConfig({ dreamProjects: 'C:\\x' })))
  check('dreamAllMax 拒绝 0', throws(() => normalizeConfig({ dreamAllMax: 0 })))

  const captured = []
  const judgeCtx = {
    subagents: {
      startActivation: async (spec) => {
        captured.push(spec)
        return {
          childId: 'child',
          result: Promise.resolve({ structured: { notes: [] }, stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  }
  await spawnJudge(judgeCtx, { provider: 'spawn', model: 'm1', cwd: 'C:\\mem' })({ parent: {}, prompt: 'p', sessionId: 'sid-1234' })
  check('判断子会话固定 cwd', captured[0]?.request?.cwd === 'C:\\mem')
  check('判断子会话固定模型路由', captured[0]?.request?.agentOptions?.model === 'm1' && captured[0]?.request?.agentOptions?.provider === 'spawn')
  captured.length = 0
  await spawnJudge(judgeCtx, { provider: 'spawn' })({ parent: {}, prompt: 'p', sessionId: 'sid-1234' })
  check('未配置模型时不传 agentOptions', captured[0]?.request?.agentOptions === undefined)

  // ── 正常 dream：查重 + 写入 + 水位线 + runs ──────────────────────
  await mkdir(layout.notesDir, { recursive: true })
  // 迁移前的旧命名：文件名是 sessionId，文件头没有 frontmatter
  await writeFile(layout.notePath('s-a.md'), '- [V|p] 这条经验会从另一个会话重复出现 (s2)\n')
  const state = createDefaultState()
  upsertSession(state, 's-a', { cwd: 'C:\\proj' })
  upsertSession(state, 's-b', { cwd: 'C:\\proj' })
  upsertSession(state, 's-c', { cwd: 'C:\\proj' })

  const judgeCalls = []
  const judge = async ({ sessionId }) => {
    judgeCalls.push(sessionId)
    return { notes: [
      { text: '这条经验会从另一个会话重复出现', confidence: 'V', scope: 'p' },
      { text: '新的通用经验：先备份再迁移', confidence: 'I', scope: 'g' },
    ] }
  }
  const summary = await runDream({ ctx: makeCtx(), paths, layout, config, state, agent: { session: { header: { cwd: 'C:\\proj' } } }, judge, now })
  check('处理了全部候选', summary.attempted === 3 && summary.batch === 3)
  check('空会话跳过判断调用', !judgeCalls.includes('s-c') && summary.empty === 1)
  // 第一条与已有笔记重复；第二条写入 s-a 后进入查重集合，所以总共只新增 1 条
  check('重复内容只写一次', summary.notes === 1)
  const noteA = await readFile(layout.notePath(state.sessions['s-a'].file), 'utf8')
  const parsedA = parseNote(noteA)
  check('新条目落到会话笔记', noteA.includes('新的通用经验：先备份再迁移') && parsedA.entries.length === 2)
  check('dream 条目用日期标记', /^d \d{4}-\d{2}-\d{2}$/.test(parsedA.entries[1].stamp))
  check('dream 写入的文件名/描述非空', Boolean(parsedA.meta.name) && Boolean(parsedA.meta.description))
  check('dream 文件按 name 命名并带 session', state.sessions['s-a'].file.endsWith('.md')
    && state.sessions['s-a'].file !== 's-a.md' && parsedA.meta.session === 's-a')
  check('索引同步 name/description', state.sessions['s-a'].name === parsedA.meta.name
    && state.sessions['s-a'].description === parsedA.meta.description)
  check('空会话推进水位线', state.sessions['s-c'].dreamedThroughSeq === 0)
  check('有内容会话推进水位线', state.sessions['s-a'].dreamedThroughSeq === 4)
  const reloaded = await loadState(layout)
  check('runs 记录已落盘', reloaded.state.runs.at(-1)?.kind === 'dream' && reloaded.state.runs.at(-1)?.notes === 1)
  check('摘要可读', formatDreamSummary(summary).includes('notes added: 1'))
  const progress = JSON.parse(await readFile(layout.dreamProgressPath, 'utf8'))
  check('进度文件记录完成阶段', progress.stage === 'done' && progress.finished === 3 && progress.notes === 1)
  check('水位线随每个会话落盘', reloaded.state.sessions['s-a'].dreamedThroughSeq === 4)

  // ── 中断：已完成的水位线与笔记保留，未完成的下次重跑 ─────────────
  const abortDir = await mkdtemp(join(tmpdir(), 'agent-memory-m5a-'))
  try {
    const layout4 = memoryPaths(join(abortDir, 'memory'))
    const paths4 = { dshHome: abortDir, memoryDir: layout4.root }
    const state4 = createDefaultState()
    for (const id of ['s-a', 's-b', 's-c']) upsertSession(state4, id, { cwd: 'C:\\proj' })
    const controller = new AbortController()
    let calls = 0
    const abortingJudge = async () => {
      calls += 1
      if (calls === 1) {
        return { notes: [{ text: '中断前写入的经验，必须保留在笔记文件里', confidence: 'V', scope: 'p' }] }
      }
      controller.abort()
      throw new Error('cancelled by user')
    }
    const summary4 = await runDream({
      ctx: makeCtx(), paths: paths4, layout: layout4, config, state: state4,
      agent: {}, judge: abortingJudge, now, signal: controller.signal,
    })
    check('中断后不再处理后续会话', summary4.aborted === true && summary4.cancelled === 1 && summary4.attempted === 2)
    const notes4 = await Promise.all(['s-a', 's-b'].map((id) => (
      state4.sessions[id]?.file
        ? readFile(layout4.notePath(state4.sessions[id].file), 'utf8').catch(() => '')
        : Promise.resolve('')
    )))
    check('中断前写入的笔记保留', notes4.some((text) => text.includes('中断前写入的经验')))
    const reloaded4 = await loadState(layout4)
    check('中断也记 runs 且带 aborted', reloaded4.state.runs.at(-1)?.aborted === true)
    check('已完成会话水位线已落盘', Object.values(reloaded4.state.sessions).some((entry) => entry.dreamedThroughSeq === 4))
    const progress4 = JSON.parse(await readFile(layout4.dreamProgressPath, 'utf8'))
    check('进度文件标记 aborted', progress4.stage === 'aborted')
  } finally {
    await rm(abortDir, { recursive: true, force: true })
  }

  // ── 手动勾选：只跑指定会话，且绕过硬水位线 ────────────────────────
  const pickDir = await mkdtemp(join(tmpdir(), 'agent-memory-m5p-'))
  try {
    const layout5 = memoryPaths(join(pickDir, 'memory'))
    const paths5 = { dshHome: pickDir, memoryDir: layout5.root }
    const state5 = createDefaultState()
    for (const id of ['s-a', 's-b', 's-c']) upsertSession(state5, id, { cwd: 'C:\\proj', dreamedThroughSeq: 99 })
    const summary5 = await runDream({
      ctx: makeCtx(), paths: paths5, layout: layout5, config, state: state5, agent: {},
      judge: async () => ({ notes: [{ text: '手动重跑也要能写进笔记文件', confidence: 'I', scope: 'p' }] }),
      now, only: ['s-a'],
    })
    check('手动选择只处理指定会话', summary5.attempted === 1 && summary5.batch === 1)
    const note5 = await readFile(layout5.notePath(state5.sessions['s-a'].file), 'utf8')
    check('手动选择绕过水位线写入', note5.includes('手动重跑也要能写进笔记文件'))
  } finally {
    await rm(pickDir, { recursive: true, force: true })
  }

  // ── 旧文件补元数据：只读文件条目，不产生新笔记 ────────────────────
  const metaDir = await mkdtemp(join(tmpdir(), 'agent-memory-m5m-'))
  try {
    const layout6 = memoryPaths(join(metaDir, 'memory'))
    const paths6 = { dshHome: metaDir, memoryDir: layout6.root }
    await mkdir(layout6.notesDir, { recursive: true })
    await writeFile(layout6.notePath('s-old.md'), '- [V|p] 旧文件里的一条够长经验，等 dream 补描述 (s3)\n')
    const state6 = createDefaultState()
    upsertSession(state6, 's-old', { cwd: 'C:\\proj', dreamedThroughSeq: 99, noteEntries: 1 })
    let metaPrompt = ''
    const metaJudge = async ({ prompt }) => {
      metaPrompt = prompt
      return { name: '旧会话的记忆', description: '记录旧文件里的经验' }
    }
    const summary6 = await runDream({
      ctx: makeCtx(), paths: paths6, layout: layout6, config, state: state6, agent: {}, judge: metaJudge, now,
    })
    check('旧文件进入补写队列', summary6.metaCandidates === 1 && summary6.metaFixed === 1)
    check('补写提示词只带文件条目', metaPrompt.includes('旧文件里的一条够长经验'))
    const metaText = await readFile(layout6.notePath(state6.sessions['s-old'].file), 'utf8')
    const metaParsed = parseNote(metaText)
    check('补写不产生新笔记', metaParsed.entries.length === 1 && metaParsed.meta.name === '旧会话的记忆')
    check('补写按 name 改名并写回 session', state6.sessions['s-old'].file === '旧会话的记忆.md'
      && metaParsed.meta.session === 's-old')
    check('补写同步索引', state6.sessions['s-old'].name === '旧会话的记忆'
      && state6.sessions['s-old'].description === '记录旧文件里的经验')
    // 再跑一次：文件已有元数据，不再重复补写
    const summary6b = await runDream({
      ctx: makeCtx(), paths: paths6, layout: layout6, config, state: state6, agent: {}, judge: metaJudge, now,
    })
    check('已有元数据不重复补写', summary6b.metaCandidates === 0 && summary6b.metaFixed === 0)
  } finally {
    await rm(metaDir, { recursive: true, force: true })
  }

  // ── 失败不推进水位线 ──────────────────────────────────────────────
  const failDir = await mkdtemp(join(tmpdir(), 'agent-memory-m5f-'))
  try {
    const layout2 = memoryPaths(join(failDir, 'memory'))
    const paths2 = { dshHome: failDir, memoryDir: layout2.root }
    const state2 = createDefaultState()
    for (const id of ['s-a', 's-b', 's-c']) upsertSession(state2, id, { cwd: 'C:\\proj' })
    const failing = async () => { throw new Error('judge boom') }
    const summary2 = await runDream({ ctx: makeCtx(), paths: paths2, layout: layout2, config, state: state2, agent: {}, judge: failing, now })
    // s-c 内容太少不调用判断，所以失败 2、空 1
    check('失败被记录且不影响其它会话', summary2.failed.length === 2 && summary2.empty === 1 && summary2.notes === 0)
    check('失败不推进水位线', (state2.sessions['s-a'].dreamedThroughSeq ?? -1) === -1)
    const reloaded2 = await loadState(layout2)
    check('失败运行也记 runs', reloaded2.state.runs.at(-1)?.failed === 2)
  } finally {
    await rm(failDir, { recursive: true, force: true })
  }

  // ── 单飞：同一时刻只允许一个 dream ────────────────────────────────
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slowJudge = async () => { await gate; return { notes: [] } }
  const slowState = createDefaultState()
  upsertSession(slowState, 's-a', { cwd: 'C:\\proj' })
  const slowDir = await mkdtemp(join(tmpdir(), 'agent-memory-m5s-'))
  try {
    const layout3 = memoryPaths(join(slowDir, 'memory'))
    const paths3 = { dshHome: slowDir, memoryDir: layout3.root }
    const firstRun = runDream({ ctx: makeCtx(), paths: paths3, layout: layout3, config, state: slowState, agent: {}, judge: slowJudge, now })
    await new Promise((resolve) => setTimeout(resolve, 20))
    let rejected = false
    try {
      await runDream({ ctx: makeCtx(), paths: paths3, layout: layout3, config, state: createDefaultState(), agent: {}, judge: slowJudge, now })
    } catch (error) {
      rejected = String(error.message).includes('已在运行')
    }
    release()
    await firstRun
    check('单飞锁生效', rejected === true)
  } finally {
    await rm(slowDir, { recursive: true, force: true })
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nSELFTEST M5 ${failed.length === 0 ? 'OK' : `FAILED (${failed.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
