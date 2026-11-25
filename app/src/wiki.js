/**
 * M6 wiki：把够格的全局结论渲染成页面、维护索引与候选、守住体积闸门。
 *
 * 目录（DESIGN.md §2.2）：
 *   <root>/wiki/*.md             升格页（跨工作区可复用）
 *   <root>/wiki/index.md         页目录
 *   <root>/wiki/candidates/*.md  证据不够的候选（可再生，体积超标时先删）
 *
 * 写入规则：
 *  - 页面内容先过隐私 lint，命中即拒（不写坏数据）；
 *  - 体积比 = wiki 字节 / 笔记字节；超标时先放弃候选，仍超标则本轮不升格。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectNoteEntries, decideGroup, findConflicts, groupEntries, pickPrimary } from './evidence.js'
import { lintWikiPage } from './lint.js'
import { saveState } from './state.js'

/** 日期裁成 YYYY-MM-DD。 */
function dayOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 稳定文件名：可读前缀 + 内容哈希，避免中文/标点/长度问题。 */
function slugify(text, key) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 6)
  return `${base || 'topic'}-${hash}`
}

/** 渲染一个 wiki 页（frontmatter + 主结论 + 证据 + 冲突）。 */
export function renderPage({ group, status, conflictTexts = [], now = new Date() }) {
  const primary = pickPrimary(group)
  const evidence = group.entries.map((entry) => `${entry.sessionId}#${entry.stamp}`)
  const lines = [
    '---',
    // 标题用 JSON 字符串转义：内容里可能有冒号/反引号/引号，避免 frontmatter 被误解析
    `title: ${JSON.stringify(primary.text.slice(0, 80))}`,
    'scope: global',
    `status: ${status}`,
    `updated: ${dayOf(now)}`,
    `evidence: [${evidence.map((value) => JSON.stringify(value)).join(', ')}]`,
  ]
  if (conflictTexts.length > 0) {
    lines.push('conflict: true')
    lines.push(`conflicts: [${conflictTexts.map((value) => JSON.stringify(value.slice(0, 80))).join(', ')}]`)
  }
  lines.push('---', '', primary.text, '', '## 证据（不含路径，避免隐私外泄）', '')
  for (const entry of group.entries.slice(0, 20)) {
    lines.push(`- ${entry.sessionId} · [${entry.confidence}|${entry.scope}] · (${entry.stamp})`)
  }
  if (conflictTexts.length > 0) {
    lines.push('', '## ⚠ 冲突（待下一次 dream 用转录裁定）', '')
    for (const text of conflictTexts) lines.push(`- ${text}`)
  }
  return `${lines.join('\n')}\n`
}

/** 目录字节数（用于体积比闸门）。 */
async function dirBytes(dir) {
  let total = 0
  try {
    for (const name of await readdir(dir)) {
      try {
        total += (await stat(join(dir, name))).size
      } catch {
        // 单个文件读不到不影响统计
      }
    }
  } catch {
    // 目录不存在按 0 处理
  }
  return total
}

/** wiki 现状：页数、候选数、字节与体积比。 */
export async function readWikiStats(layout) {
  let pages = 0
  let candidates = 0
  try {
    pages = (await readdir(layout.wikiDir)).filter((name) => name.endsWith('.md') && name !== 'index.md').length
  } catch {
    // 尚未创建
  }
  try {
    candidates = (await readdir(layout.wikiCandidatesDir)).filter((name) => name.endsWith('.md')).length
  } catch {
    // 尚未创建
  }
  // 体积比只量升格页（与同步闸门口径一致）；候选是临时缓存，单独报数量
  let pageBytes = 0
  try {
    for (const name of await readdir(layout.wikiDir)) {
      if (!name.endsWith('.md') || name === 'index.md') continue
      try {
        pageBytes += (await stat(join(layout.wikiDir, name))).size
      } catch {
        // 单个文件读不到不影响统计
      }
    }
  } catch {
    // 尚未创建
  }
  const notesBytes = await dirBytes(layout.notesDir)
  return { pages, candidates, pageBytes, notesBytes, ratio: notesBytes > 0 ? pageBytes / notesBytes : 0 }
}

/** 渲染 wiki 目录页。 */
function renderIndex(items, now) {
  const lines = ['# Agent memory wiki', '', `updated: ${dayOf(now)}`, '']
  if (items.length === 0) {
    lines.push('（还没有够格的全局结论）')
  } else {
    for (const item of items.sort((left, right) => right.group.entries.length - left.group.entries.length)) {
      lines.push(`- ${item.group.text.slice(0, 80)} · evidence ${item.group.entries.length} → ${item.slug}.md`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 同步 wiki：聚合笔记 → 判定门槛 → 隐私 lint → 体积闸门 → 落盘 → 更新 state.topics。
 * @param {object} params
 * @returns {Promise<object>} 摘要（页数、候选、阻断原因、体积比）。
 */
export async function syncWiki({ layout, state, config, now = new Date() }) {
  await mkdir(layout.wikiDir, { recursive: true })
  await mkdir(layout.wikiCandidatesDir, { recursive: true })

  const groups = groupEntries(await collectNoteEntries(layout, state))
  const conflicts = findConflicts(groups)
  const promoted = []
  const candidates = []
  const blockedPages = []

  for (const group of groups.values()) {
    const decision = decideGroup(group, config)
    if (decision.status === 'skipped') continue
    const conflictTexts = [...(conflicts.get(group.key) ?? [])]
      .map((key) => groups.get(key)?.text)
      .filter(Boolean)
    const slug = slugify(group.text, group.key)
    const page = renderPage({ group, status: decision.status, conflictTexts, now })
    const lint = lintWikiPage(page)
    if (!lint.ok) {
      blockedPages.push({ key: group.key, reason: 'privacy', issues: lint.issues })
      continue
    }
    const item = { group, slug, page, decision }
    if (decision.status === 'promoted') promoted.push(item)
    else candidates.push(item)
  }

  // 体积闸门：只看升格页（候选是临时缓存、可再生，先写但限量）
  const notesBytes = await dirBytes(layout.notesDir)
  const promotedBytes = promoted.reduce((sum, item) => sum + Buffer.byteLength(item.page, 'utf8'), 0)
  const ratio = notesBytes > 0 ? promotedBytes / notesBytes : 0
  const promotionsBlocked = ratio > config.wikiMaxRatio
  if (promotionsBlocked) promoted.length = 0

  // 候选限量：按证据数量倒序，最多 40 个，避免早期候选把磁盘写爆
  const keptCandidates = candidates
    .sort((left, right) => right.group.entries.length - left.group.entries.length)
    .slice(0, 40)

  // 升格页：写新页、清孤儿页
  const desired = new Set()
  for (const item of promoted) {
    const file = join(layout.wikiDir, `${item.slug}.md`)
    await writeFile(file, item.page, 'utf8')
    desired.add(`${item.slug}.md`)
  }
  let existing = []
  try {
    existing = await readdir(layout.wikiDir)
  } catch {
    existing = []
  }
  for (const name of existing) {
    if (!name.endsWith('.md') || name === 'index.md') continue
    if (promotionsBlocked) break
    if (!desired.has(name)) await rm(join(layout.wikiDir, name), { force: true })
  }
  await writeFile(layout.wikiIndexPath, renderIndex(promoted, now), 'utf8')

  // 候选：每次整体重建（限量写入）
  await rm(layout.wikiCandidatesDir, { recursive: true, force: true })
  await mkdir(layout.wikiCandidatesDir, { recursive: true })
  for (const item of keptCandidates) {
    await writeFile(join(layout.wikiCandidatesDir, `${item.slug}.md`), item.page, 'utf8')
  }

  // 更新中央索引的 topics（注入层只读 status=promoted）
  const topics = {}
  for (const item of promoted) {
    topics[item.slug] = {
      title: pickPrimary(item.group).text.slice(0, 80),
      page: `wiki/${item.slug}.md`,
      status: 'promoted',
      updatedAt: now.toISOString(),
      evidence: item.group.entries.map((entry) => `${entry.sessionId}#${entry.stamp}`),
    }
  }
  for (const item of keptCandidates) {
    topics[item.slug] = {
      title: pickPrimary(item.group).text.slice(0, 80),
      page: `wiki/candidates/${item.slug}.md`,
      status: 'candidate',
      updatedAt: now.toISOString(),
      evidence: item.group.entries.map((entry) => `${entry.sessionId}#${entry.stamp}`),
    }
  }
  state.topics = topics
  await saveState(layout, state)

  return {
    promoted: promoted.length,
    candidates: keptCandidates.length,
    blockedPages: blockedPages.length,
    blocked: blockedPages.slice(0, 5).map((item) => item.reason),
    blockedIssues: blockedPages.slice(0, 3).flatMap((item) => item.issues.slice(0, 2)),
    ratio,
    promotionsBlocked,
  }
}

/** 渲染一次同步摘要（命令与 dream 收尾共用）。 */
export function formatWikiSummary(summary) {
  const lines = [
    'Agent memory · wiki',
    `pages: ${summary.promoted}, candidates: ${summary.candidates}`,
    `volume: wiki/notes = ${summary.ratio.toFixed(2)} (limit ${summary.maxRatio ?? '0.70'})`,
  ]
  if (summary.promotionsBlocked) lines.push('promotions blocked: volume ratio over limit; prune notes or wiki first')
  if (summary.blockedPages > 0) {
    lines.push(`pages refused by privacy lint: ${summary.blockedPages}`)
    for (const issue of summary.blockedIssues ?? []) lines.push(`- ${issue.rule}: ${issue.match}`)
  }
  return lines.join('\n')
}
