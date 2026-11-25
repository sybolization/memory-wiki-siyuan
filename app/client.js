/**
 * 客户端半：目前只做一件事——把扩展自带、注册在侧栏 foot 的 RSI 面板藏起来。
 *
 * 背景：`项目 RSI` 面板不是本插件画的，而是 DSH Cline 扩展的 host-services
 * 客户端插件注册到 `sidebar.footer.action` 的单元格（组件根类名
 * `dshc-rsi-project`）。槽位是 list 类型，注册方无法被"移除"，只能让它的
 * 渲染结果不可见。这里注入一条全局样式把它隐藏，为后续把同一位置换成
 * memory 面板腾出空间（届时改为注册自己的 slot 单元格并渲染真实 UI）。
 *
 * 注意：这是对扩展内部类名的依赖，扩展升级改了类名就会失效；
 * 到时候需要按新 DOM 调整选择器。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-memory',
  factory() {
    const HIDE_RSI_CSS = '[data-slot="sidebar.footer.action"] .dshc-rsi-project{display:none !important}'
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-agent-memory', 'hide-rsi-panel')
          style.textContent = HIDE_RSI_CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'agent-memory.hide-rsi-panel')
      },
    }
  },
})
