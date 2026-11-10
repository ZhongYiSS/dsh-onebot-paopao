/**
 * 她自己的「口味账」：哪些 UP 主 / 哪个关键词让她觉得聊得开心。
 *
 * 数据只有一个来源——她每轮回复末尾自己打的 `[SCORE n]`（0~12）。
 * tick 在下一拍取到分，就按 `(分-5)/5` 给上一轮推过去的视频加/减分（-1 ~ +1），
 * 挑视频时按这份账加权排序。头几天样本少，效果要攒一阵才看得出来。
 * @module dsh-onebot/companion/taste
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'taste.json'
const MAX_ENTRIES = 400
const DECAY = 0.98 // 每次记分顺手把它乘一下，旧账慢慢淡出

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function fileOf(home) {
  return path.join(String(home || ''), FILE)
}

/** 读口味账：{ up: { mid: { s, n, at } }, kw: { 关键词: { s, n, at } } } */
export function readTaste(home) {
  const empty = { up: {}, kw: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(home), 'utf8'))
    return {
      up: raw && typeof raw.up === 'object' && raw.up ? raw.up : {},
      kw: raw && typeof raw.kw === 'object' && raw.kw ? raw.kw : {},
    }
  } catch {
    return empty
  }
}

function trim(bucket) {
  const keys = Object.keys(bucket)
  if (keys.length <= MAX_ENTRIES) return
  keys
    .sort((a, b) => (Number(bucket[b]?.at) || 0) - (Number(bucket[a]?.at) || 0))
    .slice(MAX_ENTRIES)
    .forEach((k) => { delete bucket[k] })
}

/**
 * 按分数给上一轮推出去的候选记账。
 * @param home 泡泡家目录
 * @param picks [{ upMid, kw, bvid }]
 * @param score 0~100（她打的 0~10 × 10）
 */
export function bumpTaste(home, picks, score, now = Date.now()) {
  const list = Array.isArray(picks) ? picks.filter(Boolean) : []
  if (!list.length) return null
  const s = Number(score)
  if (!Number.isFinite(s)) return null
  const delta = clamp((s - 50) / 50, -1, 1) // 5 分不动，10 分 +1，0 分 -1
  if (delta === 0) return null
  const taste = readTaste(home)
  for (const p of list) {
    const up = String(p?.upMid ?? '')
    const kw = String(p?.kw ?? '')
    for (const [bucket, key] of [[taste.up, up], [taste.kw, kw]]) {
      if (key === '' || key === '热门') continue
      const cur = bucket[key] || { s: 0, n: 0, at: 0 }
      bucket[key] = { s: clamp((Number(cur.s) || 0) * DECAY + delta, -20, 20), n: (Number(cur.n) || 0) + 1, at: now }
    }
  }
  trim(taste.up)
  trim(taste.kw)
  try {
    fs.mkdirSync(String(home || ''), { recursive: true })
    const tmp = fileOf(home) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(taste, null, 1))
    fs.renameSync(tmp, fileOf(home))
  } catch {
    return null
  }
  return taste
}

/** 排序用：UP 主的账权重高一点（人比词准），没有账就是 0。 */
export function tasteScore(taste, upMid, kw) {
  if (!taste) return 0
  const up = Number(taste.up?.[String(upMid ?? '')]?.s) || 0
  const k = Number(taste.kw?.[String(kw ?? '')]?.s) || 0
  return up * 1.0 + k * 0.5
}
