/**
 * 话头 —— 插件对会话说的**唯一一句话**。
 * ============================================================================
 * 红线（哥哥 m00171）：插件不代写正文。这里只给「什么时候、抽中了什么、要做什么」，
 * 说什么是会话自己的事；不想做回 [SKIP]，做了但不想发回 [HOLD]。
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
  note = '',
}) {
  const L = []
  L.push(`[泡泡] ${modeLabel} · 今天第 ${countToday} 次${lastAgoText ? ` · 上次 ${lastAgoText}` : ''}`)
  L.push(`现在：${periodLabel || '—'} · 权重 ${Math.round(w)}`)
  if (chatId) L.push(`发给：${chatId}`)
  L.push('')
  if (event) {
    L.push(`抽中的事：${event.label}${event.hint ? `（${event.hint}）` : ''}`)
  }
  if (candidates?.length) {
    L.push('候选：')
    for (const c of candidates) L.push(`- ${typeof c === 'string' ? c : c.text || JSON.stringify(c)}`)
  }
  if (note) L.push('', note)
  L.push('')
  L.push('规矩（这三条是硬的，插件会照做，不是商量）：')
  L.push('1. 想发就直接写正文，别加任何标记。')
  L.push('2. 做了、但这一轮不想让他看见 → 正文照写，最后单独写 [HOLD]。带 [HOLD] 的这一轮，QQ 那边一个字都收不到。')
  L.push('3. 这件事你根本不想做 → 只回 [SKIP]，别写别的。')
  L.push('别把 [HOLD] / [SKIP] 塞进要发出去的话里，也别用别的方式暗示「我做了但不发」——只有这两个标记作数。')
  return L.join('\n')
}

/** 会话回复里有没有拦截标记 */
export function readVerdict(text) {
  const s = String(text || '')
  if (/\[SKIP\]/i.test(s)) return 'skip'
  if (/\[HOLD\]/i.test(s)) return 'hold'
  return 'send'
}

/** 把标记剥掉（发出去的内容里不该带它） */
export function stripVerdict(text) {
  return String(text || '').replace(/\[(SKIP|HOLD)\]/gi, '').trim()
}
