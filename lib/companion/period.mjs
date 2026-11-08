/**
 * 时段 —— 现在算哪一段、是不是在免打扰里。
 */

export const PERIODS = [
  { from: 0,    to: 7,    label: '深夜' },
  { from: 7,    to: 11.5, label: '早上' },
  { from: 11.5, to: 14,   label: '中午' },
  { from: 14,   to: 17,   label: '下午' },
  { from: 17,   to: 19,   label: '傍晚' },
  { from: 19,   to: 21.5, label: '晚上' },
  { from: 21.5, to: 24,   label: '深夜' },
]

export function periodOf(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60
  return PERIODS.find((p) => h >= p.from && h < p.to) || PERIODS[0]
}

/**
 * 「9」「9:30」「09:00」都认。
 * 以前只认 HH:MM，而设置页的时间框存下来的是「0」「9」这种纯小时数，
 * 解析失败一律返回 0 → from === to → 免打扰永远不生效（11-08 修的）。
 */
export function parseHM(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/)
  if (!m) return 0
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2] ?? 0))
}

/** 分钟数 → HH:MM，存盘用，保证永远是同一副样子。 */
export function formatHM(minutes) {
  const v = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(minutes) || 0)))
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0')
}

/** 免打扰：[from, to)；跨夜也对 */
export function inQuiet(date = new Date(), quiet = null) {
  if (!quiet || quiet.enabled === false) return false
  const cur = date.getHours() * 60 + date.getMinutes()
  const from = parseHM(quiet.from)
  const to = parseHM(quiet.to)
  if (from === to) return false
  return from < to ? cur >= from && cur < to : cur >= from || cur < to
}
