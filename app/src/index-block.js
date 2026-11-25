/**
 * 注入块的渲染：把记忆目录压成一小段"树形路标"，塞进系统提示。
 *
 * 设计要点（DESIGN.md §3.4）：
 *  - 只给 root + 树形目录：`notes/` 下每个文件一行 `文件名 — 短描述`；
 *  - 文件名就是 name，session 只存在文件字段与索引里，不进注入层；
 *  - 描述截断到 40 字，一行一个文件，正文永不进上下文；
 *  - 按 cwd 过滤，别的项目只贡献全局主题；
 *  - 硬上限：行数与字节数谁先到用谁，超出即截断并标注。
 */
import { basename } from 'node:path'

/** 单行裁剪：超长加省略号，避免一条描述吃满注入预算。 */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text
}

/**
 * 截断到 maxLines 行与 maxBytes 字节之内。
 * @param {string[]} lines
 * @param {number} maxLines
 * @param {number} maxBytes
 * @returns {string}
 */
export function trimBlock(lines, maxLines, maxBytes) {
  const marker = '- … (truncated)'
  let kept = lines.slice(0, maxLines)
  if (kept.length < lines.length) kept = [...kept.slice(0, Math.max(1, maxLines - 1)), marker]
  let text = kept.join('\n')
  // 行数合格后再压字节：一次砍一行直到进入预算
  while (Buffer.byteLength(text, 'utf8') > maxBytes && kept.length > 2) {
    kept = [...kept.slice(0, kept.length - 2), marker]
    text = kept.join('\n')
  }
  return text
}

/** 树形缩进：最后一项用 └─，其余用 ├─。 */
function treeLines(items, render) {
  return items.map((item, index) => `${index === items.length - 1 ? '└─' : '├─'} ${render(item)}`)
}

/**
 * 为某一个 cwd 渲染注入块；空索引或无相关内容返回空串（不占上下文）。
 * @param {object} params
 * @param {object} params.state - 中央索引内容。
 * @param {object} params.layout - memoryPaths() 结果。
 * @param {{maxIndexLines: number, maxIndexBytes: number}} params.config
 * @param {string} [params.cwd] - 目标会话的工作目录。
 * @returns {string}
 */
export function renderIndexBlock({ state, layout, config, cwd }) {
  const topics = Object.values(state?.topics ?? {}).filter((topic) => topic?.status === 'promoted')
  // 只列有内容的笔记文件：0 条目的会话没有可读文件，列出来只是噪音
  const sessions = Object.entries(state?.sessions ?? {})
    .map(([id, session]) => ({ id, ...session }))
    .filter((session) => (session?.cwd ?? '') === (cwd ?? '')
      && (session?.noteEntries ?? 0) > 0
      && (session?.file || session?.name))
    .sort((left, right) => String(right?.noteUpdatedAt ?? '').localeCompare(String(left?.noteUpdatedAt ?? '')))
    .slice(0, 10)

  if (topics.length === 0 && sessions.length === 0) return ''

  const lines = ['## Agent memory', `root: ${layout.root}`]

  if (sessions.length > 0) {
    lines.push('notes/')
    lines.push(...treeLines(sessions, (session) => {
      const file = session.file ?? `${session.name}.md`
      return `${file} — ${clip(session.description, 40) || '（无描述，dream 会补写）'}`
    }))
  }

  if (topics.length > 0) {
    lines.push('wiki/')
    lines.push(...treeLines(topics.slice(0, 12), (topic) => {
      const file = basename(String(topic.page ?? '')) || '(untitled).md'
      return `${file} — ${clip(topic.title, 40)}`
    }))
  }

  return trimBlock(lines, config.maxIndexLines, config.maxIndexBytes)
}
