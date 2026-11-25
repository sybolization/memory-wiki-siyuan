/**
 * M6 自检：wiki 证据门槛、页面渲染、隐私 lint、体积闸门、目录页与 topics。
 *
 * 全程临时目录，不依赖 DSH 运行时。
 * 运行：node scripts/selftest-m6.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPaths } from '../src/paths.js'
import { createDefaultState, upsertSession } from '../src/state.js'
import { lintNoteLine, scanPrivacy } from '../src/lint.js'
import { collectNoteEntries, decideGroup, findConflicts, groupEntries } from '../src/evidence.js'
import { renderPage, readWikiStats, syncWiki, formatWikiSummary } from '../src/wiki.js'
import { renderIndexBlock } from '../src/index-block.js'

const results = []
/** 断言并记录一行结果。 */
function check(label, ok) {
  results.push([label, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

const dir = await mkdtemp(join(tmpdir(), 'agent-memory-m6-'))
try {
  const layout = memoryPaths(join(dir, 'memory'))
  const config = { wikiMinWorkspaces: 2, wikiMinSessions: 3, wikiMaxRatio: 0.7 }
  await mkdir(layout.notesDir, { recursive: true })

  // ── 行格式与隐私 lint ────────────────────────────────────────────
  check('合法笔记行通过', lintNoteLine('- [V|p] 一条经验 (s12)').ok === true)
  check('非法笔记行被标记', lintNoteLine('只是普通文本').ok === false)
  check('绝对路径命中隐私', scanPrivacy('文件在 C:\\Users\\bob\\secret.txt 里').length > 0)
  check('凭据形态命中隐私', scanPrivacy('api_key = sk-abc123456').some((issue) => issue.rule === 'credential'))
  check('UUID 不误报', scanPrivacy('session 684b3de6-142b-4c25-a0a5-30b245bf7eb0').length === 0)

  // ── 证据门槛 ──────────────────────────────────────────────────────
  const state = createDefaultState()
  const notes = {
    'session-a': ['- [V|g] 部署前先备份数据库 (s1)'],
    'session-b': ['- [I|g] 部署前先备份数据库 (s2)'],
    'session-e': ['- [V|g] 部署前先备份数据库 (s5)'],
    'session-c': ['- [V|g] 只在一个会话出现的结论 (s3)'],
    'session-d': ['- [V|p] 项目内结论不进全局页 (s4)'],
    'session-f': ['- [V|g] 迁移前必须关闭旧进程 (s6)'],
    'session-g': ['- [V|g] 迁移前不要关闭旧进程 (s7)'],
    'session-h': ['- [V|g] 迁移前必须关闭旧进程 (s8)'],
  }
  const cwds = {
    'session-a': 'C:\\work\\alpha',
    'session-b': 'C:\\work\\beta',
    'session-e': 'C:\\work\\alpha',
    'session-c': 'C:\\work\\alpha',
    'session-d': 'C:\\work\\alpha',
    'session-f': 'C:\\work\\alpha',
    'session-g': 'C:\\work\\beta',
    'session-h': 'C:\\work\\gamma',
  }
  for (const [sessionId, lines] of Object.entries(notes)) {
    upsertSession(state, sessionId, { cwd: cwds[sessionId], file: `${sessionId}.md`, noteEntries: lines.length })
    await writeFile(layout.notePath(`${sessionId}.md`), `${lines.join('\n')}\n`, 'utf8')
  }
  // 填充笔记体积，避免体积比一开始就超限
  const padding = Array.from({ length: 60 }, (_, index) => `- [I|p] 填充用的项目笔记第 ${index} 条，内容足够长以压低体积比 (s${index})`)
  await writeFile(layout.notePath('session-pad.md'), `${padding.join('\n')}\n`, 'utf8')

  const groups = groupEntries(await collectNoteEntries(layout, state))
  const mainGroup = groups.get('部署前先备份数据库')
  check('同一结论跨会话聚合', mainGroup?.entries.length === 3)
  check('两工作区即达门槛', decideGroup(mainGroup, config).status === 'promoted')
  check('单会话结论只进候选', decideGroup(groups.get('只在一个会话出现的结论'), config).status === 'candidate')
  check('p 条目永不升格', decideGroup(groups.get('项目内结论不进全局页'), config).status === 'skipped')

  const conflicts = findConflicts(groups)
  check('极性相反被标记冲突', conflicts.has('迁移前必须关闭旧进程') && conflicts.has('迁移前不要关闭旧进程'))
  const conflictPage = renderPage({
    group: groups.get('迁移前必须关闭旧进程'),
    status: 'promoted',
    conflictTexts: ['迁移前不要关闭旧进程'],
  })
  check('冲突写进页面', conflictPage.includes('conflict: true') && conflictPage.includes('⚠ 冲突'))

  // ── 同步：升格页 / 候选 / 索引 / 隐私拒绝 ─────────────────────────
  await writeFile(layout.notePath('session-i.md'), '- [V|g] 密码在 C:\\Users\\bob\\secret.txt 里 (s9)\n', 'utf8')
  upsertSession(state, 'session-i', { cwd: 'C:\\work\\delta', file: 'session-i.md' })
  await writeFile(layout.notePath('session-j.md'), '- [V|g] 密码在 C:\\Users\\bob\\secret.txt 里 (s10)\n', 'utf8')
  upsertSession(state, 'session-j', { cwd: 'C:\\work\\epsilon', file: 'session-j.md' })

  const summary = await syncWiki({ layout, state, config })
  check('够格结论写出升格页', summary.promoted >= 2)
  const pageFile = await readFile(join(layout.wikiDir, `${Object.keys(state.topics).find((slug) => state.topics[slug].status === 'promoted')}.md`), 'utf8')
  check('页面含 frontmatter 与证据', pageFile.startsWith('---') && pageFile.includes('evidence: ['))
  check('候选页写进 candidates', summary.candidates >= 1)
  check('隐私内容被拒绝', summary.blockedPages >= 1)
  check('体积比在限内', summary.ratio <= config.wikiMaxRatio)

  // ── 目录页 / topics / 注入块 ─────────────────────────────────────
  const wikiIndex = await readFile(layout.wikiIndexPath, 'utf8')
  check('目录页生成', wikiIndex.includes('# Agent memory wiki') && wikiIndex.includes('部署前先备份数据库'))
  check('topics 更新为 promoted', Object.values(state.topics).some((topic) => topic.status === 'promoted'))
  const block = renderIndexBlock({ state, layout, config, cwd: 'C:\\work\\alpha' })
  check('注入块只列 promoted 主题', block.includes('wiki/') && block.includes('部署前先备份数据库')
    && !block.includes('只在一个会话出现的结论'))
  check('注入块树形列出笔记文件', block.includes('notes/') && block.includes('session-a.md — '))

  // ── 体积闸门：wiki 页超过笔记体积比例时阻断升格 ──────────────────
  const tightDir = await mkdtemp(join(tmpdir(), 'agent-memory-m6t-'))
  try {
    const tightLayout = memoryPaths(join(tightDir, 'memory'))
    const tightState = createDefaultState()
    await mkdir(tightLayout.notesDir, { recursive: true })
    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      upsertSession(tightState, sessionId, { cwd: 'C:\\work\\alpha', file: `${sessionId}.md`, noteEntries: 1 })
      await writeFile(tightLayout.notePath(`${sessionId}.md`), '- [V|g] 部署前先备份数据库 (s1)\n', 'utf8')
    }
    const tightSummary = await syncWiki({ layout: tightLayout, state: tightState, config: { ...config, wikiMaxRatio: 0.0001 } })
    check('超限阻断升格', tightSummary.promotionsBlocked === true && tightSummary.promoted === 0)
  } finally {
    await rm(tightDir, { recursive: true, force: true })
  }

  // ── 统计与摘要 ───────────────────────────────────────────────────
  const stats = await readWikiStats(layout)
  check('统计可读', stats.pages >= 2 && stats.candidates >= 1 && stats.ratio > 0)
  check('摘要可读', formatWikiSummary({ ...summary, maxRatio: config.wikiMaxRatio }).includes('pages:'))
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nSELFTEST M6 ${failed.length === 0 ? 'OK' : `FAILED (${failed.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
