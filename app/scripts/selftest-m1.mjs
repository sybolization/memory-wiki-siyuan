/**
 * M1 自检：在临时目录里跑一遍 paths + state，不碰真实记忆目录。
 *
 * 覆盖：目录创建、缺失索引的默认值、会话记录合并、水位线、
 * 原子写覆盖、runs 追加、损坏索引与版本不匹配的拒绝。
 *
 * 运行：node scripts/selftest-m1.mjs
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPaths, ensureMemoryDirs, writeJsonAtomic } from '../src/paths.js'
import { createDefaultState, loadState, saveState, upsertSession, dreamedThroughSeq, recordRun } from '../src/state.js'

const results = []
/** 断言并记录一行结果。 */
function check(label, ok) {
  results.push([label, Boolean(ok)])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

const dir = await mkdtemp(join(tmpdir(), 'agent-memory-m1-'))
try {
  const layout = memoryPaths(dir)
  await ensureMemoryDirs(layout)
  check('创建 notes 目录', existsSync(layout.notesDir))
  check('创建 wiki/candidates 目录', existsSync(layout.wikiCandidatesDir))

  const first = await loadState(layout)
  check('缺失索引返回默认值', first.existed === false && first.state.version === 1)

  const state = first.state
  upsertSession(state, 'session-a', { cwd: 'C:\\demo', dreamedThroughSeq: 41 })
  check('会话记录合并', state.sessions['session-a']?.cwd === 'C:\\demo')
  check('水位线读取', dreamedThroughSeq(state, 'session-a') === 41)
  check('未处理会话水位线为 -1', dreamedThroughSeq(state, 'session-b') === -1)

  await saveState(layout, state)
  const second = await loadState(layout)
  check('保存后能读回', second.existed && second.state.sessions['session-a']?.dreamedThroughSeq === 41)
  check('updatedAt 已写入', typeof second.state.updatedAt === 'string')

  await recordRun(layout, second.state, { id: 'run-1', status: 'ok' })
  const runLines = (await readFile(layout.runsPath, 'utf8')).trim().split('\n')
  check('runs.jsonl 追加一行', runLines.length === 1 && runLines[0].includes('run-1'))
  check('runs 同时进入索引', (await loadState(layout)).state.runs.length === 1)

  // 原子写覆盖：用默认索引盖掉带数据的索引，必须整体替换而不是合并
  await writeJsonAtomic(layout.indexPath, createDefaultState())
  const replaced = await loadState(layout)
  check('原子写覆盖旧内容', replaced.state.sessions['session-a'] === undefined)

  // 损坏 JSON 必须报错（不能静默当成空索引，否则会覆盖用户数据）
  await writeFile(layout.indexPath, '{ not json', 'utf8')
  let corruptRejected = false
  try {
    await loadState(layout)
  } catch {
    corruptRejected = true
  }
  check('损坏索引被拒绝', corruptRejected)

  // 版本不匹配必须报错（迁移由后续里程碑决定，不能猜）
  await writeFile(layout.indexPath, JSON.stringify({ version: 99 }), 'utf8')
  let versionRejected = false
  try {
    await loadState(layout)
  } catch {
    versionRejected = true
  }
  check('版本不匹配被拒绝', versionRejected)
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nSELFTEST M1 ${failed.length === 0 ? 'OK' : `FAILED (${failed.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
