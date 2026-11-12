/**
 * 状态与账本 —— 全落在家里，不落在插件包里（更新插件不会把记录冲掉）。
 *   <home>/state.json     当前权重、今天说了几次、滑动窗口
 *   <home>/history.jsonl  做过的事（追加写，一行一条，永不重写）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, obj) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function defaultState() {
  return {
    w: 0,
    lastRiseAt: Date.now(),
    lastTriggerAt: 0,
    todayCount: 0,
    dayKey: '',
    lastByEvent: {},
    window: [],
  }
}

export function dayKeyOf(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function readState(home) {
  const s = { ...defaultState(), ...readJson(join(home, 'state.json'), {}) }
  if (!Array.isArray(s.window)) s.window = []
  if (!s.lastByEvent || typeof s.lastByEvent !== 'object') s.lastByEvent = {}
  return s
}

export function writeState(home, s) {
  ensureDir(home)
  writeJson(join(home, 'state.json'), s)
}

// ---------------------------------------------------------------- 每个会话一个桶
/** 一个会话自己的账本（权重、今天几次、滑动窗口各管各的；发过的视频在 bubble/videos.json 里，全局一本）。 */
export function normalizeBucket(raw) {
  const s = { ...defaultState(), ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!Array.isArray(s.window)) s.window = []
  if (!s.lastByEvent || typeof s.lastByEvent !== 'object') s.lastByEvent = {}
  return s
}

/**
 * 读所有会话的桶。
 * 老版本 state.json 是「一整份状态」，没有 buckets —— 读的时候顺手搬进
 * `legacyKey`（老配置里那个 chatId）名下，不丢权重。
 */
export function readBuckets(home, legacyKey = '_default') {
  const raw = readJson(join(home, 'state.json'), {})
  if (raw && raw.buckets && typeof raw.buckets === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(raw.buckets)) out[k] = normalizeBucket(v)
    return out
  }
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return {}
  const legacy = { ...raw }
  delete legacy.buckets
  const key = String(legacyKey || '_default')
  delete legacy.chatId
  return { [key]: normalizeBucket(legacy) }
}

export function writeBuckets(home, buckets) {
  ensureDir(home)
  writeJson(join(home, 'state.json'), { buckets })
}

/**
 * 取某个会话的账本；没有就当场建一个挂进 buckets。
 * （以前是 `buckets[chatId] || normalizeBucket(null)`——没有的时候返回一个
 *  游离对象，外面改了半天再 writeBuckets，改动直接丢了。V2 落地时踩到，
 *  现在改成「拿到的一定是桶里的那一个」。）
 */
export function bucketOf(buckets, chatId) {
  const key = String(chatId)
  if (!buckets[key] || typeof buckets[key] !== 'object') buckets[key] = normalizeBucket(null)
  return buckets[key]
}

/** 追加一条「做过的事」 */
export function appendHistory(home, item) {
  ensureDir(home)
  const line = JSON.stringify({ at: Date.now(), ...item }) + '\n'
  appendFileSync(join(home, 'history.jsonl'), line, 'utf8')
}

/** 读最近 limit 条（新的在前） */
export function readHistory(home, limit = 40) {
  const file = join(home, 'history.jsonl')
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit)).reverse().map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- 兴趣分
/**
 * 会话自己打的兴趣分（[SCORE n]，0~12 → 这里存 0~120）。
 * 单独一个文件：tick 每一拍都会整份写 state.json，分数是异步到的，
 * 写同一个文件会互相覆盖。所以分数落 scores.json，tick 下一拍来取。
 */
export function noteScore(home, chatId, score, extra = {}) {
  const f = join(home, 'scores.json')
  const all = readJson(f, {})
  // 上限 120（=12 分）：11/12 分是新加的档，别在这儿被截成 10 分（11-11 抓到的口径不一致）
  const n = Math.max(0, Math.min(120, Number(score)))
  if (!Number.isFinite(n)) return null
  const rec = { score: n, at: Date.now() }
  if (extra.inbound === true) rec.inbound = true
  if (extra.origin) rec.origin = String(extra.origin)
  all[String(chatId)] = rec
  ensureDir(home)
  writeJson(f, all)
  return rec
}

export function readScore(home, chatId) {
  const all = readJson(join(home, 'scores.json'), {})
  const v = all[String(chatId)]
  if (!v || !Number.isFinite(Number(v.score))) return null
  return { score: Number(v.score), at: Number(v.at) || 0, inbound: v.inbound === true, origin: v.origin || '' }
}

/** 把「多久以前」变成人话 */
export function agoText(ms) {
  if (!ms || ms < 0) return ''
  const m = Math.floor(ms / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
