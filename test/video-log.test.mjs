import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readVideos, noteSentVideo, blockVideo, unblockVideo, canPickVideo, VIDEO_KEEP_DAYS,
} from '../lib/companion/video-log.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'vlog-'))
}

test('发出去过的不再抽到；抽到没发的不占名额', () => {
  const home = tmp()
  try {
    const now = Date.now()
    assert.equal(canPickVideo(home, 'BV1aaaaaaaaa', { now }), true)
    noteSentVideo(home, { bvid: 'BV1aaaaaaaaa', title: '发过的', chatId: 'private:1', now })
    assert.equal(canPickVideo(home, 'BV1aaaaaaaaa', { now }), false)
    // again = 允许重发老视频
    assert.equal(canPickVideo(home, 'BV1aaaaaaaaa', { again: true, now }), true)
    // 从没发过的照样能抽
    assert.equal(canPickVideo(home, 'BV1bbbbbbbbb', { now }), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('30 天之后自己解禁', () => {
  const home = tmp()
  try {
    const now = Date.now()
    noteSentVideo(home, { bvid: 'BV1ccccccccc', now: now - (VIDEO_KEEP_DAYS + 1) * 86400_000 })
    assert.equal(canPickVideo(home, 'BV1ccccccccc', { now }), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('「不再推」是永久的，again 也绕不过；能恢复', () => {
  const home = tmp()
  try {
    const now = Date.now()
    blockVideo(home, 'BV1ddddddddd', now)
    assert.equal(canPickVideo(home, 'BV1ddddddddd', { again: true, now }), false)
    assert.deepEqual(Object.keys(readVideos(home, now).blocked), ['BV1ddddddddd'])
    unblockVideo(home, 'BV1ddddddddd', now)
    assert.equal(canPickVideo(home, 'BV1ddddddddd', { again: true, now }), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('重复记同一条只更新时间，不堆行', () => {
  const home = tmp()
  try {
    const now = Date.now()
    noteSentVideo(home, { bvid: 'BV1eeeeeeeee', title: '第一次', now })
    noteSentVideo(home, { bvid: 'BV1eeeeeeeee', title: '第二次', now: now + 1000 })
    const sent = readVideos(home, now + 2000).sent
    assert.deepEqual(Object.keys(sent), ['BV1eeeeeeeee'])
    assert.equal(sent['BV1eeeeeeeee'].title, '第二次')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
