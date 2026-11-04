/**
 * 事件池 —— 插件「都做些什么」的清单。
 * ============================================================================
 * 哥哥 m00210：事件池不只说话，也可以是刷视频 / 找图片 / 上网看看…
 * 哥哥 m00219：要能勾选、能调概率、**总数加起来 100%**。
 *
 * 所以这里的 weight 是「份数」，任意正整数；UI 上显示的是归一化后的百分比，
 * 加起来永远是 100 —— 改任何一项，其余按比例跟着变，不会出现 103%。
 * ============================================================================
 */

/** 默认事件池（主动档 9 个，合计 100 份） */
export const EVENT_POOL = [
  { id: 'chat',   label: '说句话',   weight: 30, bonus: 3, adapter: 'chat',   hint: '随便聊两句，不用找理由' },
  { id: 'video',  label: '刷视频',   weight: 20, bonus: 5, adapter: 'bili',   hint: '去 B站 搜一轮，挑一条值得的' },
  { id: 'image',  label: '找张图',   weight: 10, bonus: 4, adapter: 'image',  hint: '翻相册或画一张，发一张' },
  { id: 'web',    label: '上网看看', weight: 8,  bonus: 4, adapter: 'web',    hint: '搜点新鲜事，挑一条有意思的说' },
  { id: 'meme',   label: '甩表情包', weight: 8,  bonus: 4, adapter: 'meme',   hint: '从表情包里挑一张' },
  { id: 'voice',  label: '发语音',   weight: 7,  bonus: 5, adapter: 'voice',  hint: '说句话，用说的' },
  { id: 'memory', label: '翻旧账',   weight: 6,  bonus: 4, adapter: 'memory', hint: '去记忆里翻件旧事出来说' },
  { id: 'remind', label: '提醒哥哥', weight: 6,  bonus: 8, adapter: 'remind', hint: '到点该提醒的事（有就提醒，没有跳过）' },
  { id: 'sing',   label: '唱首歌',   weight: 5,  bonus: 6, adapter: 'sing',   hint: '唱一小段' },
]

/** 归一化成百分比（禁用的项 percent = 0） */
export function normalizePercent(pool = EVENT_POOL) {
  const on = pool.filter((e) => e.enabled !== false && Number(e.weight) > 0)
  const total = on.reduce((s, e) => s + Number(e.weight), 0) || 1
  return pool.map((e) => ({
    ...e,
    percent: e.enabled === false || Number(e.weight) <= 0
      ? 0
      : Math.round((Number(e.weight) / total) * 1000) / 10,
  }))
}

/** 按份数抽一个；没有可用事件时返回 null */
export function drawEvent(pool = EVENT_POOL, rnd = Math.random) {
  const on = pool.filter((e) => e.enabled !== false && Number(e.weight) > 0)
  if (!on.length) return null
  const total = on.reduce((s, e) => s + Number(e.weight), 0)
  let r = rnd() * total
  for (const e of on) {
    r -= Number(e.weight)
    if (r <= 0) return e
  }
  return on[on.length - 1]
}

/** 按 id 找 */
export function eventById(pool, id) {
  return pool.find((e) => e.id === id) || null
}

/** 把存盘的 pool 和默认池合并（新版本加了事件也不会丢） */
export function mergePool(saved) {
  if (!Array.isArray(saved) || !saved.length) return EVENT_POOL.map((e) => ({ ...e, enabled: true }))
  const byId = new Map(saved.map((e) => [e.id, e]))
  const merged = EVENT_POOL.map((e) => {
    const s = byId.get(e.id)
    return s
      ? { ...e, weight: Number(s.weight) > 0 ? Number(s.weight) : e.weight, enabled: s.enabled !== false, bonus: Number.isFinite(Number(s.bonus)) ? Number(s.bonus) : e.bonus }
      : { ...e, enabled: true }
  })
  // 用户自己加的事件（没有内置定义）也留着
  for (const s of saved) {
    if (!EVENT_POOL.some((e) => e.id === s.id) && s.id) {
      merged.push({ id: s.id, label: s.label || s.id, weight: Number(s.weight) || 1, bonus: Number(s.bonus) || 0, adapter: s.adapter || 'chat', hint: s.hint || '', enabled: s.enabled !== false })
    }
  }
  return merged
}
