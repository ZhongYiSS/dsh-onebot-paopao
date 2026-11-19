/**
 * 反连令牌的两种写法都要认。
 *
 * 干什么：验证 `requestToken()` 优先取 `Authorization: Bearer`、其次取 `?access_token=`。
 * 什么时候用：改动 lib/connection.js 的鉴权分支前后跑一遍。
 * 什么时候别用：这不是端到端测试，真实握手（401/升级）还要靠手动连一次核对。
 * 常见坑：Node 的 `req.headers` 值是字符串；URL 里的 token 会被 `decodeURIComponent` 一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestToken } from '../lib/connection.js'

const req = (headers = {}, url = '/ws') => ({ headers, url })

test('带 Authorization: Bearer 的头优先', () => {
  assert.equal(requestToken(req({ authorization: 'Bearer abc123' }, '/ws?access_token=zzz')), 'abc123')
})

test('大小写与多余空格都容忍', () => {
  assert.equal(requestToken(req({ authorization: '  bearer   tok-9  ' })), 'tok-9')
})

test('没有头就用 ?access_token=', () => {
  assert.equal(requestToken(req({}, '/ws?access_token=qq-token')), 'qq-token')
})

test('URL 里带编码的令牌会解码', () => {
  assert.equal(requestToken(req({}, '/ws?access_token=a%20b')), 'a b')
})

test('都没有就是空串（调用方按长度不等直接拒）', () => {
  assert.equal(requestToken(req({}, '/ws')), '')
  assert.equal(requestToken(req({})), '')
})

test('坏 URL 不抛异常', () => {
  assert.equal(requestToken({ headers: {}, url: 'http://[::1' }), '')
})