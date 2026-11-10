// NapCat 快捷启动的纯函数测试：路径校验 / 命令行拼装 / tasklist 解析 / 自动探测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launcherPath, qrPath, validateNapcatDir, buildLaunchCommand,
  parseTasklist, qrInfo, guessNapcatDir, resolveNapcatDir, detectBotQQ, QR_STALE_SEC,
} from '../lib/napcat.js'

const mk = (withLauncher = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-'))
  if (withLauncher) writeFileSync(join(dir, 'launcher.bat'), '@echo off\r\n', 'utf8')
  return dir
}

test('空目录：给中文提示，不猜', () => {
  const r = validateNapcatDir('')
  assert.equal(r.ok, false)
  assert.match(r.error, /还没填 NapCat 目录/)
})

test('目录不存在 / 没有 launcher.bat：分开报', () => {
  const missing = validateNapcatDir(join(tmpdir(), 'napcat-一定没有这个目录-1234'))
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
  const bare = mk(false)
  try {
    const r = validateNapcatDir(bare)
    assert.equal(r.ok, false)
    assert.match(r.error, /没有 launcher\.bat/)
  } finally { rmSync(bare, { recursive: true, force: true }) }
})

test('目录正常：返回 launcher 绝对路径', () => {
  const dir = mk()
  try {
    const r = validateNapcatDir(dir)
    assert.equal(r.ok, true)
    assert.equal(r.launcher, launcherPath(dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('命令行：有机器号且允许快速登录才带 -q', () => {
  const dir = mk()
  try {
    const a = buildLaunchCommand(dir, { uin: '3490240357', quickLogin: true })
    assert.equal(a.file, 'cmd.exe')
    assert.deepEqual(a.args, ['/c', '"' + launcherPath(dir) + '" -q 3490240357'])
    const b = buildLaunchCommand(dir, { uin: '3490240357', quickLogin: false })
    assert.deepEqual(b.args, ['/c', '"' + launcherPath(dir) + '"'])
    const c = buildLaunchCommand(dir, { uin: '', quickLogin: true })
    assert.equal(c.args[1].includes('-q'), false)
    assert.equal(buildLaunchCommand('', {}), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('tasklist 输出解析：有进程取 PID，没进程返回 0', () => {
  assert.equal(parseTasklist('"NapCatWinBootMain.exe","25308","Console","1","12,345 K"\r\n'), 25308)
  assert.equal(parseTasklist('信息: 没有运行的任务匹配指定标准。'), 0)
  assert.equal(parseTasklist(''), 0)
})

test('二维码：没有文件时 exists=false，写出来之后能拿到时间', () => {
  const dir = mk()
  try {
    assert.equal(qrInfo(dir).exists, false)
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(qrPath(dir), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const info = qrInfo(dir)
    assert.equal(info.exists, true)
    assert.equal(info.bytes, 4)
    assert.ok(info.at > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('自动探测：环境变量指到哪就用哪；填的目录优先且填错不偷偷换', () => {
  const dir = mk()
  try {
    assert.equal(guessNapcatDir('', { NAPCAT_DIR: dir }), dir)
    const r = resolveNapcatDir('', { env: { NAPCAT_DIR: dir } })
    assert.equal(r.ok, true)
    assert.equal(r.auto, true)
    const bad = resolveNapcatDir(join(tmpdir(), 'napcat-绝对没有-9999'), { env: { NAPCAT_DIR: dir } })
    assert.equal(bad.ok, false)
    assert.equal(bad.auto, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('机器人号：从 config 目录的文件名里认出来，认不出回空串', () => {
  const dir = mk()
  try {
    assert.equal(detectBotQQ(dir), '', '空目录不该猜出号')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'onebot11_3490240357.json'), '{}', 'utf8')
    assert.equal(detectBotQQ(dir), '3490240357')
    // 认出来了就带 -q；没有号就退回普通启动（扫码）
    const cmd = buildLaunchCommand(dir, { uin: detectBotQQ(dir), quickLogin: true })
    assert.ok(cmd, '应该拼出命令')
    assert.ok(cmd.args.join(' ').includes('-q 3490240357'), '命令里没带 -q：' + cmd.args.join(' '))
    const plain = buildLaunchCommand(dir, { uin: '', quickLogin: true })
    assert.ok(!plain.args.join(' ').includes('-q'), '没号时不该带 -q')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('二维码：超过 150 秒没更新就算过期（别拿旧图给人扫）', () => {
  const dir = mk()
  try {
    mkdirSync(join(dir, 'cache'), { recursive: true })
    const p = qrPath(dir)
    writeFileSync(p, Buffer.from('89504e47', 'hex'))
    const now = Date.now()
    const fresh = qrInfo(dir, now + 30_000)
    assert.equal(fresh.exists, true)
    assert.equal(fresh.stale, false)
    assert.ok(fresh.ageSec >= 29 && fresh.ageSec <= 31, '年龄算错了：' + fresh.ageSec)
    const old = qrInfo(dir, now + 600_000)
    assert.equal(old.stale, true, '10 分钟前的图应该判过期')
    assert.equal(QR_STALE_SEC, 150)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
