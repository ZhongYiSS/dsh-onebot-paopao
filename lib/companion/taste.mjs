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
  const taste = readTaste(home)
  // 2026-11-19 审计：DECAY 以前只乘在「这一轮记到的那几条」上，别的条目永远不减，
  // 等于旧账永不过期（一条 UP 攒到 +20 就再也不掉）。改成每记一次分，整本账先统一淡出。
  if (list.length > 0) {
    for (const bucket of [taste.up, taste.kw]) {
      for (const key of Object.keys(bucket)) {
        const cur = bucket[key]
        if (!cur || typeof cur !== 'object') continue
        cur.s = clamp((Number(cur.s) || 0) * DECAY, -20, 20)
      }
    }
  }
  // 11-14：5 分（delta=0）以前直接 return —— 于是「她没意见」的那条 at 一直不刷新，
  // trim() 按 at 排序裁到 400 条时，常被推但她从不评价的 UP 会被当成旧账清掉。
  // 现在 0 分也刷 at（只刷已有的条目，不新建）。
  if (delta === 0) {
    let touched = false
    for (const p of list) {
      for (const [bucket, key] of [[taste.up, String(p?.upMid ?? '')], [taste.kw, String(p?.kw ?? '')]]) {
        if (key === '' || key === '热门' || !bucket[key]) continue
        bucket[key].at = now
        touched = true
      }
    }
    if (!touched) {
      // 2026-11-19 审计：5 分轮不新建条目（11-14 的口径），但整本账的衰减已经在上面算过了 ——
      // 以前这里直接 return null，等于「她没评价的那一轮」衰减白算。落盘，但对外仍回 null
      // （返回 null 的语义是「这一轮没记到新东西」，调用方靠它判断要不要记分）。
      if (list.length > 0) {
        try {
          fs.mkdirSync(String(home || ''), { recursive: true })
          const tmp1 = fileOf(home) + '.tmp'
          fs.writeFileSync(tmp1, JSON.stringify(taste, null, 1))
          fs.renameSync(tmp1, fileOf(home))
        } catch { /* 落盘失败无所谓，下一轮再来 */ }
      }
      return null
    }
    try {
      fs.mkdirSync(String(home || ''), { recursive: true })
      const tmp0 = fileOf(home) + '.tmp'
      fs.writeFileSync(tmp0, JSON.stringify(taste, null, 1))
      fs.renameSync(tmp0, fileOf(home))
    } catch {
      // 刷 at 失败无所谓，下一轮再来
    }
    return taste
  }
  for (const p of list) {
    const up = String(p?.upMid ?? '')
    const kw = String(p?.kw ?? '')
    for (const [bucket, key] of [[taste.up, up], [taste.kw, kw]]) {
      if (key === '' || key === '热门') continue
      const cur = bucket[key] || { s: 0, n: 0, at: 0 }
      // 2026-11-19 审计：上面已经整本账乘过一次 DECAY，这里再乘就是 0.98²。
      // 被打分的条目用已经衰减过的 cur.s 加 delta 就行。
      bucket[key] = { s: clamp((Number(cur.s) || 0) + delta, -20, 20), n: (Number(cur.n) || 0) + 1, at: now }
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
