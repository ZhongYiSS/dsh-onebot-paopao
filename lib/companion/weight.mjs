/**
 * 权重核 —— 只做数学，不碰 IO、不碰时钟。
 * ============================================================================
 * 哥哥定的语义（m00197）：
 *   · 权重 w ∈ [-20, 100]，低于阈值就不主动开口（QQ 自己的消息规则另算）
 *   · w 随时间上升（每小时 +risePerHour）
 *   · w 越高，定时触发事件的概率越高
 *   · 触发后按会话给的分（兴趣分）兑现，掉回阈值下方
 *   · 事件本身、加分、扣分，全在插件里跑，会话只管开口 + 反馈分数
 * ============================================================================
 */

export const W_MIN = -20
export const W_MAX = 100

/** 夹在 [-20, 100]；坏值当 0 */
export function clamp(w) {
  const n = Number(w)
  if (!Number.isFinite(n)) return 0
  return Math.min(W_MAX, Math.max(W_MIN, n))
}

/** 时间流逝加分：按毫秒比例，每小时 +risePerHour */
export function riseByTime(w, elapsedMs, risePerHour) {
  if (!(elapsedMs > 0) || !(risePerHour > 0)) return clamp(w)
  return clamp(w + risePerHour * (elapsedMs / 3_600_000))
}

/** 过没过阈值 */
export function canSpeak(w, threshold) {
  return clamp(w) >= Number(threshold)
}

/**
 * 这一次抽卡命中的概率。
 * 刚过阈值 = 0.35 × pmax（不至于一过线就必中），到顶 = pmax。
 */
export function triggerChance(w, threshold, pmax = 0.12) {
  const ww = clamp(w)
  if (ww < Number(threshold)) return 0
  const span = Math.max(1, W_MAX - Number(threshold))
  const t = Math.min(1, (ww - Number(threshold)) / span)
  return Math.max(0, Number(pmax)) * (0.35 + 0.65 * t)
}

/**
 * 开口之后释放。
 * 基础扣 base，再按会话反馈的兴趣分扣 0~span。
 * 兴趣分 100 = 聊得特别开心 → 扣得最多 → 接下来更安静；
 * 兴趣分 0 = 敷衍/冷场 → 扣得少 → 还容易再开口。
 */
export function release(w, score, { base = 20, span = 40 } = {}) {
  const s = Math.min(100, Math.max(0, Number.isFinite(Number(score)) ? Number(score) : 50))
  return clamp(clamp(w) - (Number(base) + (s / 100) * Number(span)))
}

/** 抽中事件那一刻的加分（代表「兴致还在」） */
export function addBonus(w, bonus) {
  return clamp(clamp(w) + (Number(bonus) || 0))
}

/** 被怼 / 冷场：额外扣 */
export function penalize(w, amount) {
  return clamp(clamp(w) - Math.max(0, Number(amount) || 0))
}
