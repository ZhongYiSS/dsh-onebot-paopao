import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OneBotConnection } from 'file:///D:/AI/聊天/dsh-onebot/lib/connection.js'

test('反连（noServer）模式下 address() 不抛，认 reverseHttp', () => {
  const c = new OneBotConnection({})
  // 复现线上：server 是 WebSocketServer（noServer 模式下没有 address 或直接抛）
  c.server = { address() { throw new Error('The server is operating in "noServer" mode') } }
  c.reverseHttp = { address: () => ({ address: '127.0.0.1', port: 8643 }) }
  assert.deepEqual(c.address(), { host: '127.0.0.1', port: 8643 })
})

test('两个都没有时返回 undefined，不抛', () => {
  const c = new OneBotConnection({})
  c.server = { address() { throw new Error('The server is operating in "noServer" mode') } }
  assert.equal(c.address(), undefined)
})
