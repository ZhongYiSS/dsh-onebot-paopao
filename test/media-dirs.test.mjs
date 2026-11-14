import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshHomeDir, forbiddenReason, productRoots, sendRootsFor } from '../lib/media-dirs.js'

// 2026-11-14：发文件围栏改成「先看谁在要，再看文件在哪」。
// 这几条盯着三件事：硬拒清单不管谁要都拦、管理员回合不设目录围栏、群成员回合工作区随开关。

test('硬拒清单：宿主的会话/配置/令牌，谁都发不出去', () => {
  const home = dshHomeDir()
  const bad = [
    join(home, 'sessions', 'ws', 'session.v4.jsonl.zstd'),
    join(home, 'onebot', 'settings.json'),
    join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    join(home, 'credentials.yaml'),
  ]
  for (const p of bad) assert.notEqual(forbiddenReason(p), null, p)
})

test('硬拒清单：密钥目录与钥匙类文件名', () => {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  for (const p of [
    join(home, '.ssh', 'id_ed25519'),
    join(home, '.aws', 'credentials'),
    'D:/work/.env',
    'D:/work/.env.local',
    'D:/work/server.pem',
    'D:/work/id_rsa',
    'D:/work/.npmrc',
  ]) {
    assert.notEqual(forbiddenReason(p), null, p)
  }
})

test('硬拒清单不误伤产物目录和普通文件', () => {
  const home = dshHomeDir()
  for (const p of [
    join(home, 'media', 'onebot', 'stickers', 'a.png'),
    join(home, 'bubble', 'video-cache.json'),
    join(home, 'storages', 'x', 'out.png'),
    'D:/AI/图片/表情包/memes/骄傲.png',
    'D:/AI/out/notes.txt',
  ]) {
    assert.equal(forbiddenReason(p), null, p)
  }
})

test('管理员回合不设目录围栏（返回 null）', () => {
  const roots = sendRootsFor({ mediaDir: join(dshHomeDir(), 'media', 'onebot'), isTurnAdmin: true })
  assert.equal(roots, null)
})

test('群成员回合：产物目录常在，工作区随开关', () => {
  const mediaDir = join(dshHomeDir(), 'media', 'onebot')
  const on = sendRootsFor({ mediaDir, isTurnAdmin: false, workspace: 'D:/AGI', groupMediaWorkspace: true })
  assert.ok(on.includes(mediaDir))
  assert.ok(on.includes('D:/AGI'))

  const off = sendRootsFor({ mediaDir, isTurnAdmin: false, workspace: 'D:/AGI', groupMediaWorkspace: false })
  assert.ok(off.includes(mediaDir))
  assert.ok(!off.includes('D:/AGI'))

  const extra = sendRootsFor({ mediaDir, isTurnAdmin: false, extraDirs: ['D:/pics'], groupMediaWorkspace: false })
  assert.ok(extra.includes('D:/pics'))
})

test('产物目录都是推出来的，不是写死的机器路径', () => {
  const roots = productRoots(join(dshHomeDir(), 'media', 'onebot'))
  // 2026-11-14 审计：系统临时目录不再整体放行（%TEMP% 里有宿主的重启日志和第三方文件）
  assert.ok(!roots.includes(tmpdir()))
  for (const r of roots) assert.ok(/^([a-zA-Z]:[\\/]|\/)/.test(r), r)
  assert.ok(!roots.some((r) => r.includes('蓝色大肥鱼')))
})

test('临时目录下的钥匙文件名仍然拦（目录本身不再整体放行，靠硬拒兜）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-'))
  try {
    const ok = join(dir, 'shot.png')
    const bad = join(dir, '.env')
    writeFileSync(ok, 'x')
    writeFileSync(bad, 'x')
    assert.equal(forbiddenReason(ok), null)
    assert.notEqual(forbiddenReason(bad), null)
    mkdirSync(join(dir, 'sub'), { recursive: true })
    assert.equal(forbiddenReason(join(dir, 'sub', 'b.txt')), null)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// 2026-11-14 审计（P0）：三个真漏的洞，钉住别再开。
test('硬拒清单：会话内容的第二份拷贝（storages / cache / B站 凭据）', () => {
  const home = dshHomeDir()
  const bad = [
    join(home, 'storages', 'session_projcache', 'sessions', 'x.json'),
    join(home, 'storages', 'dsh-context', 'x.json'),
    join(home, 'cache', 'attachments', 'request-images', 'ab', 'deadbeef'),
    join(home, 'bubble', 'bili', 'bili_credential.json'),
  ]
  for (const p of bad) assert.notEqual(forbiddenReason(p), null, p)
})

test('钥匙文件名：前缀带 credential 的也要拦（bili_credential.json）', () => {
  for (const p of ['D:/x/bili_credential.json', 'D:/x/my-credentials.yml', 'D:/x/credential.json']) {
    assert.notEqual(forbiddenReason(p), null, p)
  }
  // 正常素材不该被误伤
  assert.equal(forbiddenReason('D:/x/credit-report.png'), null)
})

test('成员回合的根目录：不给 storages / cache / 系统临时目录 / bubble', () => {
  const roots = sendRootsFor({ mediaDir: join(dshHomeDir(), 'media', 'onebot'), isTurnAdmin: false, workspace: 'D:/AGI' })
  const flat = roots.map((r) => r.replace(/\\/g, '/').toLowerCase())
  for (const bad of ['/storages', '/cache', '/bubble']) {
    assert.equal(flat.some((r) => r.includes(bad)), false, bad + ' ← ' + flat.join(' | '))
  }
  assert.equal(flat.some((r) => r.includes('/temp')), false, '系统临时目录')
})

test('productRoots 只留媒体目录，不再整体放出宿主数据区', () => {
  const roots = productRoots(join(dshHomeDir(), 'media', 'onebot')).map((r) => r.replace(/\\/g, '/').toLowerCase())
  assert.equal(roots.length, 2)
  assert.equal(roots.some((r) => r.endsWith('/media')), true)
})
