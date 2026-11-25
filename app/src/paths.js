/**
 * 记忆目录布局 + 文件原语。
 *
 * 布局（DESIGN.md §2）：
 *   <root>/index.json          中央索引（Host 原子写）
 *   <root>/runs.jsonl          dreaming 审计日志（append-only）
 *   <root>/notes/<name>.md     每会话一份笔记（文件名 = name）
 *   <root>/wiki/…              全局 wiki 页与候选
 */
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 计算记忆目录下所有固定路径。
 * @param {string} memoryDir - 记忆根目录（绝对路径）。
 * @returns {object} 路径表；函数型字段按需生成单文件路径。
 */
export function memoryPaths(memoryDir) {
  const notesDir = join(memoryDir, 'notes')
  const wikiDir = join(memoryDir, 'wiki')
  return {
    root: memoryDir,
    indexPath: join(memoryDir, 'index.json'),
    runsPath: join(memoryDir, 'runs.jsonl'),
    /** 正在运行的 dream 的实时进度（阶段、已完成数、当前会话）。 */
    dreamProgressPath: join(memoryDir, 'dream-progress.json'),
    notesDir,
    wikiDir,
    wikiIndexPath: join(wikiDir, 'index.md'),
    wikiCandidatesDir: join(wikiDir, 'candidates'),
    /** 某个笔记文件的完整路径：文件名 = `<name>.md`，session 记在文件头里。 */
    notePath: (file) => join(notesDir, file),
  }
}

/**
 * 确保目录骨架存在（幂等）。
 * @param {ReturnType<typeof memoryPaths>} paths
 */
export async function ensureMemoryDirs(paths) {
  await mkdir(paths.notesDir, { recursive: true })
  await mkdir(paths.wikiCandidatesDir, { recursive: true })
}

/**
 * 读 JSON 文件；不存在返回 undefined（首次运行是正常状态，不报错）。
 * @param {string} file
 * @returns {Promise<unknown>}
 */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`无法读取 ${file}: ${error.message}`, { cause: error })
  }
}

/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖。
 * 同目录 rename 在 Windows/POSIX 上都是原子替换，进程中途退出不会留下半个文件。
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * 追加一行（runs.jsonl 用）。调用方负责传入不含换行的单行文本。
 * @param {string} file
 * @param {string} line
 */
export async function appendLine(file, line) {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
}
