/**
 * 从 DSH Cline 扩展里移除 RSI 界面（侧栏卡片 + 设置页「RSI 项目管理」）。
 *
 * 为什么必须改两份：
 *   - `~\.vscode\extensions\<扩展>\dist\vendor\host-services\lib\client.js`（扩展 vendor 副本）
 *   - `$DSH_HOME\profiles\node_modules\@dsh-cline\host-services\lib\client.js`（安装副本）
 *   扩展激活时会比较两份内容（samePluginContents），只改一份会被自动覆盖回来。
 *
 * 幂等：已打过标记的文件直接跳过；第一次修改前留 `.bak-agent-memory` 备份。
 * 扩展升级后 vendor 会变回原样，重跑本脚本即可。
 *
 * 用法：node scripts/remove-rsi.mjs [--host]
 *   --host 额外移除 Host 侧 `registerRsi(ctx, webServer)` 调用（需要重启 DSH 服务生效）。
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh-cline')
const withHost = process.argv.includes('--host')
const MARK_UI = 'RSI UI removed by agent-memory'
const MARK_HOST = 'RSI host removed by agent-memory'

/** 客户端两处 slot 注册的精确匹配（只匹配 RsiSection / CurrentProjectRsiEntry 结尾的那两处）。 */
const CLIENT_PATCHES = [
  {
    name: 'settings.section (RSI 项目管理)',
    pattern: /ctx\.slots\.inject\("settings\.section", \(\) => ctx\.slots\.register\(\{[\s\S]*?\}, RsiSection\)\);/,
  },
  {
    name: 'sidebar.footer.action (当前项目 RSI)',
    pattern: /ctx\.slots\.inject\("sidebar\.footer\.action", \(\) => ctx\.slots\.register\(\{[\s\S]*?\}, CurrentProjectRsiEntry\)\);/,
  },
]

/** Host 侧的 RSI 注册调用。 */
const HOST_PATCHES = [
  {
    name: 'registerRsi(ctx, webServer)',
    pattern: /^([ \t]*)registerRsi\(ctx, webServer\);[ \t]*$/m,
    replace: (_match, indent) => `${indent}/* ${MARK_HOST} */`,
  },
]

/** 在扩展目录里找最新的 DSH Cline 扩展。 */
function findExtensionDirs() {
  const roots = [
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-insiders', 'extensions'),
  ]
  const found = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      if (!name.startsWith('shengsuan-cloud.cline-shengsuan-')) continue
      const lib = join(root, name, 'dist', 'vendor', 'host-services', 'lib')
      if (existsSync(join(lib, 'client.js'))) found.push({ label: `extension ${name}`, lib })
    }
  }
  return found.sort((left, right) => left.label.localeCompare(right.label))
}

/** 对单个文件应用补丁：幂等、先备份、报告替换数量。 */
async function patchFile(file, patches, marker) {
  if (!existsSync(file)) return { file, status: 'missing' }
  const original = await readFile(file, 'utf8')
  if (original.includes(marker)) return { file, status: 'already-patched' }

  let next = original
  let applied = 0
  for (const patch of patches) {
    const before = next
    next = next.replace(patch.pattern, typeof patch.replace === 'function' ? patch.replace : patch.replace ?? '')
    if (next !== before) applied += 1
    else console.warn(`  ! 未匹配：${patch.name}（${file}）`)
  }
  if (applied === 0) return { file, status: 'no-match' }

  const backup = `${file}.bak-agent-memory`
  if (!existsSync(backup)) await copyFile(file, backup)
  next = next.replace(/\n?$/, '') + `\n/* ${marker} */\n`
  await writeFile(file, next, 'utf8')
  return { file, status: `patched (${applied} site(s))` }
}

const targets = [...findExtensionDirs(), { label: 'profile install', lib: join(DSH_HOME, 'profiles', 'node_modules', '@dsh-cline', 'host-services', 'lib') }]
if (targets.length === 0 || targets.every((target) => !existsSync(join(target.lib, 'client.js')))) {
  console.error('找不到 host-services 安装目录（扩展或 profile 里都没有）')
  process.exit(1)
}

console.log(`RSI removal${withHost ? '（含 Host 注册）' : '（仅 UI）'}`)
for (const target of targets) {
  console.log(`- ${target.label}: ${target.lib}`)
  const client = await patchFile(join(target.lib, 'client.js'), CLIENT_PATCHES, MARK_UI)
  console.log(`  client.js: ${client.status}`)
  if (withHost) {
    const host = await patchFile(join(target.lib, 'index.js'), HOST_PATCHES, MARK_HOST)
    console.log(`  index.js: ${host.status}`)
  }
}

// 两份副本内容一致，扩展激活时才不会判定"需要重新安装"
const copies = targets.map((target) => join(target.lib, 'client.js')).filter((file) => existsSync(file))
if (copies.length === 2) {
  const [left, right] = await Promise.all(copies.map((file) => readFile(file, 'utf8')))
  console.log(`\n两份 client.js 内容一致：${left === right ? '是' : '否（下次扩展激活可能重装，需要重跑本脚本）'}`)
}
console.log('\n完成。重载 VS Code 窗口后生效；扩展升级后重跑本脚本。')
