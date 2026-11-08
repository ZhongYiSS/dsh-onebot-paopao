/**
 * 追聊 —— 会话自己要求「过一会儿再补一句」。
 * ============================================================================
 * 哥哥 11-08 定的：**追不追由会话说，插件只管照做**。
 *   会话在正文最后写 `[MORE]`（或 `[MORE 30]` 指定秒数）→ 插件排一个定时器，
 *   到点把话头递回去让她自己再说一轮。
 *
 * 红线（这条最容易做歪）：
 *   - 插件不判断「该不该追」，只执行她写的标记；没写就不追。
 *   - 到点前他说话了 → 这条作废（他自己接上了，再补就是自说自话）。
 *   - 免打扰、限流、绑定开关留给 tick 判（所以到点调的是 tick，不是直接发）。
 *   - 每小时有上限，免得变成每句都追；撞上限就丢掉并记账。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

const HITS = 'followup.json'
const LOG = 'followup.jsonl'
const HOUR = 3600_000

function readHits(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, HITS), 'utf8'))
    return Array.isArray(j?.hits) ? j.hits : []
  } catch {
    return []
  }
}

function writeHits(home, hits) {
  try {
    const dir = path.dirname(path.join(home, HITS))
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, '.followup.json.tmp')
    fs.writeFileSync(tmp, JSON.stringify({ hits }), 'utf8')
    fs.renameSync(tmp, path.join(home, HITS))
  } catch {
    /* 记账失败不影响追聊 */
  }
}

function logLine(home, rec) {
  try {
    fs.appendFileSync(path.join(home, LOG), JSON.stringify(rec) + '\n')
  } catch {
    /* 同上 */
  }
}

/**
 * @param home - 泡泡数据目录（`$DSH_HOME/bubble`）。
 * @param getConfig - () => { followupEnabled, followupDelayMinSec, followupDelayMaxSec, followupMaxPerHour }
 * @param fire - (chatId) => Promise<{ skipped?, ok?, ... }>，到点后真正跑一轮（一般是 ticker.tick(chatId, { followup: true })）
 * @param userSpokeAt - (chatId) => number，他最后一次说话的毫秒时间（0 = 不知道）
 */
export function createFollowup({
  home,
  getConfig = () => ({}),
  fire = async () => ({ skipped: 'nofire' }),
  userSpokeAt = () => 0,
  log = () => {},
  now = () => Date.now(),
  rnd = Math.random,
}) {
  const timers = new Map() // chatId -> { timer, dueAt, askedAt, delay }

  function settings() {
    const c = getConfig() || {}
    const min = Math.max(3, Math.min(600, Number(c.followupDelayMinSec) || 12))
    const max = Math.max(min, Math.min(900, Number(c.followupDelayMaxSec) || 20))
    const perHour = Math.max(0, Math.min(60, Number(c.followupMaxPerHour) || 3))
    return { enabled: c.followupEnabled !== false, min, max, perHour }
  }

  function cancel(chatId) {
    const p = timers.get(chatId)
    if (!p) return false
    clearTimeout(p.timer)
    timers.delete(chatId)
    return true
  }

  function stop() {
    for (const p of timers.values()) clearTimeout(p.timer)
    timers.clear()
  }

  /** 排队一次追聊。secs 是她自己写的秒数（没写就 0 = 用配置里的随机区间）。 */
  function request(chatId, secs = 0) {
    const s = settings()
    if (!s.enabled) return { ok: false, reason: 'off' }
    const t = now()
    const hits = readHits(home).filter((h) => t - Number(h.at || 0) < HOUR)
    const mine = hits.filter((h) => String(h.chatId) === String(chatId))
    if (mine.length >= s.perHour) {
      log('info', '追聊撞上限（' + s.perHour + '/小时）：' + chatId)
      logLine(home, { at: t, chatId, result: 'cap', perHour: s.perHour })
      return { ok: false, reason: 'cap' }
    }
    const asked = Math.max(0, Math.min(600, Number(secs) || 0))
    const delaySec = asked > 0 ? Math.max(5, asked) : Math.round(s.min + rnd() * Math.max(1, s.max - s.min))
    const dueAt = t + delaySec * 1000

    cancel(chatId)
    writeHits(home, [...hits, { chatId, at: t }])

    const timer = setTimeout(() => {
      timers.delete(chatId)
      fire(chatId, { dueAt, askedAt: t }).then((r) => {
        const skipped = (r && r.skipped) || ''
        if (skipped) log('info', '追聊没发出去（' + skipped + '）：' + chatId)
        logLine(home, { at: now(), chatId, askedAt: t, delaySec, skipped, ok: !!(r && r.ok) })
      }).catch((e) => {
        log('warn', '追聊出错（' + chatId + '）：' + (e?.message ?? e))
        logLine(home, { at: now(), chatId, askedAt: t, delaySec, error: String(e?.message ?? e) })
      })
    }, delaySec * 1000)
    timer.unref?.()
    timers.set(chatId, { timer, dueAt, askedAt: t, delaySec })
    return { ok: true, dueAt, delaySec }
  }

  /** tick 到点前问一句：他在这之后说话了没？ */
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
    userSpokeSince,
    get pending() {
      return [...timers.entries()].map(([chatId, p]) => ({ chatId, dueAt: p.dueAt, delaySec: p.delaySec }))
    },
  }
}
