/**
 * @local/dsh-agent-memory —— 插件入口（薄）。
 *
 * Cordis 只认这个模块导出的 `name` / `inject` / `apply`；
 * 真正的实现在 src/ 下按职责分文件，入口不写业务逻辑，方便阅读与替换。
 */
export { name, inject, apply } from './src/plugin.js'
