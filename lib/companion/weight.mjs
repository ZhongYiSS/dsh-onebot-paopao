/**
 * 权重核 —— 只做数学，不碰 IO、不碰时钟。
 * ============================================================================
 * 哥哥定的语义（m00197）：
 *   · 权重 w ∈ [地板, 100]，地板每套配置自己定（-100 ~ 0），低于阈值就不主动开口
 *   · 每抽一拍涨 risePerTick（跟隔了多久无关）
 *   · w 越高，定时触发事件的概率越高
 *   · 一轮结束按会话给的分（心情分）当场结算，掉回阈值下方
 *   · 事件本身、加分、扣分，全在插件里跑，会话只管开口 + 反馈分数
 * ============================================================================
 */

export const W_MIN = -100
export const W_MAX = 100
/** 没配下限时的默认地板（哥哥 11-10 起下限开放到 -100 ~ 0，每套模式自己定） */
export const W_FLOOR_DEFAULT = -20

/** 夹在 [上限, 下限]；floor 默认用老地板 -20，坏值当 0 */
export function clamp(w, floor = W_FLOOR_DEFAULT) {
  const n = Number(w)
  if (!Number.isFinite(n)) return 0
  const lo = Math.min(0, Math.max(W_MIN, Number.isFinite(Number(floor)) ? Number(floor) : W_FLOOR_DEFAULT))
  return Math.min(W_MAX, Math.max(lo, n))
}

/** 时间流逝加分：按毫秒比例，每小时 +risePerHour（老算法，只留着给旧配置换算） */
export function riseByTime(w, elapsedMs, risePerHour) {
  if (!(elapsedMs > 0) || !(risePerHour > 0)) return clamp(w)
  return clamp(w + risePerHour * (elapsedMs / 3_600_000))
}

/** 每次抽卡加分：跑一拍就涨 risePerTick，跟过了多久无关 */
export function riseByTick(w, risePerTick, floor = W_FLOOR_DEFAULT) {
  const per = Number(risePerTick)
  if (!Number.isFinite(per) || per <= 0) return clamp(w, floor)
  return clamp(w + per, floor)
}

/** 过没过阈值 */
export function canSpeak(w, threshold, floor = W_FLOOR_DEFAULT) {
  return clamp(w, floor) >= Number(threshold)
}

/**
 * 这一次抽卡命中的概率。
 * 哥哥 11-05 定的口径：p = (w / 100) × pmax —— 权重多少，概率就是它的百分之几。
 * 阈值仍然是硬门槛：w 低于阈值一律 0（m05320 确认保留）。
 * 旧算法是 pmax × (0.35 + 0.65 × 过了阈值多少)，权重和概率对不上号，已换掉。
 */
export function triggerChance(w, threshold, pmax = 0.12, floor = W_FLOOR_DEFAULT) {
  const ww = clamp(w, floor)
  if (ww < Number(threshold)) return 0
  return Math.max(0, Number(pmax)) * (Math.max(0, ww) / W_MAX)
}

/**
 * 兴趣分 → 补多少（按基础扣的百分比）。哥哥 11-10 / 11-11 定的表：
 *   12 分 +200%、11 分 +150%、10 分 +120%、9 分 +80%、8 分 +60%、7 分 +50%、
 *   6 分 +20%、5 分 0%、4 分 -20%、3 分 -40%、2 分 -60%、1 分 -80%、0 分 -100%
 * 一段对话先扣一个基础扣；分到了再按这张表补/追扣。10 分净赚 20%，11 分净赚 50%，
 * 12 分净赚 100%（等于这一段不但没花，还倒赚一倍），0 分净扣两倍。
 * score 传 0~120（会话打 0-12 分 ×10）。inbound=true 表示这段对话是他先找上来的，表前 +2 分。
 */
export const REFUND_PCT = [-100, -80, -60, -40, -20, 0, 20, 50, 60, 80, 120, 150, 200]
/** 分数上限（12 分）：超过的不再往上算，口径和「打几分」那张表保持一致 */
export const SCORE_MAX = 12

export function refundPct(score, { inbound = false, inboundBonus = 2 } = {}) {
  const raw = Number.isFinite(Number(score)) ? Number(score) / 10 : 5
  // 11-11 哥哥：这个旋钮可以是负数——有的性格爱打高分，靠它把分压回来。
  const bonus = Number.isFinite(Number(inboundBonus)) ? Number(inboundBonus) : 2
  const s = Math.min(SCORE_MAX, Math.max(0, Math.round(raw + (inbound ? bonus : 0))))
  return REFUND_PCT[s]
}

/** 结算一轮：w + 百分比 × 基础扣（正数补回来，负数再扣） */
export function settle(w, score, { base = 20, floor = W_FLOOR_DEFAULT, inbound = false, inboundBonus = 2 } = {}) {
  const b = Math.max(0, Number(base) || 0)
  return clamp(clamp(w, floor) + (refundPct(score, { inbound, inboundBonus }) / 100) * b, floor)
}

/** 一轮的固定消耗（不管这轮发没发出去，哥哥 11-10 定的：憋住也算花一次） */
export function spend(w, base = 20, { floor = W_FLOOR_DEFAULT } = {}) {
  return clamp(clamp(w, floor) - Math.max(0, Number(base) || 0), floor)
}

/** 老名字，留给旧调用（等价于 settle 到 5 分） */
export function release(w, score, { base = 20, floor = W_FLOOR_DEFAULT } = {}) {
  return settle(w, score, { base, floor })
}

/** 抽中事件那一刻的加分（代表「兴致还在」） */
export function addBonus(w, bonus, floor = W_FLOOR_DEFAULT) {
  return clamp(clamp(w, floor) + (Number(bonus) || 0), floor)
}

/** 被怼 / 冷场：额外扣 */
export function penalize(w, amount) {
  return clamp(clamp(w) - Math.max(0, Number(amount) || 0))
}
