/**
 * 视频账 —— 发出去过的视频，以及「再也不想推」的黑名单。
 * ============================================================================
 * 哥哥 11-10 定的口径：
 *  - 「抽到过」不算数，**发出去才算占用**（挑到了但没发，下一轮还能再挑到）；
 *  - 发出去过的，30 天内不再自动抽到（跨会话共享一本账，群和私聊别推同一条）；
 *  - 聊天里她主动挑视频时，可以用 `again` 忽略这本账（他让她再发一次老视频）；
 *  - 「不再推」是永久的，跟 30 天那份分开存。
 * 落脚：$DSH_HOME/bubble/videos.json
 * ============================================================================
 */
import { join } from 'node:path'
import { readJson, writeJson, ensureDir } from './state.mjs'

export const VIDEO_KEEP_DAYS = 30
const MAX_ROWS = 800

export function videosFile(home) {
  return join(home, 'videos.json')
}

/** 读账本，顺手清掉过期的「发过」记录（黑名单不清）。 */
export function readVideos(home, now = Date.now()) {
  const raw = readJson(videosFile(home), {}) || {}
  const sent = raw.sent && typeof raw.sent === 'object' ? raw.sent : {}
  const blocked = raw.blocked && typeof raw.blocked === 'object' ? raw.blocked : {}
  const cutoff = now - VIDEO_KEEP_DAYS * 86400_000
  const out = { sent: {}, blocked: {} }
  for (const [bvid, rec] of Object.entries(sent)) {
    const at = Number(rec && rec.at) || 0
    if (at > cutoff && String(bvid) !== '') out.sent[bvid] = rec
  }
  for (const [bvid, rec] of Object.entries(blocked)) {
    if (String(bvid) !== '') out.blocked[bvid] = rec
  }
  // 只留最近 800 条，别让文件无限长
  const rows = Object.entries(out.sent).sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
  out.sent = Object.fromEntries(rows.slice(0, MAX_ROWS))
  return out
}

/**
 * 「视频标题小抄」——抽到的候选在 prepare 时把 bvid → 标题/UP 记一笔。
 * 干什么：发出去记账时能把标题一起写上（以前发过的视频在面板里只有一串 BV 号）。
 * 为什么单开一份：`videos.json` 只认 sent/blocked 两个键，塞进去会被 readVideos 洗掉；
 *   而且记账发生在「发出去了」那一刻，那时候不该再为标题发一次网络请求。
 * 落脚：$DSH_HOME/bubble/video-titles.json
 */
export function titlesFile(home) {
  return join(home, 'video-titles.json')
}

/** 把一批候选的标题记进小抄（只留最近 300 条）。 */
export function rememberTitles(home, list = [], now = Date.now()) {
  if (!Array.isArray(list) || list.length === 0) return 0
  const raw = readJson(titlesFile(home), {}) || {}
  let n = 0
  for (const x of list) {
    const bvid = String(x?.bvid ?? '').trim()
    const title = String(x?.title ?? '').trim()
    if (bvid === '' || title === '') continue
    raw[bvid] = { title: title.slice(0, 120), up: String(x?.up ?? '').slice(0, 40), at: now }
    n += 1
  }
  if (n === 0) return 0
  const rows = Object.entries(raw).sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0)).slice(0, 300)
  ensureDir(home)
  writeJson(titlesFile(home), Object.fromEntries(rows))
  return n
}

/** 查小抄；没有就返回空串。 */
export function titleOf(home, bvid) {
  const raw = readJson(titlesFile(home), {}) || {}
  const rec = raw[String(bvid ?? '').trim()]
  if (!rec || typeof rec !== 'object') return { title: '', up: '' }
  return { title: String(rec.title || ''), up: String(rec.up || '') }
}

function save(home, data) {
  ensureDir(home)
  writeJson(videosFile(home), data)
}

/** 记一条「真发出去了」。重复发同一条只更新时间和会话。 */
export function noteSentVideo(home, { bvid, title = '', url = '', chatId = '', now = Date.now() } = {}) {
  const id = String(bvid || '').trim()
  if (id === '') return false
  const data = readVideos(home, now)
  data.sent[id] = {
    at: now,
    title: String(title || (data.sent[id] && data.sent[id].title) || ''),
    url: String(url || (data.sent[id] && data.sent[id].url) || `https://www.bilibili.com/video/${id}`),
    chatId: String(chatId || (data.sent[id] && data.sent[id].chatId) || ''),
  }
  save(home, data)
  return true
}

/** 永久不再推这条。 */
export function blockVideo(home, bvid, now = Date.now()) {
  const id = String(bvid || '').trim()
  if (id === '') return false
  const data = readVideos(home, now)
  data.blocked[id] = { at: now }
  save(home, data)
  return true
}

export function unblockVideo(home, bvid, now = Date.now()) {
  const id = String(bvid || '').trim()
  if (id === '') return false
  const data = readVideos(home, now)
  if (!data.blocked[id]) return false
  delete data.blocked[id]
  save(home, data)
  return true
}

/** 这条还能不能抽：黑名单永久挡，最近 30 天发过的挡。`again` 只放开 30 天那份。 */
export function canPickVideo(home, bvid, { again = false, now = Date.now() } = {}) {
  const data = readVideos(home, now)
  if (data.blocked[bvid]) return false
  if (!again && data.sent[bvid]) return false
  return true
}

/** 把 OneBot 段拍平成一段文字：text 段取正文，其余段把 data 序列化（卡片链接藏在 json 里）。 */
export function segmentsText(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((s) => {
      const d = s && s.data
      if (!d || typeof d !== 'object') return ''
      if (typeof d.text === 'string') return d.text
      try { return JSON.stringify(d) } catch { return '' }
    })
    .filter(Boolean)
    .join('\n')
}

/** 一段文字里出现的所有 BV 号（去重）。 */
export function bvidsInText(text) {
  return [...new Set(String(text || '').match(/BV[0-9A-Za-z]{10}/g) || [])]
}
