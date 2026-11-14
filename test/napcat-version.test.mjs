import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeQqVersion, qqInstallDirFromRegistry, qqVersionHint, supportedQqVersions } from '../lib/napcat.js'

// 2026-11-14：NapCat 上游停更后，唯一能做的是「别悄悄连不上」。
// 这一组钉住判定本身：写法差异、认不认识、说不说得出口。

test('QQ 的 curVersion 与 NapCat 表里的 -x64 后缀能对上', () => {
  const list = ['9.9.33-51802-x64', '9.9.33-52230-x64', '9.9.36-53644-x64']
  assert.equal(judgeQqVersion('9.9.33-52230', list).ok, true)
  assert.equal(judgeQqVersion('9.9.33-52230-x64', list).ok, true)
})

test('表里没有的构建判成不支持，并且认得出「更新」方向', () => {
  const list = ['9.9.33-52230-x64', '9.9.36-53644-x64']
  const newer = judgeQqVersion('9.9.37-54395', list)
  assert.equal(newer.ok, false)
  assert.equal(newer.newer, true)
  const older = judgeQqVersion('9.9.20-35951', list)
  assert.equal(older.ok, false)
  assert.equal(older.newer, false)
})

test('看不出来的时候就说看不出来（不吓人）', () => {
  assert.equal(judgeQqVersion('', ['9.9.33-52230-x64']).ok, null)
  assert.equal(judgeQqVersion('9.9.33-52230', []).ok, null)
  assert.equal(qqVersionHint(judgeQqVersion('', [])), '')
  assert.equal(qqVersionHint(judgeQqVersion('9.9.33-52230', ['9.9.33-52230-x64'])), '')
})

test('不认的时候给一句能照做的话', () => {
  const st = judgeQqVersion('9.9.37-54395', ['9.9.36-53644-x64'])
  const hint = qqVersionHint(st)
  assert.match(hint, /9\.9\.37-54395/)
  assert.match(hint, /9\.9\.36-53644-x64/)
  assert.match(hint, /curVersion|SnowLuma/)
})

test('注册表 UninstallString 能抠出目录，抠不到回空串', () => {
  const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ\r\n    UninstallString    REG_SZ    "C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"\r\n\r\n'
  assert.equal(qqInstallDirFromRegistry(out), 'C:\\Program Files\\Tencent\\QQNT')
  assert.equal(qqInstallDirFromRegistry(''), '')
  assert.equal(qqInstallDirFromRegistry('    UninstallString    REG_SZ    C:\\X\\U.exe'), 'C:\\X')
})

test('读不到 napcat.mjs 就回空列表（不抛）', () => {
  assert.deepEqual(supportedQqVersions('D:/不存在的目录'), [])
})
