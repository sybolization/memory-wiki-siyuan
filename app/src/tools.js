/**
 * 模型侧工具面：诊断工具 + 记忆写入工具。
 *
 * 读取/搜索刻意不提供工具：索引与笔记都是普通文件，
 * 模型用内置 `read`/`grep` 即可（DESIGN.md 决策 14/15）。
 */
import { buildDoctorReport } from './doctor.js'
import { saveEntry } from './note-service.js'
import { buildScanPlan, formatScanReport } from './scan.js'
import { loadState } from './state.js'

/**
 * 注册本插件对模型暴露的所有工具。
 *
 * 工具集必须"常驻且稳定"：注册之后只随插件卸载而消失，绝不按 config 或运行状态
 * 在会话中途增删。DSH 在工具集变化时会开新的 request series 并重写 tools 数组，
 * 模型侧前缀缓存整段作废（实测单次 2k–290k token 重新计费）。所以 config.enabled
 * 控制的是"行为"（memory_note 拒绝写入、memory_status 只回报 disabled），
 * 不是"是否注册"。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{layout: object, config: object, paths: object}} deps
 */
export function registerTools(ctx, deps) {
  registerStatusTool(ctx, deps)
  registerNoteTool(ctx, deps)
}

/** 诊断工具：验证加载状态与服务/API 可用性（只读）。detail=scan 时给出候选队列。 */
function registerStatusTool(ctx, deps) {
  ctx.effect(() => ctx.tools.register({
    name: 'memory_status',
    description: 'Report agent-memory plugin status: loaded services, API probes, memory paths, index state, and visible sessions. Diagnostic only; it reads no memory and changes nothing. Pass detail="scan" to list the sessions a dream run would process.',
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['summary', 'scan'],
          description: 'summary (default) reports status; scan lists the candidate queue without calling a model.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { report: { type: 'string' } },
        required: ['report'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
    },
    execute: async (args, exec) => {
      if (deps.config.enabled === false) {
        return {
          report: 'agent-memory is disabled (config.enabled=false). Tools stay registered so the model-facing tool list never changes mid-session; set config.enabled to true in cordis.patch.yml to use them.',
        }
      }
      if (args?.detail === 'scan') {
        const { state } = await loadState(deps.layout)
        const plan = await buildScanPlan({ ctx: deps.ctx, state, dshHome: deps.paths.dshHome, signal: exec.signal })
        return { report: formatScanReport(plan) }
      }
      return { report: await buildDoctorReport({ ...deps, agent: exec.agent, signal: exec.signal }) }
    },
  }), 'agent-memory.tools.status')
}

/** 记忆写入工具：追加一行候选笔记（幂等、单行、自动盖来源标记）。 */
function registerNoteTool(ctx, deps) {
  const { layout, config } = deps
  ctx.effect(() => ctx.tools.register({
    name: 'memory_note',
    description: 'Append one memory note line to this session\'s note file. Optional: most turns need none. Add a line only when it would change a future session\'s behavior — a rule validated by experience, a trap, a failed path, or a decision a future session could not read from the repository. Write the note in Chinese; keep commands and code identifiers in their original form. When the note file is new, also pass `name` and `description` so the injected index shows what this file is about: the file is named `<name>.md`, and both fields are required by the file format and never left empty. If nothing is worth recording, do not call this tool; end the turn normally.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Single-line note content.' },
        confidence: {
          type: 'string',
          enum: ['V', 'I', 'U'],
          description: 'V = verified against the transcript, I = inferred (default), U = explicitly requested by the user.',
        },
        scope: {
          type: 'string',
          enum: ['p', 'g'],
          description: 'p = project-only (default), g = global candidate that dreaming may promote.',
        },
        name: {
          type: 'string',
          description: 'Readable name of this note file (at most 50 chars): what the session was doing. The file is named `<name>.md` (a `-2` suffix is added on collision). Pass it when the file is new; pass an improved one later and the file is renamed.',
        },
        description: {
          type: 'string',
          description: 'One sentence (at most 240 chars) describing what experiences this note file records. Pass it when the file is new; pass an improved one later if it no longer fits.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'duplicate', 'error'] },
          line: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['status', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.line ? `${value.message}\n${value.line}` : String(value?.message ?? ''),
      }],
    },
    execute: async (args, exec) => {
      if (!config.enabled) {
        return { status: 'error', message: 'agent-memory is disabled (config.enabled=false).' }
      }
      const session = exec.agent?.session
      if (!session) {
        return { status: 'error', message: 'No agent session in this call; memory notes need one.' }
      }
      const input = args && typeof args === 'object' ? args : {}
      const text = typeof input.text === 'string' ? input.text : ''
      if (text.trim() === '') return { status: 'error', message: 'text is required.' }
      const confidence = input.confidence === 'V' || input.confidence === 'U' ? input.confidence : 'I'
      const scope = input.scope === 'g' ? 'g' : 'p'
      const name = typeof input.name === 'string' ? input.name : undefined
      const description = typeof input.description === 'string' ? input.description : undefined
      try {
        const result = await saveEntry({ layout, session, text, confidence, scope, name, description })
        // 写成功后刷新注入块缓存，让下一次请求立刻看到新条目
        await deps.indexStore?.refresh?.()
        if (result.duplicate) {
          const head = result.metaChanged ? 'Metadata updated; the note itself was already recorded' : 'Already recorded; nothing written'
          return { status: 'duplicate', message: `${head} (${result.entryCount} entries in ${result.path}).` }
        }
        const warning = result.indexWarning ? `\nwarning: index update failed: ${result.indexWarning}` : ''
        return {
          status: 'ok',
          line: result.line,
          message: `Recorded (${result.entryCount} entries in ${result.path}).\nname: ${result.meta.name}\ndescription: ${result.meta.description}${warning}`,
        }
      } catch (error) {
        return { status: 'error', message: `Failed to record: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'agent-memory.tools.note')
}
