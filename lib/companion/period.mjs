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

export function parseHM(s) {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return 0
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]))
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
