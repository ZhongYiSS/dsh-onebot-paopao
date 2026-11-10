/**
 * 检查环境（doctor）的几条底线：
 *   1. 从 profile 的 cordis.patch.yml 里只读 dsh-onebot 那一层 config 的标量
 *   2. 每一项都有 level / detail，红黄绿只在 ok|warn|bad 里
 *   3. 转写脚本随包带着（不用用户自己找 听写.py）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDoctor, readProfileConfig } from '../lib/doctor.mjs'
import { toolPaths } from '../lib/video-look.js'

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-doctor-'))
  mkdirSync(join(dir, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(
    join(dir, 'profiles', 'desktop', 'cordis.patch.yml'),
    [
      '- id: dsh-onebot',
      '  disabled: false',
      '  config:',
      '    mode: reverse',
      '    port: 8643',
      '    accessToken: fish-test',
      '    napcatDir: D:\\NapCat\\NapCat.Shell',
      '    napcatQuickLogin: true',
      '    adminUsers:',
      '      - "123"',
      '    promptExtra: |',
      '      ## 人设',
      '      hello',
      '- id: other',
      '  config:',
      '    wrong: yes',
    ].join('\n'),
    'utf8',
  )
  return dir
}

test('读 profile 配置：只认 dsh-onebot 那层 config 的标量', () => {
  const home = makeHome()
  try {
    const cfg = readProfileConfig(home)
    assert.equal(cfg.mode, 'reverse')
    assert.equal(cfg.port, '8643')
    assert.equal(cfg.accessToken, 'fish-test')
    assert.equal(cfg.napcatDir, 'D:\\NapCat\\NapCat.Shell')
    assert.equal(cfg.napcatQuickLogin, 'true')
    assert.equal(cfg.wrong, undefined, '别的插件的键不该被读进来')
    assert.equal(cfg.disabled, undefined, 'config 外面的键不该被读进来')
    assert.equal(cfg.adminUsers, undefined, '嵌套数组不该被当成标量')
    assert.equal(cfg.promptExtra, undefined, '块标量不该被当成标量')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor：每一项都有 level/detail，等级只有三种', async () => {
  const got = await runDoctor({ config: {}, napcat: { pid: 0 } })
  assert.ok(Array.isArray(got.items) && got.items.length >= 8, '项数太少：' + got.items.length)
  const ids = got.items.map((i) => i.id)
  for (const need of ['node', 'ffmpeg', 'ffprobe', 'ytdlp', 'python', 'bili', 'vision', 'napcat']) {
    assert.ok(ids.includes(need), '缺一项：' + need)
  }
  for (const it of got.items) {
    assert.ok(['ok', 'warn', 'bad'].includes(it.level), '等级不对：' + it.id + '=' + it.level)
    assert.equal(typeof it.detail, 'string')
    assert.ok(it.detail !== '', 'detail 空了：' + it.id)
    assert.equal(typeof it.label, 'string')
  }
  assert.equal(got.bad, got.items.filter((i) => i.level === 'bad').length)
  assert.equal(got.ok, got.bad === 0)
})

test('转写脚本随包带着（用户自己配的优先，但包里那份一定在）', () => {
  const tp = toolPaths()
  assert.ok(existsSync(tp.bundledAsr), '缺少 assets/asr/transcribe.py')
  // 这台机器在 tools.json 里指定了自己的 听写.py，那是有意的覆盖；两种都算对
  assert.ok(tp.asrScript !== null && tp.asrScript !== '', '没找到任何转写脚本')
  assert.ok(existsSync(tp.asrScript), '找到的脚本不存在：' + tp.asrScript)
})
