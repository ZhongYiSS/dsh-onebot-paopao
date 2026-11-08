/**
 * 会话自选（pins）的分支测试：直接拿真的 ChatRegistry 原型，把「宿主那几样」换成假的。
 * 这样不用重启宿主也能验「钉自己 / 钉假的 / 抢别人的 / 挂不上要退回」四条路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatRegistry } from '../lib/registry.js'

const SID = 'session-75338a0e-ff8d-4d26-9fb2-8c7dfb67dcfe'
const OTHER = 'session-11111111-2222-3333-4444-555555555555'

/** 造一个只有 pins 真写盘、其余全靠假的 registry。 */
function makeRegistry({ onDisk = [SID], live = new Map(), failResume = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'))
  const pins = join(dir, 'chat-session-pins.json')
  const retiredFile = join(dir, 'retired-sessions.json')
  writeFileSync(retiredFile, '[]', 'utf8')
  const r = Object.create(ChatRegistry.prototype)
  Object.assign(r, {
    chats: new Map(live),
    bySession: new Map(),
    evictedChats: new Map(),
    pendingCreates: new Map(),
    brokenSessions: new Set(),
    retiredSessionIds: new Set(),
    resumed: [],
    settings: new Map(),
    deps: {
      config: { mediaDir: dir },
      log: () => {},
      onChatRemoved: () => {},
      sessionPersistence: {
        open: async (id) => {
          const want = String(id)
          if (!onDisk.includes(want) && !onDisk.includes(want.replace(/^session-/, 'session-'))) {
            throw new Error('no such session: ' + want)
          }
          return { header: { agentPreset: undefined }, read: async () => ({ events: [] }), close: async () => {} }
        },
      },
      agents: {},
    },
  })
  // 只保留被测到的真方法，其余按需覆盖
  r.saveMapping = async () => {}
  r.saveRetired = async () => { writeFileSync(retiredFile, JSON.stringify([...r.retiredSessionIds]), 'utf8') }
  r.noteSessionEvent = () => {}
  r.getSettings = () => ({
    get interimOverride() { return undefined },
    get goal() { return undefined },
    get workspacePath() { return undefined },
  })
  r.clearInterimTimers = () => {}
  r.resumeWithRetry = async (chatId, sessionId) => {
    if (failResume.includes(sessionId)) throw new Error('接不上 ' + sessionId)
    r.resumed.push([chatId, sessionId])
    const chat = { chatId, sessionId, busy: false, dispose: async () => {} }
    r.chats.set(chatId, chat)
    return chat
  }
  r.pinsFile = pins
  r.retiredFile = retiredFile
  r.dir = dir
  return r
}

const readPins = (r) => JSON.parse(readFileSync(r.pinsFile, 'utf8'))

test('钉自己现在这个会话：不卸不挂，顺手把它从退休名单里放回来', async () => {
  const live = new Map([['private:1', { chatId: 'private:1', sessionId: SID, busy: false, dispose: async () => {} }]])
  const r = makeRegistry({ live })
  r.retiredSessionIds.add(SID)   // 真实情况：这条正在用的会话还挂在退休名单里
  const out = await r.pinSession('private:1', SID)
  assert.equal(out.ok, true)
  assert.equal(out.unchanged, true)
  assert.equal(r.resumed.length, 0, '不该重挂一遍')
  assert.equal(r.chats.get('private:1').sessionId, SID)
  assert.equal(r.retiredSessionIds.has(SID), false, '钉住它的同时要解退休，否则重启会丢')
  assert.equal(readPins(r)['private:1'], SID)
  rmSync(r.dir, { recursive: true, force: true })
})

test('钉一个盘上没有的 id：not-found，pins 一个字都不写', async () => {
  const r = makeRegistry({ onDisk: [] })
  const out = await r.pinSession('private:1', OTHER)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'not-found')
  assert.throws(() => readPins(r), 'pins 文件不该被创建')
  rmSync(r.dir, { recursive: true, force: true })
})

test('会话正开着（GUI 在用）：给 in-use，别退休、别写 pins', async () => {
  const r = makeRegistry({ onDisk: ['session-11111111-2222'] })
  r.chats.set('private:1', { chatId: 'private:1', sessionId: 'old-1', busy: false })
  r.resumeWithRetry = async () => { throw new Error('session "s-1" is already owned by an active write handle') }
  const out = await r.pinSession('private:1', 'session-11111111-2222')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'in-use')
  assert.ok(/正开着/.test(out.message))
  // 不能进退休名单（进了就永久黑名单，关掉 GUI 也接不回来）
  assert.equal(r.retiredSessionIds.has('session-11111111-2222'), false)
  assert.equal(r.brokenSessions.has('session-11111111-2222'), false)
  // pins 要退回去
  assert.equal(readPins(r)['private:1'], undefined)
  rmSync(r.dir, { recursive: true, force: true })
})

test('形状不对的 id：bad-id', async () => {
  const r = makeRegistry()
  const out = await r.pinSession('private:1', 'session-ab')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'bad-id')
  rmSync(r.dir, { recursive: true, force: true })
})

test('想抢别人的会话：taken', async () => {
  const live = new Map([['private:1', { chatId: 'private:1', sessionId: SID, busy: false, dispose: async () => {} }]])
  const r = makeRegistry({ live })
  const out = await r.pinSession('group:2', SID)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'taken')
  rmSync(r.dir, { recursive: true, force: true })
})

test('换到另一条会话：卸旧挂新，pins 换过去', async () => {
  const old = 'session-99999999-8888-7777-6666-555555555555'
  const live = new Map([['private:1', { chatId: 'private:1', sessionId: old, busy: false, dispose: async () => {} }]])
  const r = makeRegistry({ live, onDisk: [old, SID] })
  const out = await r.pinSession('private:1', SID)
  assert.equal(out.ok, true)
  assert.equal(out.sessionId, SID)
  assert.deepEqual(r.resumed, [['private:1', SID]], '只该挂一次目标会话')
  assert.equal(r.chats.get('private:1').sessionId, SID)
  assert.equal(readPins(r)['private:1'], SID)
  rmSync(r.dir, { recursive: true, force: true })
})

test('目标挂不上：pins 退回原样，旧会话接回来', async () => {
  const old = 'session-99999999-8888-7777-6666-555555555555'
  const live = new Map([['private:1', { chatId: 'private:1', sessionId: old, busy: false, dispose: async () => {} }]])
  const r = makeRegistry({ live, onDisk: [old, SID], failResume: [SID] })
  const out = await r.pinSession('private:1', SID)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'resume-failed')
  assert.equal(r.chats.get('private:1').sessionId, old, '旧会话要接回来')
  assert.deepEqual(r.resumed, [['private:1', old]])
  assert.deepEqual(readPins(r), {}, 'pins 不该留下失败的记录')
  rmSync(r.dir, { recursive: true, force: true })
})

test('改回自动：只删这一条，当前会话不动', async () => {
  const live = new Map([['private:1', { chatId: 'private:1', sessionId: SID, busy: false, dispose: async () => {} }]])
  const r = makeRegistry({ live })
  await r.pinSession('private:1', SID)
  const out = await r.unpinSession('private:1')
  assert.equal(out.ok, true)
  assert.equal(r.chats.get('private:1').sessionId, SID)
  assert.deepEqual(readPins(r), {})
  rmSync(r.dir, { recursive: true, force: true })
})
