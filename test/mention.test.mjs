import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectMention, detectUserMention } from 'file:///D:/AI/聊天/dsh-onebot/lib/cq.js'

// 2026-11-14 审计（P2-12）：@全体成员 以前被当成「@本鱼」——群里任何人 @all
// 都能无条件把本鱼叫醒，等于绕过「必须 @」这条限制。

const BOT = '3490240357'
const OWNER = '1094335744'

test('@本鱼 算，@全体成员 不算', () => {
  assert.equal(detectMention([{ type: 'at', data: { qq: BOT } }], '', BOT, ''), true)
  assert.equal(detectMention([{ type: 'at', data: { qq: 'all' } }], '', BOT, ''), false)
})

test('CQ 串里同理（没有分段数组时走正则）', () => {
  assert.equal(detectMention(undefined, '[CQ:at,qq=' + BOT + '] 在吗', BOT, ''), true)
  assert.equal(detectMention(undefined, '[CQ:at,qq=all] 在吗', BOT, ''), false)
})

test('@主人 算「叫到主人」，@全体 不算', () => {
  assert.equal(detectUserMention([{ type: 'at', data: { qq: OWNER } }], '', OWNER), true)
  assert.equal(detectUserMention([{ type: 'at', data: { qq: 'all' } }], '', OWNER), false)
  assert.equal(detectUserMention(undefined, '[CQ:at,qq=all]', OWNER), false)
})