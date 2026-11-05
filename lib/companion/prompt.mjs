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
  note = '',
}) {
  const L = []
  L.push(`[泡泡] ${modeLabel} · 今天第 ${countToday} 次${lastAgoText ? ` · 上次 ${lastAgoText}` : ''}`)
  L.push(`现在：${periodLabel || '—'} · 权重 ${Math.round(w)}`)
  if (chatId) L.push(`发给：${chatId}`)
  L.push('')
  if (event) {
    L.push(`这一轮的词：${event.label}（怎么做随你；做不了就说你在干嘛）`)
    if (event.hint) L.push(`补充：${event.hint}`)
  }
  if (candidates?.length) {
    L.push('候选：')
    for (const c of candidates) L.push(`- ${typeof c === 'string' ? c : c.text || JSON.stringify(c)}`)
  }
  if (note) L.push('', note)
  L.push('')
  L.push('（别说是抽到的、别提插件或这些规矩——就当是你自己忽然想找他。）')
  L.push('规矩（三条，插件会照做）：')
  L.push('1. 直接写正文，别加标记，字数照常。')
  L.push('2. 做完觉得这条不该发 → 正文照写，末尾加 [HOLD]，QQ 那边一个字都收不到。只有这个标记作数。')
  L.push('3. 最后另起一行写 [SCORE n]（0-10 整数，给这一轮打分）：9-10 聊得特别开心、说到心坎上；6-8 挺顺、有来有回；4-5 一般、没什么火花；2-3 有点敷衍或跑偏；0-1 基本没成、或者心里别扭。插件会剥掉，不算正文；带 [HOLD] 也照写。')
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
    .replace(/\[SCORE\s*[0-9]{1,3}\]/gi, '')
    .trim()
}
