/**
 * B站 适配器 —— 抽中「刷视频」时真去搜一轮。
 * ============================================================================
 * 只做「把候选摆到桌上」这一件事，挑哪条、说什么，还是会话自己决定（红线：不代写）。
 *
 * 搜索走 B站 自己的 wbi 接口（要签名），cookie 用泡泡自己那份
 * `$DSH_HOME/bubble/bili/bili_credential.json`（老位置 bili-duty 只在没搬过时回落）。
 * 没填关键词时退化成「首页热门」，至少不会空手。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { credPath as pickBiliCredPath } from '../bili-paths.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

export function credPath(home = dshHome()) {
  return pickBiliCredPath(home)
}

export function readCred(home = dshHome()) {
  try {
    const f = credPath(home)
    if (!existsSync(f)) return null
    const c = JSON.parse(readFileSync(f, 'utf8'))
    if (!c || !c.sessdata) return null
    return {
      sessdata: String(c.sessdata || ''),
      biliJct: String(c.bili_jct || ''),
      buvid3: String(c.buvid3 || ''),
      uid: String(c.dedeuserid || ''),
    }
  } catch { return null }
}

function cookieOf(cred) {
  const parts = []
  if (cred?.sessdata) parts.push('SESSDATA=' + cred.sessdata)
  if (cred?.biliJct) parts.push('bili_jct=' + cred.biliJct)
  if (cred?.buvid3) parts.push('buvid3=' + cred.buvid3)
  if (cred?.uid) parts.push('DedeUserID=' + cred.uid)
  return parts.join('; ')
}

async function getJson(url, cred, timeoutMs = 8000) {
  const r = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: REFERER,
      accept: 'application/json, text/plain, */*',
      ...(cred ? { cookie: cookieOf(cred) } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ---- wbi 签名 -------------------------------------------------------------

let keyCache = { imgKey: '', subKey: '', at: 0 }

async function getWbiKeys(cred, timeoutMs) {
  const fresh = Date.now() - keyCache.at < 6 * 3600_000
  if (keyCache.imgKey && keyCache.subKey && fresh) return keyCache
  const j = await getJson('https://api.bilibili.com/x/web-interface/nav', cred, timeoutMs)
  const img = String(j?.data?.wbi_img?.img_url || '')
  const sub = String(j?.data?.wbi_img?.sub_url || '')
  const pick = (u) => (u.split('/').pop() || '').split('.')[0]
  const imgKey = pick(img)
  const subKey = pick(sub)
  if (!imgKey || !subKey) throw new Error('拿不到 wbi 密钥')
  keyCache = { imgKey, subKey, at: Date.now() }
  return keyCache
}

function mixinKeyOf(imgKey, subKey) {
  const orig = imgKey + subKey
  return MIXIN_TAB.map((n) => orig[n] || '').join('').slice(0, 32)
}

function signedQuery(params, mixin) {
  const p = { ...params, wts: Math.round(Date.now() / 1000) }
  const q = Object.keys(p).sort().map((k) => {
    const v = String(p[k] ?? '').replace(/[!'()*]/g, '')
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  }).join('&')
  const w_rid = createHash('md5').update(q + mixin).digest('hex')
  return `${q}&w_rid=${w_rid}`
}

// ---- 数据清洗 -------------------------------------------------------------

const stripEm = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()

export function durationSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const parts = String(v || '').split(':').map((x) => Number(x))
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function agoText(ts) {
  const d = Math.floor((Date.now() - ts * 1000) / 86400_000)
  if (!Number.isFinite(d) || d < 0) return ''
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  return `${d}天前`
}

const playText = (n) => {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿播放'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万播放'
  return v + '播放'
}

/** 搜索结果 → 统一形状 */
function normSearch(it) {
  const bvid = String(it?.bvid || '')
  if (!bvid) return null
  return {
    bvid,
    title: stripEm(it?.title),
    up: stripEm(it?.author),
    play: Number(it?.play) || 0,
    duration: durationSec(it?.duration),
    pubdate: Number(it?.pubdate) || 0,
    desc: stripEm(it?.description).slice(0, 120),
  }
}

function normPopular(it) {
  const bvid = String(it?.bvid || '')
  if (!bvid) return null
  return {
    bvid,
    title: stripEm(it?.title),
    up: stripEm(it?.owner?.name),
    play: Number(it?.stat?.view) || 0,
    duration: durationSec(it?.duration),
    pubdate: Number(it?.pubdate) || 0,
    desc: stripEm(it?.desc).slice(0, 120),
  }
}

// ---- 对外接口 -------------------------------------------------------------

/**
 * 抽中「刷视频」时调用，返回候选数组（最多 videoPerRound 条）。
 * 每条都带 `text`（给话头看）和 `title/bvid/url/note`（给记录页看）。
 */
export async function prepareBili(ev, { cfg = {}, state = {} } = {}, { home = dshHome(), log = () => {} } = {}) {
  if (!ev || ev.adapter !== 'bili') return []
  const cred = readCred(home)
  if (!cred) {
    log('B站 没登录，刷视频这轮跳过')
    return []
  }

  const want = Math.max(1, Math.min(5, Number(cfg.videoPerRound) || 3))
  const freshDays = Math.max(1, Math.min(365, Number(cfg.videoFreshDays) || 14))
  const minPlay = Math.max(0, Number(cfg.videoMinPlay) || 1000)
  const minSec = Math.max(0, Number(cfg.videoMinSec) || 60)
  const maxSec = Math.max(minSec + 1, Number(cfg.videoMaxSec) || 1800)
  const blockWords = (Array.isArray(cfg.videoExclude) ? cfg.videoExclude : [])
    .map((s) => String(s || '').trim()).filter(Boolean)

  const keywords = (Array.isArray(cfg.keywords) ? cfg.keywords : [])
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3)

  let rows = []
  const notes = []
  try {
    const { imgKey, subKey } = await getWbiKeys(cred)
    const mixin = mixinKeyOf(imgKey, subKey)
    for (const kw of keywords) {
      const qs = signedQuery({
        search_type: 'video',
        keyword: kw,
        page: 1,
        order: 'totalrank',
      }, mixin)
      const j = await getJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, cred)
      if (j?.code !== 0) { notes.push(`搜「${kw}」失败：${j?.message || j?.code}`); continue }
      const got = (j?.data?.result || []).map(normSearch).filter(Boolean)
      rows = rows.concat(got.map((x) => ({ ...x, from: kw })))
      if (rows.length >= want * 4) break
    }
  } catch (e) {
    notes.push('搜索出错：' + (e?.message ?? e))
  }

  if (!rows.length) {
    try {
      const j = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1', cred)
      if (j?.code === 0) {
        rows = (j?.data?.list || []).map(normPopular).filter(Boolean).map((x) => ({ ...x, from: '热门' }))
        if (!rows.length) notes.push('热门也是空的')
      } else {
        notes.push(`拿热门失败：${j?.message || j?.code}`)
      }
    } catch (e) {
      notes.push('拿热门出错：' + (e?.message ?? e))
    }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const before = rows.length

  rows = rows.filter((x) => {
    if (!x.title) return false
    if (x.duration && (x.duration < minSec || x.duration > maxSec)) return false
    if (x.play && x.play < minPlay) return false
    if (x.pubdate && nowSec - x.pubdate > freshDays * 86400) return false
    if (blockWords.some((w) => x.title.includes(w))) return false
    return true
  })

  // 30 天内推给过他的，别再推第二次
  const pushed = (state.pushedBvids && typeof state.pushedBvids === 'object') ? state.pushedBvids : {}
  const cutoff = Date.now() - 30 * 86400_000
  for (const k of Object.keys(pushed)) if (!(pushed[k] > cutoff)) delete pushed[k]
  const fresh = rows.filter((x) => !pushed[x.bvid])

  // 同标题的复读账号只留播放高的那条
  const seenTitle = new Set()
  const uniq = []
  for (const x of fresh.sort((a, b) => (b.play || 0) - (a.play || 0))) {
    const key = x.title.replace(/[\s\p{P}]/gu, '').slice(0, 24)
    if (seenTitle.has(key)) continue
    seenTitle.add(key)
    uniq.push(x)
  }

  const picked = uniq.slice(0, want)
  for (const x of picked) pushed[x.bvid] = Date.now()
  state.pushedBvids = pushed

  if (!picked.length) {
    log(`刷视频没搜到合适的（${before} 条候选都被筛掉了）` + (notes.length ? '：' + notes.join('；') : ''))
    return []
  }
  if (notes.length) log('刷视频有折扣：' + notes.join('；'))

  return picked.map((x) => {
    const bits = [x.up, x.duration ? fmtDur(x.duration) : '', playText(x.play), x.pubdate ? agoText(x.pubdate) : '']
      .filter(Boolean).join(' · ')
    const url = `https://www.bilibili.com/video/${x.bvid}`
    return {
      bvid: x.bvid,
      title: x.title,
      url,
      note: bits,
      from: x.from,
      text: `${x.title}（${bits}）\n  ${url}`,
    }
  })
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p2 = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p2(m)}:${p2(ss)}` : `${m}:${p2(ss)}`
}