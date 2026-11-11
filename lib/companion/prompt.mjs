/**
 * 话头 —— 插件对会话说的**唯一一句话**。
 * ============================================================================
 * 红线（哥哥 m00171）：插件不代写正文。这里只给「什么时候、抽中了哪个词」，
 * 说什么是会话自己的事；做了但不想发回 [HOLD]。
 * （哥哥 m04134：删掉 [SKIP]——抽中的这一轮不许跳过，总得说点什么。）
 * （哥哥 m05588：事件只注入一个词，具体怎么做由会话自己想；hint 是他自己加的补充。）
 * （哥哥 11-11 m17382：话头要能自己改、要给预览 —— 模板搬到 cue.mjs，这里只转手。）
 * ============================================================================
 */

import { renderCue } from './cue.mjs'

export function buildHint({
  cue = null,
  kind = 'bubble',
  modeLabel = '日常档',
  countToday = 1,
  lastAgoText = '',
  periodLabel = '',
  w = 0,
  event = null,
  candidates = [],
  chatId = '',
  chatLabel = '',
  note = '',
}) {
  // 11-11 哥哥：话头开放给设置页自己写（一段模板），这里只负责把参数递过去。
  // 没传 cue 就用默认模板（老测试、以及配置还没迁移过的情况）。
  return renderCue({
    cue,
    kind,
    modeLabel,
    periodLabel,
    countToday,
    lastAgoText,
    w,
    event,
    candidates,
    chatLabel,
    chatId,
    note,
    // 这个事件本来该由插件备料（刷视频），但这次没搜到 —— 说清楚，别让她以为有候选
    emptyCandidates: !!event?.adapter,
  })
}

/** 会话回复里有没有拦截标记（只认 [HOLD]；[SKIP] 已按哥哥 m04134 删掉） */
export function readVerdict(text) {
  const s = String(text || '')
  if (/\[HOLD\]/i.test(s)) return 'hold'
  return 'send'
}

/**
 * 兴趣分：会话在回复最后自己写的 [SCORE 7]（0~12 整数）。
 * 返回 0~120 的分数（跟 release 一个量纲），没写就 null。
 * 哥哥 11-05 定的：分由她自己打，插件只读；11-11 加了 11/12 两档（+150% / +200%）。
 */
export function readScore(text) {
  const m = /\[SCORE\s*([0-9]{1,3})\]/i.exec(String(text || ''))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(120, Math.round(Math.max(0, Math.min(12, n)) * 10)))
}

/** 把标记剥掉（发出去的内容里不该带它；老回复里的 [SKIP] 也一并剥掉，但不作数） */
export function stripVerdict(text) {
  return String(text || '')
    .replace(/\[(SKIP|HOLD)\]/gi, '')
    .replace(/\[LATER\s+[0-9]{1,4}\s*(?:m|s)?\]/gi, '')
    .replace(/\[SCORE\s*[0-9]{1,3}\]/gi, '')
    .trim()
}

/**
 * 定时话头：会话在正文里写 `[LATER 25]`（25 分钟后）/ `[LATER 90s]`（90 秒后）。
 * 只认分钟数（「多少分钟后」）。
 * 返回秒数（相对现在），没写返回 null，写坏了返回 null。
 * 哥哥 11-09：到点只是再叫醒她一轮（等于她给自己排一张卡），不是什么固定内容。
 */
export function readLater(text, now = Date.now(), maxSec = 43200) {
  const m = /\[LATER\s+([0-9]{1,4})\s*(m|s|分钟|秒)?\]/i.exec(String(text || ''))
  if (!m) return null
  const unit = (m[2] || '').toLowerCase()
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const sec = (unit === 's' || unit === '秒') ? n : n * 60
  if (!Number.isFinite(sec) || sec < 30) return null
  return Math.min(maxSec, Math.round(sec))
}
