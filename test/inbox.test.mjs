/**
 * 收件箱 + 「来料优先」的测试。
 * 关键保证：① 有来料时不被阈值/掷骰挡；② 免打扰期间不开口、料也不丢；③ 真发出去才取走。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushInbox, peekInbox, dropInbox, formatItem } from '../lib/companion/inbox.mjs'
import { createTicker } from '../lib/companion/tick.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'bubble-inbox-'))
}

const profile = {
  id: 'p1',
  name: '日常',
  threshold: 90,
  risePerTick: 0,
  tickMinutes: 5,
  triggerPmax: 0.1,
  releaseBase: 20,
  limitHours: 1,
  limitMax: 10,
  idleMinutes: 0,
  quiet: { enabled: false, from: '00:00', to: '07:00' },
  pool: [{ id: 'say', label: '说句话', weight: 100, enabled: true, bonus: 5 }],
}

test('收件箱：能塞、能看、真发了才取走，且不重复', () => {
  const home = tempHome()
  try {
    assert.equal(peekInbox(home, 'c1').length, 0)
    const n = pushInbox(home, 'c1', [
      { key: 'k1', kind: 'dm', who: '是钟壹', text: '在吗', at: Date.now() - 60_000, url: 'https://x/1' },
      { key: 'k1', kind: 'dm', who: '是钟壹', text: '在吗', at: Date.now() - 60_000 },
      { key: 'k2', kind: 'reply', who: '路人', text: '哈哈', at: Date.now() },
    ])
    assert.equal(n, 2, '同一 key 只进一次')
    assert.equal(peekInbox(home, 'c1').length, 2)
    // 别的会话看不见
    assert.equal(peekInbox(home, 'c2').length, 0)

    const line = formatItem(peekInbox(home, 'c1')[0], Date.now())
    assert.match(line, /私信 · 是钟壹/)
    assert.match(line, /1 分钟前/)
    assert.match(line, /在吗/)

    dropInbox(home, 'c1', ['k1'])
    assert.equal(peekInbox(home, 'c1').length, 1)
    assert.equal(peekInbox(home, 'c1')[0].key, 'k2')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('有来料：绕过阈值与掷骰，直接把这条递出去，发完清空', async () => {
  const home = tempHome()
  try {
    pushInbox(home, 'c1', [{ key: 'k1', kind: 'dm', who: '是钟壹', text: '在吗', at: Date.now() - 30_000 }])
    const calls = []
    const ticker = createTicker({
      getPlan: () => ({ enabled: true, dryRun: false, bindings: [{ chatId: 'c1', enabled: true, profile }] }),
      getHome: () => home,
      prepare: async () => [],
      deliver: async (d) => { calls.push(d); return { ok: true, mode: 'qq' } },
      idleCheck: async () => true,
      scoreOf: () => null,
      log: () => {},
      now: () => new Date('2026-11-08T15:00:00+08:00').getTime(),
      rnd: () => 0.999, // 掷骰必挂：阈值 90、p 只有 0.1
    })
    const r = await ticker.tick('c1', { force: false, fresh: true })
    assert.equal(calls.length, 1, '来料应该照发，不掷骰')
    assert.match(calls[0].text, /私信 · 是钟壹/)
    assert.match(calls[0].text, /在吗/)
    assert.equal(r.event, 'watch')
    assert.equal(peekInbox(home, 'c1').length, 0, '发出去才取走')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('免打扰：不开口，料留着等早上', async () => {
  const home = tempHome()
  try {
    pushInbox(home, 'c1', [{ key: 'k1', kind: 'dm', who: '是钟壹', text: '睡了没', at: Date.now() }])
    const calls = []
    const night = { ...profile, quiet: { enabled: true, from: '00:00', to: '07:00' } }
    const ticker = createTicker({
      getPlan: () => ({ enabled: true, dryRun: false, bindings: [{ chatId: 'c1', enabled: true, profile: night }] }),
      getHome: () => home,
      deliver: async (d) => { calls.push(d); return { ok: true, mode: 'qq' } },
      idleCheck: async () => true,
      log: () => {},
      now: () => new Date('2026-11-08T03:00:00+08:00').getTime(),
      rnd: () => 0.5,
    })
    const r = await ticker.tick('c1', { force: false, fresh: true })
    assert.equal(r.skipped, 'quiet')
    assert.equal(calls.length, 0)
    assert.equal(peekInbox(home, 'c1').length, 1, '料不能丢')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没来料时照旧：低于阈值就不开口', async () => {
  const home = tempHome()
  try {
    const calls = []
    const ticker = createTicker({
      getPlan: () => ({ enabled: true, dryRun: false, bindings: [{ chatId: 'c1', enabled: true, profile }] }),
      getHome: () => home,
      deliver: async (d) => { calls.push(d); return { ok: true, mode: 'qq' } },
      idleCheck: async () => true,
      log: () => {},
      now: () => Date.now(),
      rnd: () => 0.5,
    })
    const r = await ticker.tick('c1', { force: false, fresh: true })
    assert.equal(r.skipped, 'below')
    assert.equal(calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
