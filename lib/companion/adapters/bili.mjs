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
import { tasteScore } from '../taste.mjs'

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

// ---- 字幕（文本层）---------------------------------------------------------

const SUB_MAX = 600
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取一条视频的字幕文本（优先中文 AI 字幕）。没有字幕就返回空串，不抛。
 * `mixin` 是 wbi 签名密钥（getWbiKeys + mixinKeyOf 得来）。
 */
export async function subtitleText(bvid, cred, mixin, maxChars = SUB_MAX) {
  const v = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, cred)
  const d = v?.data || {}
  const cid = d.cid || (Array.isArray(d.pages) && d.pages[0]?.cid) || 0
  if (!cid) return ''
  const qs = signedQuery({ bvid, cid }, mixin)
  const p = await getJson(`https://api.bilibili.com/x/player/wbi/v2?${qs}`, cred)
  const subs = p?.data?.subtitle?.subtitles || []
  if (!subs.length) return ''
  const pick = subs.find((s) => ['ai-zh', 'zh-CN', 'zh'].includes(String(s.lan)))
    || subs.find((s) => String(s.lan || '').startsWith('zh'))
    || subs[0]
  let url = String(pick?.subtitle_url || '')
  if (!url) return ''
  if (url.startsWith('//')) url = 'https:' + url
  const j = await getJson(url, cred)
  const lines = (j?.body || []).map((x) => String(x?.content || '').trim()).filter(Boolean)
  const all = lines.join(' ').replace(/\s+/g, ' ')
  if (!all) return ''
  return all.length > maxChars ? all.slice(0, maxChars) + '…' : all
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
    upMid: String(it?.mid || ''),
    tags: stripEm(it?.tag),
    tname: stripEm(it?.typename),
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
    upMid: String(it?.owner?.mid || ''),
    tags: stripEm(it?.tname),
    tname: stripEm(it?.tname),
    play: Number(it?.stat?.view) || 0,
    duration: durationSec(it?.duration),
    pubdate: Number(it?.pubdate) || 0,
    desc: stripEm(it?.desc).slice(0, 120),
  }
}

/**
 * 关键词轮转：词多就轮着用（state.keywordCursor 记到哪了），返回这一轮要搜的词。
 * 单测直接调它，不用碰网络。
 */
export function pickKeywords(all = [], perRound = 3, state = {}) {
  const list = (Array.isArray(all) ? all : []).map((s) => String(s || '').trim()).filter(Boolean)
  const n = Math.max(1, Math.min(10, Number(perRound) || 3))
  if (list.length <= n) return list
  const cur = Math.max(0, Number(state.keywordCursor) || 0) % list.length
  const out = []
  for (let i = 0; i < n; i += 1) out.push(list[(cur + i) % list.length])
  state.keywordCursor = (cur + n) % list.length
  return out
}

/**
 * 不感兴趣判定：标题 / UP 名 / 标签 / 分区里出现屏蔽词，或 UP 在拉黑名单里 → true。
 * 单测直接调它。
 */
export function isBlocked(x, { blockWords = [], blockUids = [], blockUps = [] } = {}) {
  if (!x) return true
  const hay = `${x.title || ''} ${x.up || ''} ${x.tags || ''} ${x.tname || ''}`
  if (blockWords.some((w) => String(w || '') !== '' && hay.includes(String(w)))) return true
  if (x.upMid && blockUids.some((u) => String(u) === String(x.upMid))) return true
  if (x.up && blockUps.some((u) => String(u) === String(x.up))) return true
  return false
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
  // 拉黑 UP 主：mid 或名字都认（名字要整串一致，避免误伤）
  const blockUids = new Set((Array.isArray(cfg.videoBlockUids) ? cfg.videoBlockUids : [])
    .map((s) => String(s || '').trim()).filter(Boolean))
  const blockUps = new Set((Array.isArray(cfg.videoBlockUps) ? cfg.videoBlockUps : [])
    .map((s) => String(s || '').trim()).filter(Boolean))

  const allKeywords = (Array.isArray(cfg.keywords) ? cfg.keywords : [])
    .map((s) => String(s || '').trim()).filter(Boolean)

  // 关键词多了就轮着用：每轮取 videoKeywordsPerRound 个，游标存 state，下一轮接着往下取。
  const perRound = Math.max(1, Math.min(10, Number(cfg.videoKeywordsPerRound) || 3))
  const keywords = pickKeywords(allKeywords, perRound, state)

  let rows = []
  const notes = []
  let mixin = ''
  try {
    const { imgKey, subKey } = await getWbiKeys(cred)
    mixin = mixinKeyOf(imgKey, subKey)
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

  // 关键词搜出来的行，B站 搜索接口不给时长/播放量 —— 补一次 detail 才筛得动。
  // 只补前 8 条（约 0.35s/条），够用了，别为了筛掉一条视频多等十几秒。
  if (cfg.videoDetail !== false) {
    const need = rows.filter((x) => x.from !== '热门' && (!x.duration || !x.play)).slice(0, 8)
    for (let i = 0; i < need.length; i += 1) {
      const x = need[i]
      try {
        const j = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${x.bvid}`, cred)
        const d = j?.code === 0 ? j.data : null
        if (d) {
          if (!x.duration && d.duration) x.duration = durationSec(d.duration)
          if (!x.play) x.play = Number(d?.stat?.view) || 0
          if (!x.pubdate) x.pubdate = Number(d.pubdate) || 0
          if (!x.upMid) x.upMid = String(d?.owner?.mid || '')
          if (!x.up) x.up = stripEm(d?.owner?.name)
          if (!x.tname) x.tname = stripEm(d?.tname)
        }
      } catch (e) {
        notes.push(`补 ${x.bvid} 信息没成：` + (e?.message ?? e))
      }
      if (i + 1 < need.length) await sleep(350)
    }
  }

  rows = rows.filter((x) => {
    if (!x.title) return false
    if (x.duration && (x.duration < minSec || x.duration > maxSec)) return false
    if (x.play && x.play < minPlay) return false
    if (x.pubdate && nowSec - x.pubdate > freshDays * 86400) return false
    // 不感兴趣：标题、UP 名、标签、分区，命中一个就整条丢掉
    if (isBlocked(x, { blockWords, blockUids: [...blockUids], blockUps: [...blockUps] })) return false
    return true
  })

  // 30 天内推给过他的，别再推第二次
  const pushed = (state.pushedBvids && typeof state.pushedBvids === 'object') ? state.pushedBvids : {}
  const cutoff = Date.now() - 30 * 86400_000
  for (const k of Object.keys(pushed)) if (!(pushed[k] > cutoff)) delete pushed[k]
  const fresh = rows.filter((x) => !pushed[x.bvid])

  // 同标题的复读账号只留播放高的那条；她喜欢过的 UP 主 / 关键词排前面
  const seenTitle = new Set()
  const uniq = []
  const taste = cfg.taste || null
  const ordered = fresh.slice().sort((a, b) => {
    const dt = tasteScore(taste, b.upMid, b.from) - tasteScore(taste, a.upMid, a.from)
    if (dt !== 0) return dt > 0 ? -1 : 1
    return (Number(b.play) || 0) - (Number(a.play) || 0)
  })
  for (const x of ordered) {
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

  // 文本层：给真要发的 1~2 条补字幕节选（不下载视频，最便宜的一层「看懂」）
  if (cfg.videoSubtitle !== false && mixin) {
    const n = Math.min(2, picked.length)
    for (let i = 0; i < n; i += 1) {
      try {
        const sub = await subtitleText(picked[i].bvid, cred, mixin)
        if (sub) picked[i].subtitle = sub
      } catch (e) {
        log(`字幕（${picked[i].bvid}）没取到：` + (e?.message ?? e))
      }
      if (i + 1 < n) await sleep(400)
    }
  }

  // 画面层：真要发给哥哥的那一条，仔细看一遍（10 张图，约 1 分钟）
  let deepText = ''
  if (cfg.videoDeepOnSend !== false && picked.length > 0) {
    try {
      const { lookVideo } = await import('../../video-look.js')
      const looked = await lookVideo(`https://www.bilibili.com/video/${picked[0].bvid}`, {
        depth: cfg.videoSendDepth === 'normal' ? 'normal' : 'deep',
        config: cfg,
        log,
      })
      deepText = String(looked?.evidence ?? '')
        .split('\n')
        .filter((line) => !line.startsWith('【字幕】'))
        .join('\n')
        .slice(0, 1200)
    } catch (e) {
      log(`仔细看（${picked[0].bvid}）没成：` + (e?.message ?? e))
    }
  }

  return picked.map((x) => {
    const bits = [x.up, x.duration ? fmtDur(x.duration) : '', playText(x.play), x.pubdate ? agoText(x.pubdate) : '']
      .filter(Boolean).join(' · ')
    const url = `https://www.bilibili.com/video/${x.bvid}`
    const sub = x.subtitle ? `\n  内容：${x.subtitle}` : ''
    const look = x.bvid === picked[0].bvid && deepText !== '' ? `\n  画面：${deepText}` : ''
    return {
      bvid: x.bvid,
      title: x.title,
      url,
      note: bits,
      from: x.from,
      // 口味账用：谁做的、从哪个词搜来的
      up: x.up || '',
      upMid: x.upMid || '',
      kw: x.from || '',
      text: `${x.title}（${bits}）\n  ${url}${sub}${look}`,
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