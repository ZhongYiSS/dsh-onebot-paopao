import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clamp, riseByTime, canSpeak, triggerChance, release, addBonus } from '../lib/companion/weight.mjs'
import { drawEvent, normalizePercent, EVENT_POOL, mergePool } from '../lib/companion/events.mjs'
import { pruneWindow, canTrigger, countInWindow } from '../lib/companion/limit.mjs'
import { inQuiet, periodOf, parseHM } from '../lib/companion/period.mjs'
import { readState, readHistory, dayKeyOf } from '../lib/companion/state.mjs'
import { createTicker } from '../lib/companion/tick.mjs'

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

test('开口后释放：兴趣分越高掉得越多', () => {
  const low = release(80, 0, { base: 20, span: 40 })
  const high = release(80, 100, { base: 20, span: 40 })
  assert.equal(low, 60)
  assert.equal(high, 20)
})

test('事件加分夹住上限', () => {
  assert.equal(addBonus(98, 8), 100)
})

test('事件池百分比合计 100（四舍五入后允许 ±1）', () => {
  const p = normalizePercent(EVENT_POOL)
  const sum = p.reduce((s, e) => s + e.percent, 0)
  assert.ok(Math.abs(sum - 100) <= 1.5, `合计 ${sum}`)
})

test('抽事件只落在启用项上，并按份数分布', () => {
  const pool = [
    { id: 'a', weight: 100, enabled: true },
    { id: 'b', weight: 0, enabled: true },
    { id: 'c', weight: 100, enabled: false },
  ]
  for (let i = 0; i < 50; i++) assert.equal(drawEvent(pool, () => i / 50).id, 'a')
  // 只有 a 能用时，永远 a
  assert.equal(drawEvent([{ id: 'x', weight: 0, enabled: true }]), null)
})

test('mergePool 接得住旧版本存盘', () => {
  const merged = mergePool([{ id: 'chat', weight: 50, enabled: false }])
  const chat = merged.find((e) => e.id === 'chat')
  assert.equal(chat.weight, 50)
  assert.equal(chat.enabled, false)
  assert.ok(merged.some((e) => e.id === 'video'))
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
  threshold: 30, risePerTick: 0.5, triggerPmax: 1, releaseBase: 20, releaseSpan: 40,
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
    assert.equal(r2.w2, 25.5)   // 扣 20 + 兴趣分 50% × 40 = 40
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
