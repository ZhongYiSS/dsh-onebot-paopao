// 静态守卫：2026-11-19 全盘审计的 P0 六条，逐条钉住「别再改回去」
// 1) 防抖合并要把合并后的角色传下去（不能沿用开窗那条消息的角色）
// 2) 连发缓冲同理：全部是管理员才算管理员
// 3) 陪伴/来料投递不能硬写 admin，群聊必须是 member
// 4) qq_video_look 要过发文件同一套围栏 + URL 闸
// 5) 主动模式两个工具都只认主人/本机，子代理不行
// 6) 视频账本读写同一个目录；字幕自己取 wbi 签名；quick 档空证据不写缓存
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const inbound = read('lib/inbound.js')
const burst = read('lib/burst.js')
const deliver = read('lib/companion/deliver.mjs')
const tools = read('lib/tools.js')
const index = read('lib/index.js')
const bili = read('lib/companion/adapters/bili.mjs')
const video = read('lib/video-look.js')

test('防抖合并把 entry.role 传给 flush，proceed 用合并后的角色', () => {
  assert.match(inbound, /flush\(merged, entry\.plain, entry\.role\)/)
  assert.match(inbound, /proceed = async \(mergedText, mergedPlain, mergedRole\)/)
  assert.match(inbound, /const effRole = mergedRole === 'admin' \|\| mergedRole === 'member' \? mergedRole : role/)
  assert.match(inbound, /dispatchFollowup\(chatId, text, effRole, nickname\)/)
  assert.match(inbound, /interceptBusyTurn\(chatId, text, effRole, nickname, mergedPlain\)/)
  // 旧的「只传两个参」写法不许回来
  assert.equal(/flush\(merged, entry\.plain\)/.test(inbound), false)
})

test('连发缓冲逐条记角色，全部 admin 才算 admin', () => {
  assert.match(burst, /roles: \[role\]/)
  assert.match(burst, /state\.roles\.push\(role\)/)
  assert.equal(/^\s*state\.role = role\s*$/m.test(burst), false)
  assert.match(burst, /roles\.every\(\(r\) => r === 'admin'\) \? 'admin' : 'member'/)
})

test('投递按目标会话定角色，群聊是 member', () => {
  assert.match(deliver, /const role = String\(chatId\)\.startsWith\('group:'\) \? 'member' : 'admin'/)
  assert.match(deliver, /onebot\.dispatch\(chatId, text, role, '本鱼'/)
  assert.equal(/dispatch\(chatId, text, 'admin'/.test(deliver), false)
})

test('对外 dispatch 挡住非法角色值', () => {
  assert.match(index, /role === 'admin' \|\| role === 'member' \? role :/)
})

test('qq_video_look 过围栏：本地走发文件闸，URL 走私网闸，depth 白名单', () => {
  const block = /name: 'qq_video_look'[\s\S]*?execute: async \(args, exec\) => \{[\s\S]{0,1200}?\n    \}\)\);/.exec(tools)
  assert.ok(block, 'qq_video_look 的 execute 要在')
  const body = block[0]
  assert.match(body, /fencedMediaPath\(raw, gate\)/)
  assert.match(body, /checkedImageUrl\(bridge, raw\)/)
  assert.match(body, /const depth = a\?\.depth === 'quick' \|\| a\?\.depth === 'normal' \|\| a\?\.depth === 'deep' \? a\.depth : undefined/)
})

test('发文件围栏拆出「只判路径」的 fencedMediaPath，供看视频复用', () => {
  assert.match(tools, /async function fencedMediaPath\(path, gate\)/)
  assert.match(tools, /async function fencedMediaFile\(path, maxBytes, gate\) \{\s*\n\s*const real = await fencedMediaPath\(path, gate\)/)
})

test('主动模式两个工具都过 requireAdminCaller，且子代理不行', () => {
  assert.match(tools, /requireAdminCaller\(bridge, exec, 'qq_proactive_start', \{ allowLocal: true \}\)/)
  assert.match(tools, /requireAdminCaller\(bridge, exec, 'qq_proactive_stop', \{ allowLocal: true \}\)/)
  assert.match(tools, /if \(isSubagent && caller === undefined\)\s*\n\s*throw new Error/)
})

test('视频账本读写同一个目录（bubbleHome）', () => {
  assert.match(bili, /bubbleHome = join\(home, 'bubble'\)/)
  assert.match(bili, /const seen = readVideos\(bubbleHome\)/)
  assert.equal(/readVideos\(home\)/.test(bili), false)
  assert.match(read('lib/companion/app.mjs'), /bubbleHome: home/)
})

test('字幕自己取 wbi 签名，且接口报错不再当「没字幕」往下走', () => {
  assert.match(bili, /export async function subtitleText\(bvid, cred, mixin = '', maxChars = SUB_MAX\)/)
  assert.match(bili, /const k = await getWbiKeys\(cred, 15000\)/)
  assert.match(bili, /if \(p\?\.code !== undefined && Number\(p\.code\) !== 0\) return ''/)
})

test('quick 档空证据不写缓存', () => {
  const quick = /if \(depth === 'quick'\) \{[\s\S]{0,600}?return \{ id, title/.exec(video)
  assert.ok(quick, 'quick 分支要在')
  assert.match(quick[0], /if \(subtitle !== '' \|\| meta\.title !== ''\) \{/)
})