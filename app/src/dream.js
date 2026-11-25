/**
 * M5 dreaming：Host 编排 + 子会话判断，所有写入都在 Host 侧完成。
 *
 * 流程：扫描候选 → 逐会话生成摘录 → 起一个判断子会话（只返回 JSON）→
 * 校验/查重 → 写回该会话的笔记文件（来源标记 `(d <date>)`）→ 推进水位线 → 记 runs。
 * 失败语义：判断失败不推进水位线，下次会重试；成功但 0 条也算成功（推进）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildDigest } from './digest.js'
import {
  appendEntry, dateStamp, dedupeKey, normalizeMeta, noteTarget, parseNote, readNote, singleLine, writeNoteMeta,
} from './notes.js'
import { writeDreamProgress } from './progress.js'
import { buildScanPlan } from './scan.js'
import { recordRun, saveState, upsertSession } from './state.js'

/** 判断子会话的输出契约（对象根、无嵌套 oneOf，符合 subagent outputSchema 子集）。 */
export const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    // 文件身份：每次 dream 都要复核，允许改写，但不许留空
    name: { type: 'string' },
    description: { type: 'string' },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          confidence: { type: 'string', enum: ['V', 'I', 'U'] },
          scope: { type: 'string', enum: ['p', 'g'] },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'description', 'notes'],
  additionalProperties: false,
}

/** 只补文件元数据时的输出契约（旧笔记补写用，不产生新笔记）。 */
export const META_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['name', 'description'],
  additionalProperties: false,
}

/** 一次 dream 最多补写多少个旧文件的元数据（每次一个短判断，成本很低）。 */
const META_BACKFILL_MAX = 30

/** 模块级单飞标记：同一 Host 进程内只允许一次 dream。 */
let inFlight = false

/** 是否有 dream 正在运行。 */
export function isDreamRunning() {
  return inFlight
}

/**
 * 判断提示词：把摘录、已有记忆、输出契约放在一起。
 * @param {{digest: object, cwd?: string|null, existingLines: string[], existingMeta?: object}} params
 * @returns {string}
 */
export function buildJudgePrompt({ digest, cwd, existingLines, existingMeta }) {
  const existing = existingLines.length > 0 ? existingLines.join('\n') : '(none)'
  const meta = existingMeta ?? {}
  return [
    '你是 Agent 会话的记忆提取器。下面是一场会话的摘录，每行以事件序号开头。',
    '',
    '任务：只提取"未来的会话无法从仓库、代码或文档里重新得出的经验"，输出 JSON。',
    '输出格式（只输出 JSON，不要任何解释）：',
    '{"name":"…","description":"…","notes":[{"text":"一句话，中文，≤120 字","confidence":"V|I|U","scope":"p|g"}]}',
    '',
    '关于 name/description（这份笔记文件的身份，注入块只展示这两项）：',
    '- name：≤40 字，说明这段会话在做什么；',
    '- description：一句话（≤160 字），概括这份笔记记录了什么经验；',
    '- 已有值仍然准确就沿用，不再准确就改写；**两者都不许为空**，没把握也要给出可用的概括。',
    '',
    '判断标准：',
    '- 保留：验证过的工作方式或命令、踩过的坑、失败后修正的路径、非显然的决策与理由、用户明确纠正过的偏好。',
    '- 丢弃：任务过程叙述、代码内容、显而易见的事实、只对本次有效的临时状态。',
    '- 没有值得记的就返回空的 notes 数组；宁缺毋滥，禁止为了留痕制造空话。',
    '- 每条一行，不含换行，不含绝对路径、用户名或凭据。',
    '- 全部用中文书写；命令、文件名、代码标识符保留原样。',
    '- confidence：V=摘录里有直接证据；I=合理推断；U=用户明确要求记住。',
    '- scope：p=只对这个项目有用；g=跨项目通用。',
    '',
    `会话工作目录：${cwd ?? '(unknown)'}`,
    `现有 name：${meta.name || '(空，必须补上)'}`,
    `现有 description：${meta.description || '(空，必须补上)'}`,
    `摘录${digest.truncated ? '（已截断，保留头尾）' : ''}，共 ${digest.lines} 行：`,
    digest.text,
    '',
    '这个会话已有的记忆（不要重复）：',
    existing,
  ].join('\n')
}

/**
 * 旧文件补元数据的提示词：只读这份文件已有的笔记，不重读转录。
 * @param {{sessionId: string, cwd?: string|null, lines: string[], existingMeta?: object}} params
 * @returns {string}
 */
export function buildMetaPrompt({ sessionId, cwd, lines, existingMeta }) {
  const meta = existingMeta ?? {}
  return [
    '你是 Agent 记忆文件的元数据编辑。下面是一份已存在的笔记文件里的全部条目（一行一条）。',
    '任务：为这份文件补写 name 与 description，只输出 JSON：',
    '{"name":"…","description":"…"}',
    '',
    '- name：≤40 字，说明这份笔记属于哪段会话/在做什么；',
    '- description：一句话（≤160 字），概括这些条目记录了什么经验；',
    '- 两者都不许为空；全部用中文书写，命令、文件名、代码标识符保留原样；',
    '- 只概括，不要编造条目里没有的内容。',
    '',
    `会话：${sessionId}`,
    `工作目录：${cwd ?? '(unknown)'}`,
    `现有 name：${meta.name || '(空)'}`,
    `现有 description：${meta.description || '(空)'}`,
    '笔记条目：',
    ...(lines.length > 0 ? lines : ['(空)']),
  ].join('\n')
}

/**
 * 校验并规范化判断结果：丢空、压单行、限长、收敛枚举。
 * @param {unknown} structured - 判断子会话的 structured 输出。
 * @returns {{text: string, confidence: 'V'|'I'|'U', scope: 'p'|'g'}[]}
 */
export function normalizeNotes(structured) {
  const raw = Array.isArray(structured?.notes) ? structured.notes : []
  const notes = []
  for (const item of raw) {
    if (!item || typeof item.text !== 'string') continue
    const text = singleLine(item.text.replace(/^[-*\d.\s]+/, '')).slice(0, 300)
    if (text.length < 8) continue
    const confidence = item.confidence === 'V' || item.confidence === 'U' ? item.confidence : 'I'
    const scope = item.scope === 'g' ? 'g' : 'p'
    notes.push({ text, confidence, scope })
  }
  return notes
}

/**
 * 从判断结果里取 name/description：空串视为"没给"，交给 normalizeMeta 沿用旧值。
 * @param {unknown} structured - 判断子会话的 structured 输出。
 * @param {object} [existing] - 文件里现有的 meta。
 * @returns {{name: string, description: string}}
 */
export function normalizeJudgeMeta(structured, existing) {
  const pick = (value) => singleLine(typeof value === 'string' ? value : '')
  return {
    name: pick(structured?.name) || pick(existing?.name),
    description: pick(structured?.description) || pick(existing?.description),
  }
}

/**
 * 收集所有已有笔记的查重键，避免跨会话重复写入。
 * @param {object} layout - memoryPaths() 结果。
 * @returns {Promise<Set<string>>}
 */
async function collectExistingKeys(layout) {
  const keys = new Set()
  let files
  try {
    files = await readdir(layout.notesDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return keys
    throw error
  }
  for (const name of files) {
    if (!name.endsWith('.md')) continue
    const content = await readFile(join(layout.notesDir, name), 'utf8')
    for (const entry of parseNote(content).entries) keys.add(dedupeKey(entry.text))
  }
  return keys
}

/**
 * 默认判断器：起一个 spawn 子会话，要求结构化 JSON，等它结束后释放。
 *
 * 为了让 dream 在**任何 session 触发都得到同一个判断环境**：
 *  - `cwd` 固定传记忆根目录，不继承发起者的项目目录；
 *  - 配置了 `dreamModel` 时用固定的 provider/model 路由，不继承发起者的模型。
 * @param {object} ctx - 插件上下文。
 * @param {{provider?: string, model?: string|null, cwd?: string|null}} options
 */
export function spawnJudge(ctx, { provider = 'spawn', model = null, cwd = null } = {}) {
  return async ({ parent, prompt, sessionId, signal, schema = NOTES_SCHEMA }) => {
    const request = {
      parent,
      prompt: [{ type: 'text', text: prompt }],
      outputSchema: schema,
    }
    if (cwd) request.cwd = cwd
    if (model) request.agentOptions = { provider, model }
    let activation
    try {
      activation = await ctx.subagents.startActivation({
        provider,
        label: `memory-dream ${String(sessionId).slice(0, 8)}`,
        request,
        signal,
        delivery: 'caller',
      })
    } catch (error) {
      const wrapped = new Error(
        `judge 启动失败 (${provider}): ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      )
      wrapped.name = error?.name ?? 'JudgeSpawnError'
      wrapped.code = error?.code
      wrapped.stack = error?.stack
      throw wrapped
    }
    try {
      const result = await activation.result
      if (!result?.structured || typeof result.structured !== 'object') {
        throw new Error(`judge produced no structured output (stopReason=${result?.stopReason ?? '?'}${result?.diagnostic ? `: ${result.diagnostic}` : ''})`)
      }
      return result.structured
    } catch (error) {
      const wrapped = new Error(
        `judge 运行失败: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      )
      wrapped.name = error?.name ?? 'JudgeError'
      wrapped.code = error?.code
      wrapped.stack = error?.stack
      throw wrapped
    } finally {
      await activation.dispose?.().catch?.(() => {})
    }
  }
}

/**
 * 推进水位线并刷新会话记录。
 * name/description 只在两者都非空时才写回索引：dream 可以改写，但不会把已有值抹空。
 */
function markWatermark(state, item, noteEntries, now, meta) {
  const patch = {
    cwd: item.cwd ?? null,
    dreamedThroughSeq: item.endSeq,
    lastDreamAt: now.toISOString(),
    noteEntries,
  }
  if (meta?.name && meta?.description) {
    patch.name = meta.name
    patch.description = meta.description
    patch.session = meta.session
    if (meta.file) patch.file = meta.file
  }
  upsertSession(state, item.id, patch)
}

/**
 * 处理单个会话：摘录 → 判断 → 写回 → 水位线。
 *
 * 判断阶段可以并发（每个会话一个子会话）；所有共享状态（查重集合、水位线、
 * index.json）都在 `apply` 串行区里改，所以并发也不会互相踩。
 * @param {object} params
 * @param {(task: () => Promise<any>) => Promise<any>} params.apply - 串行执行器。
 * @returns {Promise<{added: number, empty: boolean}>}
 */
async function dreamOne({ ctx, layout, state, config, item, agent, judge, existingKeys, apply, now, signal }) {
  const snapshot = await ctx.sessionQuery.readSession(item.id)
  const digest = buildDigest({
    events: snapshot.events,
    startSeq: item.startSeq,
    endSeq: item.endSeq,
    maxChars: config.dreamMaxChars,
  })
  const target = await noteTarget(layout, state, item.id)
  const before = parseNote(await readNote(layout, target.file))

  // 几乎没有内容（如只开了一下的会话）：标记处理过，不浪费模型调用
  if (digest.lines < 2) {
    await apply(async () => {
      markWatermark(state, item, before.entries.length, now)
      await saveState(layout, state)
    })
    return { added: 0, empty: true }
  }

  const prompt = buildJudgePrompt({
    digest,
    cwd: item.cwd,
    existingLines: before.entries.slice(-20).map((entry) => entry.line),
    existingMeta: before.meta,
  })
  const structured = await judge({ parent: agent, prompt, sessionId: item.id, signal })
  const notes = normalizeNotes(structured)
  return apply(async () => {
    // name/description 由判断结果给出；空串回落到旧值，旧值也没有则派生兜底
    const meta = normalizeMeta({
      existing: before.meta,
      provided: normalizeJudgeMeta(structured),
      sessionId: item.id,
      text: before.entries.at(-1)?.text ?? digest.text.slice(0, 200),
    })
    let added = 0
    let metaWritten = false
    let file = target.file
    for (const note of notes) {
      const key = dedupeKey(note.text)
      if (existingKeys.has(key)) continue
      existingKeys.add(key)
      const result = await appendEntry(layout, { sessionId: item.id, file }, {
        text: note.text,
        confidence: note.confidence,
        scope: note.scope,
        stamp: dateStamp('d', now),
        // 第一条顺手把文件头写好（可能触发改名），后续追加用返回的文件名
        meta: metaWritten ? undefined : meta,
      })
      file = result.file
      metaWritten = true
      added += 1
    }
    // 本轮没有新增笔记但文件已有内容时，仍然允许 dream 更新 name/description
    if (!metaWritten && before.entries.length > 0) {
      file = (await writeNoteMeta(layout, { sessionId: item.id, file }, meta)).file
    }

    const after = parseNote(await readNote(layout, file))
    markWatermark(state, item, after.entries.length, now, { ...meta, file })
    // 每个会话处理完立刻落盘：中断时已完成的水位线不会回退
    await saveState(layout, state)
    return { added, empty: false, meta }
  })
}

/** 串行执行器：并发 worker 的状态写入排队执行，保证不交错。 */
function makeLock() {
  let tail = Promise.resolve()
  return (task) => {
    tail = tail.then(task, task)
    return tail
  }
}

/**
 * 找出"有笔记但文件头缺 name/description"的旧文件，供 dream 补写。
 * 只读该文件已有的条目，不重读转录——补元数据是短判断，成本很低。
 * 会话归属优先取 frontmatter 的 session；旧文件没有时按索引里的 file 反查。
 * @param {object} layout - memoryPaths() 结果。
 * @param {object} state - 中央索引。
 * @returns {Promise<{sessionId: string, file: string, parsed: object}[]>}
 */
async function collectMetaBackfill(layout, state) {
  let names
  try {
    names = await readdir(layout.notesDir)
  } catch {
    return []
  }
  const byFile = new Map()
  for (const [sessionId, info] of Object.entries(state?.sessions ?? {})) {
    if (info?.file) byFile.set(info.file, sessionId)
  }
  const items = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    let content
    try {
      content = await readFile(join(layout.notesDir, name), 'utf8')
    } catch {
      continue
    }
    const parsed = parseNote(content)
    if (parsed.entries.length === 0) continue
    if (parsed.meta?.name && parsed.meta?.description) continue
    const stem = name.slice(0, -3)
    // 会话归属：frontmatter > 索引登记的文件 > 迁移前的 `<sessionId>.md` 命名
    const sessionId = parsed.meta?.session ?? byFile.get(name) ?? (state?.sessions?.[stem] ? stem : null)
    if (!sessionId) continue
    items.push({ sessionId, file: name, parsed })
  }
  return items
}

/**
 * 跑一次 dreaming。调用方负责加载 state 与刷新注入块缓存。
 *
 * 可见性：阶段切换、每个会话开始/结束都会写 <root>/dream-progress.json，
 * 外部（doctor / 命令）随时能读到"现在卡在哪一步"。
 * 中断语义：已写入的笔记文件不变；已完成会话的水位线立即落盘；
 * 未完成的会话下次重跑，查重保证不会重复写同一条。
 * @param {object} params
 * @returns {Promise<object>} 运行摘要。
 */
export async function runDream({ ctx, paths, layout, config, state, agent, signal, judge, now = new Date(), only = [] }) {
  if (inFlight) throw new Error('dream 已在运行中，等这次结束再试')
  if (!agent) throw new Error('dream 需要一个 Agent 作为判断子会话的父级')
  inFlight = true
  const startedAt = Date.now()
  const summary = {
    attempted: 0, notes: 0, empty: 0, cancelled: 0,
    failed: [], batch: 0, candidates: 0, firstRun: false, aborted: false,
    metaCandidates: 0, metaFixed: 0, metaFailed: [],
  }
  const progress = {
    stage: 'scan',
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    candidates: 0,
    batch: 0,
    finished: 0,
    notes: 0,
    failed: 0,
    current: [],
  }
  const apply = makeLock()
  const touchProgress = async () => {
    progress.updatedAt = new Date().toISOString()
    await apply(() => writeDreamProgress(layout, progress))
  }

  try {
    await touchProgress()
    const plan = await buildScanPlan({
      ctx, state, dshHome: paths.dshHome, signal, projects: config.dreamProjects ?? [], only,
    })
    state.teamScan = plan.teamScan
    summary.candidates = plan.stats.candidates
    summary.firstRun = plan.stats.firstRun

    const batch = plan.queue.slice(0, config.dreamBatchSize)
    summary.batch = batch.length
    progress.candidates = summary.candidates
    progress.batch = summary.batch
    progress.stage = 'judge'
    await touchProgress()

    const existingKeys = await collectExistingKeys(layout)
    const dream = judge ?? spawnJudge(ctx, {
      provider: config.dreamProvider ?? 'spawn',
      model: config.dreamModel ?? null,
      cwd: layout.root,
    })

    let nextIndex = 0
    const concurrency = Math.max(1, Math.min(config.dreamConcurrency ?? 1, batch.length || 1))

    const runOne = async (item) => {
      summary.attempted += 1
      progress.current = [...progress.current, item.id]
      await touchProgress()
      try {
        const result = await dreamOne({
          ctx, layout, state, config, item, agent, judge: dream, existingKeys, apply, now, signal,
        })
        summary.notes += result.added
        if (result.empty) summary.empty += 1
      } catch (error) {
        // 用户中断导致的失败不计入 failed，也不推进水位线
        if (signal?.aborted) {
          summary.cancelled += 1
        } else {
          summary.failed.push({
            id: item.id,
            name: error instanceof Error ? error.name : typeof error,
            code: error?.code ?? null,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? String(error.stack ?? '').slice(0, 600) : '',
            at: new Date().toISOString(),
          })
          progress.failures = summary.failed.slice(-10).map((failure) => ({
            id: failure.id,
            name: failure.name,
            code: failure.code,
            error: failure.error,
            at: failure.at,
          }))
        }
      } finally {
        progress.finished += 1
        progress.notes = summary.notes
        progress.failed = summary.failed.length
        progress.current = progress.current.filter((id) => id !== item.id)
        await touchProgress()
      }
    }

    const worker = async () => {
      while (!signal?.aborted) {
        const index = nextIndex++
        if (index >= batch.length) return
        await runOne(batch[index])
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    summary.aborted = Boolean(signal?.aborted)

    // 补写旧文件的 name/description：只读该文件已有条目，不动水位线、不产生新笔记。
    // 与主批次分开统计（metaFixed/metaFailed），失败不影响主批次结果。
    if (!summary.aborted) {
      const pendingAll = await collectMetaBackfill(layout, state)
      summary.metaCandidates = pendingAll.length
      const pending = pendingAll.slice(0, META_BACKFILL_MAX)
      if (pending.length > 0) {
        progress.stage = 'meta'
        progress.metaCandidates = summary.metaCandidates
        await touchProgress()
        for (const item of pending) {
          if (signal?.aborted) {
            summary.aborted = true
            break
          }
          progress.current = [...progress.current, item.sessionId]
          await touchProgress()
          try {
            const prompt = buildMetaPrompt({
              sessionId: item.sessionId,
              cwd: state.sessions?.[item.sessionId]?.cwd ?? null,
              lines: item.parsed.entries.slice(-40).map((entry) => entry.line),
              existingMeta: item.parsed.meta,
            })
            const structured = await dream({
              parent: agent, prompt, sessionId: item.sessionId, signal, schema: META_SCHEMA,
            })
            const meta = normalizeMeta({
              existing: item.parsed.meta,
              provided: normalizeJudgeMeta(structured),
              sessionId: item.sessionId,
              text: item.parsed.entries.at(-1)?.text,
            })
            await apply(async () => {
              const written = await writeNoteMeta(layout, { sessionId: item.sessionId, file: item.file }, meta)
              upsertSession(state, item.sessionId, {
                file: written.file,
                name: written.meta.name,
                description: written.meta.description,
                session: written.meta.session,
                noteEntries: item.parsed.entries.length,
              })
              await saveState(layout, state)
            })
            summary.metaFixed += 1
          } catch (error) {
            if (signal?.aborted) {
              summary.cancelled += 1
              summary.aborted = true
            } else {
              summary.metaFailed.push({
                id: item.sessionId,
                error: error instanceof Error ? error.message : String(error),
                at: new Date().toISOString(),
              })
            }
          } finally {
            progress.current = progress.current.filter((id) => id !== item.sessionId)
            progress.metaFixed = summary.metaFixed
            await touchProgress()
          }
        }
      }
    }

    progress.stage = summary.aborted ? 'aborted' : 'done'
    return summary
  } catch (error) {
    summary.aborted = Boolean(signal?.aborted)
    progress.stage = 'failed'
    progress.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    // 成功、中断、异常都落一次运行记录；recordRun 同时保存已完成会话的水位线
    try {
      const run = {
        kind: 'dream',
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        candidates: summary.candidates,
        batch: summary.batch,
        attempted: summary.attempted,
        notes: summary.notes,
        empty: summary.empty,
        cancelled: summary.cancelled,
        metaCandidates: summary.metaCandidates,
        metaFixed: summary.metaFixed,
        metaFailed: summary.metaFailed.length,
        failed: summary.failed.length,
        failedIds: summary.failed.slice(0, 10).map((failure) => failure.id),
        failedErrors: summary.failed.slice(0, 20).map((failure) => `${String(failure.id).slice(0, 8)} [${failure.name}${failure.code ? `/${failure.code}` : ''}]: ${failure.error}`),
        failedDetails: summary.failed.slice(0, 10).map((failure) => ({
          id: failure.id, name: failure.name, code: failure.code, error: failure.error, stack: failure.stack,
        })),
        aborted: summary.aborted,
      }
      await recordRun(layout, state, run)
      summary.durationMs = run.durationMs
    } catch {
      // 记录失败不能掩盖主流程结果
    }
    progress.finishedAt = new Date().toISOString()
    progress.updatedAt = progress.finishedAt
    await writeDreamProgress(layout, progress)
    inFlight = false
  }
}

/** 渲染 dream 运行摘要（命令与诊断共用）。 */
export function formatDreamSummary(summary) {
  const lines = [
    'Agent memory · dream',
    `candidates: ${summary.candidates}${summary.firstRun ? ' (first run)' : ''}, batch: ${summary.batch}`,
    `processed: ${summary.attempted}, notes added: ${summary.notes}, empty: ${summary.empty}, failed: ${summary.failed.length}${summary.cancelled ? `, cancelled: ${summary.cancelled}` : ''}`,
  ]
  if (summary.aborted) lines.push('status: aborted（已完成的笔记与水位线保留，未完成的下次重跑）')
  if (summary.metaCandidates > 0 || summary.metaFixed > 0 || summary.metaFailed?.length > 0) {
    lines.push(`metadata: fixed ${summary.metaFixed ?? 0}/${summary.metaCandidates ?? 0} legacy file(s)${summary.metaFailed?.length ? `, failed ${summary.metaFailed.length}` : ''}`)
  }
  if (summary.durationMs != null) lines.push(`duration: ${(summary.durationMs / 1000).toFixed(1)}s`)
  for (const failure of summary.failed.slice(0, 10)) {
    lines.push(`- FAILED ${failure.id} [${failure.name}${failure.code ? `/${failure.code}` : ''}]: ${failure.error}`)
  }
  for (const failure of (summary.metaFailed ?? []).slice(0, 5)) {
    lines.push(`- META FAILED ${failure.id}: ${failure.error}`)
  }
  return lines.join('\n')
}
