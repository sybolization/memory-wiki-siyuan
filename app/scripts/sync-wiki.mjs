/**
 * 手动同步 wiki（不经过模型）：把笔记聚合成升格页/候选，并刷新中央索引 topics。
 *
 * 用法：node scripts/sync-wiki.mjs [memoryDir]
 *   省略 memoryDir 时按 $DSH_HOME/memory 解析；WIKI_MAX_RATIO 可覆盖体积比上限。
 */
import { resolveMemoryDir } from '../src/home.js'
import { normalizeConfig } from '../src/config.js'
import { memoryPaths } from '../src/paths.js'
import { loadState } from '../src/state.js'
import { formatWikiSummary, syncWiki } from '../src/wiki.js'

const memoryDir = process.argv[2] ?? null
const config = normalizeConfig({
  memoryDir,
  wikiMaxRatio: process.env.WIKI_MAX_RATIO ? Number(process.env.WIKI_MAX_RATIO) : 0.7,
})
const { memoryDir: resolved } = resolveMemoryDir(config, process.env)
const layout = memoryPaths(resolved)
const { state } = await loadState(layout)
const summary = await syncWiki({ layout, state, config })
console.log(formatWikiSummary({ ...summary, maxRatio: config.wikiMaxRatio }))
