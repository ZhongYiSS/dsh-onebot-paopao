// 刷视频的「喜好」那几块：关键词轮转、不感兴趣、口味账。
// 全部不需要网络，纯函数 + 一个临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickKeywords, isBlocked } from '../lib/companion/adapters/bili.mjs'
import { readTaste, bumpTaste, tasteScore } from '../lib/companion/taste.mjs'

test('关键词：词不多就全用，词多了轮着取、游标往下走', () => {
  assert.deepEqual(pickKeywords(['a', 'b'], 3, {}), ['a', 'b'])
  const st = {}
  assert.deepEqual(pickKeywords(['a', 'b', 'c', 'd', 'e'], 3, st), ['a', 'b', 'c'])
  assert.deepEqual(pickKeywords(['a', 'b', 'c', 'd', 'e'], 3, st), ['d', 'e', 'a'])
  assert.equal(st.keywordCursor, 1)
})

test('不感兴趣：标题、UP 名、标签、分区命中都算，拉黑 UP 主按 mid 或名字', () => {
  const v = { title: '今天的猫', up: '猫猫头', upMid: '123', tags: '萌宠,日常', tname: '动物' }
  assert.equal(isBlocked(v, { blockWords: ['标题党'] }), false)
  assert.equal(isBlocked(v, { blockWords: ['萌宠'] }), true)   // 标签命中
  assert.equal(isBlocked(v, { blockWords: ['动物'] }), true)   // 分区命中
  assert.equal(isBlocked(v, { blockWords: ['猫猫头'] }), true) // UP 名命中
  assert.equal(isBlocked(v, { blockUids: ['123'] }), true)
  assert.equal(isBlocked(v, { blockUps: ['猫猫头'] }), true)
  assert.equal(isBlocked(v, { blockUids: ['999'], blockUps: ['别人'] }), false)
})

test('口味账：10 分加、0 分减、5 分不动，UP 只替自己说话', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taste-'))
  try {
    assert.equal(bumpTaste(dir, [{ upMid: 'u1', kw: 'AI娘' }], 50), null) // 5 分不动
    assert.deepEqual(readTaste(dir), { up: {}, kw: {} })

    bumpTaste(dir, [{ upMid: 'u1', kw: 'AI娘' }], 100)
    const t = readTaste(dir)
    assert.equal(t.up.u1.s, 1)
    assert.equal(t.kw['AI娘'].s, 1)

    bumpTaste(dir, [{ upMid: 'u2', kw: '百合' }], 0)
    const t2 = readTaste(dir)
    assert.ok(t2.up.u2.s < 0)

    // 排序：喜欢的在前，没账的中间，被扣分的最后
    const ranked = [
      { upMid: 'u2', from: '百合' },
      { upMid: 'u9', from: '别的' },
      { upMid: 'u1', from: 'AI娘' },
    ].sort((a, b) => tasteScore(t2, b.upMid, b.from) - tasteScore(t2, a.upMid, a.from))
    assert.equal(ranked[0].upMid, 'u1')
    assert.equal(ranked[2].upMid, 'u2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
