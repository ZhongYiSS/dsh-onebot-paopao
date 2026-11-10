import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendLedger, readLedger, hourlyBuckets, LEDGER_KEEP_DAYS } from '../lib/companion/ledger.mjs'

const T0 = new Date(2026, 10, 10, 0, 0).getTime()

function tmp() {
  return mkdtempSync(join(tmpdir(), 'ledger-'))
}

test('流水：一笔一笔记、读回来是最新的在上', () => {
  const home = tmp()
  try {
    appendLedger(home, { at: T0, chatId: 'private:1', kind: 'tick', delta: 0, w0: 10, w1: 10, note: '没到点' })
    appendLedger(home, { at: T0 + 60e3, chatId: 'private:1', kind: 'rise', delta: 2, w0: 10, w1: 12 })
    const rows = readLedger(home, { chatId: 'private:1' })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].kind, 'rise')
    assert.equal(rows[0].delta, 2)
    assert.equal(rows[1].note, '没到点')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('流水：按会话分开读，别的会话不串', () => {
  const home = tmp()
  try {
    appendLedger(home, { at: T0, chatId: 'private:1', kind: 'rise', delta: 1, w0: 0, w1: 1 })
    appendLedger(home, { at: T0 + 1000, chatId: 'group:9', kind: 'rise', delta: 3, w0: 0, w1: 3 })
    assert.equal(readLedger(home, { chatId: 'group:9' }).length, 1)
    assert.equal(readLedger(home, { chatId: 'group:9' })[0].delta, 3)
    assert.equal(readLedger(home, {}).length, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('流水：按小时折叠，涨/扣/补/奖分开算，拍子也数', () => {
  const home = tmp()
  try {
    appendLedger(home, { at: T0, chatId: 'c', kind: 'tick', delta: 0, w0: 10, w1: 10, note: '没到点' })
    appendLedger(home, { at: T0 + 60e3, chatId: 'c', kind: 'rise', delta: 2, w0: 10, w1: 12 })
    appendLedger(home, { at: T0 + 90e3, chatId: 'c', kind: 'bonus', delta: 5, w0: 12, w1: 17, event: 'video' })
    appendLedger(home, { at: T0 + 120e3, chatId: 'c', kind: 'spend', delta: -50, w0: 17, w1: -20, origin: 'bubble' })
    appendLedger(home, { at: T0 + 180e3, chatId: 'c', kind: 'settle', delta: 30, w0: -20, w1: 10, score: 80 })
    // 跨到下一个小时
    appendLedger(home, { at: T0 + 3600e3 + 60e3, chatId: 'c', kind: 'rise', delta: 1, w0: 10, w1: 11 })
    const hs = hourlyBuckets(readLedger(home, { chatId: 'c' }))
    assert.equal(hs.length, 2)
    const first = hs.find((x) => x.hour === '00')
    assert.equal(first.rise, 2)
    assert.equal(first.spend, -50)
    assert.equal(first.settle, 30)
    assert.equal(first.bonus, 5)
    assert.equal(first.delta, -13)
    assert.equal(first.ticks, 2, 'tick + rise 各算一拍')
    assert.equal(first.sends, 1, '一次扣 = 她发过一轮')
    assert.equal(first.rows.length, 5)
    assert.equal(hs[0].hour, '01', '新的一小时排在最前')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('流水：太久以前的不算（滚动上限按天数切）', () => {
  const home = tmp()
  try {
    const old = T0 - (LEDGER_KEEP_DAYS + 2) * 86400_000
    appendLedger(home, { at: old, chatId: 'c', kind: 'rise', delta: 1, w0: 0, w1: 1 })
    const since = Date.now() - 48 * 3600_000
    assert.equal(readLedger(home, { chatId: 'c', since }).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
