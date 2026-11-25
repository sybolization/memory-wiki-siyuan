/**
 * M6 证据模型：把散落在各会话笔记里的同一结论聚合起来，判断是否够格升格为全局 wiki 页。
 *
 * 门槛（DESIGN.md §2.2）：同一结论在 ≥2 个工作区 或 ≥3 个 session 独立出现；
 * 只有 `[g]`（全局候选）参与统计，`[p]` 永不升格。
 *
 * 冲突（DESIGN.md §3.5）：字面高度相似但极性相反（"必须" vs "不要"）时互相标记，
 * 页面保留双方证据并标 `conflict`，裁决交给下一次 dream 用转录裁定。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dedupeKey, parseNote } from './notes.js'

/** 置信度优先级：用户明确要求 > 已核实 > 推断。 */
const AUTHORITY = { U: 3, V: 2, I: 1 }

/** 否定/肯定极性关键词（中英双语，够用即可）。 */
const NEGATIVE = /(?:不要|不能|不可|禁止|必须不|不应该|别|never|must not|don't)/i
const POSITIVE = /(?:必须|一定要|应该|需要|记得|always|must\b)/i

/**
 * 读取记忆目录里的全部笔记条目。
 * @param {object} layout - memoryPaths() 结果。
 * @param {object} state - 中央索引（用来补 cwd）。
 */
export async function collectNoteEntries(layout, state) {
  let names = []
  try {
    names = await readdir(layout.notesDir)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    let content = ''
    try {
      content = await readFile(join(layout.notesDir, name), 'utf8')
    } catch {
      continue
    }
    const parsed = parseNote(content)
    // 会话归属在文件头；旧文件没有 session 字段时退回文件名（迁移前的命名）
    const sessionId = parsed.meta?.session ?? name.slice(0, -3)
    for (const entry of parsed.entries) {
      entries.push({
        sessionId,
        cwd: state?.sessions?.[sessionId]?.cwd ?? null,
        confidence: entry.confidence,
        scope: entry.scope,
        stamp: entry.stamp,
        text: entry.text,
        key: dedupeKey(entry.text),
      })
    }
  }
  return entries
}

/** 工作区身份：cwd 归一化（大小写/分隔符统一）；无 cwd 归为 `(no-cwd)`。 */
function workspaceOf(cwd) {
  const value = String(cwd ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return value === '' ? '(no-cwd)' : value
}

/** 按查重键聚合成"同一结论"的组。 */
export function groupEntries(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const group = groups.get(entry.key) ?? { key: entry.key, text: entry.text, entries: [] }
    group.entries.push(entry)
    // 展示文本取第一条；裁决用 pickPrimary()
    groups.set(entry.key, group)
  }
  return groups
}

/**
 * 判定一组证据是否够格升格。
 * @returns {{status: 'promoted'|'candidate'|'skipped', workspaces?: number, sessions?: number, reason?: string}}
 */
export function decideGroup(group, config) {
  const globals = group.entries.filter((entry) => entry.scope === 'g')
  if (globals.length === 0) return { status: 'skipped', reason: 'no-global-candidate' }
  const workspaces = new Set(globals.map((entry) => workspaceOf(entry.cwd)))
  const sessions = new Set(globals.map((entry) => entry.sessionId))
  if (workspaces.size >= config.wikiMinWorkspaces || sessions.size >= config.wikiMinSessions) {
    return { status: 'promoted', workspaces: workspaces.size, sessions: sessions.size }
  }
  return { status: 'candidate', workspaces: workspaces.size, sessions: sessions.size }
}

/** 来源标记的新旧：`s<seq>` 比 seq，日期标记比日期字符串。 */
function stampWeight(stamp) {
  const value = String(stamp ?? '')
  if (value.startsWith('s')) return Number(value.slice(1)) || 0
  return Date.parse(value.slice(2)) || 0
}

/**
 * 裁决主条目：`[U]` > `[V]` > `[I]`；同级取来源最新的。
 * @param {{entries: object[]}} group
 */
export function pickPrimary(group) {
  return [...group.entries].sort((left, right) => (
    (AUTHORITY[right.confidence] ?? 0) - (AUTHORITY[left.confidence] ?? 0)
    || stampWeight(right.stamp) - stampWeight(left.stamp)
  ))[0]
}

/** 归一化成字符二元组集合（去空格/标点），用于相似度。 */
function bigrams(text) {
  const value = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const grams = new Set()
  for (let index = 0; index < value.length - 1; index += 1) grams.add(value.slice(index, index + 2))
  return grams
}

/** Jaccard 相似度。 */
function similarity(left, right) {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** 文本极性：否定优先，其次肯定，都没有则中性。 */
function polarity(text) {
  if (NEGATIVE.test(text)) return 'neg'
  if (POSITIVE.test(text)) return 'pos'
  return 'none'
}

/**
 * 找出互相冲突的组：字面高度相似（≥0.5）且极性相反（pos ↔ neg）。
 * @returns {Map<string, Set<string>>} key → 其它冲突 key
 */
export function findConflicts(groups) {
  const list = [...groups.values()]
  const conflicts = new Map()
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const left = list[i]
      const right = list[j]
      const posLeft = polarity(left.text)
      const posRight = polarity(right.text)
      if (posLeft === 'none' || posRight === 'none' || posLeft === posRight) continue
      if (similarity(left.text, right.text) < 0.5) continue
      if (!conflicts.has(left.key)) conflicts.set(left.key, new Set())
      if (!conflicts.has(right.key)) conflicts.set(right.key, new Set())
      conflicts.get(left.key).add(right.key)
      conflicts.get(right.key).add(left.key)
    }
  }
  return conflicts
}
