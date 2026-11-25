/**
 * M2 自检：笔记命名、frontmatter、解析、查重、追加，以及"写一行 + 更新索引"的服务层。
 *
 * 全程在临时目录运行，不碰真实记忆目录，也不依赖 DSH 运行时。
 * 运行：node scripts/selftest-m2.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPaths } from '../src/paths.js'
import {
  NOTE_LINE_RE, fileNameFor, formatEntry, formatMetaBlock, metaComplete, normalizeMeta, parseNote,
  sanitizeName, singleLine, seqStamp, dateStamp, appendEntry, uniqueFileName,
} from '../src/notes.js'
import { saveEntry } from '../src/note-service.js'
import { loadState } from '../src/state.js'

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

const dir = await mkdtemp(join(tmpdir(), 'agent-memory-m2-'))
try {
  const layout = memoryPaths(dir)
  const session = { id: 'session-demo', seq: 813, header: { cwd: 'C:\\demo' } }

  // ── 行格式 ────────────────────────────────────────────────────────
  const line = formatEntry({ text: '测试命令是 pnpm test', confidence: 'V', scope: 'p', stamp: seqStamp(812) })
  check('生成合法行', NOTE_LINE_RE.test(line))
  check('行尾来源序号正确', line.endsWith('(s812)'))
  check('来源序号下限为 0', seqStamp(-3) === 's0')
  check('本地日期标记', dateStamp('u', new Date(2026, 10, 17)) === 'u 2026-11-17')
  check('多行内容被压成单行', singleLine('  a\n\n b  ') === 'a b')
  check('拒绝空内容', throws(() => formatEntry({ text: '   ', stamp: seqStamp(1) })))
  check('拒绝未知置信度', throws(() => formatEntry({ text: 'x', confidence: 'Z', stamp: seqStamp(1) })))

  // ── 文件名 = name ─────────────────────────────────────────────────
  check('中文名直接作文件名', fileNameFor('DSH 提示装配排查') === 'DSH 提示装配排查.md')
  check('非法字符被替换', sanitizeName('a/b:c*d?e"f<g>h|i') === 'a-b-c-d-e-f-g-h-i')
  check('首尾点与空白被去掉', sanitizeName('  ..名字..  ') === '名字')
  check('空名退回 untitled', sanitizeName('   ') === 'untitled')
  check('Windows 保留名被改写', sanitizeName('con') === 'con-note')
  check('超长名被截断', sanitizeName('长'.repeat(80)).length === 50)

  // ── 解析与文件头 ──────────────────────────────────────────────────
  const parsed = parseNote(`${line}\n- 这是不合法的一行\n- [I|g] 另一条 (d 2026-11-17)\n`)
  check('解析出两条合法条目', parsed.entries.length === 2)
  check('不合法行被单独报告', parsed.invalid.length === 1 && parsed.invalid[0].lineNumber === 2)
  check('解析出置信度与作用域', parsed.entries[0].confidence === 'V' && parsed.entries[1].scope === 'g')

  const metaBlock = formatMetaBlock({
    name: '会话 demo 的笔记', description: '记录测试命令与构建顺序', session: 'session-demo',
  })
  check('frontmatter 块以 --- 开头结尾', metaBlock.startsWith('---\n') && metaBlock.includes('\n---\n'))
  check('frontmatter 带 session 字段', metaBlock.includes('session: session-demo'))
  const withMeta = parseNote(`${metaBlock}${line}\n`)
  check('解析出 name/description/session', withMeta.meta.name === '会话 demo 的笔记'
    && withMeta.meta.description === '记录测试命令与构建顺序'
    && withMeta.meta.session === 'session-demo')
  check('frontmatter 不算笔记条目', withMeta.entries.length === 1 && withMeta.invalid.length === 0)
  check('旧文件识别为缺元数据', parseNote(`${line}\n`).hasMeta === false)
  check('缺字段被派生补齐', metaComplete(normalizeMeta({ sessionId: 'session-demo', text: '一条够长的笔记内容' })))
  check('空串不覆盖已有值', normalizeMeta({
    existing: { name: '旧名字', description: '旧描述', session: 'session-demo' },
    provided: { name: '', description: '' },
    sessionId: 'session-demo',
  }).name === '旧名字')
  check('provided 优先于 existing', normalizeMeta({
    existing: { name: '旧名字', description: '旧描述', session: 'session-demo' },
    provided: { name: '新名字' },
    sessionId: 'session-demo',
  }).description === '旧描述')

  // ── 追加、查重、改名 ──────────────────────────────────────────────
  const first = await appendEntry(layout, { sessionId: session.id, file: null }, {
    text: '测试命令是 pnpm test', confidence: 'V', scope: 'p', stamp: seqStamp(812),
    meta: { name: '会话 demo 的笔记', description: '记录测试命令与构建顺序' },
  })
  check('首次追加按 name 命名文件', first.file === '会话 demo 的笔记.md')
  check('首次写入即带非空元数据', metaComplete(first.meta) && first.meta.session === session.id)
  const again = await appendEntry(layout, { sessionId: session.id, file: first.file }, {
    text: '  测试命令是   pnpm test ', confidence: 'I', scope: 'p', stamp: seqStamp(900),
  })
  check('重复内容被忽略（大小写/空白归一）', again.duplicate === true && again.file === first.file)
  const third = await appendEntry(layout, { sessionId: session.id, file: first.file }, {
    text: '提交前跑 pnpm build', confidence: 'U', scope: 'p', stamp: seqStamp(900),
  })
  check('不同内容继续追加', third.duplicate === false && third.entries.length === 2)
  const fileText = await readFile(layout.notePath(first.file), 'utf8')
  const fileParsed = parseNote(fileText)
  check('文件里每条一行', fileParsed.entries.length === 2 && fileParsed.meta.session === session.id)

  // 改名：name 变化 → 文件名跟着变，正文保留
  const renamed = await appendEntry(layout, { sessionId: session.id, file: first.file }, {
    text: '改名后追加的一条笔记内容', confidence: 'I', scope: 'p', stamp: seqStamp(901),
    meta: { name: '改名后的笔记' },
  })
  check('name 变化触发文件改名', renamed.file === '改名后的笔记.md')
  const renamedText = await readFile(layout.notePath(renamed.file), 'utf8')
  check('改名保留原有条目', parseNote(renamedText).entries.length === 3)
  check('旧文件已删除', await readFile(layout.notePath(first.file), 'utf8').then(() => false, () => true))

  // 重名：同名文件已存在时加 -2
  const dupName = await uniqueFileName(layout, '改名后的笔记')
  check('重名自动加后缀', dupName === '改名后的笔记-2.md')

  // ── 服务层：写一行 + 更新索引 ─────────────────────────────────────
  const saved = await saveEntry({
    layout, session, text: '端口 54788 是 Web GUI', confidence: 'I', scope: 'p',
    name: '会话 demo 的笔记', description: '记录端口与测试命令',
  })
  check('服务层写入并使用当前会话 seq', saved.duplicate === false && saved.line.endsWith('(s812)'))
  check('服务层返回条目数', saved.entryCount === 1)
  check('服务层采用传入的 name/description', saved.meta.name === '会话 demo 的笔记' && saved.meta.description === '记录端口与测试命令')
  check('服务层文件按 name 命名', saved.file === '会话 demo 的笔记.md')
  const loaded = await loadState(layout)
  const indexed = loaded.state.sessions[session.id]
  check('索引被创建', loaded.existed === true)
  check('索引记录 noteEntries', indexed?.noteEntries === 1)
  check('索引记录 cwd', indexed?.cwd === 'C:\\demo')
  check('索引记录 file/name/description/session', indexed?.file === saved.file
    && indexed?.name === '会话 demo 的笔记' && indexed?.description === '记录端口与测试命令'
    && indexed?.session === session.id)
  const dup = await saveEntry({ layout, session, text: '端口 54788 是 Web GUI', confidence: 'I', scope: 'p' })
  check('服务层查重不重复计数', dup.duplicate === true && dup.entryCount === 1 && dup.file === saved.file)
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nSELFTEST M2 ${failed.length === 0 ? 'OK' : `FAILED (${failed.length})`}`)
process.exit(failed.length === 0 ? 0 : 1)
