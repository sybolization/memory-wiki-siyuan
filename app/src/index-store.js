/**
 * 注入块的缓存 + 笔记元数据回填。
 *
 * 系统提示的 context 文本函数是**同步**的，而索引读取是异步的，
 * 所以这里维护一份按 cwd 分片的缓存：写路径（笔记/dream）触发 refresh，
 * 文本函数只做同步查表。拿不到缓存时返回空串——宁可不注入，也不阻塞请求。
 *
 * 回填：注入行只读索引里的 file/name/description。文件是权威，所以 refresh 时
 * 按 mtime 增量读一遍备注文件头，把索引里缺的/过期的字段同步过来；目录里没被
 * 索引认领的文件（手写、导入、改名）按 frontmatter 的 session 字段挂回去。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadState, saveState } from './state.js'
import { parseNote } from './notes.js'
import { renderIndexBlock } from './index-block.js'

/**
 * @param {{layout: object, config: object}} deps
 * @returns {{refresh: () => Promise<Error | null>, textFor: (cwd?: string) => string, stats: () => object}}
 */
export function createIndexBlockStore({ layout, config }) {
  /** key = cwd（'' 表示无 cwd），value = 渲染好的块。 */
  const cache = new Map()
  /** 文件名 → 上次读到的 mtimeMs：文件没变就不重读、不重写索引。 */
  const seenMtime = new Map()
  let lastRefreshAt = null
  let lastError = null

  /**
   * 把笔记文件 frontmatter 同步进索引（文件为准）。
   * @param {object} state - 已加载的索引（原地修改）。
   * @returns {Promise<boolean>} 是否发生了改动。
   */
  async function reconcileMeta(state) {
    let changed = false

    // 1) 索引里已登记文件的：按 mtime 增量读文件头，覆盖索引里的旧值
    for (const [sessionId, info] of Object.entries(state.sessions ?? {})) {
      const file = info?.file
      if (typeof file !== 'string' || file === '') continue
      let mtime
      try {
        mtime = (await stat(join(layout.notesDir, file))).mtimeMs
      } catch {
        continue
      }
      if (seenMtime.get(file) === mtime) continue
      let content
      try {
        content = await readFile(join(layout.notesDir, file), 'utf8')
      } catch {
        continue
      }
      seenMtime.set(file, mtime)
      const meta = parseNote(content).meta
      if (!meta?.name || !meta?.description) continue
      const next = {
        ...info,
        file,
        name: meta.name,
        description: meta.description,
        session: meta.session || sessionId,
      }
      if (JSON.stringify(next) !== JSON.stringify(info)) {
        state.sessions[sessionId] = next
        changed = true
      }
    }

    // 2) 目录里存在但索引没认领的文件：按 frontmatter 的 session 挂回索引
    let names = []
    try {
      names = await readdir(layout.notesDir)
    } catch {
      return changed
    }
    const claimed = new Set(Object.values(state.sessions ?? {}).map((info) => info?.file).filter(Boolean))
    for (const name of names) {
      if (!name.endsWith('.md') || claimed.has(name)) continue
      let content
      try {
        content = await readFile(join(layout.notesDir, name), 'utf8')
      } catch {
        continue
      }
      const parsed = parseNote(content)
      const sessionId = parsed.meta?.session
      if (!sessionId || !parsed.meta?.name || !parsed.meta?.description) continue
      const info = state.sessions[sessionId] ?? {}
      state.sessions[sessionId] = {
        ...info,
        file: name,
        name: parsed.meta.name,
        description: parsed.meta.description,
        session: sessionId,
        noteEntries: Math.max(info.noteEntries ?? 0, parsed.entries.length),
      }
      changed = true
    }

    return changed
  }

  /** 重新读一次索引，为每个已知 cwd 生成一份块。失败不抛出，记录后返回。 */
  async function refresh() {
    try {
      const { state, existed } = await loadState(layout)
      cache.clear()
      if (existed) {
        if (await reconcileMeta(state)) await saveState(layout, state)
        const cwds = new Set([''])
        for (const info of Object.values(state.sessions ?? {})) {
          cwds.add(typeof info?.cwd === 'string' ? info.cwd : '')
        }
        for (const cwd of cwds) {
          cache.set(cwd, renderIndexBlock({ state, layout, config, cwd }))
        }
      }
      lastError = null
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    } finally {
      lastRefreshAt = new Date().toISOString()
    }
    return lastError
  }

  /** 同步取某个 cwd 的块；未收录时退回空串。 */
  function textFor(cwd) {
    const key = typeof cwd === 'string' ? cwd : ''
    return cache.get(key) ?? cache.get('') ?? ''
  }

  /** 诊断用统计（不暴露缓存内容）。 */
  function stats() {
    return {
      scopes: cache.size,
      lastRefreshAt,
      lastError: lastError ? lastError.message : null,
    }
  }

  return { refresh, textFor, stats }
}
