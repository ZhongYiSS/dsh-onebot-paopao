import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QQ_FIELDS, writeQq, readQq } from 'file:///D:/AI/聊天/dsh-onebot/lib/companion/ext-settings.mjs'

// 哥哥 11-13：「允许做的事」点了看不出开没开 —— 真因是读回来被 String() 压成了
// "voice" 这种串，面板拿到字符串当空数组，什么都不亮，点一下又只存下刚点的那一项。
const ALL = ['voice', 'sticker', 'image', 'video', 'forward', 'draw', 'search', 'bili']

function readBack(value) {
  const onebot = { getConfig: () => ({ groupAbilities: value }), setConfig: () => true }
  const out = readQq(onebot)
  return out.fields.find((f) => f.key === 'groupAbilities')
}

test('多选字段：数组原样读回来（八项都亮）', () => {
  const f = readBack([...ALL])
  assert.equal(f.type, 'checks')
  assert.deepEqual(f.value, ALL)
})

test('多选字段：老配置里被压成字符串也认', () => {
  assert.deepEqual(readBack('voice,sticker,draw').value, ['voice', 'sticker', 'draw'])
  assert.deepEqual(readBack('').value, [])
  assert.deepEqual(readBack(undefined).value, [])
})

test('多选字段：写进去丢掉不认识的词，字符串也收', () => {
  const saved = []
  const onebot = { setConfig: (p) => { saved.push(p); return true } }
  writeQq(onebot, { groupAbilities: ['voice', '乱写的', 'draw'] })
  writeQq(onebot, { groupAbilities: 'voice, bili' })
  assert.deepEqual(saved[0].groupAbilities, ['voice', 'draw'])
  assert.deepEqual(saved[1].groupAbilities, ['voice', 'bili'])
})

test('多选字段：一个都不选 = 存空数组（只能在群里聊天）', () => {
  const saved = []
  const onebot = { setConfig: (p) => { saved.push(p); return true } }
  writeQq(onebot, { groupAbilities: [] })
  assert.deepEqual(saved[0].groupAbilities, [])
  const f = QQ_FIELDS.find((x) => x.key === 'groupAbilities')
  assert.equal(f.options.length, ALL.length)
  assert.deepEqual(f.options.map((o) => o.key), ALL)
})