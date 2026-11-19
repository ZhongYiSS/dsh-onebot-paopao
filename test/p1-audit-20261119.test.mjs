// 静态守卫：2026-11-19 审计 P1 一批
// 1) history.jsonl 会滚动、读只读尾部
// 2) 「缓存留几天」真的按条目 ttlDays 生效
// 3) 看视频三个开关进配置（不再是代码里的隐形默认）
// 4) 每拍都重写 lastPicks（非视频轮不再沿用上一轮）
// 5) [LATER] 闸门认「我们自己派发的那一轮」
// 6) mode / port / host 进 getConfig + setConfig
// 7) bili_pick_video 有持久游标、且不深看
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const state = read('lib/companion/state.mjs')
const video = read('lib/video-look.js')
const app = read('lib/companion/app.mjs')
const tick = read('lib/companion/tick.mjs')
const bridge = read('lib/bridge.js')
const index = read('lib/index.js')
const tools = read('lib/tools.js')
const bili = read('lib/companion/adapters/bili.mjs')

test('history.jsonl 有上限且会滚，读只读尾部', () => {
  assert.match(state, /HISTORY_MAX_BYTES = 4 \* 1024 \* 1024/)
  assert.match(state, /HISTORY_TAIL_BYTES = 512 \* 1024/)
  assert.match(state, /if \(statSync\(file\)\.size > HISTORY_MAX_BYTES\) rotateHistory\(file\)/)
  assert.match(state, /readSync\(fd, buf, 0, buf\.length, from\)/)
})

test('缓存 TTL 按条目 ttlDays 取小', () => {
  assert.match(video, /const hitDays = days > 0 && Number\(hit\?\.ttlDays\) > 0 \? Math\.min\(days, Number\(hit\.ttlDays\)\) : days/)
})

test('看视频三个开关进默认值、归一化、写盘白名单', () => {
  assert.match(app, /videoSendDepth: 'deep'/)
  assert.match(app, /videoDeepOnSend: true/)
  assert.match(app, /videoSubtitle: true/)
  assert.match(app, /cfg\.videoSendDepth = raw\.videoSendDepth === 'quick' \|\| raw\.videoSendDepth === 'normal'/)
  assert.match(app, /'videoDetail', 'videoSendDepth', 'videoDeepOnSend', 'videoSubtitle'/)
})

test('QQ 侧看视频参数并进准备器 cfg', () => {
  assert.match(app, /videoGrids: qq\.videoGrids, videoFrames: qq\.videoFrames/)
  assert.match(app, /videoAsr: qq\.videoAsr, videoAsrMaxSec: qq\.videoAsrMaxSec/)
  assert.match(app, /videoVisionHeaders: qq\.videoVisionHeaders/)
})

test('每拍都重写 lastPicks', () => {
  assert.match(tick, /state\.lastPicks = targets\.length === 0 \? \[\] :/)
  assert.equal(/if \(targets\.length\) \{\s*\n\s*state\.lastPicks/.test(tick), false)
})

test('[LATER] 闸门认我们自己派发的轮', () => {
  assert.match(bridge, /chat\.lastBubbleDispatchAt = Date\.now\(\)/)
  assert.match(bridge, /Math\.max\(Number\(chat && chat\.lastInboundAt \|\| 0\), Number\(chat && chat\.lastBubbleDispatchAt \|\| 0\)\)/)
})

test('mode / port / host 进 getConfig 与 setConfig', () => {
  assert.match(index, /mode: bridge\.deps\.config\.mode,\s*\n\s*port: bridge\.deps\.config\.port,\s*\n\s*host: bridge\.deps\.config\.host,/)
  assert.match(index, /'mode', 'port', 'host',/)
})

test('forward 模式下「监听」那盏灯看连接状态', () => {
  assert.match(index, /listening: addr !== undefined \|\| \(mode === 'forward' && !!\(conn && conn\.connected\)\)/)
})

test('bili_pick_video 有持久游标、不深看', () => {
  assert.match(tools, /const pickState = readJson\(pickFile, \{\}\) \|\| \{\}/)
  assert.match(tools, /state: pickState, again: args\.again === true/)
  assert.match(tools, /writeJson\(pickFile, pickState\)/)
  assert.match(tools, /videoDeepOnSend: false/)
})

test('发出去之前看的深度走白名单', () => {
  assert.match(bili, /const sendDepth = cfg\.videoSendDepth === 'normal' \? 'normal'/)
})