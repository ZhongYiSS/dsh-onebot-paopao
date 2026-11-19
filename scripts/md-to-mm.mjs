#!/usr/bin/env node
/**
 * md-to-mm.mjs —— 把 Markdown 大纲转成 Freeplane 思维导图（.mm，FreeMind/Freeplane XML）
 *
 * 干什么：读一份 md（标题 + 列表就是树），输出 .mm 文件，供 Freeplane 打开、拖动、折叠。
 * 什么时候用：
 *   - 文档改了要更新导图（泡泡的功能全景、实现细节）；
 *   - 想把任意 md 大纲拖进思维导图软件里看。
 * 什么时候别用：
 *   - 需要双向同步（Freeplane 里改了不会回写 md）——想回写就改 md 再跑一次；
 *   - 想要图里的自由连线 / 手绘（那是 Excalidraw / draw.io 的活）。
 * 常见坑：
 *   - .mm 里的 TEXT 必须 XML 转义（& < > " '），否则 Freeplane 打不开；
 *   - Freeplane 要求 `<map version="freeplane x.y.z">`，版本号写低了可能忽略新特性，写高了老版本可能不认；
 *   - 折叠状态用 FOLDED="true"：默认全展开会糊成一团，顶层只留两三层展开更顺手。
 *
 * 用法：
 *   node scripts/md-to-mm.mjs <输入.md> <输出.mm> [--fold=2] [--title=根节点名]
 *   --fold=N   从第 N 层开始折叠（默认 2：根 + 一级展开，二级以下收起）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const [inPath, outPath, ...rest] = process.argv.slice(2)
if (!inPath || !outPath) {
  console.error('用法: node scripts/md-to-mm.mjs <输入.md> <输出.mm> [--fold=2] [--title=名字]')
  process.exit(2)
}
const foldArg = rest.find((a) => a.startsWith('--fold='))
const titleArg = rest.find((a) => a.startsWith('--title='))
const foldFrom = foldArg ? Number(foldArg.split('=')[1]) : 2
const rootTitle = titleArg ? titleArg.split('=').slice(1).join('=') : basename(inPath).replace(/\.md$/i, '')

/** XML 属性转义 */
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/** 去掉行内 markdown 装饰，只留人看得懂的文字 */
function plain(s) {
  return String(s)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const lines = readFileSync(inPath, 'utf8').split(/\r?\n/)

/** 树节点：{ text, depth, children } */
const root = { text: rootTitle, depth: -1, children: [] }
const stack = [root]

function push(text, depth) {
  while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
  const node = { text, depth, children: [] }
  stack[stack.length - 1].children.push(node)
  stack.push(node)
  return node
}

let inFence = false
for (const raw of lines) {
  if (/^\s*(```|~~~)/.test(raw)) {
    inFence = !inFence
    continue
  }
  if (inFence) continue
  const line = raw.replace(/\t/g, '  ')
  if (!line.trim()) continue

  const h = /^(#{1,6})\s+(.*)$/.exec(line)
  if (h) {
    const depth = h[1].length - 1
    const text = plain(h[2])
    if (text) push(text, depth)
    continue
  }

  // 列表项（缩进 2 空格一级）
  const li = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(line)
  if (li) {
    const indent = Math.floor(li[1].length / 2)
    const text = plain(li[2])
    if (!text) continue
    const parentDepth = stack[stack.length - 1].depth
    push(text, parentDepth + 1 + indent)
    continue
  }

  // 普通段落：当上一节点的子节点，长句截断
  const text = plain(line)
  if (text && text.length >= 2) {
    const t = text.length > 120 ? text.slice(0, 117) + '…' : text
    push(t, stack[stack.length - 1].depth + 1)
  }
}

let idSeed = 0
function render(node, level) {
  const id = `ID_${++idSeed}`
  const folded = level >= foldFrom ? ' FOLDED="true"' : ''
  const kids = node.children.map((c) => render(c, level + 1)).join('')
  const self = node === root ? '' : ` TEXT="${esc(node.text)}"`
  return `<node ID="${id}"${self}${folded}>${kids}</node>`
}

const xml =
  `<map version="freeplane 1.7.0">\n` +
  `<!-- 由 scripts/md-to-mm.mjs 从 ${esc(basename(inPath))} 生成；改内容请改 md 再重新生成 -->\n` +
  `<node ID="ID_0" TEXT="${esc(rootTitle)}">${root.children.map((c) => render(c, 1)).join('')}</node>\n` +
  `</map>\n`

writeFileSync(outPath, xml, 'utf8')

const count = (function walk(n) {
  return 1 + n.children.reduce((a, c) => a + walk(c), 0)
})(root)
console.log(`已生成 ${outPath}（${count} 个节点，从第 ${foldFrom} 层折叠）`)