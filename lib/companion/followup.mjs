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

// 到点了但这一拍没发出去的原因 → 多久之后再试一次。
// （哥哥 11-14：以前 busy/quiet 直接丢掉，等于「排了的追聊遇上另一个拍子在跑就永久蒸发」。）
const RETRY_MS = {
  busy: 90_000,        // 别的会话正有一拍在跑，等它跑完
  quiet: 10 * 60_000,  // 免打扰时段，过十分钟再看一眼（多数人设的夜间是几小时）
  off: 5 * 60_000,     // 插件刚被关掉
  notyet: 60_000,      // 这一拍还没到点（极端情况：手动/并发）
  nochat: 5 * 60_000,  // 聊天对象暂时没了（会话在重建）
}
const MAX_TRIES = 12     // 最多重试这么多次，再发不出去就真放弃并留一行 warn

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
  log = () => {},
  now = () => Date.now(),
}) {
  const timers = new Map() // chatId -> { timer, dueAt, askedAt, sec }

  function settings() {
    const c = getConfig() || {}
    const maxSec = Math.max(60, Math.min(43200, (Number(c.followupMaxHours) || 12) * 3600))
    const perDay = Math.max(1, Math.min(20, Number.isFinite(Number(c.followupPerDay)) && Number(c.followupPerDay) > 0 ? Number(c.followupPerDay) : 20))
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
    for (const [chatId, p] of timers) out[chatId] = { dueAt: p.dueAt, askedAt: p.askedAt, sec: p.sec, tries: p.tries || 0 }
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
          const tries = Number(p.tries) || 0
          // 这一拍没跑成（另有一拍在跑 / 免打扰 / 插件关着 / 投递真的失败了）：不算放弃，过一会儿再来。
          // 11-14 体检 B1：tick 以前被投递失败也回 ok:true，所以只有 skipped 会重排；
          // 现在 tick 会说 ok:false，这里也要当「没跑成」看待，否则追聊当场作废。
          const failed = r && r.ok === false
          if ((skipped && RETRY_MS[skipped] !== undefined || failed) && tries < MAX_TRIES) {
            const wait = failed ? 60_000 : RETRY_MS[skipped]
            arm(chatId, { dueAt: now() + wait, askedAt: p.askedAt, sec: p.sec, tries: tries + 1 })
            log('info', '定时话头这一拍没跑成（' + (skipped || 'deliver-failed') + '），' + Math.round(wait / 60_000) + ' 分钟后再试（第 ' + (tries + 1) + ' 次）：' + chatId)
            logLine(home, { at: now(), chatId, askedAt: p.askedAt, sec: p.sec, skipped: skipped || 'deliver-failed', retry: tries + 1 })
            return
          }
          if (skipped || failed) log('info', '定时话头没发出去（' + (skipped || 'deliver-failed') + '）：' + chatId)
          logLine(home, { at: now(), chatId, askedAt: p.askedAt, sec: p.sec, skipped, ok: !!(r && r.ok) })
        })
        .catch((e) => {
          log('warn', '定时话头出错（' + chatId + '）：' + (e?.message ?? e))
          logLine(home, { at: now(), chatId, askedAt: p.askedAt, sec: p.sec, error: String(e?.message ?? e) })
        })
    }, delay)
    timer.unref?.()
    timers.set(chatId, { timer, dueAt: p.dueAt, askedAt: p.askedAt, sec: p.sec, tries: Number(p.tries) || 0 })
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
    arm(chatId, { dueAt: t + delay * 1000, askedAt: t, sec: delay, tries: 0 })
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
    // 开关关着就别把上次留下的排程捡回来（否则「关了还要发」）
    try {
      if (settings().enabled === false) return
    } catch { /* 读不到配置就照旧恢复，别把该发的弄丢 */ }
    const saved = readJson(home, PENDING, {}) || {}
    const t = now()
    for (const [chatId, p] of Object.entries(saved)) {
      const dueAt = Number(p.dueAt) || 0
      if (!chatId || !dueAt) continue
      // 已经在内存里排着的那条不要重排（否则会有两个定时器抢同一个 chatId，
      // 旧的到点还会把新的 map 条目删掉）。restore 因此是幂等的，可以随时再调。
      if (timers.has(chatId)) continue
      arm(chatId, { dueAt: Math.max(dueAt, t + 5000), askedAt: Number(p.askedAt) || t, sec: Number(p.sec) || 0, tries: Number(p.tries) || 0 })
    }
  }


  return {
    request,
    cancel,
    stop,
    restore,
    get pending() {
      return [...timers.entries()].map(([chatId, p]) => ({ chatId, dueAt: p.dueAt, sec: p.sec }))
    },
  }
}
