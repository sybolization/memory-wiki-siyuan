/**
 * M3 自检：注入块树形渲染、按 cwd 过滤、截断、文件头回填索引，以及 context 注册后的取值路径。
 *
 * 运行：node scripts/selftest-m3.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPaths } from '../src/paths.js'
import { saveState, createDefaultState, loadState, upsertSession } from '../src/state.js'
import { renderIndexBlock, trimBlock } from '../src/index-block.js'
import { createIndexBlockStore } from '../src/index-store.js'
import { registerInjection } from '../src/inject.js'

const results = []
/** 断言并记录一行结果。 */
function check(label, ok) {
  results.push([label, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

const dir = await mkdtemp(join(tmpdir(), 'agent-memory-m3-'))
try {
  const layout = memoryPaths(dir)
  const config = { maxIndexLines: 60, maxIndexBytes: 4096 }

  // ── 空索引：不注入任何东西 ────────────────────────────────────────
  const emptyStore = createIndexBlockStore({ layout, config })
  await emptyStore.refresh()
  check('空索引不注入', emptyStore.textFor('C:\\A') === '')

  // ── 有内容：树形、按 cwd 过滤、只保留 promoted 主题 ────────────────
  const state = createDefaultState()
  upsertSession(state, 'session-a', {
    cwd: 'C:\\A', file: '会话 A 的笔记.md', name: '会话 A 的笔记',
    description: 'A 项目的构建与部署命令', noteEntries: 2, noteUpdatedAt: '2026-11-17T10:00:00.000Z',
  })
  upsertSession(state, 'session-b', {
    cwd: 'C:\\B', file: '会话 B 的笔记.md', name: '会话 B 的笔记',
    description: 'B 项目的测试命令', noteEntries: 1, noteUpdatedAt: '2026-11-16T10:00:00.000Z',
  })
  // 0 条目的会话没有可读文件，不应出现在注入块里
  upsertSession(state, 'session-empty', { cwd: 'C:\\A', noteEntries: 0, noteUpdatedAt: '2026-11-17T11:00:00.000Z' })
  state.topics.topicA = { title: 'Topic A', page: 'wiki/a.md', status: 'promoted', updatedAt: '2026-11-17T09:00:00.000Z' }
  state.topics.topicB = { title: 'Candidate B', page: 'wiki/candidates/b.md', status: 'candidate', updatedAt: '2026-11-17T09:30:00.000Z' }
  await saveState(layout, state)

  const store = createIndexBlockStore({ layout, config })
  await store.refresh()
  const blockA = store.textFor('C:\\A')
  const blockB = store.textFor('C:\\B')
  const blockC = store.textFor('C:\\C')
  check('A 项目看到自己的笔记', blockA.includes('会话 A 的笔记.md') && !blockA.includes('会话 B 的笔记.md'))
  check('B 项目看到自己的笔记', blockB.includes('会话 B 的笔记.md') && !blockB.includes('会话 A 的笔记.md'))
  check('注入块是树形目录', blockA.includes('notes/') && blockA.includes('└─ 会话 A 的笔记.md — A 项目的构建与部署命令'))
  check('wiki 单独一棵树', blockA.includes('wiki/') && blockA.includes('└─ a.md — Topic A'))
  check('注入块不出现 session id', !blockA.includes('session-a') && !blockA.includes('session-'))
  check('0 条目会话不注入', !blockA.includes('session-empty'))
  check('只保留 promoted 主题', blockA.includes('Topic A') && !blockA.includes('Candidate B'))
  check('无笔记的项目只看到全局主题', blockC.includes('Topic A') && !blockC.includes('会话 A'))
  check('注入块以标题开头', blockA.startsWith('## Agent memory'))
  check('root 行给出记忆目录', blockA.includes(`root: ${layout.root}`))

  // 描述超长时截断到 40 字
  const longState = createDefaultState()
  upsertSession(longState, 'session-long', {
    cwd: 'C:\\A', file: '长描述.md', name: '长描述',
    description: '很长的描述'.repeat(20), noteEntries: 1, noteUpdatedAt: '2026-11-17T10:00:00.000Z',
  })
  const longBlock = renderIndexBlock({ state: longState, layout, config, cwd: 'C:\\A' })
  const longLine = longBlock.split('\n').find((item) => item.includes('长描述.md'))
  check('长描述被截断加省略号', longLine.includes('…') && longLine.length < 60)

  // ── 文件头回填索引：手写文件也能挂回会话并进注入块 ────────────────
  await mkdir(layout.notesDir, { recursive: true })
  await writeFile(layout.notePath('手写名字.md'), [
    '---', 'name: 手写名字', 'description: 手写描述', 'session: session-c2', '---', '',
    '- [V|p] 一条手写笔记内容 (s1)', '',
  ].join('\n'), 'utf8')
  upsertSession(state, 'session-c2', { cwd: 'C:\\A', noteEntries: 1 })
  await saveState(layout, state)
  const store2 = createIndexBlockStore({ layout, config })
  await store2.refresh()
  check('手写文件按 session 挂回注入块', store2.textFor('C:\\A').includes('手写名字.md — 手写描述'))
  const afterReconcile = await loadState(layout)
  check('回填写回索引 file/name', afterReconcile.state.sessions['session-c2']?.file === '手写名字.md'
    && afterReconcile.state.sessions['session-c2']?.name === '手写名字')

  // ── 截断：行数优先，其次字节 ─────────────────────────────────────
  const tight = renderIndexBlock({
    state, layout, config: { maxIndexLines: 5, maxIndexBytes: 4096 }, cwd: 'C:\\A',
  })
  check('行数截断生效', tight.split('\n').length <= 5 && tight.includes('truncated'))
  const byteTight = trimBlock(['## x', '- a'.repeat(40), '- b'.repeat(40), '- c'.repeat(40)], 60, 120)
  check('字节截断生效', Buffer.byteLength(byteTight, 'utf8') <= 120)

  // ── context 注册：文本函数按 AssembleContext.agent 取块 ────────────
  let registered = null
  const fakeCtx = {
    effect: (fn) => fn(),
    systemPrompt: { context: (definition) => { registered = definition; return () => {} } },
  }
  registerInjection(fakeCtx, { indexStore: store, config })
  check('context 已注册', registered?.name === 'agent-memory:index' && registered.order === 118)
  const textA = registered.text({ agent: { session: { header: { cwd: 'C:\\A' } } } })
  check('context 文本按 cwd 取值', textA === blockA)
  const textNoAgent = registered.text({})
  // 无 agent 时退回 "无 cwd" 那一份：只有全局主题，没有任何会话笔记
  check('无 agent 时只见全局主题', textNoAgent === store.textFor('') && textNoAgent.includes('Topic A') && !textNoAgent.includes('会话 A'))
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nSELFTEST M3 ${failed.length === 0 ? 'OK' : `FAILED (${failed.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
