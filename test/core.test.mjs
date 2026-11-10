import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clamp, riseByTime, canSpeak, triggerChance, settle, refundPct, spend, addBonus } from '../lib/companion/weight.mjs'
import { drawEvent, normalizePercent, EVENT_POOL, mergePool } from '../lib/companion/events.mjs'
import { pruneWindow, canTrigger, countInWindow } from '../lib/companion/limit.mjs'
import { inQuiet, periodOf, parseHM, formatHM } from '../lib/companion/period.mjs'
import { readState, readHistory, dayKeyOf } from '../lib/companion/state.mjs'
import { createTicker } from '../lib/companion/tick.mjs'
import { parseMessage, xmlSummary } from '../lib/cq.js'
import { biliLinkNote, findBiliRefs, formatDuration, formatCount } from '../lib/link-expand.js'
import { buildNewsCard, cardSegments, clampText } from '../lib/card.js'
import { styleReason } from '../lib/bili-act.js'
import { matchCloseChat, matchOpenChat } from '../lib/inbound.js'
import { validatePinSessionId, shortPinId } from '../lib/pin-id.js'

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

test('评分结算：10 分补 120%、5 分不动、0 分追扣一倍', () => {
  // 哥哥 11-10 的表：这一轮已经先扣过一格 20，分到了按百分比补/追扣。
  assert.equal(settle(60, 50, { base: 20 }), 60) // 5 分不动
  assert.equal(settle(60, 100, { base: 20 }), 84) // 10 分补 120% → +24
  assert.equal(settle(60, 90, { base: 20 }), 76) // 9 分 +80% → +16
  assert.equal(settle(60, 80, { base: 20 }), 72) // 8 分 +60% → +12
  assert.equal(settle(60, 70, { base: 20 }), 70) // 7 分 +50% → +10
  assert.equal(settle(60, 60, { base: 20 }), 64) // 6 分 +20% → +4
  assert.equal(settle(60, 40, { base: 20 }), 56) // 4 分 -20% → -4
  assert.equal(settle(60, 10, { base: 20 }), 44) // 1 分 -80% → -16
  assert.equal(settle(60, 0, { base: 20 }), 40) // 0 分 -100% → -20
  assert.equal(refundPct(100), 120)
  assert.equal(refundPct(0), -100)
  // 他找上门的那段对话 +2 分：5 分变 7 分档(+50%)
  assert.equal(refundPct(50, { inbound: true }), 50)
  assert.equal(refundPct(30, { inbound: true }), 0) // 3 分 +2 = 5 分
  // 补到爆也一样夹在 100
  assert.equal(settle(95, 100, { base: 20 }), 100)
})

test('每轮固定消耗：不管发没发出去都扣一格，夹在地板上', () => {
  assert.equal(spend(30, 20), 10)
  assert.equal(spend(5, 20), -15)
  assert.equal(spend(-15, 20), -20) // 默认地板 -20
  assert.equal(spend(-15, 20, { floor: -100 }), -35) // 下限开放后可到 -35
  assert.equal(spend(-95, 20, { floor: -100 }), -100)
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

const mkPlan = (profile, chatId = 'private:1', globals = {}) => ({
  enabled: true, dryRun: true,
  bindings: [{ chatId, enabled: true, profile }],
  globals,
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
    assert.equal(r2.w2, 65.5)   // 11-10 起不在 tick 里扣，扣分改到 QQ 那边回合结束时做
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
  assert.equal(readScore('[SCORE 11]'), 110)   // 11-11 新加的档：+150%
  assert.equal(readScore('[SCORE 12]'), 120)   // 12 分封顶：+200%
  assert.equal(readScore('[SCORE 13]'), 120)   // 超 12 按 12 算
  assert.equal(readScore('没有分'), null)
  assert.equal(stripVerdict('正文 [SCORE 8] [HOLD]'), '正文')
})

test('tick 不再结算分数：加减分都在回合结束时当场算（11-11）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const profile = mkProfile()
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      // 就算外面递了一份分进来，tick 也不许动权重（扣和补都归回合钩子）
      scoreOf: () => ({ score: 100, at: now + 1 }),
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0,
    })
    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 70
    b.window = []
    b.lastTriggerAt = now - 60_000
    writeBuckets(home, buckets)

    const r = await ticker.tick('private:1', { force: true })
    assert.equal(r.score, undefined, 'tick 不结算分数')
    assert.equal(r.scoreDelta, undefined, 'tick 不改权重')
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

test('「随意聊聊」只认发词 + 时长，位置随意', () => {
  assert.equal(matchOpenChat('随意聊聊'), 0)
  assert.equal(matchOpenChat('随意聊聊吧'), 0)
  assert.equal(matchOpenChat('小鱼，随便聊聊两分钟'), 2)
  assert.equal(matchOpenChat('本鱼，咱们随意聊聊吧，先聊 20 分钟'), 20)
  assert.equal(matchOpenChat('随便聊聊半小时'), 30)
  assert.equal(matchOpenChat('随意聊一会儿'), 3)
  assert.equal(matchOpenChat('随意聊聊两句'), 3)
  assert.equal(matchOpenChat('@钟汐儿 随意聊聊 5 分钟'), 5)
  assert.equal(matchOpenChat('今天吃啥'), null)
  assert.equal(matchOpenChat('陪本鱼聊会儿'), null)
})

test('关「随意聊聊」：带词的长句和整句短话都认，正常句子不误关', () => {
  assert.equal(matchCloseChat('停止随意聊聊'), true)
  assert.equal(matchCloseChat('停下随意聊聊'), true)
  assert.equal(matchCloseChat('@钟汐儿 别聊了'), true)
  assert.equal(matchCloseChat('不聊了'), true)
  assert.equal(matchCloseChat('关掉'), true)
  assert.equal(matchCloseChat('好了，停止'), true)
  assert.equal(matchCloseChat('这视频停在那了'), false)
  assert.equal(matchCloseChat('关机'), false)
  assert.equal(matchCloseChat('随意聊聊'), false)
  // 11-07 真事：他说「关闭随意聊聊」时被当成又开了一次窗——关窗词必须认「关闭 / 关一下」。
  assert.equal(matchCloseChat('关闭随意聊聊'), true)
  assert.equal(matchCloseChat('关闭'), true)
  assert.equal(matchCloseChat('关一下随意聊'), true)
  assert.equal(matchCloseChat('关我什么事，随便聊聊而已'), false)
})

test('「随意聊聊」开关不替她说话：只递话头（B 方案）', async () => {
  const { InboundPipeline } = await import('../lib/inbound.js')
  const notes = []
  const texts = []
  const ctx = {
    config: { openChatDefaultMs: 600000, openChatMaxMs: 1200000 },
    log: () => { },
    sendToChat: async (_id, t) => { texts.push(t) },
    dispatchFollowup: async (id, t, role, nick) => { notes.push({ id, t, role, nick }) },
  }
  const p = new InboundPipeline(ctx, { now: () => 1_000_000 })
  const total = await p.startOpenChat('group:1', 10)
  assert.equal(total, 10)
  assert.equal(texts.length, 0, '开窗不许发写死的句子')
  await p.stopOpenChat('group:1', true)
  assert.equal(texts.length, 0, '关窗也不许')
  p.nudgeSelf('group:1', '（他对你说「随意聊聊十分钟」。）')
  assert.equal(notes.length, 1, '话头要走会话，不走 sendToChat')
  assert.equal(notes[0].role, 'admin')
  assert.ok(notes[0].t.includes('随意聊聊'))
})


test('免打扰：只写小时数也认，且这段时间不涨权重', async () => {
  assert.equal(parseHM('0'), 0)
  assert.equal(parseHM('9'), 9 * 60)
  assert.equal(parseHM('9:30'), 9 * 60 + 30)
  assert.equal(formatHM(540), '09:00')
  assert.equal(inQuiet(new Date(2026, 10, 8, 3, 0), { enabled: true, from: '0', to: '9' }), true)
  assert.equal(inQuiet(new Date(2026, 10, 8, 10, 0), { enabled: true, from: '0', to: '9' }), false)

  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 8, 3, 0).getTime()
    const profile = mkProfile({ quiet: { enabled: true, from: '0', to: '9' } })
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0,
    })
    const r = await ticker.tick('private:1')
    assert.equal(r.skipped, 'quiet')
    const b = bucketOf(readBuckets(home, 'private:1'), 'private:1')
    assert.equal(b.w, 0, '免打扰期间权重不动')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('跑子进程：程序不存在要干净地 reject，不能变成未捕获异常', async () => {
  const { runSubprocess } = await import('../lib/video-look.js')
  const seen = []
  const onCaught = (e) => seen.push(e)
  process.on('uncaughtException', onCaught)
  try {
    await assert.rejects(
      () => runSubprocess('D:/__nope__/yt-dlp.exe', ['--version'], { timeoutMs: 3000 }),
      /找不到程序/,
    )
  } finally {
    process.removeListener('uncaughtException', onCaught)
  }
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(seen, [], '不该冒出未捕获异常')
})

test('定时话头：只认 [LATER 分钟数]，算得出秒数', async () => {
  const { readLater, stripVerdict } = await import('../lib/companion/prompt.mjs')
  const now = new Date(2026, 10, 9, 10, 0, 0).getTime()
  assert.equal(readLater('正文\n[LATER 25]', now), 1500)
  assert.equal(readLater('正文 [LATER 90s]', now), 90)
  assert.equal(readLater('[AT 21:00]', now), null)          // 11-09 哥哥砍掉「到几点」这种写法
  assert.equal(readLater('[LATER 720]', now, 43200), 43200)  // 夹到 12 小时上限
  assert.equal(readLater('没有标记', now), null)
  assert.equal(readLater('[LATER 0]', now), null)
  assert.equal(readLater('[LATER 9999]', now, 43200), 43200) // 夹到上限
  assert.equal(stripVerdict('正文 [LATER 25] [SCORE 8]'), '正文')
})

test('定时话头：一条未决、撞每日上限就丢、能撤、重启排得回来', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { createFollowup } = await import('../lib/companion/followup.mjs')
    const cfg = { followupEnabled: true, followupPerDay: 2, followupMaxHours: 12, followupMinSec: 60 }
    let t = new Date(2026, 10, 9, 10, 0, 0).getTime()
    const fired = []
    const fu = createFollowup({
      home, getConfig: () => cfg,
      fire: async (chatId) => { fired.push(chatId); return { ok: true } },
      now: () => t,
    })
    try {
      const a = fu.request('private:1', 600)
      assert.equal(a.ok, true)
      assert.equal(a.sec, 600)
      // 同一个会话再排 → 覆盖，不叠两条
      const b = fu.request('private:1', 1200)
      assert.equal(b.ok, true)
      assert.equal(fu.pending.length, 1)
      assert.equal(fu.pending[0].sec, 1200)
      // 同一个会话今天已经排过 2 次（上面两次）→ 第三次撞上限
      const c = fu.request('private:1', 300)
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'cap')
      // 别的会话各算各的，不受影响
      assert.equal(fu.request('private:2', 300).ok, true)
      // 撤掉
      assert.equal(fu.cancel('private:1'), true)
      assert.equal(fu.pending.length, 1)
    } finally { fu.stop() }

    // 重启：落盘的那条能排回来（时间改成 20 秒后，等它真的响）
    t = new Date(2026, 10, 9, 10, 0, 0).getTime()
    const fu2 = createFollowup({ home, getConfig: () => cfg, fire: async (c) => { fired.push(c); return { ok: true } }, now: () => t })
    fu2.restore()
    assert.equal(fu2.pending.length, 1)
    fu2.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('追聊那一轮：不判阈值、不掷骰，但照走限流和免打扰', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const now = new Date(2026, 10, 8, 12, 0).getTime()
    const profile = mkProfile({ threshold: 99, triggerPmax: 0.01 })
    let delivered = 0
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      deliver: async () => { delivered += 1; return { ok: true, mode: 'dry' } },
      now: () => now,
      rnd: () => 0.99,
    })
    // 普通抽卡：阈值 99、初始权重 0 → 被拦
    const normal = await ticker.tick('private:1')
    assert.equal(normal.skipped, 'below')
    // 追聊：同样的权重、同样的掷骰，照样发出去
    const r = await ticker.tick('private:1', { followup: true })
    assert.equal(r.ok, true)
    assert.equal(r.event, 'followup')
    assert.equal(delivered, 1)
    // 免打扰里追聊也不许发
    const night = new Date(2026, 10, 9, 3, 0).getTime()
    const ticker2 = createTicker({
      getPlan: () => mkPlan(mkProfile({ quiet: { enabled: true, from: '00:00', to: '09:00' } })),
      getHome: () => home,
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => night,
      rnd: () => 0,
    })
    const q = await ticker2.tick('private:1', { followup: true })
    assert.equal(q.skipped, 'quiet')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('会话自选：手填的 session id 只收规范形状（2026-11-08）', () => {
  // 合格：GUI 那种带 session- 的、插件早期按 QQ 号起的裸 id 都收
  assert.equal(validatePinSessionId('session-75338a0e-ff8d-4d26-9fb2-8c7dfb67dcfe'), undefined)
  assert.equal(validatePinSessionId('  session-mw1q97ni  '), undefined)
  assert.equal(validatePinSessionId('onebot-group-476694593'), undefined)
  assert.equal(validatePinSessionId('onebot-private-12345678-mw7j60ix'), undefined)
  assert.equal(validatePinSessionId('75338a0e-ff8d-4d26-9fb2-8c7dfb67dcfe'), undefined)
  // 不合格：空、空格、太短、带路径
  assert.equal(validatePinSessionId(''), '没填会话 id')
  assert.equal(validatePinSessionId(undefined), '没填会话 id')
  assert.equal(validatePinSessionId('session-abc def'), '会话 id 里不该有空格')
  assert.match(String(validatePinSessionId('session-ab')), /session-/)
  assert.match(String(validatePinSessionId('D:/x/session-abc12345')), /session-/)
  // 短名只露一段，够认人又不刷屏
  assert.equal(shortPinId('session-75338a0e-ff8d-4d26-9fb2-8c7dfb67dcfe'), '75338a0e')
  assert.equal(shortPinId('onebot-group-476694593'), 'onebot-group')
  assert.equal(shortPinId(''), '')
})

test('存配置时 B站 来料四个开关不会被抹掉', async () => {
  const { readConfigFromObject, readConfig, writeConfig } = await import('../lib/companion/app.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'bbl-'))
  const home = dir
  try {
    writeConfig(home, {
      enabled: true, dryRun: true, profiles: [{ id: 'p', name: 'P' }], bindings: [],
      biliDm: true, biliAt: false, biliReply: false, biliWeight: false,
    })
    const cfg = readConfig(home)
    const again = readConfigFromObject(cfg)
    assert.equal(again.biliAt, false)
    assert.equal(again.biliReply, false)
    assert.equal(again.biliWeight, false)
    assert.equal(again.biliDm, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存配置时定时聊与刷视频偏好不会被抹掉（全局键全量写回）', async () => {
  const { readConfigFromObject, readConfig, writeConfig } = await import('../lib/companion/app.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'bbl-'))
  try {
    writeConfig(dir, { enabled: true, dryRun: true, profiles: [{ id: 'p', name: 'P' }], bindings: [] })
    const cfg = readConfig(dir)
    cfg.followupEnabled = true
    cfg.followupPerDay = 7
    cfg.followupMaxHours = 5
    cfg.followupMinSec = 120
    cfg.videoKeywordsPerRound = 2
    cfg.videoDetail = false
    cfg.videoBlockUids = ['123']
    cfg.videoBlockUps = ['某某']
    writeConfig(dir, readConfigFromObject(cfg))
    const back = readConfig(dir)
    assert.equal(back.followupEnabled, true, '定时话头开关')
    assert.equal(back.followupPerDay, 7, '每天几条')
    assert.equal(back.followupMaxHours, 5, '最长几小时')
    assert.equal(back.followupMinSec, 120, '最短多久')
    assert.equal(back.videoKeywordsPerRound, 2, '每轮几个关键词')
    assert.equal(back.videoDetail, false, '关键词补详情')
    assert.deepEqual(back.videoBlockUids, ['123'])
    assert.deepEqual(back.videoBlockUps, ['某某'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick：准备阶段拿得到整份配置上的兴趣关键词（别退回热门兜底）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 4, 12, 0).getTime()
    const profile = mkProfile({
      pool: [{ id: 'video', label: '去b站找个视频', weight: 100, bonus: 0, adapter: 'bili', hint: '', enabled: true }],
    })
    const globals = { keywords: ['AI娘', '百合'], videoPerRound: 4, videoMinPlay: 5000 }
    let seen = null
    const ticker = createTicker({
      getPlan: () => mkPlan(profile, 'private:1', globals),
      getHome: () => home,
      prepare: async (ev, info) => { seen = info.cfg; return [] },
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0,
    })

    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 100
    b.window = []
    writeBuckets(home, buckets)

    await ticker.tick('private:1')

    assert.ok(seen, 'prepare 应该被调用')
    assert.deepEqual(seen.keywords, ['AI娘', '百合'], '兴趣关键词要传到 prepare')
    assert.equal(seen.videoPerRound, 4, '刷视频参数也要传')
    assert.equal(seen.videoMinPlay, 5000)
    assert.equal(seen.threshold, profile.threshold, '这套模式自己的配置不能被覆盖掉')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('绑定关掉：整条停摆，既不涨权重也不抽卡（2026-11-09）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 10, 9, 12, 0).getTime()
    const buckets = readBuckets(home)
    bucketOf(buckets, 'private:1').w = 10
    writeBuckets(home, buckets)

    const profile = mkProfile({ risePerTick: 5, threshold: 0, triggerPmax: 1, tickMinutes: 0 })
    let delivered = 0
    const ticker = createTicker({
      getPlan: () => ({ ...mkPlan(profile), bindings: [{ chatId: 'private:1', enabled: false, profile }] }),
      getHome: () => home,
      deliver: async () => { delivered += 1; return { ok: true, mode: 'dry' } },
      now: () => now,
      rnd: () => 0,
    })
    const r = await ticker.tick('private:1')
    assert.equal(r.skipped, 'binding-off')
    assert.equal(delivered, 0)
    const after = readBuckets(home)
    assert.equal(bucketOf(after, 'private:1').w, 10, '关掉开关不该涨权重')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('绑定关掉：手里攒着没结的分也不许结算（2026-11-11）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const now = new Date(2026, 11, 11, 1, 30).getTime()
    const buckets = readBuckets(home)
    bucketOf(buckets, 'group:9').w = 6
    writeBuckets(home, buckets)
    const profile = mkProfile({ risePerTick: 5, threshold: 0, triggerPmax: 1, tickMinutes: 0 })
    const ticker = createTicker({
      getPlan: () => ({ ...mkPlan(profile), bindings: [{ chatId: 'group:9', enabled: false, profile }] }),
      getHome: () => home,
      scoreOf: () => ({ score: 10, at: now - 60000, inbound: true }),
      now: () => now,
      rnd: () => 0,
      deliver: async () => ({ ok: true, mode: 'dry' }),
    })
    const r = await ticker.tick('group:9')
    assert.equal(r.skipped, 'binding-off')
    const after = readBuckets(home)
    assert.equal(bucketOf(after, 'group:9').w, 6, '关掉的会话不该被「评分结算」改权重')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('定时话头：限流卡满也照发（2026-11-09）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    let now = new Date(2026, 10, 9, 12, 0).getTime()
    const profile = mkProfile({ threshold: 99, triggerPmax: 0.01, limitHours: 3, limitMax: 1, tickMinutes: 1 })
    let delivered = 0
    const ticker = createTicker({
      getPlan: () => mkPlan(profile),
      getHome: () => home,
      deliver: async () => { delivered += 1; return { ok: true, mode: 'dry' } },
      now: () => now,
      rnd: () => 0.99,
    })
    // 手动抽一发先占满窗口
    await ticker.tick('private:1', { force: true })
    now += 61_000
    const normal = await ticker.tick('private:1')
    assert.equal(normal.skipped, 'limit')
    // 定时话头无视限流
    const later = await ticker.tick('private:1', { followup: true })
    assert.equal(later.ok, true)
    assert.equal(delivered, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('抽中事件就按份数加分（「一段只加一次」跟着对话间隔一起拆了，11-11）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-'))
  try {
    const { readBuckets, writeBuckets, bucketOf } = await import('../lib/companion/state.mjs')
    const t0 = new Date(2026, 10, 4, 12, 0).getTime()
    const profile = mkProfile({ triggerPmax: 1, limitHours: 3, limitMax: 9 })
    let now = t0
    const ticker = createTicker({
      getPlan: () => mkPlan(profile, 'private:1'),
      getHome: () => home,
      deliver: async () => ({ ok: true, mode: 'dry' }),
      now: () => now,
      rnd: () => 0,
    })
    const buckets = readBuckets(home, 'private:1')
    const b = bucketOf(buckets, 'private:1')
    b.w = 70
    b.window = []
    writeBuckets(home, buckets)

    const first = await ticker.tick('private:1', { force: true })
    assert.equal(first.bonus, 5, '抽中就给那份加分')

    // 两分钟后又开口：照样加（不再按「段」压掉）
    now = t0 + 2 * 60_000
    const second = await ticker.tick('private:1', { force: true })
    assert.equal(second.bonus, 5, '不再看是不是同一段')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
test('回合结算：先扣一格，再按分补/追（同一把 base，计次对称）', async () => {
  const { spend, settle } = await import('../lib/companion/weight.mjs')
  const base = 40
  const floor = -30
  const spent = spend(30, base, { floor })
  assert.equal(spent, -10, '30 - 40')
  const net = (score) => Math.round((settle(spent, score, { base, floor }) - 30) * 10) / 10
  assert.equal(net(100), 8, '10 分 +120%，净赚 8')
  assert.equal(net(50), -40, '5 分 0%，只扣不补')
  assert.equal(net(0), -60, '0 分 -100% 再追扣一格（被地板 -30 挡住）')
  assert.equal(net(120), 40, '12 分 +200%，净赚 40')
})

test('他找上门那几份分：只给他起的轮，可以是负数（11-11）', async () => {
  const { refundPct } = await import('../lib/companion/weight.mjs')
  assert.equal(refundPct(80, { inbound: false }), 60, '抽卡/追聊那一下：8 分就是 8 分')
  assert.equal(refundPct(80, { inbound: true, inboundBonus: 2 }), 120, '他起的这一轮：8+2 → 10 分')
  assert.equal(refundPct(80, { inbound: true, inboundBonus: -5 }), -40, '负数把分压下来：8-5 → 3 分')
  assert.equal(refundPct(110), 150, '11 分 +150%')
  assert.equal(refundPct(120), 200, '12 分 +200%')
  assert.equal(refundPct(200), 200, '超过 12 分不越界')
  assert.equal(refundPct(-3), -100, '低于 0 分按 0 分')
})