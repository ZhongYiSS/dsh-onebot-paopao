/**
 * 话头 —— 插件对会话说的**唯一一句话**。
 * ============================================================================
 * 红线（哥哥 m00171）：插件不代写正文。这里只给「什么时候、抽中了哪个词」，
 * 说什么是会话自己的事；做了但不想发回 [HOLD]。
 * （哥哥 m04134：删掉 [SKIP]——抽中的这一轮不许跳过，总得说点什么。）
 * （哥哥 m05588：事件只注入一个词，具体怎么做由会话自己想；hint 是他自己加的补充。）
 * ============================================================================
 */

export function buildHint({
  modeLabel = '日常档',
  countToday = 1,
  lastAgoText = '',
  periodLabel = '',
  w = 0,
  event = null,
  candidates = [],
  chatId = '',
  chatLabel = '',
  note = '',
}) {
  const L = []
  L.push(`[泡泡] ${modeLabel} · 今天第 ${countToday} 次${lastAgoText ? ` · 上次 ${lastAgoText}` : ''}`)
  const who = chatLabel || chatId
  L.push(`现在：${periodLabel || '—'} · 权重 ${Math.round(w)}${who ? ` · 发给 ${who}` : ''}`)
  L.push('')
  if (event) L.push(`这一轮的词：${event.label}（怎么做随你；做不了就说你在干嘛）`)
  if (event?.hint) L.push(`补充：${event.hint}`)
  if (candidates?.length) {
    L.push('候选：')
    for (const c of candidates) L.push(`- ${typeof c === 'string' ? c : c.text || JSON.stringify(c)}`)
  } else if (event?.adapter) {
    // 这个事件本来该由插件备料（刷视频），但这次没搜到 —— 说清楚，别让她以为有候选
    L.push('（这次没准备到候选：自己找也行，或者换个方式。）')
  }
  if (note) L.push('', note)
  L.push('')
  L.push('（别说是抽到的、别提插件。不该发就回 [HOLD]，插件会剥掉、不算正文。）')
  return L.join('\n')
}

/** 会话回复里有没有拦截标记（只认 [HOLD]；[SKIP] 已按哥哥 m04134 删掉） */
export function readVerdict(text) {
  const s = String(text || '')
  if (/\[HOLD\]/i.test(s)) return 'hold'
  return 'send'
}

/**
 * 兴趣分：会话在回复最后自己写的 [SCORE 7]（0~12 整数）。
 * 返回 0~120 的分数（跟 release 一个量纲），没写就 null。
 * 哥哥 11-05 定的：分由她自己打，插件只读；11-11 加了 11/12 两档（+150% / +200%）。
 */
export function readScore(text) {
  const m = /\[SCORE\s*([0-9]{1,3})\]/i.exec(String(text || ''))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(120, Math.round(Math.max(0, Math.min(12, n)) * 10)))
}

/** 把标记剥掉（发出去的内容里不该带它；老回复里的 [SKIP] 也一并剥掉，但不作数） */
export function stripVerdict(text) {
  return String(text || '')
    .replace(/\[(SKIP|HOLD)\]/gi, '')
    .replace(/\[LATER\s+[0-9]{1,4}\s*(?:m|s)?\]/gi, '')
    .replace(/\[SCORE\s*[0-9]{1,3}\]/gi, '')
    .trim()
}

/**
 * 定时话头：会话在正文里写 `[LATER 25]`（25 分钟后）/ `[LATER 90s]`（90 秒后）。
 * 只认分钟数（「多少分钟后」）。
 * 返回秒数（相对现在），没写返回 null，写坏了返回 null。
 * 哥哥 11-09：到点只是再叫醒她一轮（等于她给自己排一张卡），不是什么固定内容。
 */
export function readLater(text, now = Date.now(), maxSec = 43200) {
  const m = /\[LATER\s+([0-9]{1,4})\s*(m|s|分钟|秒)?\]/i.exec(String(text || ''))
  if (!m) return null
  const unit = (m[2] || '').toLowerCase()
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const sec = (unit === 's' || unit === '秒') ? n : n * 60
  if (!Number.isFinite(sec) || sec < 30) return null
  return Math.min(maxSec, Math.round(sec))
}
