/**
 * 上下文注入：把索引块作为一条 runtime-context 注册到提示注册表。
 *
 * 为什么不是 system prompt section：索引块只要写一条笔记就会变（条目数、日期、
 * 新会话的行、文件是否已生成），而 system prompt 在历史里是一段"可变的前缀"——
 * 在 opencode-go 这类不支持 mid-conversation system message 的路由上，DSH 会把
 * system 节点原地替换（surfaceOp: "replace"），前缀缓存从第一个 token 起全部失效。
 * runtime context 走的是 append-only 快照（surfaceOp: "append"）：变化只会多出
 * 一条快照消息，之前的 system prompt 与历史全部保持命中。
 *
 * order 118：工作目录(100)/沙箱策略(110)/审批策略(115) 之后、子代理委派(120) 之前，
 * 与原先 order 450 想表达的"模型在做决定前先看到记忆索引"一致，但不占 system prompt。
 */
export function registerInjection(ctx, deps) {
  const { indexStore, config } = deps

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'agent-memory:index',
    order: 118,
    // 笔记是用户数据，可能包含 {{...}} 字样；按字面量渲染，不做变量插值
    interpolate: false,
    // 同步查缓存：拿不到就返回空串，绝不阻塞或抛错；关掉插件时同样不注入
    text: (context) => (config.enabled === false
      ? ''
      : indexStore.textFor(context?.agent?.session?.header?.cwd ?? '')),
  }), 'agent-memory.context.index')
}
