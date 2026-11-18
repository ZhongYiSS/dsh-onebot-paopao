/**
 * video-look 的「下载先失败」防护回归测试。
 *
 * 事故（2026-11-19）：看一条已经被删的 B站 视频（稿件不可见 code=62002）。
 * lookVideo 里下载是提前开跑的，紧接着还要 await 元信息和字幕；下载先 reject 时
 * 没有人接住 ⇒ 宿主把未处理拒绝当成致命错误 ⇒ 整个 DSH 退出。
 * 这里钉住三件事：①下载结果当场兜住 ②不可见的稿子不再去试 yt-dlp ③缺 yt-dlp 的报错分两种
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'video-look.js'), 'utf8')

test('下载 promise 当场兜住，不留裸拒绝', () => {
  assert.match(src, /download\(ref, dir, log\)\.then\(/, '下载必须立刻挂上 then 兜住')
  assert.match(src, /\(\s*file\s*\)\s*=>\s*\(\{\s*ok:\s*true,\s*file\s*\}\)/, '成功分支要包成 {ok:true,file}')
  assert.match(src, /\(\s*error\s*\)\s*=>\s*\(\{\s*ok:\s*false,\s*error\s*\}\)/, '失败分支要包成 {ok:false,error}')
  assert.doesNotMatch(src, /const file = await downloadPromise/, '不许再裸 await（那会把失败漏成未处理拒绝）')
  assert.match(src, /const got = await downloadPromise/, '要 await 兜住后的结果')
  assert.match(src, /if \(!got\.ok\) throw got\.error/, '失败要显式抛出，不能当成功')
})

test('稿件不可见不再去试 yt-dlp', () => {
  assert.match(src, /62002\|稿件不可见/, '62002 / 稿件不可见 要短路')
  assert.match(src, /这条 B站 视频看不了：/, '短路后要给一句人话')
})

test('缺 yt-dlp 的报错按 B站 / 站外分开', () => {
  assert.match(src, /B站 直连没下成，兜底的 yt-dlp 也没装/, 'B站 那条要说清是兜底没装')
  assert.match(src, /下载站外视频需要 yt-dlp（B站 视频不用）/, '站外那条保持原话')
})