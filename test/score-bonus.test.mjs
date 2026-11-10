import test from 'node:test'
import assert from 'node:assert/strict'

import { refundPct, settle, REFUND_PCT } from '../lib/companion/weight.mjs'

test('补分表就是那 13 档（0~12 分）', () => {
  assert.equal(REFUND_PCT.length, 13)
  for (let s = 0; s <= 12; s += 1) {
    assert.equal(refundPct(s * 10), REFUND_PCT[s], `${s} 分`)
  }
  // 11/12 分是 11-11 哥哥要的两档
  assert.equal(refundPct(110), 150)
  assert.equal(refundPct(120), 200)
})

test('「他找上门多给几分」可调（默认 2）', () => {
  // 8 分：不加 = 60%；+2 档 → 10 分 = 120%
  assert.equal(refundPct(80, { inbound: true }), 120)
  assert.equal(refundPct(80, { inbound: true, inboundBonus: 0 }), 60)
  assert.equal(refundPct(80, { inbound: true, inboundBonus: 1 }), 80)
  // 6 分 +2 → 8 分 = 60%
  assert.equal(refundPct(60, { inbound: true, inboundBonus: 2 }), 60)
  // 封顶 12 分，别越界（10 + 5 档 = 15 → 按 12 算 = 200%）
  assert.equal(refundPct(100, { inbound: true, inboundBonus: 5 }), 200)
})

test('settle 按可调加分结算', () => {
  // 底 40、当前 20、8 分（不加分）= +60% × 40 = +24 → 44
  assert.equal(settle(20, 80, { base: 40, floor: -100 }), 44)
  // 同一条 +2 档（10 分 = +120%）= +48 → 68
  assert.equal(settle(20, 80, { base: 40, floor: -100, inbound: true, inboundBonus: 2 }), 68)
  // 0 分 = -100% → 20 - 40 = -20
  assert.equal(settle(20, 0, { base: 40, floor: -100 }), -20)
})
