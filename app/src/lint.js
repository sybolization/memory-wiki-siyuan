/**
 * M6 lint：两类检查，都不阻断主流程，但全局页隐私命中即拒。
 *
 *  1. 笔记行格式：`write`/`edit` 之后提醒（warn-only），不拦截。
 *  2. 全局页隐私扫描：绝对路径 / 用户名 / UNC / 邮箱 / 凭据形态，写入 wiki 前拒绝。
 *
 * 正则刻意保守：宁可多报，也不把机器相关的信息带进全局 wiki。
 */
import { NOTE_LINE_RE } from './notes.js'

/** 隐私规则：命中任意一条，内容不得进入全局页。 */
export const PRIVACY_RULES = [
  { name: 'absolute-windows-path', pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:\\[^\s"'`|]+/g },
  { name: 'unc-path', pattern: /\\\\[A-Za-z0-9._-]+\\[^\s"'`|]*/g },
  { name: 'user-home', pattern: /\bUsers[\\/][A-Za-z0-9._-]+/gi },
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'credential', pattern: /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*\S+/gi },
  // 只抓连续 32+ 的 base64/hex 串；UUID 带连字符，不会误伤 session id
  { name: 'long-secret', pattern: /\b[A-Za-z0-9+/]{32,}={0,2}/g },
]

/**
 * 扫描一段文本里的隐私形态。
 * @param {string} text
 * @returns {{rule: string, match: string}[]}
 */
export function scanPrivacy(text) {
  const source = String(text ?? '')
  const issues = []
  for (const rule of PRIVACY_RULES) {
    rule.pattern.lastIndex = 0
    for (const match of source.matchAll(rule.pattern)) {
      issues.push({ rule: rule.name, match: match[0].trim().slice(0, 80) })
    }
  }
  return issues
}

/**
 * 校验单行笔记；空行视为通过。返回原因供命令展示。
 * @param {string} line
 * @returns {{ok: boolean, reason?: string}}
 */
export function lintNoteLine(line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed === '') return { ok: true }
  if (NOTE_LINE_RE.test(trimmed)) return { ok: true }
  return { ok: false, reason: '笔记行不符合格式：- [V|p] 内容 (s812)' }
}

/**
 * 全局页隐私检查：正文、frontmatter 一视同仁。
 * @param {string} text
 * @returns {{ok: boolean, issues: {rule: string, match: string}[]}}
 */
export function lintWikiPage(text) {
  const issues = scanPrivacy(text)
  return { ok: issues.length === 0, issues }
}

/**
 * 渲染隐私问题列表（最多 5 条，避免撑爆命令输出）。
 * @param {{rule: string, match: string}[]} issues
 */
export function formatPrivacyIssues(issues) {
  return issues
    .slice(0, 5)
    .map((issue) => `- ${issue.rule}: ${issue.match}`)
    .join('\n')
}
