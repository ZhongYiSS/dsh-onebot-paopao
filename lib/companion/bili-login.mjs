/**
 * 泡泡自己的 B站 扫码登录。
 * ============================================================================
 * 以前扫码是刷B站插件的工具，卸了它泡泡就没法续期凭证。哥哥 11-04 要「泡泡能
 * 单独运行」，所以这套搬进泡泡自己：
 *
 *   startLogin()  → 找 B站 要二维码（passport qrcode/generate），顺手画成 SVG
 *   pollLogin()   → 轮询扫码状态（86101 没扫 / 86090 扫了待确认 / 86038 过期 / 0 成了）
 *   成功时把 Set-Cookie 里的 SESSDATA / bili_jct / buvid3 / DedeUserID 写进
 *   `$DSH_HOME/bubble/bili/bili_credential.json` —— 就是泡泡读的那份。
 *
 * 只依赖 `qrcode`（画码用，MIT），不碰刷B站、不碰 python。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { biliHome } from './bili-paths.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const HEADERS = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
  accept: 'application/json, text/plain, */*',
}

const GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?source=main-fe-header&qrcode_key='

/** 把 Set-Cookie 数组收成 {name: value}。 */
function cookiesOf(list) {
  const out = {}
  for (const line of list || []) {
    const head = String(line).split(';')[0]
    const i = head.indexOf('=')
    if (i > 0) out[head.slice(0, i).trim()] = head.slice(i + 1).trim()
  }
  return out
}

function credFile(dshHome) {
  return join(biliHome(dshHome), 'bili_credential.json')
}

function readOld(dshHome) {
  try { return JSON.parse(readFileSync(credFile(dshHome), 'utf8')) } catch { return {} }
}

/** 找 B站 要一张二维码，返回 { key, url, svg }。 */
export async function startLogin() {
  const res = await fetch(GENERATE, { headers: HEADERS })
  const j = await res.json()
  if (!j || j.code !== 0 || !j.data?.url) {
    throw new Error('B站 没给二维码：' + (j?.message || JSON.stringify(j?.code)))
  }
  const svg = await QRCode.toString(j.data.url, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
  return { key: j.data.qrcode_key, url: j.data.url, svg }
}

/** 看看登录成没成；成了就落凭证。 */
export async function pollLogin(dshHome, key) {
  if (!key) return { ok: false, state: 'error', message: '没有 qrcode_key' }
  const res = await fetch(POLL + encodeURIComponent(key), { headers: HEADERS })
  const j = await res.json()
  if (!j || j.code !== 0) return { ok: false, state: 'error', message: j?.message || 'B站 不给查' }
  const code = j.data?.code
  if (code === 86101) return { ok: true, state: 'waiting', message: '还没扫' }
  if (code === 86090) return { ok: true, state: 'scanned', message: '扫到了，手机上点确认' }
  if (code === 86038) return { ok: true, state: 'expired', message: '二维码过期了，点一下重来' }
  if (code !== 0) return { ok: true, state: 'error', message: j.data?.message || ('不认识的返回：' + code) }

  const c = cookiesOf(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])
  if (!c.SESSDATA) return { ok: false, state: 'error', message: '登录说成了，但没拿到 SESSDATA' }

  const old = readOld(dshHome)
  const payload = {
    sessdata: c.SESSDATA,
    bili_jct: c.bili_jct || old.bili_jct || '',
    buvid3: c.buvid3 || old.buvid3 || '',
    dedeuserid: c.DedeUserID || c.dedeuserid || old.dedeuserid || '',
  }
  const file = credFile(dshHome)
  mkdirSync(biliHome(dshHome), { recursive: true })
  const tmp = file + '.tmp-bubble'
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)

  const who = await whoami(payload)
  return { ok: true, state: 'done', message: who ? `登录成功：${who.uname}` : '登录成功', user: who }
}

/** 用刚拿到的凭证问一句「我是谁」，顺便验证凭证真能用。 */
export async function whoami(cred) {
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        ...HEADERS,
        referer: 'https://www.bilibili.com/',
        cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`,
      },
    })
    const j = await res.json()
    if (j?.code !== 0 || !j.data?.isLogin) return null
    return { isLogin: true, uname: String(j.data.uname || ''), mid: Number(j.data.mid) || 0 }
  } catch { return null }
}

/** 当前凭证还能不能用（设置页显示一行状态用）。 */
export async function currentUser(dshHome) {
  const f = credFile(dshHome)
  if (!existsSync(f)) return { ok: false, message: '还没有凭证' }
  let old = {}
  try { old = JSON.parse(readFileSync(f, 'utf8')) } catch { return { ok: false, message: '凭证文件读不动' } }
  if (!old.sessdata) return { ok: false, message: '凭证里没有 SESSDATA' }
  const who = await whoami(old)
  if (!who) return { ok: false, message: '凭证过期了，点「扫码登录」续一下' }
  return { ok: true, uname: who.uname, mid: who.mid, message: `已登录：${who.uname}` }
}