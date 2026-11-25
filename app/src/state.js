/**
 * 中央索引 index.json 的形态、加载、保存与常用写入辅助。
 *
 * 为什么是自管 JSON 而不是 ctx.storageDomain：
 * 本地 link 插件解析不到 @deepseek-ai/*（含 Zod schema 依赖），
 * 所以这里用 node:fs + 原子写实现同样的事（见 DESIGN.md §2.3）。
 */
import { readJson, writeJsonAtomic, appendLine } from './paths.js'

/** 索引结构版本；字段语义变化时 +1，旧文件会被明确拒绝而不是静默读错。 */
export const STATE_VERSION = 1
/** runs 只保留最近 N 条，避免索引无限生长（完整审计仍在 runs.jsonl）。 */
const MAX_RUNS = 100

/** 首次运行的空索引。 */
export function createDefaultState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    sessions: {},
    topics: {},
    teamMembers: [],
    runs: [],
  }
}

/** 版本不匹配时抛出，便于上层决定"备份后重建"还是"停手"。 */
export class StateVersionError extends Error {}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 把磁盘上的原始 JSON 收敛成已知结构：未知字段丢弃、缺字段补默认。
 * @param {unknown} raw
 * @returns {ReturnType<typeof createDefaultState>}
 */
export function normalizeState(raw) {
  if (!isObject(raw)) throw new StateVersionError('index.json 不是对象')
  if (raw.version !== STATE_VERSION) {
    throw new StateVersionError(`index.json 版本 ${String(raw.version)} 与当前 ${STATE_VERSION} 不匹配`)
  }
  return {
    version: STATE_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    sessions: isObject(raw.sessions) ? raw.sessions : {},
    topics: isObject(raw.topics) ? raw.topics : {},
    teamMembers: Array.isArray(raw.teamMembers)
      ? raw.teamMembers.filter((value) => typeof value === 'string')
      : [],
    runs: Array.isArray(raw.runs) ? raw.runs.slice(-MAX_RUNS) : [],
  }
}

/**
 * 读取索引；文件不存在时返回空索引并标记 existed=false。
 * @param {ReturnType<import('./paths.js').memoryPaths>} paths
 * @returns {Promise<{ state: ReturnType<typeof createDefaultState>, existed: boolean }>}
 */
export async function loadState(paths) {
  const raw = await readJson(paths.indexPath)
  if (raw === undefined) return { state: createDefaultState(), existed: false }
  return { state: normalizeState(raw), existed: true }
}

/**
 * 保存索引（自动更新 updatedAt，原子写）。
 * @param {ReturnType<import('./paths.js').memoryPaths>} paths
 * @param {ReturnType<typeof createDefaultState>} state
 */
export async function saveState(paths, state) {
  state.updatedAt = new Date().toISOString()
  await writeJsonAtomic(paths.indexPath, state)
}

/**
 * 合并更新一条会话记录；只覆盖 patch 里给出的字段。
 * @returns {object} 更新后的会话记录。
 */
export function upsertSession(state, sessionId, patch) {
  const next = { ...(state.sessions[sessionId] ?? {}), ...patch, sessionId }
  state.sessions[sessionId] = next
  return next
}

/**
 * 读取水位线；未处理过返回 -1（任何真实 seq 都大于它）。
 */
export function dreamedThroughSeq(state, sessionId) {
  const value = state.sessions[sessionId]?.dreamedThroughSeq
  return Number.isInteger(value) ? value : -1
}

/**
 * 记录一次 dreaming 运行：索引内保留最近 100 条，完整记录追加到 runs.jsonl。
 * @param {ReturnType<import('./paths.js').memoryPaths>} paths
 * @param {ReturnType<typeof createDefaultState>} state
 * @param {object} run
 */
export async function recordRun(paths, state, run) {
  state.runs.push(run)
  if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS)
  await appendLine(paths.runsPath, JSON.stringify(run))
  await saveState(paths, state)
}
