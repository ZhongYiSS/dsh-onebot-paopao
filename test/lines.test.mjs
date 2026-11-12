import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QQ_FIELDS, writeQq, readQq } from 'file:///D:/AI/聊天/dsh-onebot/lib/companion/ext-settings.mjs'
test('多行字段：按行拆、清空写回空数组', () => {
  const f = QQ_FIELDS.find((x) => x.key === 'sensitivePatterns')
  assert.ok(f)
  assert.equal(f.type, 'lines')
  const saved = []
  const onebot = { setConfig: (p) => { saved.push(p); return true } }
  writeQq(onebot, { sensitivePatterns: ['rm -rf', '关机'] })
  writeQq(onebot, { sensitivePatterns: [] })
  assert.deepEqual(saved[0].sensitivePatterns, ['rm -rf', '关机'])
  assert.deepEqual(saved[1].sensitivePatterns, [])
})
