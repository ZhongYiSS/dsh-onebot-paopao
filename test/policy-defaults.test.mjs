// 2026-11-15 哥哥定：不用「安全模式」当默认——回原版 onebot 的做法。
// 这里钉三件事：
//   ① schema 默认值：groupPreset 留空、dmRestricted 关、groupPolicy 开放
//   ② 群聊预设留空**不再**拒绝开会话（以前 11-14 审计为了 fail-closed 加过，现在按哥哥的意思撤掉）
//   ③ 面板快照（settings-remote）与 zod 默认一致，不然面板显示一套、服务端跑另一套
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Config, resolvePolicy } from '../lib/index.js'
import { SCHEMA_DEFAULTS } from '../lib/settings-remote.js'

const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const registrySrc = readFileSync(new URL('../lib/registry.js', import.meta.url), 'utf8')
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('默认值回到原版 onebot：群聊预设留空、私聊分级关、群聊开放', () => {
  const d = Config({})
  assert.equal(d.groupPreset, '', 'groupPreset 默认应该是空（跟其它会话一样走 agentPreset）')
  assert.equal(d.dmRestricted, false, 'dmRestricted 默认应该关')
  assert.equal(d.groupPolicy, 'open', 'groupPolicy 默认应该是 open（白名单仍由 groupAllowFrom 卡）')
})

test('面板快照与 zod 默认一致（差一个就会「显示一套、跑另一套」）', () => {
  assert.equal(SCHEMA_DEFAULTS.groupPolicy, 'open')
  assert.equal(SCHEMA_DEFAULTS.dmRestricted, false)
  // 面板客户端那份 DEFAULTS 也一起钉住
  assert.match(clientSrc, /groupPolicy: "open"/, 'client.js 的 DEFAULTS 没跟着改')
  assert.match(clientSrc, /dmRestricted: false/, 'client.js 的 DEFAULTS 没跟着改')
})

test('群聊预设留空不再拒绝开会话（只对填了名字的才校验）', () => {
  assert.ok(!/groupWanted === ''/.test(registrySrc), '还有「留空就 throw」的分支')
  assert.ok(!registrySrc.includes('群聊预设没填'), '还在报「群聊预设没填」')
  assert.ok(registrySrc.includes("if (isGroupChat && groupWanted !== '')"), '填了名字的那条校验必须留着')
})

test('默认配置下群聊放行、私聊只认管理员（跟原版一样）', () => {
  const policy = resolvePolicy({ ...Config({}), adminUsers: ['1094335744'] })
  assert.equal(policy.groupPolicy, 'open', '群聊默认放开')
  assert.equal(policy.dmPolicy, 'open', '私聊策略默认 open')
  assert.deepEqual(policy.adminUsers, ['1094335744'])
  // open 的私聊分支只认管理员 —— 白名单（allowFrom）不开后门，这点跟原版一致
  assert.deepEqual(policy.allowFrom, [])
})

// 2026-11-15：QQ 客户端不再固定是 NapCat，「必做清单」里不许再要求填 NapCat 目录，
// 也不许再出现「第一次用」卡的非 NapCat 文案（他是照面板学会这套的，文案必须一致）。
test('必做清单不再要求 NapCat 目录（客户端现在可以是别人的）', async () => {
  const { readFileSync } = await import('node:fs')
  const appSrc = readFileSync(new URL('../lib/companion/app.mjs', import.meta.url), 'utf8')
  assert.ok(!appSrc.includes("key: 'napcatDir'"), '清单里还挂着 NapCat 目录')
  // 清单剩五项，且都是跟聊天本身有关的
  const start = appSrc.indexOf('function readSetup(cfg)')
  const end = appSrc.indexOf('function readAccess()')
  const body = appSrc.slice(start, end)
  const keys = [...body.matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1])
  assert.deepEqual(keys, ['ownerQQ', 'workspace', 'memeDir', 'bindings', 'events'])
})
