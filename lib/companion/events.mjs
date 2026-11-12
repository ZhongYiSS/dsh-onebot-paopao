/**
 * 事件池 —— 插件「都做些什么」的清单。
 * ============================================================================
 * 哥哥 m00210：事件池不只说话，也可以是刷视频 / 找图片 / 上网看看…
 * 哥哥 m00219：要能勾选、能调概率、**总数加起来 100%**。
 *
 * 所以这里的 weight 是「份数」，任意正整数；UI 上显示的是归一化后的百分比，
 * 加起来永远是 100 —— 改任何一项，其余按比例跟着变，不会出现 103%。
 *
 * 哥哥 m05588：事件只需要**注入一个词**，怎么做让会话自己想办法。
 * 所以默认 hint 全空；hint 是留给哥哥自己填的一句补充（设置页里每个事件下面），
 * 留空就只把 label 递给会话。
 * ============================================================================
 */

/** 默认事件池（10 个槽位，开着的合计 100 份）。
 *  哥哥 m18764：**默认词全空**，只有「第一次初始化」才把 SEED_LABEL 填进配置里 ——
 *  下载下来就是填好的样子（好改），但空词就是「用户清掉了」，不许自动补回去。
 *  「唱首歌」要多装一套歌声引擎，默认关着，用户配好再打开。 */
export const EVENT_POOL = [
  { id: 'chat',   label: '', weight: 24, bonus: 3, adapter: 'chat',   hint: '' },
  { id: 'video',  label: '', weight: 18, bonus: 5, adapter: 'bili',   hint: '' },
  { id: 'meme',   label: '', weight: 10, bonus: 4, adapter: 'meme',   hint: '' },
  { id: 'image',  label: '', weight: 10, bonus: 4, adapter: 'image',  hint: '' },
  { id: 'voice',  label: '', weight: 8,  bonus: 5, adapter: 'voice',  hint: '' },
  { id: 'web',    label: '', weight: 8,  bonus: 4, adapter: 'web',    hint: '' },
  { id: 'joke',   label: '', weight: 8,  bonus: 4, adapter: 'chat',   hint: '' },
  { id: 'memory', label: '', weight: 6,  bonus: 4, adapter: 'memory', hint: '' },
  { id: 'remind', label: '', weight: 8,  bonus: 8, adapter: 'remind', hint: '' },
  { id: 'sing',   label: '', weight: 5,  bonus: 6, adapter: 'sing',   hint: '', enabled: false },
]

/** 第一次初始化时写进配置的词（写进去之后就跟用户手填的一样，随便改） */
export const SEED_LABEL = {
  chat: '聊天',
  video: '发个视频',
  meme: '发表情包',
  image: '找张图',
  voice: '发个语音',
  web: '上网看看',
  joke: '讲个笑话',
  memory: '翻个旧账',
  remind: '提醒我',
  sing: '唱首歌',
}

/** 装好就填好的那一份（只有新建配置时用得到） */
export function seedPool() {
  return EVENT_POOL.map((e) => ({ ...e, label: SEED_LABEL[e.id] || '' }))
}

/** 词最长多少字 */
export const LABEL_MAX = 20

/** 这个事件算不算「活着」：开着、有份数、而且填了词 */
export function isLive(e) {
  return e.enabled !== false && Number(e.weight) > 0 && String(e.label || '').trim() !== ''
}

/** 补充那句最长多少字 */
export const HINT_MAX = 80

/** 归一化成百分比（禁用、没份数、没词的项 percent = 0） */
export function normalizePercent(pool = EVENT_POOL) {
  const on = pool.filter(isLive)
  const total = on.reduce((s, e) => s + Number(e.weight), 0) || 1
  return pool.map((e) => ({
    ...e,
    percent: isLive(e) ? Math.round((Number(e.weight) / total) * 1000) / 10 : 0,
  }))
}

/** 按份数抽一个；没有可用事件（没词也算不可用）时返回 null */
export function drawEvent(pool = EVENT_POOL, rnd = Math.random) {
  const on = pool.filter(isLive)
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
  if (!Array.isArray(saved) || !saved.length) return EVENT_POOL.map((e) => ({ ...e, enabled: e.enabled !== false }))
  const byId = new Map(saved.map((e) => [e.id, e]))
  const merged = EVENT_POOL.map((e) => {
    const s = byId.get(e.id)
    return s
      ? {
        ...e,
        // 存盘里的词优先；存的是空串就保持空——空 = 用户自己清掉了，不替她补回来
        label: (typeof s.label === 'string' && s.label.trim()) ? s.label.trim().slice(0, LABEL_MAX) : e.label,
        weight: Number(s.weight) > 0 ? Number(s.weight) : e.weight,
        enabled: s.enabled !== false,
        bonus: Number.isFinite(Number(s.bonus)) ? Number(s.bonus) : e.bonus,
        // 哥哥自己填的补充要留住（默认池里是空的）
        hint: typeof s.hint === 'string' ? s.hint.slice(0, HINT_MAX) : e.hint,
      }
      : { ...e, enabled: e.enabled !== false }
  })
  // 用户自己加的事件（没有内置定义）也留着
  for (const s of saved) {
    if (!EVENT_POOL.some((e) => e.id === s.id) && s.id) {
      merged.push({
        id: s.id,
        label: String(s.label || s.id).trim().slice(0, LABEL_MAX),
        weight: Number(s.weight) || 1,
        bonus: Number(s.bonus) || 0,
        adapter: s.adapter || 'chat',
        hint: typeof s.hint === 'string' ? s.hint.slice(0, HINT_MAX) : '',
        enabled: s.enabled !== false,
      })
    }
  }
  return merged
}
