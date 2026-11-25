/**
 * dreaming 进度文件：让"后台在做什么、跑到哪一步"从外部可读。
 *
 * 由 runDream 在阶段切换、每个会话开始/结束时原子写入；
 * 只用于观察，不参与任何决策，写失败也绝不打断 dream。
 */
import { readFile } from 'node:fs/promises'
import { readJson, writeJsonAtomic } from './paths.js'

/**
 * 覆盖写进度文件。
 * @param {object} layout - memoryPaths() 结果。
 * @param {object} progress - 进度对象。
 */
export async function writeDreamProgress(layout, progress) {
  try {
    await writeJsonAtomic(layout.dreamProgressPath, progress)
  } catch {
    // 进度可见性不能反过来影响 dream 本身
  }
}

/**
 * 读进度文件；从未运行过时返回 undefined。
 * @param {object} layout
 */
export async function readDreamProgress(layout) {
  try {
    return await readJson(layout.dreamProgressPath)
  } catch {
    return undefined
  }
}

/**
 * 读 runs.jsonl 的最后一行，作为"上次运行"摘要；没有历史时返回 undefined。
 * @param {object} layout
 */
export async function readLastRun(layout) {
  try {
    const text = await readFile(layout.runsPath, 'utf8')
    const line = text.trim().split('\n').at(-1)
    if (!line) return undefined
    const run = JSON.parse(line)
    const aborted = run.aborted ? ' · aborted' : ''
    return `dream: idle · last run ${run.at ?? '?'} · attempted ${run.attempted ?? 0}/${run.batch ?? '?'} · notes ${run.notes ?? 0}${aborted}`
  } catch {
    return undefined
  }
}

/**
 * 渲染成一行，供 doctor / 命令使用。
 * @param {object|undefined} progress
 * @returns {string|null}
 */
export function formatDreamProgress(progress) {
  if (!progress) return null
  const current = (progress.current ?? []).map((id) => String(id).slice(0, 8)).join(',')
  const finished = `${progress.finished ?? 0}/${progress.batch ?? '?'}`
  const parts = [
    `dream: ${progress.stage ?? 'unknown'}`,
    `finished ${finished}`,
    `notes ${progress.notes ?? 0}`,
    `failed ${progress.failed ?? 0}`,
  ]
  if (current) parts.push(`current ${current}`)
  if (progress.metaCandidates != null) parts.push(`meta ${progress.metaFixed ?? 0}/${progress.metaCandidates}`)
  if (progress.updatedAt) parts.push(`updated ${progress.updatedAt}`)
  if (progress.error) parts.push(`error ${progress.error}`)
  return parts.join(' · ')
}
