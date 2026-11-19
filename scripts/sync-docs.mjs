#!/usr/bin/env node
/**
 * sync-docs.mjs —— 把 Obsidian 库里的泡泡文档同步回插件仓库的 docs/
 *
 * 干什么：
 *   库里的两份笔记（编辑源）→ 仓库 docs/FEATURES.md、docs/ARCHITECTURE.md，
 *   顺手重新生成 docs/FEATURES.html（markmap 单文件，给别人看）。
 *
 * 什么时候用：
 *   改完库里那两份笔记、要提交 / 发版 / 给别人看之前跑一次。
 *   `--check` 只报告差异、不写盘（提交前自查）。
 *
 * 什么时候别用：
 *   别反过来手抄仓库 docs 到库里 —— 方向只有一个：库 → 仓库。
 *   库里那份是「人改的地方」，仓库这份是「给 GitHub 看的副本」。
 *
 * 库在哪：默认读脚本旁边的 `sync-docs.local.json`（不进库），或环境变量
 *   BUBBLE_DOCS_VAULT。这个文件被 .gitignore 忽略，因为路径是本机的。
 *   markmap 可执行文件：环境变量 MARKMAP_BIN，没设就用 PATH 上的 markmap。
 *
 * 常见坑：
 *   - 库里文件名带中文，路径一律绝对路径；
 *   - Obsidian 正开着那两份笔记时它可能还没落盘（等状态栏「已保存」再跑）；
 *   - 仓库 docs/README.md 不参与同步（两个读者不同，它保持仓库自己的版本）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONFIG = join(ROOT, 'scripts/sync-docs.local.json')

function vaultDir() {
  if (process.env.BUBBLE_DOCS_VAULT) return process.env.BUBBLE_DOCS_VAULT
  if (existsSync(CONFIG)) {
    try {
      const j = JSON.parse(readFileSync(CONFIG, 'utf8'))
      if (j && typeof j.vault === 'string' && j.vault.trim()) return j.vault.trim()
    }
    catch { /* 配置坏了当没配 */ }
  }
  return ''
}

const VAULT = vaultDir()
if (!VAULT) {
  console.log('没配库路径：写 scripts/sync-docs.local.json（{"vault": "…/泡泡"}）或设 BUBBLE_DOCS_VAULT')
  process.exit(2)
}
if (!existsSync(VAULT)) {
  console.log('库里找不到这个目录：' + VAULT)
  process.exit(2)
}

const PAIRS = [
  ['泡泡-功能全景.md', join(ROOT, 'docs/FEATURES.md')],
  ['泡泡-实现细节.md', join(ROOT, 'docs/ARCHITECTURE.md')],
]

const checkOnly = process.argv.includes('--check')
let changed = 0

for (const [srcName, dst] of PAIRS) {
  const src = join(VAULT, srcName)
  if (!existsSync(src)) {
    console.log('跳过（库里没有）：' + srcName)
    continue
  }
  const a = readFileSync(src, 'utf8')
  const b = existsSync(dst) ? readFileSync(dst, 'utf8') : ''
  if (a === b) {
    console.log('一致：' + srcName)
    continue
  }
  changed++
  if (checkOnly) {
    console.log('有差异：' + srcName + '（' + (b === '' ? '仓库没有这份' : '内容不同') + '）')
    continue
  }
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  console.log('已同步：' + srcName + ' → ' + dst)
}

if (changed > 0 && !checkOnly) {
  const cli = process.env.MARKMAP_BIN || 'markmap'
  try {
    // --no-open：不加这个，markmap 生成完会自己弹一个浏览器窗口（11-19 就弹过一次）
    execFileSync(cli, ['docs/FEATURES.md', '--offline', '--no-open', '-o', 'docs/FEATURES.html'], { cwd: ROOT, shell: true, stdio: 'pipe' })
    console.log('已重新生成 docs/FEATURES.html（' + statSync(join(ROOT, 'docs/FEATURES.html')).size + ' 字节）')
  }
  catch (error) {
    console.log('没重新生成 HTML（markmap 不可用）：' + String((error && error.message) || error).slice(0, 120))
  }
}

if (checkOnly && changed > 0) process.exitCode = 2
console.log(changed === 0 ? '两边已经一致' : (checkOnly ? '共 ' + changed + ' 份有差异' : '共同步 ' + changed + ' 份'))