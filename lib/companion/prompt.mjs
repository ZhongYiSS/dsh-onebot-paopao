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
  L.push('（别说是抽到的、别提插件。末尾标记，插件会剥掉、不算正文：不该发→[HOLD]；打分 0-10，标准 5 分、10 分非常满意、0 分被气到了→[SCORE n]。）')
  return L.join('\n')
}

/** 会话回复里有没有拦截标记（只认 [HOLD]；[SKIP] 已按哥哥 m04134 删掉） */
export function readVerdict(text) {
  const s = String(text || '')
  if (/\[HOLD\]/i.test(s)) return 'hold'
  return 'send'
}

/**
 * 兴趣分：会话在回复最后自己写的 [SCORE 7]（0~10 整数）。
 * 返回 0~100 的分数（跟 release 一个量纲），没写就 null。
 * 哥哥 11-05 定的：分由她自己打，插件只读。
 */
export function readScore(text) {
  const m = /\[SCORE\s*([0-9]{1,3})\]/i.exec(String(text || ''))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(Math.max(0, Math.min(10, n)) * 10)))
}

/** 把标记剥掉（发出去的内容里不该带它；老回复里的 [SKIP] 也一并剥掉，但不作数） */
export function stripVerdict(text) {
  return String(text || '')
    .replace(/\[(SKIP|HOLD)\]/gi, '')
    .replace(/\[MORE(\s+\d{1,3})?\]/gi, '')
    .replace(/\[SCORE\s*[0-9]{1,3}\]/gi, '')
    .trim()
}

/**
 * 追聊：会话自己在末尾写的 [MORE]（可带秒数 [MORE 30]）。
 * 返回 0 = 写了但没给秒数（用配置里的随机区间），null = 没写。
 * 哥哥 11-08：追不追由她决定，插件只执行。
 */
export function readMore(text) {
  const m = /\[MORE(?:\s+(\d{1,3}))?\]/i.exec(String(text || ''))
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 0
}
