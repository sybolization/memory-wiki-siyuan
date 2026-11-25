/**
 * 会话摘录：把 `[startSeq, endSeq]` 区间内的事件压成给判断模型看的文本。
 *
 * 只保留"人说了什么、模型说了什么、调了什么工具、结果/失败是什么"，
 * 跳过 turn/step/system/request 等结构性事件。每行以事件序号开头，
 * 方便判断模型与后续人工回溯。
 */

/** 单条文本的截断长度。 */
const MAX_TEXT = 600
const MAX_ARGS = 200
const MAX_RESULT = 400

/** 从 ContentBlock[] 里只取 text 块（丢弃 reasoning/图片等）。 */
export function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 压成单行并截断。 */
function clip(text, limit = MAX_TEXT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * 把一条事件描述成一行；不参与记忆的事件返回 null。
 * @param {{type: string, seq: number, data: any}} event
 * @returns {string | null}
 */
export function describeEvent(event) {
  const { type, seq, data } = event ?? {}
  switch (type) {
    case 'user/message': {
      const text = clip(blockText(data?.content))
      if (text === '') return null
      const isHuman = data?.source?.kind === 'human'
      return `${seq} [${isHuman ? '用户' : '注入'}] ${text}`
    }
    case 'assistant/message': {
      const text = clip(blockText(data?.message?.content))
      return text === '' ? null : `${seq} [助手] ${text}`
    }
    case 'tool/call': {
      return `${seq} [调用] ${data?.name ?? '?'}(${clip(data?.arguments, MAX_ARGS)})`
    }
    case 'tool/result': {
      const text = clip(blockText(data?.message?.content), MAX_RESULT)
      if (text === '') return null
      const failed = data?.message?.isError === true || data?.error != null
      return `${seq} [${failed ? '失败' : '结果'}] ${text}`
    }
    default:
      return null
  }
}

/**
 * 构建摘录。超长时保留头 40% 与尾 60%（开头是任务，结尾是结论与纠正）。
 * @param {{events: object[], startSeq: number, endSeq: number, maxChars?: number}} params
 * @returns {{text: string, lines: number, considered: number, truncated: boolean}}
 */
export function buildDigest({ events, startSeq, endSeq, maxChars = 12000 }) {
  const lines = []
  let considered = 0
  for (const event of events ?? []) {
    if (typeof event?.seq !== 'number' || event.seq < startSeq || event.seq > endSeq) continue
    considered += 1
    const line = describeEvent(event)
    if (line) lines.push(line)
  }
  let text = lines.join('\n')
  let truncated = false
  if (text.length > maxChars) {
    truncated = true
    const head = Math.floor(maxChars * 0.4)
    const tail = maxChars - head
    text = `${text.slice(0, head)}\n…(中间省略)…\n${text.slice(-tail)}`
  }
  return { text, lines: lines.length, considered, truncated }
}
