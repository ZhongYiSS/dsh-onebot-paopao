/**
 * 口味账的衰减必须作用到整本账。
 *
 * 干什么：验证 `bumpTaste` 每记一次分，所有旧条目的分数都乘一次 `DECAY`（不是只乘这一轮碰到的那几条）。
 * 什么时候用：改动 lib/companion/taste.mjs 的记分/裁剪逻辑前后跑一遍。
 * 什么时候别用：它不是端到端测试，挑视频的加权排序效果还得实跑看。
 * 常见坑：`bumpTaste(home, picks, score, now)` 的 score 是 0~100（内部换算成 -1 ~ +1），50 = 「没意见」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpTaste, readTaste } from '../lib/companion/taste.mjs'

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'taste-'))
  try { return fn(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

const vid = (upMid, kw) => ({ upMid, kw })

test('旧账会随着新的一次记分一起淡出', () => withHome((home) => {
  bumpTaste(home, [vid('1001', '鲸鱼'), vid('1002', '白饭')], 100, 1_000)
  const first = readTaste(home)
  assert.ok(first.up['1001'].s > 0, '第一条应该有正分')
  const before = first.up['1002'].s

  // 第二次只碰 1001：1002 也必须跟着乘 DECAY，不能原地不动
  bumpTaste(home, [vid('1001', '鲸鱼')], 50, 2_000)
  const after = readTaste(home).up['1002'].s
  assert.ok(Math.abs(after - before * 0.98) < 1e-9, `1002 的分应该按 0.98 衰减：${before} → ${after}`)
}))

test('没有候选时不衰减（空轮别白扣）', () => withHome((home) => {
  bumpTaste(home, [vid('2001', '深海')], 90, 1_000)
  const before = readTaste(home).up['2001'].s
  assert.equal(bumpTaste(home, [], 90, 2_000), null)
  assert.equal(readTaste(home).up['2001'].s, before)
}))