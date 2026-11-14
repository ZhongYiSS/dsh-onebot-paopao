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
  assert.ok(roots.includes(tmpdir()))
  for (const r of roots) assert.ok(/^([a-zA-Z]:[\\/]|\/)/.test(r), r)
  assert.ok(!roots.some((r) => r.includes('蓝色大肥鱼')))
})

test('临时目录里的东西能发，临时目录下的钥匙文件名仍然拦', () => {
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