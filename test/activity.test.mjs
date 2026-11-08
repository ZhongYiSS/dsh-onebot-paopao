/**
 * 动作账：B站 那边动手做的事，也要进同一本「做过的事」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteAction } from '../lib/companion/activity.mjs'
import { readHistory } from '../lib/companion/state.mjs'

test('点赞/评论/私信都记一条，带 kind=bili-act 和链接', () => {
  const home = mkdtempSync(join(tmpdir(), 'bubble-act-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(noteAction('点赞', { bvid: 'BV1nWxZ6AE8E' }), true)
    assert.equal(noteAction('评论', { bvid: 'BV1nWxZ6AE8E', title: '柠檬酸菜鱼', text: '0:04 最酸' }), true)
    assert.equal(noteAction('私信', { title: 'UID 233078950', text: '在吗', url: 'https://space.bilibili.com/233078950' }), true)

    const rows = readHistory(join(home, 'bubble'), 10)
    assert.equal(rows.length, 3)
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
    assert.equal(byLabel['点赞'].kind, 'bili-act')
    assert.equal(byLabel['点赞'].chatId, 'bili')
    assert.equal(byLabel['点赞'].mode, 'bili')
    assert.match(byLabel['点赞'].targets[0].url, /BV1nWxZ6AE8E/)
    assert.equal(byLabel['评论'].targets[0].title, '柠檬酸菜鱼')
    assert.equal(byLabel['评论'].text, '0:04 最酸')
    assert.match(byLabel['私信'].targets[0].url, /space\.bilibili\.com/)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})
