import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readQq, writeQq } from 'file:///D:/AI/聊天/dsh-onebot/lib/companion/ext-settings.mjs'

// 2026-11-14 外部审计（P1-2 / P1-8）：
// ① lines 类型原来没有分支 —— 读回来是 String(数组) 拼的逗号串，多行框里全是假的；
// ② 文本框清空一律被当成「没填、不提交」——「人格改回默认」「目录清掉」都存不进去。

function mk(init) {
  let cfg = { ...init }
  return {
    getConfig: () => ({ ...cfg }),
    setConfig: (patch) => { cfg = { ...cfg, ...patch }; return true },
    _dump: () => ({ ...cfg }),
  }
}

test('lines 字段：数组原样读回，字符串按换行切', () => {
  const a = readQq(mk({ mediaFreeDirs: ['D:/a', 'D:/b'] })).fields.find((f) => f.key === 'mediaFreeDirs')
  assert.deepEqual(a.value, ['D:/a', 'D:/b'])

  const b = readQq(mk({ mediaFreeDirs: 'D:/a\nD:/b' })).fields.find((f) => f.key === 'mediaFreeDirs')
  assert.deepEqual(b.value, ['D:/a', 'D:/b'])
})

test('文本框清空 = 明确写回空串（回到默认），不是「不提交」', () => {
  const onebot = mk({ promptExtra: '原样一段人设', memeDir: 'D:/somewhere/memes' })
  writeQq(onebot, { promptExtra: '', memeDir: '   ' })
  const after = onebot._dump()
  assert.equal(after.promptExtra, '')
  assert.equal(after.memeDir, '')
})

test('非文本类型的空值仍然「不提交」，别把开关/数字打回默认', () => {
  const onebot = mk({ debounceMs: 5000 })
  writeQq(onebot, { debounceMs: '' })
  assert.equal(onebot._dump().debounceMs, 5000)
})