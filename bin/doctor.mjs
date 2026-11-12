#!/usr/bin/env node
/**
 * 检查环境 —— 装完先跑这个：一条命令看清「缺什么、去哪儿补」。
 *
 *   node bin/doctor.mjs
 *
 * 只查不装：不下载、不改系统。退出码 0 = 必需项全过，1 = 必需项有没过（跑不起来）。
 * 每项前面标着 [必需] / [可选]：必需只有 Node + ws/canvas/fontkit 四项。
 * 设置页里也有同一份检查（「检查环境」按钮），这个文件是给命令行用的。
 */
import { runDoctor, readProfileConfig } from '../lib/doctor.mjs'

const color = process.stdout.isTTY === true
const paint = (code, s) => (color ? '\u001b[' + code + 'm' + s + '\u001b[0m' : s)
const mark = { ok: paint('32', '✅'), warn: paint('33', '⚠️ '), bad: paint('31', '❌') }

// 命令行没有运行中的插件实例，配置从 profile 的 cordis.patch.yml 里读一份
const config = readProfileConfig()
const got = await runDoctor({ config, napcat: null })
console.log('')
for (const it of got.items) {
  const need = it.need === 'must' ? paint('31', '[必需] ') : '[可选] '
  console.log('  ' + (mark[it.level] || '•') + ' ' + need + it.label)
  console.log('      ' + it.detail)
  if (it.fix !== '') console.log('      → ' + paint('36', it.fix))
}
console.log('')
console.log(got.ok
  ? paint('32', '  必需的四项都齐了，能跑。') + (got.betterBad > 0 ? '另有 ' + got.betterBad + ' 项可选功能没配齐（不影响聊天）。' : '')
  : paint('31', '  ' + got.mustBad + ' 项必需没过，上面跟了怎么补。'))
console.log('')
process.exit(got.ok ? 0 : 1)
