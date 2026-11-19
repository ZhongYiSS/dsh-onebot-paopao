/**
 * 2026-11-19 哥哥定的三件小事（0.5.44）：
 *   1. `[AT 23:30]` 真排程（以前只剥、静默丢掉）
 *   2. `/setup/token`、`/client-config` 只给面板（要带 x-bubble-panel）
 *   3. 发过的视频记标题（面板里能看名字，不是一串 BV 号）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAt, readLater } from '../lib/companion/prompt.mjs'
import { matchAt, stripMarkers } from '../lib/markers.js'
import { rememberTitles, titleOf } from '../lib/companion/video-log.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 本地时间构造，测试跟着机器时区走（readAt 用的也是本地钟点）。 */
const at = (h, mi) => new Date(2026, 10, 19, h, mi, 0, 0).getTime()

test('[AT 23:30] 算出到那个钟点还有多少秒', () => {
  assert.equal(readAt('[AT 23:30]', at(10, 0)), 13.5 * 3600)
  assert.equal(readAt('[AT 11:00]', at(10, 30)), 30 * 60)
  assert.equal(readAt('随便聊。[AT 23:30]', at(23, 0)), 30 * 60)
})

test('[AT] 写法容错：不写前导零、夹空格', () => {
  assert.equal(matchAt('[AT 9:05]'), '9:05')
  assert.equal(readAt('[AT 9:05]', at(9, 0)), 5 * 60)
  assert.equal(readAt('[at 9:05]', at(9, 0)), 5 * 60)
})

test('[AT] 已经过了 / 不合法 一律不排（不擅自挪到明天）', () => {
  assert.equal(readAt('[AT 09:00]', at(10, 0)), null)
  assert.equal(readAt('[AT 25:00]', at(10, 0)), null)
  assert.equal(readAt('[AT 10:70]', at(10, 0)), null)
  assert.equal(readAt('没有标记', at(10, 0)), null)
})

test('[AT] 太近按 60 秒算，免得「就是现在」排不上', () => {
  assert.equal(readAt('[AT 10:00]', at(10, 0) - 20_000), 60)
})

test('[AT] 标记照样从正文剥干净', () => {
  assert.equal(stripMarkers('晚点说 [AT 23:30]'), '晚点说')
})

test('[LATER] 没被这一步改坏', () => {
  assert.equal(readLater('[LATER 25]', at(10, 0)), 25 * 60)
  assert.equal(readLater('[LATER 90s]', at(10, 0)), 90)
})

test('视频标题小抄：写进去、读得回、只留最近 300 条', () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-titles-'))
  try {
    assert.deepEqual(titleOf(home, 'BVnothere'), { title: '', up: '' })
    rememberTitles(home, [
      { bvid: 'BV1xx411c7mD', title: '标题一', up: '张三' },
      { bvid: 'BV1yy411c7mE', title: '标题二', up: '李四' },
      { bvid: '', title: '没 bvid 的' },
    ])
    assert.deepEqual(titleOf(home, 'BV1xx411c7mD'), { title: '标题一', up: '张三' })
    const base = Date.now()
    for (let i = 0; i < 320; i += 1) rememberTitles(home, [{ bvid: 'BV' + String(i).padStart(10, '0'), title: 't' + i }], base + i)
    const raw = JSON.parse(readFileSync(join(home, 'video-titles.json'), 'utf8'))
    assert.ok(Object.keys(raw).length <= 300, '不能无限长')
    assert.equal(raw['BV1xx411c7mD'], undefined, '老的要被挤掉')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('两个会吐令牌的接口只给面板', () => {
  const src = readFileSync(join(ROOT, 'lib/companion/app.mjs'), 'utf8')
  const tok = src.slice(src.indexOf("p === '/setup/token'"), src.indexOf("p === '/setup/token'") + 300)
  assert.ok(tok.includes('panelOnly(req)'), '/setup/token 要有面板闸')
  const cc = src.slice(src.indexOf("p === '/client-config'"), src.indexOf("p === '/client-config'") + 300)
  assert.ok(cc.includes('panelOnly(req)'), '/client-config 也要有')
  const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(client.includes("'x-bubble-panel': '1'"), '面板自己要带头')
})