import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clamp, riseByTime, canSpeak, triggerChance, release, releaseFactor, addBonus } from '../lib/companion/weight.mjs'
import { drawEvent, normalizePercent, EVENT_POOL, mergePool } from '../lib/companion/events.mjs'
import { pruneWindow, canTrigger, countInWindow } from '../lib/companion/limit.mjs'
import { inQuiet, periodOf, parseHM } from '../lib/companion/period.mjs'
import { readState, readHistory, dayKeyOf } from '../lib/companion/state.mjs'
import { createTicker } from '../lib/companion/tick.mjs'
import { parseMessage, xmlSummary } from '../lib/cq.js'
import { biliLinkNote, findBiliRefs, formatDuration, formatCount } from '../lib/link-expand.js'
import { buildNewsCard, cardSegments, clampText } from '../lib/card.js'
import { styleReason } from '../lib/bili-act.js'

test('clamp 夹在 [-20,100]，坏值当 0', () => {
  assert.equal(clamp(150), 100)
  assert.equal(clamp(-99), -20)
  assert.equal(clamp('abc'), 0)
})

test('权重随时间上升', () => {
  assert.equal(riseByTime(0, 3_600_000, 6), 6)
  assert.equal(riseByTime(10, 1_800_000, 6), 13)
  assert.equal(riseByTime(99, 3_600_000, 6), 100)
})

test('阈值与概率都是单调的', () => {
  assert.equal(canSpeak(29, 30), false)
  assert.equal(canSpeak(30, 30), true)
  assert.equal(triggerChance(29, 30), 0)
  const a = triggerChance(30, 30)
  const b = triggerChance(65, 30)
  const c = triggerChance(100, 30)
  assert.ok(a > 0 && a < b && b < c)
  assert.ok(c <= 0.12 + 1e-9)
  // 11-05 新口径：p = (w / 100) × pmax；阈值以下仍是 0
  assert.ok(Math.abs(triggerChance(50, 30, 0.5) - 0.25) < 1e-9)
  assert.ok(Math.abs(triggerChance(30, 30, 0.12) - 0.036) < 1e-9)
  assert.ok(Math.abs(triggerChance(100, 30, 0.5) - 0.5) < 1e-9)
  assert.equal(triggerChance(29.9, 30, 1), 0)
})

test('开口后释放：10 分不扣、5 分标准、1 分双倍', () => {
  const p5 = release(80, 50, { base: 20 })
  const p10 = release(80, 100, { base: 20 })
  const p1 = release(80, 10, { base: 20 })
  const p0 = release(80, 0, { base: 20 })
  assert.equal(p5, 60)
  assert.equal(p10, 80)
  assert.equal(p1, 40)
  assert.equal(p0, 40) // 0 分也封顶在双倍
  assert.ok(Math.abs(releaseFactor(80) - 0.4) < 1e-9)
  assert.ok(Math.abs(releaseFactor(60) - 0.8) < 1e-9)
  assert.ok(Math.abs(releaseFactor(20) - 1.75) < 1e-9)
})

test('事件加分夹住上限', () => {
  assert.equal(addBonus(98, 8), 100)
})

test('事件池百分比合计 100（四舍五入后允许 ±1）', () => {
  const p = normalizePercent(EVENT_POOL.map((e) => ({ ...e, label: '词' + e.id })))
  const sum = p.reduce((s, e) => s + e.percent, 0)
  assert.ok(Math.abs(sum - 100) <= 1.5, `合计 ${sum}`)
})

test('默认事件池的词全空，空词不参与抽签', () => {
  assert.ok(EVENT_POOL.every((e) => e.label === ''))
  assert.equal(drawEvent(EVENT_POOL, () => 0.5), null)
  const withWord = mergePool([{ id: 'chat', label: '说句话', weight: 30 }])
  assert.equal(drawEvent(withWord, () => 0.01).id, 'chat')
})

test('抽事件只落在启用项上，并按份数分布', () => {
  const pool = [
    { id: 'a', label: '甲', weight: 100, enabled: true },
    { id: 'b', label: '乙', weight: 0, enabled: true },
    { id: 'c', label: '丙', weight: 100, enabled: false },
    { id: 'd', label: '', weight: 100, enabled: true },
  ]
  for (let i = 0; i < 50; i++) assert.equal(drawEvent(pool, () => i / 50).id, 'a')
  // 只有 a 能用时，永远 a
  assert.equal(drawEvent([{ id: 'x', label: '甲', weight: 0, enabled: true }]), null)
})

test('mergePool 接得住旧版本存盘', () => {
  const merged = mergePool([{ id: 'chat', weight: 50, enabled: false }])
  const chat = merged.find((e) => e.id === 'chat')
  assert.equal(chat.weight, 50)
  assert.equal(chat.enabled, false)
  assert.ok(merged.some((e) => e.id === 'video'))
})

test('默认事件只给词，hint 全空', () => {
  assert.ok(EVENT_POOL.every((e) => e.hint === ''))
})

test('mergePool 留住自己填的补充', () => {
  const merged = mergePool([{ id: 'video', hint: '挑短的' }])
  assert.equal(merged.find((e) => e.id === 'video').hint, '挑短的')
})

test('话头只递词；填了补充才多说一句', async () => {
  const { buildHint } = await import('../lib/companion/prompt.mjs')
  const bare = buildHint({ event: { label: '刷视频', hint: '' } })
  assert.ok(bare.includes('这一轮的词：刷视频'))
  assert.ok(!bare.includes('补充：'))
  assert.ok(!bare.includes('去 B站 搜一轮'))
  const withHint = buildHint({ event: { label: '刷视频', hint: '挑短的' } })
  assert.ok(withHint.includes('补充：挑短的'))
})

test('滑动窗口是真滚动', () => {
  const now = 10 * 3_600_000
  const win = [now - 4 * 3_600_000, now - 1 * 3_600_000]
  assert.equal(countInWindow(win, 3, now), 1)
  assert.equal(pruneWindow(win, 3, now).length, 1)
  assert.equal(canTrigger(win, 3, 2, now), true)
  assert.equal(canTrigger(win, 3, 1, now), false)
})

test('免打扰（含跨夜）', () => {
  const at = (h, m = 0) => new Date(2026, 10, 4, h, m)
  const q = { enabled: true, from: '00:00', to: '07:00' }
  assert.equal(inQuiet(at(3), q), true)
  assert.equal(inQuiet(at(7), q), false)
  assert.equal(inQuiet(at(12), q), false)
  const q2 = { enabled: true, from: '23:00', to: '02:00' }
  assert.equal(inQuiet(at(23, 30), q2), true)
  assert.equal(inQuiet(at(1), q2), true)
  assert.equal(inQuiet(at(12), q2), false)
  assert.equal(inQuiet(at(3), { enabled: false, from: '00:00', to: '07:00' }), false)
})

test('parseHM 坏输入不炸', () => {
  assert.equal(parseHM('07:30'), 450)
  assert.equal(parseHM(''), 0)
  assert.equal(parseHM('99:99'), 23 * 60 + 59)
})

test('时段能认出深夜', () => {
  assert.equal(periodOf(new Date(2026, 10, 4, 23, 0)).label, '深夜')
  assert.equal(periodOf(new Date(2026, 10, 4, 9, 0)).label, '早上')
})

const mkProfile = (over = {}) => ({
  id: 'p1', name: '日常档', mode: 'daily',
  threshold: 30, risePerTick: 0.5, triggerPmax: 1, releaseBase: 20,
  limitHours: 3, limitMax: 2, tickMinutes: 5, idleMinutes: 0,
  quiet: { enabled: false, from: '00:00', to: '07:00' },
  pool: [{ id: 'chat', label: '说句话', weight: 100, bonus: 5, enabled: true }],
  ...over,
})

const mkPlan = (profile, chatId = 'private:1') => ({
  enabled: true, dryRun: true,
  bindings: [{ chatId, enabled: true, profile }],
})

test('tick：低于阈值不动，高于阈值必中时走完整链路', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const profile = mkProfile()
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0,   // 掷骰永远命中
    })

    // 权重 0、阈值 30 ⇒ 不动（手动抽才无视门槛，这里走自动那一拍）
    const r1 = await ticker.tick('private:1')
    assert.equal(r1.skipped, 'below')

    // 手动把权重拉到 60 再跑
    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 60
    b.lastRiseAt = now
    writeBuckets(home, buckets)

    const r2 = await ticker.tick('private:1', { force: true })
    assert.equal(r2.ok, true)
    assert.equal(r2.event, 'chat')
    assert.equal(r2.w1, 65.5)   // 60 + 每拍 0.5 + 事件加分 5
    assert.equal(r2.w2, 45.5)   // 标准扣 20（5 分系数 1）
    const hist = readHistory(home, 5)
    assert.equal(hist.length, 1)
    assert.equal(hist[0].event, 'chat')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('tick：限流挡住第二条', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 80
    b.lastRiseAt = now
    b.lastTriggerAt = now - 60_000
    b.todayCount = 1
    b.dayKey = dayKeyOf(now)
    b.window = [now - 60_000]
    writeBuckets(home, buckets)

    const profile = mkProfile({ limitMax: 1 })
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      now: () => now,
      rnd: () => 0,
    })
    const r = await ticker.tick('private:1')
    assert.equal(r.skipped, 'limit')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('tick：干跑开关从 plan 传到投递（不然永远发不出去）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 80
    b.lastRiseAt = now
    writeBuckets(home, buckets)

    const seen = []
    const ticker = createTicker({
      getPlan: () => ({ ...mkPlan(mkProfile()), dryRun: false }),
      getHome: () => home,
      deliver: async (arg) => { seen.push(arg.cfg); return { ok: true, mode: 'qq' } },
      now: () => now,
      rnd: () => 0,
    })
    const r = await ticker.tick('private:1', { force: true })
    assert.equal(r.ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].dryRun, false, '投递拿到的 cfg 里必须有 dryRun:false')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('tick：每拍涨 risePerTick，没到点的那一拍不涨', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const profile = mkProfile({ risePerTick: 2, threshold: 99 })
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0.99,
    })

    // 第一拍：0 → 2，但离阈值 99 还远（走自动那一拍）
    const r1 = await ticker.tick('private:1')
    assert.equal(r1.skipped, 'below')
    assert.equal(r1.w0, 0)
    let b = bucketOf(readBuckets(home, 'private:1'), 'private:1')
    assert.equal(b.w, 2)

    // 不 force 且没到下一拍：notyet，权重不动
    const buckets = readBuckets(home, 'private:1')
    bucketOf(buckets, 'private:1').lastTickAt = now
    writeBuckets(home, buckets)
    const r2 = await ticker.tick('private:1')
    assert.equal(r2.skipped, 'notyet')
    b = bucketOf(readBuckets(home, 'private:1'), 'private:1')
    assert.equal(b.w, 2, '没到点的那一拍不能涨')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('tick：手动「抽一发」无视阈值 / 掷骰 / 免打扰 / 限流', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 0
    b.window = [now - 60_000, now - 30_000]   // 窗口已经满了
    writeBuckets(home, buckets)

    const profile = mkProfile({
      threshold: 99, triggerPmax: 0.01, limitMax: 1, limitHours: 3, idleMinutes: 600,
      quiet: { enabled: true, from: '00:00', to: '23:59' },
    })
    let delivered = 0
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      idleCheck: async () => false,
      deliver: async () => { delivered += 1; return { ok: true, mode: 'dry' } },
      now: () => now,
      rnd: () => 0.999,
    })
    const r = await ticker.tick('private:1', { force: true })
    assert.equal(r.ok, true, '手动抽必须真跑，不能被门槛挡')
    assert.equal(delivered, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('兴趣分：[SCORE n] 读得出、剥得干净', async () => {
  const { readScore, stripVerdict } = await import('../lib/companion/prompt.mjs')
  assert.equal(readScore('今天好累 [SCORE 8]'), 80)
  assert.equal(readScore('[score 0]'), 0)
  assert.equal(readScore('[SCORE 10]'), 100)
  assert.equal(readScore('[SCORE 12]'), 100)   // 超 10 按 10 算
  assert.equal(readScore('没有分'), null)
  assert.equal(stripVerdict('正文 [SCORE 8] [HOLD]'), '正文')
})

test('tick：下一拍按她打的兴趣分补扣（50 分不动）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const profile = mkProfile()
    let scored = null
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      scoreOf: () => scored,
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0,
    })

    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 100
    b.window = []
    b.lastTriggerAt = now - 60_000   // 上一轮是一分钟前发的
    writeBuckets(home, buckets)

    // 她给自己打了满分 → 系数 0，把投递时按 5 分扣的那一下整个还回来（+20）
    scored = { score: 100, at: now + 1 }
    const r = await ticker.tick('private:1', { force: true })
    assert.equal(r.score, 100)
    assert.equal(r.scoreDelta, 20)
    assert.equal(r.w0, 100)

    // 同一个分数不会被吃第二遍
    const r2 = await ticker.tick('private:1', { force: true })
    assert.equal(r2.score, undefined)

    // 隔太久的分数不算（平时聊天她也每轮打分，那种不该算到泡泡头上）
    scored = { score: 0, at: now + 30 * 60_000 }
    const r3 = await ticker.tick('private:1', { force: true })
    assert.equal(r3.score, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('xml 卡片抠得出标题/描述/链接，空的退回 [卡片]', () => {
  const xml = `<?xml version='1.0'?><msg serviceID="1" brief="[分享] 深海鲸歌" url="https://b23.tv/AbCd12">` +
    `<item layout="2"><title>深海鲸歌</title><summary>一条很安静的助眠视频 &amp; 白噪音</summary></item>` +
    `<source name="哔哩哔哩"/></msg>`
  const out = xmlSummary(xml)
  assert.match(out, /^\[卡片:/)
  assert.ok(out.includes('深海鲸歌'))
  assert.ok(out.includes('& 白噪音'))       // 实体反转义
  assert.ok(out.includes('https://b23.tv/AbCd12'))
  assert.equal(xmlSummary(''), '[卡片]')
  assert.equal(xmlSummary('<msg brief="[分享] 只有标题"></msg>'), '[卡片:只有标题]')

  // 段级：xml 不再只剩 [xml]，share 的 url 也不丢
  const p = parseMessage([{ type: 'xml', data: { data: xml } }], '')
  assert.ok(p.text.includes('深海鲸歌'))
  assert.ok(!p.text.includes('[xml]'))
  const s = parseMessage([{ type: 'share', data: { title: '一条视频', url: 'https://b23.tv/x1' } }], '')
  assert.equal(s.text, '[分享:一条视频 | https://b23.tv/x1]')
})

test('B站 链接：认得出 BV / 短链，展开成一句人话并缓存', async () => {
  assert.equal(formatDuration(205), '3:25')
  assert.equal(formatDuration(3725), '1:02:05')
  assert.equal(formatCount(123456), '12.3万')

  const text = '看这个 https://b23.tv/AbCd12 还有 BV1xx411c7mD 重复 BV1xx411c7mD'
  const refs = findBiliRefs(text)
  assert.equal(refs.length, 2)
  assert.equal(refs[0].kind, 'short')          // 按出现顺序，短链在前
  assert.equal(refs[1].bvid, 'BV1xx411c7mD')   // 重复的 BV 只留一次

  let calls = 0
  const fake = async (url) => {
    calls++
    if (String(url).includes('b23.tv')) {
      return { headers: { get: () => 'https://www.bilibili.com/video/BV1gVHA6mEbS/?x=1' }, url }
    }
    return {
      json: async () => ({
        code: 0,
        data: { title: '深海鲸歌', owner: { name: '某UP' }, duration: 205, stat: { view: 123456 } },
      }),
    }
  }
  const note = await biliLinkNote(text, { fetchImpl: fake })
  assert.ok(note.includes('深海鲸歌'))
  assert.ok(note.includes('UP：某UP'))
  assert.ok(note.includes('3:25'))
  assert.ok(note.includes('播放 12.3万'))
  const before = calls
  const again = await biliLinkNote(text, { fetchImpl: fake })
  assert.equal(again, note)
  assert.equal(calls, before)          // 第二次全走缓存，不再打接口

  // 拿不到就静默，不抛
  const broken = async () => { throw new Error('boom') }
  assert.equal(await biliLinkNote('https://b23.tv/zzz', { fetchImpl: broken }), '')
})

test('链接卡片：news 结构、跳转地址、超长截断', () => {
  const card = buildNewsCard({
    title: '深海鲸歌'.repeat(20),        // 超长要截
    desc: '一条很安静的\n助眠视频',
    url: 'https://www.bilibili.com/video/BV1gVHA6mEbS',
    pic: 'https://i0.hdslb.com/a.jpg',
    tag: '哔哩哔哩',
  })
  assert.equal(card.app, 'com.tencent.structmsg')
  assert.equal(card.view, 'news')
  const news = card.meta.news
  assert.ok(news.title.length <= 60)
  assert.ok(news.title.endsWith('…'))
  assert.equal(news.desc, '一条很安静的 助眠视频')   // 换行压成空格
  assert.equal(news.jumpUrl, 'https://www.bilibili.com/video/BV1gVHA6mEbS')
  assert.equal(news.preview, 'https://i0.hdslb.com/a.jpg')
  assert.equal(card.prompt, '[分享] ' + news.title)

  // 没给封面就不该有 preview 键（空串会让卡片开天窗）
  const bare = buildNewsCard({ title: 't', url: 'https://x.y' })
  assert.equal('preview' in bare.meta.news, false)
  assert.equal(clampText('  a\n b  ', 10), 'a b')

  // 段：json 里再套一层字符串
  const segs = cardSegments(card)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].type, 'json')
  assert.equal(JSON.parse(segs[0].data.data).meta.news.title, news.title)
})

test('评论套话闸门：正常话放行，模板/纯表情/空/超长拦下', () => {
  assert.equal(styleReason('这个布偶被柠檬酸到皱眉的样子，跟周一早上的我一模一样'), '')
  assert.match(styleReason('首先，这期视频就到这里，感谢观看'), /像模板/)
  assert.match(styleReason('一键三连'), /像模板/)
  assert.match(styleReason('😂😂😂'), /只有表情/)
  assert.match(styleReason('   '), /空的/)
  assert.match(styleReason('啊'.repeat(400)), /太长了/)
})
