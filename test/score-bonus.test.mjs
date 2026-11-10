import test from 'node:test'
import assert from 'node:assert/strict'

import { refundPct, settle, REFUND_PCT } from '../lib/companion/weight.mjs'

test('补分表就是那 11 档', () => {
  for (let s = 0; s <= 10; s += 1) {
    assert.equal(refundPct(s * 10), REFUND_PCT[s], `${s} 分`)
  }
})

test('「他找上门多给几分」可调（默认 2）', () => {
  // 8 分：不加 = 60%；+2 档 → 10 分 = 120%
  assert.equal(refundPct(80, { inbound: true }), 120)
  assert.equal(refundPct(80, { inbound: true, inboundBonus: 0 }), 60)
  assert.equal(refundPct(80, { inbound: true, inboundBonus: 1 }), 80)
  // 6 分 +2 → 8 分 = 60%
  assert.equal(refundPct(60, { inbound: true, inboundBonus: 2 }), 60)
  // 封顶 10 分，别越界
  assert.equal(refundPct(100, { inbound: true, inboundBonus: 5 }), 120)
})

test('settle 按可调加分结算', () => {
  // 底 40、当前 20、8 分（不加分）= +60% × 40 = +24 → 44
  assert.equal(settle(20, 80, { base: 40, floor: -100 }), 44)
  // 同一条 +2 档（10 分 = +120%）= +48 → 68
  assert.equal(settle(20, 80, { base: 40, floor: -100, inbound: true, inboundBonus: 2 }), 68)
  // 0 分 = -100% → 20 - 40 = -20
  assert.equal(settle(20, 0, { base: 40, floor: -100 }), -20)
})
