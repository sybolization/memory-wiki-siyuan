/**
 * 写入服务：把"一条候选笔记"变成"文件里的一行 + 索引里的一次更新"。
 *
 * 工具 `memory_note` 与命令 `/remember` 共用这里，保证两条入口行为一致。
 * 文件名 = name（重名由 notes.js 加后缀）；索引里存 file/name/description/session，
 * 注入块只读索引，不再回读文件。
 * 失败语义：笔记文件是权威，索引是派生——索引写失败只回带警告，不回滚笔记。
 */
import { appendEntry, noteTarget, seqStamp } from './notes.js'
import { loadState, saveState, upsertSession } from './state.js'

/**
 * 追加一条笔记并更新索引。
 * @param {object} params
 * @param {object} params.layout - memoryPaths() 结果。
 * @param {{id: string, seq: number, header?: {cwd?: string}}} params.session - 当前会话。
 * @param {string} params.text - 笔记内容。
 * @param {'V'|'I'|'U'} [params.confidence] - 置信度，默认 I（推断）。
 * @param {'p'|'g'} [params.scope] - 作用域，默认 p（项目内）。
 * @param {string} [params.name] - 笔记文件名（可选，缺省时沿用/派生）。
 * @param {string} [params.description] - 笔记描述（可选，缺省时沿用/派生）。
 * @returns {Promise<{duplicate: boolean, line?: string, entryCount: number, file: string, path: string, meta: object, metaChanged: boolean, indexWarning?: string}>}
 */
export async function saveEntry({ layout, session, text, confidence = 'I', scope = 'p', name, description }) {
  const sessionId = session.id
  // 来源序号取"调用时刻最后一条已提交事件"：session.seq 是下一条事件的编号
  const seq = seqStamp(Math.max(0, Number(session.seq ?? 1) - 1))

  // 先读索引找到这个会话已有的文件（没有就交给 appendEntry 新建）
  let state
  let indexWarning
  try {
    state = (await loadState(layout)).state
  } catch (error) {
    indexWarning = error instanceof Error ? error.message : String(error)
  }
  const target = state ? await noteTarget(layout, state, sessionId) : { sessionId, file: null }

  const result = await appendEntry(layout, target, {
    text,
    confidence,
    scope,
    stamp: seq,
    meta: { name, description, session: sessionId },
  })

  if (state) {
    try {
      upsertSession(state, sessionId, {
        cwd: session.header?.cwd ?? null,
        noteEntries: result.entries.length,
        noteUpdatedAt: new Date().toISOString(),
        latestSeq: Math.max(0, Number(session.seq ?? 1) - 1),
        // 注入块直接读这些字段，不再回读文件
        file: result.file,
        name: result.meta.name,
        description: result.meta.description,
        session: sessionId,
      })
      await saveState(layout, state)
    } catch (error) {
      // 索引坏了不该丢掉刚写下的笔记：明确告诉调用方，下次 dream 会重建索引
      indexWarning = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    duplicate: result.duplicate,
    line: result.line,
    entryCount: result.entries.length,
    file: result.file,
    path: layout.notePath(result.file),
    meta: result.meta,
    metaChanged: result.metaChanged,
    indexWarning,
  }
}
