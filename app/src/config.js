/**
 * 插件配置：默认值 + 归一化 + 校验。
 *
 * 注意：本插件以 `link:` 方式装进 profile，解析不到任何 `@deepseek-ai/*` 包，
 * 所以不能用 schemastery 声明 `Config` schema（那需要 import）。
 * 这里用纯 JavaScript 校验：Loader 把行里的 config 原样传进来，由我们兜底。
 */

/** 默认配置。字段少而稳定，后续里程碑只增不改语义。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关：后续里程碑用它决定是否注册记忆工具/注入/dreaming。 */
  enabled: true,
  /** 记忆根目录；null 表示 $DSH_HOME/memory。 */
  memoryDir: null,
  /** 注入索引的硬上限（行数与字节数，二者谁先到用谁）。 */
  maxIndexLines: 60,
  maxIndexBytes: 4096,
  /** 调试输出（只影响 Host 侧日志，不影响模型）。 */
  debug: false,
  /** M6：wiki 升格门槛——至少 N 个工作区或 M 个会话独立出现。 */
  wikiMinWorkspaces: 2,
  wikiMinSessions: 3,
  /** wiki 总字节 / 笔记总字节 的上限比；超标先弃候选，仍超标则本轮不升格。 */
  wikiMaxRatio: 0.7,
  /** 单次 dream 最多处理几个会话（控制单次成本）。 */
  dreamBatchSize: 5,
  /** 单个会话交给判断模型的摘录上限（字符数）。 */
  dreamMaxChars: 12000,
  /** 并发处理的会话数（每个会话各自一个判断子会话；1 = 串行）。 */
  dreamConcurrency: 1,
  /** 判断子会话用的 subagent provider；null 表示内置默认 `spawn`。 */
  dreamProvider: null,
  /** 判断子会话固定使用的模型；null 表示继承发起 dream 的会话。
   * 设置后 dream 在任何 session 触发都用同一个模型，结果不随调用者变化。 */
  dreamModel: null,
  /**
   * 允许参与 dream 的项目根路径（cwd 前缀匹配，Windows 大小写不敏感）。
   * 空数组 = 全量；默认排除久远/无关项目时在这里列白名单。
   */
  dreamProjects: [],
  /** `/dream all` 单次最多处理的会话数（防止一口气跑太多）。 */
  dreamAllMax: 100,
})

/**
 * 把行配置归一化成已知字段，并对未知字段保持宽容（向前兼容）。
 * @param {unknown} raw - Loader 传入的原始配置对象。
 * @returns {typeof DEFAULT_CONFIG & Record<string, unknown>} 归一化后的配置。
 * @throws {TypeError} 字段类型非法时抛错，让 Loader 在激活期就暴露问题。
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULT_CONFIG, ...input }

  if (typeof config.enabled !== 'boolean') {
    throw new TypeError('agent-memory: config.enabled 必须是布尔值')
  }
  if (config.memoryDir !== null && (typeof config.memoryDir !== 'string' || config.memoryDir.trim() === '')) {
    throw new TypeError('agent-memory: config.memoryDir 必须是非空字符串或 null')
  }
  for (const key of ['maxIndexLines', 'maxIndexBytes']) {
    const value = config[key]
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`agent-memory: config.${key} 必须是正整数`)
    }
  }
  if (typeof config.debug !== 'boolean') {
    throw new TypeError('agent-memory: config.debug 必须是布尔值')
  }
  for (const key of ['wikiMinWorkspaces', 'wikiMinSessions']) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      throw new TypeError(`agent-memory: config.${key} 必须是 1..20 的整数`)
    }
  }
  if (typeof config.wikiMaxRatio !== 'number' || !(config.wikiMaxRatio > 0) || config.wikiMaxRatio > 5) {
    throw new TypeError('agent-memory: config.wikiMaxRatio 必须是 (0, 5] 的数值')
  }
  if (!Number.isInteger(config.dreamBatchSize) || config.dreamBatchSize < 1 || config.dreamBatchSize > 50) {
    throw new TypeError('agent-memory: config.dreamBatchSize 必须是 1..50 的整数')
  }
  if (!Number.isInteger(config.dreamMaxChars) || config.dreamMaxChars < 2000 || config.dreamMaxChars > 60000) {
    throw new TypeError('agent-memory: config.dreamMaxChars 必须是 2000..60000 的整数')
  }
  if (!Number.isInteger(config.dreamConcurrency) || config.dreamConcurrency < 1 || config.dreamConcurrency > 4) {
    throw new TypeError('agent-memory: config.dreamConcurrency 必须是 1..4 的整数')
  }
  if (config.dreamProvider !== null && (typeof config.dreamProvider !== 'string' || config.dreamProvider.trim() === '')) {
    throw new TypeError('agent-memory: config.dreamProvider 必须是非空字符串或 null')
  }
  if (config.dreamModel !== null && (typeof config.dreamModel !== 'string' || config.dreamModel.trim() === '')) {
    throw new TypeError('agent-memory: config.dreamModel 必须是非空字符串或 null')
  }
  if (!Array.isArray(config.dreamProjects) || config.dreamProjects.some((prefix) => typeof prefix !== 'string' || prefix.trim() === '')) {
    throw new TypeError('agent-memory: config.dreamProjects 必须是非空字符串数组')
  }
  if (!Number.isInteger(config.dreamAllMax) || config.dreamAllMax < 1 || config.dreamAllMax > 500) {
    throw new TypeError('agent-memory: config.dreamAllMax 必须是 1..500 的整数')
  }
  return config
}
