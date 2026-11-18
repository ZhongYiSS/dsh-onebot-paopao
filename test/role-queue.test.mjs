// 静态守卫：角色登记队列不许再逐条刷日志，且必须有长度上限
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../lib/bridge.js', import.meta.url)
const code = readFileSync(SRC, 'utf8')

test('过期角色登记不再逐条打日志', () => {
  assert.equal(code.includes("'角色队列里有过期条目"), false)
  assert.match(code, /staleRoleWarnAt/)
  assert.match(code, /角色队列清掉 ' \+ stale \+ ' 条过期登记/)
})

test('角色登记队列有上限，超了丢最老的', () => {
  assert.match(code, /turnRoleQueueMax/)
  const cap = /while \(chat\.pendingTurnAt\.length > queueMax\) \{[\s\S]{0,400}?chat\.pendingTurnOrigins\.shift\(\)/.exec(code)
  assert.ok(cap, '上限循环里三条队列要一起摘')
})

test('摘过期登记时三条队列同步', () => {
  const prune = /while \(chat\.pendingTurnAt\.length > 0 && Date\.now\(\) - Number\(chat\.pendingTurnAt\[0\] \|\| 0\) > ttl\) \{[\s\S]{0,400}?chat\.pendingTurnOrigins\.shift\(\)/.exec(code)
  assert.ok(prune, '过期清理也要三条一起摘')
})