/**
 * 笔记文件：命名、frontmatter、解析、查重与写入。
 *
 * 文件形态（DESIGN.md §2.1）：
 *   ---
 *   name: DSH 提示装配上下文排查
 *   description: 记录 runtime context 在 assembly.contexts 而非 sections
 *   session: session-151fc59a-1e60-427c-bbe1-da05e2e93db8
 *   ---
 *
 *   - [V|p] 内容 (s812)
 *
 * 文件名 = name（`<name>.md`，重名自动 `-2`/`-3`）：模型在注入块里看到的就是文件名。
 * session 只是文件里的一个字段，用来把笔记对应回会话与索引；不参与命名。
 * name / description / session 三者都强制非空——本模块没有"留空"的分支。
 */
import { access, appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 行格式：置信度 V/I/U、作用域 p/g、来源标记 s<seq> | u <date> | d <date>。 */
export const NOTE_LINE_RE = /^- \[(?<confidence>V|I|U)\|(?<scope>p|g)\] (?<text>.+) \((?<stamp>s\d+|u \d{4}-\d{2}-\d{2}|d \d{4}-\d{2}-\d{2})\)$/

/** 允许的置信度与作用域取值。 */
export const CONFIDENCE_VALUES = ['V', 'I', 'U']
export const SCOPE_VALUES = ['p', 'g']

/** name（同时是文件名主干）与 description 的长度上限。 */
export const NAME_MAX = 50
export const DESCRIPTION_MAX = 240

/** 文件头 frontmatter：只认开头那一块 `---` … `---`（允许 BOM）。 */
const FRONTMATTER_RE = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/

/** Windows 保留文件名：直接当文件名会失败。 */
const RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 把任意文本压成单行：换行/连续空白折叠为一个空格。 */
export function singleLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 来源标记：会话事件序号。 */
export function seqStamp(seq) {
  return `s${Math.max(0, Math.trunc(seq))}`
}

/** 来源标记：本地日期（kind = 'u' 用户手写 / 'd' dream 合成）。 */
export function dateStamp(kind, date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${kind} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 元数据某个字段是否可用（存在且压成单行后非空）。 */
export function metaValue(value) {
  return singleLine(value)
}

/** name / description / session 是否都已填。 */
export function metaComplete(meta) {
  return Boolean(metaValue(meta?.name) && metaValue(meta?.description) && metaValue(meta?.session))
}

/**
 * 生成一行合法笔记。内容是权威，格式错误直接抛错（由调用方转成用户可读提示）。
 * @param {{text: string, confidence?: 'V'|'I'|'U', scope?: 'p'|'g', stamp: string}} entry
 * @returns {string}
 */
export function formatEntry({ text, confidence = 'I', scope = 'p', stamp }) {
  if (!CONFIDENCE_VALUES.includes(confidence)) throw new Error(`未知置信度：${confidence}`)
  if (!SCOPE_VALUES.includes(scope)) throw new Error(`未知作用域：${scope}`)
  const body = singleLine(text)
  if (!body) throw new Error('笔记内容为空')
  const line = `- [${confidence}|${scope}] ${body} (${stamp})`
  if (!NOTE_LINE_RE.test(line)) throw new Error(`笔记行格式不合法：${line}`)
  return line
}

/**
 * 把 name 收敛成安全的文件名主干：去 Windows 非法字符、去首尾点与空白、限长。
 * 中文原样保留；同名冲突由 uniqueFileName 处理。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  let text = singleLine(name)
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (text === '') text = 'untitled'
  if (RESERVED_STEM.test(text)) text = `${text}-note`
  return text.slice(0, NAME_MAX).replace(/[.\s]+$/g, '')
}

/** name → 文件名。 */
export function fileNameFor(name) {
  return `${sanitizeName(name)}.md`
}

/** 文件是否存在（只用于命名冲突探测）。 */
async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 为一篇笔记挑一个不冲突的文件名：`<name>.md` 已存在时依次试 `<name>-2.md`…
 * @param {object} layout - memoryPaths() 结果。
 * @param {string} name - 期望的 name。
 * @param {string|null} [exceptFile] - 自己当前的文件名（改名时不跟自己冲突）。
 * @returns {Promise<string>}
 */
export async function uniqueFileName(layout, name, exceptFile = null) {
  const stem = sanitizeName(name)
  let candidate = `${stem}.md`
  let index = 2
  while (candidate !== exceptFile && await fileExists(join(layout.notesDir, candidate))) {
    candidate = `${stem}-${index}.md`
    index += 1
  }
  return candidate
}

/** frontmatter 值编码：只在 YAML 会被误解时才加双引号。 */
function encodeMetaValue(value) {
  const text = singleLine(value)
  return /[:#"'[\]{},&*?|>%@`]|^[-\s]|\s$/.test(text) ? JSON.stringify(text) : text
}

/** frontmatter 值解码：双引号按 JSON 还原，单引号去壳，其余原样。 */
function decodeMetaValue(raw) {
  const text = String(raw ?? '').trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    try {
      return String(JSON.parse(text))
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) return text.slice(1, -1)
  return text
}

/**
 * 渲染 frontmatter 块（含其后的空行分隔）。
 * @param {{name: string, description: string, session: string}} meta
 * @returns {string}
 */
export function formatMetaBlock(meta) {
  return [
    '---',
    `name: ${encodeMetaValue(meta.name)}`,
    `description: ${encodeMetaValue(meta.description)}`,
    `session: ${encodeMetaValue(meta.session)}`,
    '---',
    '',
    '',
  ].join('\n')
}

/**
 * 解析 frontmatter；返回 { name?, description?, session?, hasMeta }。
 * 兼容旧文件（没有 frontmatter）：hasMeta=false。
 * @param {string} content
 */
export function parseMeta(content) {
  const match = FRONTMATTER_RE.exec(String(content ?? ''))
  if (!match) return { name: undefined, description: undefined, session: undefined, hasMeta: false }
  const meta = {}
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim().toLowerCase()
    if (key !== 'name' && key !== 'description' && key !== 'session') continue
    meta[key] = singleLine(decodeMetaValue(line.slice(at + 1)))
  }
  return { ...meta, hasMeta: true }
}

/**
 * 用 meta 替换（或补上）文件头，正文原样保留。
 * @param {string} content
 * @param {{name: string, description: string, session: string}} meta
 * @returns {string}
 */
export function replaceMetaBlock(content, meta) {
  const text = String(content ?? '')
  const match = FRONTMATTER_RE.exec(text)
  if (match) return `${formatMetaBlock(meta)}${text.slice(match[0].length)}`
  return text.trim() === '' ? formatMetaBlock(meta) : `${formatMetaBlock(meta)}${text}`
}

/** 会话短 id：`session-f6f52e60-…` → `f6f52e60`。 */
function shortSessionId(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8) || 'unknown'
}

/**
 * 兜底派生：调用方与文件都没给时，用会话 id + 这条笔记内容凑出非空值。
 * 质量一般，但保证"永远有 name/description/session"；dream 会在此基础上改写。
 */
export function deriveMeta(sessionId, text) {
  const id = shortSessionId(sessionId)
  const body = singleLine(text)
  return {
    name: `会话 ${id} 的笔记`,
    description: body.slice(0, DESCRIPTION_MAX) || `会话 ${id} 的记忆笔记`,
    session: String(sessionId ?? '').trim() || `session-${id}`,
  }
}

/**
 * 收敛出最终 meta：provided > existing > 派生，三段保证三个字段都非空。
 * @param {{existing?: object, provided?: object, sessionId: string, text?: string}} params
 * @returns {{name: string, description: string, session: string}}
 */
export function normalizeMeta({ existing, provided, sessionId, text }) {
  const name = metaValue(provided?.name) || metaValue(existing?.name)
  const description = metaValue(provided?.description) || metaValue(existing?.description)
  const session = metaValue(existing?.session) || metaValue(provided?.session) || metaValue(sessionId)
  const derived = name && description && session ? null : deriveMeta(sessionId, text ?? description ?? name)
  return {
    name: (name || derived.name).slice(0, NAME_MAX),
    description: (description || derived.description).slice(0, DESCRIPTION_MAX),
    session: session || derived.session,
  }
}

/**
 * 解析整份笔记：返回元数据、合法条目与不合法行（不合法只报告，不阻断后续追加）。
 * @param {string} content
 */
export function parseNote(content) {
  const text = String(content ?? '')
  const match = FRONTMATTER_RE.exec(text)
  const body = match ? text.slice(match[0].length) : text
  const meta = match ? parseMeta(text) : { name: undefined, description: undefined, session: undefined, hasMeta: false }
  // 报错行号用文件绝对行号：frontmatter 占几行就整体后移几行
  const lineOffset = match ? (match[0].match(/\n/g)?.length ?? 0) : 0
  const entries = []
  const invalid = []
  body.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd()
    if (line === '') return
    const found = NOTE_LINE_RE.exec(line)
    if (!found?.groups) {
      invalid.push({ lineNumber: lineOffset + index + 1, line })
      return
    }
    entries.push({ line, ...found.groups })
  })
  return { meta, hasMeta: meta.hasMeta, entries, invalid }
}

/** 查重键：忽略来源标记，按小写、空白折叠后的文本比较。 */
export function dedupeKey(text) {
  return singleLine(text).toLowerCase()
}

/**
 * 从索引里取某个会话的笔记目标（sessionId + 文件名）；文件尚未创建时 file 为 null。
 * 兼容迁移前的命名：索引里没有 file 时，若 `<sessionId>.md` 存在就沿用它。
 * @param {object} layout - memoryPaths() 结果。
 * @param {object} state - 中央索引。
 * @param {string} sessionId
 * @returns {Promise<{sessionId: string, file: string|null}>}
 */
export async function noteTarget(layout, state, sessionId) {
  const info = state?.sessions?.[sessionId] ?? {}
  if (typeof info.file === 'string' && info.file !== '') return { sessionId, file: info.file }
  const legacy = `${sessionId}.md`
  if (await fileExists(join(layout.notesDir, legacy))) return { sessionId, file: legacy }
  return { sessionId, file: null }
}

/**
 * 读取笔记文件；不存在时视为空。
 * @param {object} layout - memoryPaths() 结果。
 * @param {string|null} file - 文件名（含 .md）。
 */
export async function readNote(layout, file) {
  if (!file) return ''
  try {
    return await readFile(join(layout.notesDir, file), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * 把内容写到目标文件；若文件名因改名而变化，先写新文件再删旧文件。
 * @returns {Promise<string>} 最终文件名。
 */
async function commitFile(layout, fromFile, toFile, content) {
  await mkdir(layout.notesDir, { recursive: true })
  await writeFile(join(layout.notesDir, toFile), content, 'utf8')
  if (fromFile && fromFile !== toFile) await unlink(join(layout.notesDir, fromFile)).catch(() => {})
  return toFile
}

/**
 * 直接改写文件头（不动正文）；name 变了就同时重命名文件。
 * dream 改写 name/description 的唯一入口。
 * @param {object} layout
 * @param {{sessionId: string, file: string|null}} target
 * @param {{name: string, description: string, session: string}} meta
 * @returns {Promise<{meta: object, file: string, changed: boolean}>}
 */
export async function writeNoteMeta(layout, target, meta) {
  const content = await readNote(layout, target.file)
  const parsed = parseNote(content)
  const final = normalizeMeta({ existing: parsed.meta, provided: meta, sessionId: target.sessionId })
  const next = replaceMetaBlock(content, final)
  const toFile = await uniqueFileName(layout, final.name, target.file)
  const changed = next !== content || toFile !== target.file
  if (changed) await commitFile(layout, target.file, toFile, next)
  return { meta: final, file: toFile, changed }
}

/**
 * 追加一条笔记（幂等：同内容已存在时返回 duplicate，不写文件）。
 *
 * meta 只在这里维护：没给就用文件里的；文件也没有就派生。name 变了会顺手重命名文件，
 * 所以任何写入路径都不会产出缺少 name/description/session 的笔记文件。
 * @param {object} layout - memoryPaths() 结果。
 * @param {{sessionId: string, file: string|null}} target
 * @param {{text: string, confidence?: 'V'|'I'|'U', scope?: 'p'|'g', stamp: string, meta?: {name?: string, description?: string}}} entry
 * @returns {Promise<{duplicate: boolean, line?: string, entries: object[], invalid: object[], meta: object, file: string, metaChanged: boolean}>}
 */
export async function appendEntry(layout, target, entry) {
  const content = await readNote(layout, target.file)
  const parsed = parseNote(content)
  const meta = normalizeMeta({
    existing: parsed.meta,
    provided: entry.meta,
    sessionId: target.sessionId,
    text: entry.text,
  })
  const metaChanged = !metaComplete(parsed.meta)
    || metaValue(parsed.meta.name) !== meta.name
    || metaValue(parsed.meta.description) !== meta.description
    || metaValue(parsed.meta.session) !== meta.session
  // 先修文件头，正文由 replaceMetaBlock 原样保留（含暂时不合法的手写行）
  const base = metaChanged ? replaceMetaBlock(content, meta) : content
  // name 变了 → 文件名跟着变（重名自动加后缀）
  const file = await uniqueFileName(layout, meta.name, target.file)

  const key = dedupeKey(entry.text)
  const duplicate = parsed.entries.some((existing) => dedupeKey(existing.text) === key)
  if (duplicate) {
    if (metaChanged || file !== target.file) await commitFile(layout, target.file, file, base)
    return { duplicate: true, entries: parsed.entries, invalid: parsed.invalid, meta, file, metaChanged }
  }

  const line = formatEntry(entry)
  // 文件末尾可能没有换行（外部编辑过），追加前补齐，保证每条独占一行
  const needsNewline = base !== '' && !base.endsWith('\n')
  const addition = `${needsNewline ? '\n' : ''}${line}\n`
  await commitFile(layout, target.file, file, `${base}${addition}`)

  return {
    duplicate: false,
    line,
    entries: [...parsed.entries, { ...parseNote(line).entries[0] }],
    invalid: parsed.invalid,
    meta,
    file,
    metaChanged,
  }
}
