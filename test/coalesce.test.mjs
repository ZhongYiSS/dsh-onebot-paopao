// 11-14 体检 C8：防抖合并窗把几条消息并成一轮时，包装与指令只能出现一次。
// 以前是把每条的整份 final（含 <chat_memory>、群前缀、<user_message> 外壳）直接 join，
// 3 条连发就是 3 份记忆块、3 层嵌套边界，模型看到的是叠起来的指令。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWrappedParts } from '../lib/inbound.js'

const part = (inner, nick = '甲') => ({
  nickname: nick,
  text: '<chat_memory>\n旧事若干\n</chat_memory>\n[群成员] <user_message qq="10001" nickname="' + nick + '">' + inner + '</user_message>',
})

test('合并：包装、记忆块、群前缀只出现一次', () => {
  const merged = mergeWrappedParts([part('一'), part('二'), part('三')], ['甲'])
  assert.equal(merged.split('<chat_memory>').length - 1, 1)
  assert.equal(merged.split('<user_message').length - 1, 1)
  assert.equal(merged.split('</user_message>').length - 1, 1)
  assert.equal(merged.split('[群成员]').length - 1, 1)
})

test('合并：三条正文都在，且包在同一个外壳里', () => {
  const merged = mergeWrappedParts([part('一'), part('二'), part('三')], ['甲'])
  for (const t of ['一', '二', '三']) assert.ok(merged.includes(t), t + ' 丢了')
  const open = merged.lastIndexOf('<user_message')
  const close = merged.lastIndexOf('</user_message>')
  assert.ok(open < merged.indexOf('一') || merged.indexOf('一') > open)
  assert.ok(merged.indexOf('三') < close, '正文必须在闭合标签之前')
})

test('合并：不同说话人加昵称前缀', () => {
  const merged = mergeWrappedParts([part('一', '甲'), part('二', '乙')], ['甲', '乙'])
  assert.ok(merged.includes('甲：一'))
  assert.ok(merged.includes('乙：二'))
})

test('合并：只有一条时原样返回（不额外加标题）', () => {
  const one = part('只有一句')
  assert.equal(mergeWrappedParts([one], ['甲']), one.text)
})

test('合并：认不出外壳时退回老办法，消息不丢', () => {
  const merged = mergeWrappedParts([{ text: '裸一', nickname: '甲' }, { text: '裸二', nickname: '甲' }], ['甲'])
  assert.ok(merged.includes('裸一') && merged.includes('裸二'))
})
