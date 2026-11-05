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

/** 时间流逝加分：按毫秒比例，每小时 +risePerHour（老算法，只留着给旧配置换算） */
export function riseByTime(w, elapsedMs, risePerHour) {
  if (!(elapsedMs > 0) || !(risePerHour > 0)) return clamp(w)
  return clamp(w + risePerHour * (elapsedMs / 3_600_000))
}

/** 每次抽卡加分：跑一拍就涨 risePerTick，跟过了多久无关 */
export function riseByTick(w, risePerTick) {
  const per = Number(risePerTick)
  if (!Number.isFinite(per) || per <= 0) return clamp(w)
  return clamp(w + per)
}

/** 过没过阈值 */
export function canSpeak(w, threshold) {
  return clamp(w) >= Number(threshold)
}

/**
 * 这一次抽卡命中的概率。
 * 哥哥 11-05 定的口径：p = (w / 100) × pmax —— 权重多少，概率就是它的百分之几。
 * 阈值仍然是硬门槛：w 低于阈值一律 0（m05320 确认保留）。
 * 旧算法是 pmax × (0.35 + 0.65 × 过了阈值多少)，权重和概率对不上号，已换掉。
 */
export function triggerChance(w, threshold, pmax = 0.12) {
  const ww = clamp(w)
  if (ww < Number(threshold)) return 0
  return Math.max(0, Number(pmax)) * (Math.max(0, ww) / W_MAX)
}

/**
 * 兴趣分 → 扣分系数（哥哥 11-05 定的表）：
 *   10 分 0（一点不扣）、9 分 0.2、8 分 0.4、7 分 0.6、6 分 0.8、
 *   5 分 1（标准）、4 分 1.25、3 分 1.5、2 分 1.75、1 分 2（双倍）——0 分也按 2 封顶。
 * score 传的是 0~100（会话打 0-10 分 ×10）。
 */
export function releaseFactor(score) {
  const s = Math.min(10, Math.max(0, Number.isFinite(Number(score)) ? Number(score) / 10 : 5))
  const f = s >= 5 ? 1 - (s - 5) / 5 : 1 + (5 - s) / 4
  return Math.min(2, Math.max(0, f))
}

/**
 * 开口之后释放：扣 = 基础扣 × 系数。
 * 聊得越开心扣得越少（10 分不扣），聊得没感觉扣得越多（1 分双倍）。
 */
export function release(w, score, { base = 20 } = {}) {
  return clamp(clamp(w) - Math.max(0, Number(base)) * releaseFactor(score))
}

/** 抽中事件那一刻的加分（代表「兴致还在」） */
export function addBonus(w, bonus) {
  return clamp(clamp(w) + (Number(bonus) || 0))
}

/** 被怼 / 冷场：额外扣 */
export function penalize(w, amount) {
  return clamp(clamp(w) - Math.max(0, Number(amount) || 0))
}
