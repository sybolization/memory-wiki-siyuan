/**
 * 插件装配层：只做"读配置 → 算路径 → 接上各能力"。
 *
 * 目录结构：
 *   tools.js        模型侧工具（memory_status / memory_note）
 *   commands.js     人类命令（/memory、/remember）
 *   inject.js       系统提示注入（索引块 section）
 *   index-block.js  注入块渲染与截断
 *   index-store.js  按 cwd 的注入块缓存（同步查表）
 *   notes.js        笔记行格式与文件追加
 *   note-service.js "写一行 + 更新索引"的唯一入口
 *   state.js        index.json 的加载/保存/水位线
 *   paths.js        目录布局与原子写
 *   doctor.js       诊断报告
 *
 * 后续里程碑只在这里加装配行，不把业务逻辑堆进入口。
 */
import { normalizeConfig } from './config.js'
import { resolveMemoryDir } from './home.js'
import { memoryPaths } from './paths.js'
import { registerTools } from './tools.js'
import { registerCommands } from './commands.js'
import { registerInjection } from './inject.js'
import { createIndexBlockStore } from './index-store.js'

/** Cordis 诊断名（Loader 报错时显示）。 */
export const name = 'agent-memory'

/**
 * 必需服务：缺失就让 Loader 在激活期报错，而不是静默降级。
 * systemPrompt 供索引注入；subagents 供 M5 dreaming 起判断子会话。
 */
export const inject = ['systemPrompt', 'tools', 'commands', 'sessionQuery', 'subagents', 'agents']

/**
 * Cordis 入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} rawConfig - 行配置（cordis.patch.yml 里的 config）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const paths = resolveMemoryDir(config)
  const layout = memoryPaths(paths.memoryDir)
  // 注入块缓存：写路径与启动时刷新，系统提示的文本函数只做同步查表
  const indexStore = createIndexBlockStore({ layout, config })
  const deps = { ctx, config, paths, layout, indexStore }

  registerTools(ctx, deps)
  registerCommands(ctx, deps)
  registerInjection(ctx, deps)

  // 预热一次：失败只会让注入块为空，不影响插件其余能力
  void indexStore.refresh()

  // M4/M5：扫描、水位线与 dreaming；M6：wiki 与 lint。
}
