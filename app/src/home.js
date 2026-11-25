/**
 * 路径解析：DSH 主目录与记忆目录。
 *
 * 为什么不用 `@deepseek-ai/dsh-home-paths`：本地 link 插件解析不到该包
 * （profile 的 node_modules 只链接本地包）。这里按同一套规则自己解析：
 * 优先 `DSH_HOME` 环境变量，退回 `~/.dsh`。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 解析 DSH 主目录。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量（测试时可注入）。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return resolve(fromEnv || join(homedir(), '.dsh'))
}

/**
 * 解析记忆根目录，并回带 DSH 主目录供诊断展示。
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {NodeJS.ProcessEnv} [env] - 环境变量（测试时可注入）。
 * @returns {{ dshHome: string, memoryDir: string }}
 */
export function resolveMemoryDir(config, env = process.env) {
  const dshHome = resolveDshHome(env)
  const override = typeof config.memoryDir === 'string' ? config.memoryDir.trim() : ''
  return {
    dshHome,
    // 默认 $DSH_HOME/memory：跨工作区共享、升级不丢、插件包目录之外
    memoryDir: override ? resolve(override) : join(dshHome, 'memory'),
  }
}
