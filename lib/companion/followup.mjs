/**
 * 定时话头 —— 会话自己说「过一会儿/几点，把话头再递给我」。
 * ============================================================================
 * 哥哥 11-09 重新定的规矩：
 *   1. **抽卡（插件主动叫她）的那一轮不许定时**——只有「他说话/回她」的那一轮才有资格。
 *      闸门放在 bridge：只有在他刚说完话的窗口里（默认 3 分钟）才认这个标记。
 *   2. 到点只是**再叫醒她一轮**（等于她给自己排了一张卡），不是发固定的一句话，
 *      所以她到点看到的是最新上下文，不会穿帮。
 *   3. 免打扰照样管（由 tick 判）；**限流不管**（tick 里 followup 跳过 limit）。
 *   4. 上限：每个会话同时只留一条；每天条数可配；最长 12 小时（可配）。
 *   5. 重启/刷新不丢：落的 `followup-pending.json`，起来时重新排上。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

const PENDING = 'followup-pending.json'
const LOG = 'followup.jsonl'
const DAY = 86400_000

function readJson(home, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(home, name, data) {
  try {
    fs.mkdirSync(home, { recursive: true })
    const tmp = path.join(home, `.${name}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, path.join(home, name))
  } catch {
    /* 记账失败不影响主流程 */
  }
}

function logLine(home, rec) {
  try {
    fs.appendFileSync(path.join(home, LOG), JSON.stringify(rec) + '\n')
  } catch {
    /* 同上 */
  }
}

export function createFollowup({
  home,
  getConfig = () => ({}),
  /** (chatId, info) => Promise<{skipped?, ok?}> 到点真正跑一轮 */
  fire = async () => ({ skipped: 'nofire' }),
  userSpokeAt = () => 0,
  log = () => {},
  now = () => Date.now(),
}) {
  const timers = new Map() // chatId -> { timer, dueAt, askedAt, sec }

  function settings() {
    const c = getConfig() || {}
    const maxSec = Math.max(60, Math.min(43200, (Number(c.followupMaxHours) || 12) * 3600))
    const perDay = Math.max(1, Math.min(20, Number(c.followupPerDay) || 3))
    const minSec = Math.max(30, Math.min(3600, Number(c.followupMinSec) || 60))
    return { enabled: c.followupEnabled !== false, maxSec, perDay, minSec }
  }

  /** 今天（按自然日）这个会话已经排过几次 */
  function usedToday(chatId, t) {
    let rows = []
    try {
      rows = fs.readFileSync(path.join(home, LOG), 'utf8').split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
    } catch {
      rows = []
    }
    const midnight = new Date(t)
    midnight.setHours(0, 0, 0, 0)
    return rows.filter((r) => r.result === 'asked' && String(r.chatId) === String(chatId) && Number(r.askedAt || 0) >= midnight.getTime()).length
  }

  function persist() {
    const out = {}
    for (const [chatId, p] of timers) out[chatId] = { dueAt: p.dueAt, askedAt: p.askedAt, sec: p.sec }
    writeJson(home, PENDING, out)
  }

  function arm(chatId, p) {
    const delay = Math.max(1000, p.dueAt - now())
    const timer = setTimeout(() => {
      timers.delete(chatId)
      persist()
      Promise.resolve(fire(chatId, { dueAt: p.dueAt, askedAt: p.askedAt, sec: p.sec }))
        .then((r) => {
          const skipped = (r && r.skipped) || ''
          if (skipped) log('info', '定时话头没发出去（' + skipped + '）：' + chatId)
          logLine(home, { at: now(), chatId, askedAt: p.askedAt, sec: p.sec, skipped, ok: !!(r && r.ok) })
        })
        .catch((e) => {
          log('warn', '定时话头出错（' + chatId + '）：' + (e?.message ?? e))
          logLine(home, { at: now(), chatId, askedAt: p.askedAt, sec: p.sec, error: String(e?.message ?? e) })
        })
    }, delay)
    timer.unref?.()
    timers.set(chatId, { timer, dueAt: p.dueAt, askedAt: p.askedAt, sec: p.sec })
    persist()
  }

  /** 排一条。sec = 多少秒后（已由 prompt.mjs 算好偏移）。 */
  function request(chatId, sec = 0) {
    const s = settings()
    if (!s.enabled) return { ok: false, reason: 'off' }
    const t = now()
    const delay = Math.max(s.minSec, Math.min(s.maxSec, Math.round(Number(sec) || 0)))
    if (!Number.isFinite(delay) || delay <= 0) return { ok: false, reason: 'bad' }
    if (usedToday(chatId, t) >= s.perDay) {
      log('info', '定时话头撞每日上限（' + s.perDay + ' 条）：' + chatId)
      return { ok: false, reason: 'cap' }
    }
    cancel(chatId)
    arm(chatId, { dueAt: t + delay * 1000, askedAt: t, sec: delay })
    logLine(home, { at: t, chatId, askedAt: t, sec: delay, result: 'asked' })
    return { ok: true, dueAt: t + delay * 1000, sec: delay }
  }

  function cancel(chatId) {
    const p = timers.get(chatId)
    if (!p) return false
    clearTimeout(p.timer)
    timers.delete(chatId)
    persist()
    return true
  }

  function stop() {
    for (const p of timers.values()) clearTimeout(p.timer)
    timers.clear()
  }

  /** 起来时把没到点的重新排上（过了点的 5 秒后补发一次，别丢）。 */
  function restore() {
    const saved = readJson(home, PENDING, {}) || {}
    const t = now()
    for (const [chatId, p] of Object.entries(saved)) {
      const dueAt = Number(p.dueAt) || 0
      if (!chatId || !dueAt) continue
      arm(chatId, { dueAt: Math.max(dueAt, t + 5000), askedAt: Number(p.askedAt) || t, sec: Number(p.sec) || 0 })
    }
  }

  function userSpokeSince(chatId, since) {
    try {
      return Number(userSpokeAt(chatId) || 0) > Number(since || 0)
    } catch {
      return false
    }
  }

  return {
    request,
    cancel,
    stop,
    restore,
    userSpokeSince,
    get pending() {
      return [...timers.entries()].map(([chatId, p]) => ({ chatId, dueAt: p.dueAt, sec: p.sec }))
    },
  }
}
