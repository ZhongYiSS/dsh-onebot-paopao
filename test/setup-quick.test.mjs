import test from 'node:test'
import assert from 'node:assert/strict'

// 2026-11-15 哥哥定：主人 QQ / 工作区 / 表情包目录直接放在首页必做清单里改。
// 钉两件事：①哪三项能就地改、改的是哪个配置键 ②填错要被挡住（不是静默存进去）。
const app = await import('../lib/companion/app.mjs')
const { SETUP_EDITABLE, quickEdit } = app

test('必做清单：能就地改的正好三项，且指向正确的配置键', () => {
  assert.deepEqual(Object.keys(SETUP_EDITABLE).sort(), ['memeDir', 'ownerQQ', 'workspace'])
  assert.equal(SETUP_EDITABLE.ownerQQ, 'ownerQQ')
  assert.equal(SETUP_EDITABLE.workspace, 'workspacePath')
  assert.equal(SETUP_EDITABLE.memeDir, 'memeDir')
})

test('必做清单：不认识的东西一律拒，别让人以为存上了', () => {
  for (const bad of ['', 'port', 'accessToken', 'workspacePath', 'adminUsers']) {
    const r = quickEdit(bad, 'x')
    assert.equal(r.field, '', bad + ' 不该被认')
    assert.match(r.error, /只认三项/)
  }
})

test('必做清单：主人 QQ 只认数字号，空格会先被去掉', () => {
  assert.equal(quickEdit('ownerQQ', ' 1094335744 ').value, '1094335744')
  assert.equal(quickEdit('ownerQQ', ' 1094335744 ').error, '')
  assert.equal(quickEdit('ownerQQ', '').error, '')          // 清空允许（等于不填）
  for (const bad of ['abc', '123', '1094335744123', '1094335744a', '@1094335744']) {
    assert.match(quickEdit('ownerQQ', bad).error, /要填一串数字/, bad)
  }
})

test('必做清单：工作区和表情包目录不清空格以外的东西', () => {
  const r1 = quickEdit('workspace', ' D:\\AGI ')
  assert.equal(r1.value, 'D:\\AGI')
  assert.equal(r1.error, '')
  const r2 = quickEdit('memeDir', 'D:\\图\\表情包')
  assert.equal(r2.value, 'D:\\图\\表情包')
  assert.equal(r2.error, '')
})

test('必做清单：这三项都在 setConfig 白名单里（不然又是能填不能存）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const i = src.indexOf('setConfig: (patch) => {')
  assert.ok(i > 0, '找不到 setConfig 实现')
  const seg = src.slice(i, i + 12000)
  for (const k of ['ownerQQ', 'memeDir', 'workspacePath']) {
    assert.ok(seg.includes("'" + k + "'"), 'setConfig 白名单里没有 ' + k)
  }
})
