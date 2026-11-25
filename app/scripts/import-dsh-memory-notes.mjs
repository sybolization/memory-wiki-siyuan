#!/usr/bin/env node
/**
 * 把整理好的笔记清单导入 DSH 记忆库（notes/<id>.md + index.json）。
 *
 * 设计原则：
 * - 只写 $DSH_HOME/memory，不碰插件包目录；
 * - 默认 dry-run，必须显式 --apply 才落盘；
 * - index.json 先备份再原子替换；
 * - 笔记行复用 src/notes.js 的格式校验，避免写出 lint 不认的行；
 * - 同一 sessionId 重复导入时按“文本去重”合并，不覆盖已有手工笔记。
 *
 * 用法：
 *   node scripts/import-dsh-memory-notes.mjs `
 *     --manifest _scratch/opencode-export/2026-11-20/dsh-import.json
 *
 *   node scripts/import-dsh-memory-notes.mjs ... --apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatEntry, formatMetaBlock, normalizeMeta, parseNote, sanitizeName } from '../src/notes.js'

function parseArgs(argv) {
  const out = { manifest: null, memoryDir: null, apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 缺少参数`)
      i += 1
      return value
    }
    if (arg === '--manifest') out.manifest = next()
    else if (arg === '--memory-dir') out.memoryDir = next()
    else if (arg === '--apply') out.apply = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

function resolveMemoryDir(explicit) {
  if (explicit) return path.resolve(explicit)
  const home = process.env.USERPROFILE ?? os.homedir()
  const fromDshHome = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'memory') : null
  if (fromDshHome && fs.existsSync(path.join(fromDshHome, 'index.json'))) return path.resolve(fromDshHome)
  const cline = path.join(home, '.dsh-cline', 'memory')
  if (fs.existsSync(path.join(cline, 'index.json'))) return cline
  return path.join(home, '.dsh', 'memory')
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

/** 同步版重名探测：`<name>.md` 已存在时依次试 `<name>-2.md`… */
function uniqueFileNameSync(notesDir, name) {
  const stem = sanitizeName(name)
  let candidate = `${stem}.md`
  let index = 2
  while (fs.existsSync(path.join(notesDir, candidate))) {
    candidate = `${stem}-${index}.md`
    index += 1
  }
  return candidate
}

function buildLines(existingContent, notes, stamp) {
  const existing = parseNote(existingContent)
  const lines = existing.entries.map((entry) => entry.line)
  const known = new Set(existing.entries.map((entry) => entry.text.toLowerCase()))
  let added = 0
  for (const note of notes) {
    const line = formatEntry({
      text: note.text,
      confidence: note.confidence ?? 'V',
      scope: note.scope ?? 'p',
      stamp,
    })
    const parsed = parseNote(line)
    if (parsed.entries.length !== 1) throw new Error(`生成的笔记行不合法：${line}`)
    const key = parsed.entries[0].text.toLowerCase()
    if (known.has(key)) continue
    known.add(key)
    lines.push(line)
    added += 1
  }
  return { lines, added, existingInvalid: existing.invalid }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/import-dsh-memory-notes.mjs --manifest <json> [--memory-dir <dir>] [--apply]')
    return
  }
  if (!args.manifest) throw new Error('缺少 --manifest')
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8'))
  const cwd = String(manifest.cwd ?? '')
  const stamp = String(manifest.stamp ?? `d ${new Date().toISOString().slice(0, 10)}`)
  const sessions = Array.isArray(manifest.sessions) ? manifest.sessions : []
  if (!cwd) throw new Error('manifest.cwd 不能为空')
  if (sessions.length === 0) throw new Error('manifest.sessions 不能为空')

  const memoryDir = resolveMemoryDir(args.memoryDir)
  const notesDir = path.join(memoryDir, 'notes')
  const indexPath = path.join(memoryDir, 'index.json')
  if (!fs.existsSync(indexPath)) throw new Error(`找不到记忆索引：${indexPath}`)
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  if (index.version !== 1) throw new Error(`index.json 版本 ${index.version} 与当前 1 不匹配`)

  const now = new Date().toISOString()
  const planned = []
  for (const session of sessions) {
    const id = String(session.id ?? '').trim()
    if (!id) throw new Error('session.id 不能为空')
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`session.id 只能包含字母数字点横线下划线：${id}`)
    // 文件名 = name（重名加 -2）；已有索引文件时沿用，避免重复导入改名
    const indexedFile = index.sessions?.[id]?.file
    const existingPath = typeof indexedFile === 'string' && indexedFile !== ''
      ? path.join(notesDir, indexedFile)
      : null
    const existingContent = existingPath && fs.existsSync(existingPath) ? fs.readFileSync(existingPath, 'utf8') : ''
    const { lines, added, existingInvalid } = buildLines(existingContent, session.notes ?? [], stamp)
    // 文件头必须带 name/description/session：清单里给了就用，没给则沿用旧文件或按内容派生
    const meta = normalizeMeta({
      existing: parseNote(existingContent).meta,
      provided: {
        name: session.title ?? session.name,
        description: session.description,
        session: id,
      },
      sessionId: id,
      text: session.notes?.[0]?.text,
    })
    const file = indexedFile && existingPath ? indexedFile : uniqueFileNameSync(notesDir, meta.name)
    const notePath = path.join(notesDir, file)
    const entry = {
      ...(index.sessions?.[id] ?? {}),
      cwd,
      file,
      noteEntries: lines.length,
      noteUpdatedAt: now,
      sessionId: id,
      name: meta.name,
      description: meta.description,
      session: id,
      importedFrom: manifest.source ?? 'opencode',
      sourceSessionId: session.sourceSessionId ?? null,
    }
    planned.push({ id, notePath, lines, added, existingInvalid, entry, meta })
  }

  console.log(`memory dir: ${memoryDir}`)
  console.log(`mode: ${args.apply ? 'APPLY' : 'DRY-RUN (加 --apply 落盘)'}`)
  for (const item of planned) {
    console.log(`- ${item.id}: ${item.added} new / ${item.lines.length} total -> ${item.notePath}`)
    if (item.existingInvalid.length > 0) {
      console.log(`  warning: 已有 ${item.existingInvalid.length} 行格式不合法，保留原样不动`)
    }
  }
  console.log(`index: ${indexPath}`)

  if (!args.apply) {
    console.log('\n预览（第一条）：')
    console.log(JSON.stringify({ session: planned[0].id, entry: planned[0].entry, firstLines: planned[0].lines.slice(0, 3) }, null, 2))
    console.log('\n未写入任何文件。')
    return
  }

  const backup = `${indexPath}.bak-opencode-import-${timestamp()}`
  fs.copyFileSync(indexPath, backup)
  console.log(`backup: ${backup}`)

  fs.mkdirSync(notesDir, { recursive: true })
  for (const item of planned) {
    // 保留已有非法行，避免“导入”变成静默清理用户手写内容。
    const invalidLines = item.existingInvalid.map((entry) => entry.line)
    const content = formatMetaBlock(item.meta) + [...item.lines, ...invalidLines].join('\n') + '\n'
    writeAtomic(item.notePath, content)
    index.sessions ??= {}
    index.sessions[item.id] = item.entry
  }
  index.updatedAt = now
  writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  console.log('done.')
  console.log('提示：DSH 正在运行时，注入块缓存要等一次 /memory doctor、/remember、memory_note 或插件重载才会刷新。')
}

main()
