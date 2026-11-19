/**
 * 2026-11-19 第二轮审计（陪伴核心 + 工具/入站）修掉的那批，逐条钉住。
 * 都是静态守卫：断言「代码里还有没有这条防线」，防止以后手滑把修复删回去。
 * 什么时候跑：npm test（每次）。
 * 什么时候别用：想验证行为细节时别靠这个文件——它只读源码字符串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('连发合并派发失败不许变成未捕获拒绝（进程会被带下去）', () => {
  const src = read('lib/burst.js')
  assert.ok(src.includes('Promise.resolve(this.deps.dispatch('), '派发必须包一层 Promise.resolve')
  assert.ok(src.includes('合并连发后派发失败'), '要有 catch 兜住')
})

test('非管理员一条消息只吃一格限流配额', () => {
  const src = read('lib/inbound.js')
  assert.ok(src.includes('if (!isAdmin && this.rateLimited(chatId))'), '入口处给成员占配额')
  assert.ok(src.includes('if (isAdmin && this.rateLimited(chatId))'), 'I/O 前那处只给管理员占')
  assert.ok(!src.includes('if (this.rateLimited(chatId))\n            return;'), '不许再出现无条件的第二次占用')
})

test('口味账：被打分的条目一圈只衰减一次', () => {
  const src = read('lib/companion/taste.mjs')
  assert.ok(!src.includes('* DECAY + delta'), '整本账已乘过 DECAY，这里不能再乘')
  assert.ok(src.includes('clamp((Number(cur.s) || 0) + delta, -20, 20)'), '直接加 delta')
})

test('lastPicks 记完分要清空，不许挂到最后一批视频上反复记', () => {
  const src = read('lib/companion/app.mjs')
  assert.ok(src.includes('bucket.lastPicks = []'), '结算后必须清空')
})

test('免打扰 24:00 存回去不许变成 23:59', () => {
  const src = read('lib/companion/period.mjs')
  assert.ok(src.includes('Math.min(24 * 60, Math.round(Number(minutes) || 0))'), '1440 是合法值')
  assert.ok(!src.includes('24 * 60 - 1, Math.round(Number(minutes)'), '旧的夹取要拆掉')
})

test('定时话头重排前先清旧定时器，写盘失败要说出来', () => {
  const src = read('lib/companion/followup.mjs')
  assert.ok(src.includes('clearTimeout(prev.timer)'), '重排前清旧的')
  assert.ok(src.includes('return writeJson(home, PENDING, out) !== false'), 'persist 要回结果')
  assert.ok(src.includes('saved'), 'request 要把落盘结果交出去')
})

test('发文件围栏、卡片封面、NapCat 参数、视频抽签的门禁都在', () => {
  const tools = read('lib/tools.js')
  assert.ok(tools.includes("requireAdminCaller(bridge, exec, 'bili_pick_video', { allowLocal: true })"), 'bili_pick_video 要门禁')
  assert.ok(tools.includes('!Array.isArray(a.params)'), 'qq_napcat_api 不收数组')
  assert.ok(tools.includes('pic = await checkedImageUrl(bridge, a.pic.trim())'), '卡片封面要走 SSRF 闸')
  assert.ok(tools.includes('truncated: clipped'), '合并转发被截断要报出来')
})

test('wrapUserMessage 的 qq 属性只留数字', () => {
  const src = read('lib/chat.js')
  assert.ok(src.includes("String(userId ?? '').replace(/[^0-9]/g, '')"), 'userId 必须净化')
})

test('代理对保护在 maxChars=1 时也生效', () => {
  const src = read('lib/outbound.js')
  assert.ok(src.includes('if (cut > 0 && cut < rest.length)'), 'cut > 1 → cut > 0')
})

test('settings.json 读坏了要留副本，不许静默清空', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes("'.broken-'"), '留一份坏文件')
})

test('生成客户端配置时先问 plainToken（accessToken 不在 getConfig 里）', () => {
  const src = read('lib/companion/app.mjs')
  const fn = src.slice(src.indexOf('function bubbleToken()'), src.indexOf('function bubbleToken()') + 900)
  assert.ok(fn.includes('plainToken'), '要先试 plainToken')
  assert.ok(fn.indexOf('plainToken') < fn.indexOf('getConfig'), '顺序：plainToken 在前')
})

test('旧版 state.json 迁移后要写回，别留 _default 幽灵桶', () => {
  const src = read('lib/companion/state.mjs')
  assert.ok(src.includes('export function readBuckets(home, legacyKey = \'_default\', migrate = false)'), '要能要迁移')
  assert.ok(src.includes('if (migrate)'), 'migrate 分支在')
  const tick = read('lib/companion/tick.mjs')
  assert.ok(tick.includes('readBuckets(home, legacyKey, true)'), 'tick 读盘时要迁移')
})