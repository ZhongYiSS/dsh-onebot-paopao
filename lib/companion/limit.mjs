/**
 * 限流 —— 滑动窗口「N 小时最多 M 条」。
 * ============================================================================
 * 哥哥 m00219 ③：每日上限改成「*小时最多*条」可自定义时间。
 * 所以这里存的是每次触发的时间戳数组，判断时先裁掉窗口外的，再数。
 * 真滚动，不是整点清零。
 * ============================================================================
 */

/** 裁掉窗口外的时间戳 */
export function pruneWindow(window, hours, now = Date.now()) {
  const h = Math.max(0.1, Number(hours) || 1)
  const cut = now - h * 3_600_000
  return (Array.isArray(window) ? window : []).filter((t) => Number(t) > cut)
}

/** 还能不能再触发 */
export function canTrigger(window, hours, max, now = Date.now()) {
  const m = Math.max(1, Number(max) || 1)
  return pruneWindow(window, hours, now).length < m
}

/** 窗口里已经几条 */
export function countInWindow(window, hours, now = Date.now()) {
  return pruneWindow(window, hours, now).length
}

/** 离下一条还要多久（毫秒）；能发就返回 0 */
export function msUntilNext(window, hours, max, now = Date.now()) {
  const h = Math.max(0.1, Number(hours) || 1)
  const m = Math.max(1, Number(max) || 1)
  const win = pruneWindow(window, h, now).sort((a, b) => a - b)
  if (win.length < m) return 0
  const oldest = win[win.length - m]
  return Math.max(1, oldest + h * 3_600_000 - now)
}
