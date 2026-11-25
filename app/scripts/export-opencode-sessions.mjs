#!/usr/bin/env node
/**
 * 把 OpenCode 会话导出到工作区，并生成“去掉工具噪音”的问答转录。
 *
 * 用法：
 *   node scripts/export-opencode-sessions.mjs `
 *     --days 3 `
 *     --cwd <project-directory> `
 *     --out _scratch/opencode-export/2026-11-20 `
 *     [--only-relevant]
 *
 * 产物：
 *   <out>/raw/<sessionId>.json        官方 `opencode session export` 原文
 *   <out>/transcripts/<sessionId>.md  只保留 user / assistant 文本
 *   <out>/index.md                    清单、关键词命中数、文件指针
 *
 * 说明：
 * - 只读 opencode.db，不修改任何 OpenCode 数据；
 * - 默认排除当前正在运行的会话（OPENCODE_SESSION_ID）；
 * - 关键词只用于标记/筛选，不删除原始导出。
 */
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_KEYWORD = 'pok[eé]mon|pokered|gbc|宝可梦|口袋妖怪|皮卡丘|pikachu'

function parseArgs(argv) {
  const out = {
    days: 3,
    cwd: process.cwd(),
    out: null,
    keyword: DEFAULT_KEYWORD,
    includeCurrent: false,
    onlyRelevant: false,
    db: path.join(process.env.USERPROFILE ?? '', '.local', 'share', 'opencode', 'opencode.db'),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 缺少参数`)
      i += 1
      return value
    }
    if (arg === '--days') out.days = Number(next())
    else if (arg === '--cwd') out.cwd = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--keyword') out.keyword = next()
    else if (arg === '--db') out.db = next()
    else if (arg === '--include-current') out.includeCurrent = true
    else if (arg === '--only-relevant') out.onlyRelevant = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

function normalizePath(value) {
  return String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function exportOne(sessionId) {
  const command = `opencode session export ${sessionId}`
  const buf = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  })
  return buf
}

function textBlocks(message) {
  if (message?.type === 'user' && typeof message.text === 'string') {
    return [{ role: 'USER', text: message.text }]
  }
  if (message?.type !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '')
    .map((part) => ({ role: 'ASSISTANT', text: part.text }))
}

function buildTranscript(data, keyword, onlyRelevant) {
  const info = data.info ?? {}
  const re = new RegExp(keyword, 'i')
  const blocks = []
  for (const message of data.messages ?? []) {
    for (const block of textBlocks(message)) {
      blocks.push({
        role: block.role,
        time: message.time?.created ?? null,
        text: block.text,
        hit: re.test(block.text),
      })
    }
  }
  const titleHit = re.test(info.title ?? '')
  const hits = blocks.filter((block) => block.hit).length
  const relevant = titleHit || hits >= 3

  // 默认保留全部问答；--only-relevant 时，不相关会话只留命中块和前后各一块。
  const kept = []
  blocks.forEach((block, index) => {
    if (!onlyRelevant || relevant || block.hit) kept.push(block)
    else if (blocks[index - 1]?.hit || blocks[index + 1]?.hit) kept.push(block)
  })

  const lines = [
    `# ${info.title || '(untitled)'}`,
    '',
    `- session: \`${info.id ?? ''}\``,
    `- cwd: \`${info.location?.directory ?? ''}\``,
    `- created: ${info.time?.created ? new Date(info.time.created).toISOString() : '?'}`,
    `- updated: ${info.time?.updated ? new Date(info.time.updated).toISOString() : '?'}`,
    `- source: \`opencode session export ${info.id ?? ''}\``,
    `- keyword: \`${keyword}\``,
    `- relevant: ${relevant ? 'yes' : 'no'} (${hits} matching text blocks)`,
    '',
    '> 只保留 user / assistant 的文本，故意省略 reasoning、工具调用、工具结果和附件；',
    '> 完整原文见同目录 raw/ 下的 JSON。',
    '',
  ]
  for (const block of kept) {
    lines.push(`## ${block.role}${block.time ? ` · ${new Date(block.time).toISOString()}` : ''}`, '', block.text.trim(), '')
  }
  return { markdown: lines.join('\n'), blocks: blocks.length, kept: kept.length, hits, relevant, info }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/export-opencode-sessions.mjs --days 3 --cwd <project-directory> --out <dir>')
    return
  }
  if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days 必须是正数')
  const outDir = path.resolve(args.out ?? path.join('_scratch', 'opencode-export', stamp().slice(0, 10)))
  const rawDir = path.join(outDir, 'raw')
  const transcriptDir = path.join(outDir, 'transcripts')
  fs.mkdirSync(rawDir, { recursive: true })
  fs.mkdirSync(transcriptDir, { recursive: true })

  const cutoff = Date.now() - args.days * 24 * 3600 * 1000
  const db = new DatabaseSync(args.db, { readOnly: true })
  const all = db.prepare(`
    select id, title, directory, time_created, time_updated
    from session_v2
    where time_updated >= ?
    order by time_updated desc
  `).all(cutoff)
  const current = process.env.OPENCODE_SESSION_ID
  const target = normalizePath(args.cwd)
  const sessions = all.filter((session) => {
    if (!args.includeCurrent && current && session.id === current) return false
    return target === '' || normalizePath(session.directory) === target
  })

  const rows = []
  for (const session of sessions) {
    let buf
    try {
      buf = exportOne(session.id)
    } catch (error) {
      console.error(`[skip] ${session.id}: export 失败：${error.message}`)
      continue
    }
    const rawPath = path.join(rawDir, `${session.id}.json`)
    fs.writeFileSync(rawPath, buf)
    let data
    try {
      data = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      console.error(`[skip] ${session.id}: 导出不是合法 JSON：${error.message}`)
      continue
    }
    const transcript = buildTranscript(data, args.keyword, args.onlyRelevant)
    const transcriptPath = path.join(transcriptDir, `${session.id}.md`)
    fs.writeFileSync(transcriptPath, transcript.markdown, 'utf8')
    rows.push({
      session,
      rawPath,
      transcriptPath,
      rawBytes: buf.length,
      ...transcript,
    })
  }

  const indexLines = [
    `# OpenCode 会话导出 · ${stamp()}`,
    '',
    `- 范围：最近 ${args.days} 天（按 time_updated）`,
    `- 工作区：${args.cwd || '(全部)'}`,
    `- 关键词：\`${args.keyword}\``,
    `- 会话数：${rows.length}`,
    '',
    '| 会话 | 标题 | 更新时间 | 文本块 | 命中 | 相关 | raw | transcript |',
    '|---|---|---|---:|---:|---|---|---|',
  ]
  for (const row of rows) {
    const title = String(row.info.title ?? '').replace(/\|/g, '\\|')
    indexLines.push([
      `\`${row.info.id}\``,
      title,
      row.info.time?.updated ? new Date(row.info.time.updated).toISOString() : '?',
      row.blocks,
      row.hits,
      row.relevant ? 'yes' : 'no',
      `[json](raw/${row.info.id}.json)`,
      `[md](transcripts/${row.info.id}.md)`,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  indexLines.push('', '> `relevant=yes` 表示标题命中，或正文命中至少 3 个文本块。')
  fs.writeFileSync(path.join(outDir, 'index.md'), `${indexLines.join('\n')}\n`, 'utf8')

  console.log(`导出完成：${outDir}`)
  for (const row of rows) {
    console.log(`- ${row.info.id}  ${row.relevant ? 'RELEVANT' : 'no'}  hits=${row.hits}  raw=${(row.rawBytes / 1024).toFixed(0)}KB  ${row.info.title ?? ''}`)
  }
}

main()
