/**
 * lib/bili-watch.mjs —— B站 那边有动静
 * ============================================================================
 * 盯三样：私信、回复我的、@我的。
 * 全是 GET + Cookie，不花 token；只有真来新的才去敲会话的门。
 *
 * 跟「刷视频」不一样：这里不看权重、不算概率，有新东西才说话。
 * 递过去只是一句话头，理不理、怎么理是会话自己的事。
 *
 * 去重：<home>/bili-seen.json 记 msg_key / 消息 id，同一条只提一次。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson, ensureDir, readState, appendHistory, agoText } from './state.mjs'
import { credPath as pickBiliCredPath } from './bili-paths.mjs'
import { credPath as biliCredPath } from './bili-paths.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
const MAX_ITEMS = 5
const KEEP_MS = 30 * 24 * 3600 * 1000

/** 读 B站 凭证（泡泡自己家 bubble/bili，没有才回落到 bili-duty，取新的那份） */
export function readBiliCred(dshHome) {
  const f = pickBiliCredPath(dshHome)
  if (!existsSync(f)) return null
  try {
    const c = JSON.parse(readFileSync(f, 'utf8'))
    if (!c?.sessdata) return null
    return {
      sessdata: String(c.sessdata),
      bili_jct: String(c.bili_jct || ''),
      buvid3: String(c.buvid3 || ''),
      mid: Number(c.dedeuserid) || 0,
    }
  } catch { return null }
}

function headers(cred) {
  return {
    'user-agent': UA,
    referer: 'https://message.bilibili.com/',
    origin: 'https://message.bilibili.com',
    accept: 'application/json',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}; DedeUserID=${cred.mid || ''}`,
  }
}

async function jget(url, cred, ms = 12000) {
  const r = await fetch(url, { headers: headers(cred), signal: AbortSignal.timeout(ms) })
  const j = await r.json().catch(() => null)
  if (!j) throw new Error('返回不是 JSON（HTTP ' + r.status + '）')
  if (j.code !== 0) throw new Error(`code=${j.code} ${j.message || ''}`.trim())
  return j.data
}

const cut = (s, n = 110) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// B站 官方通知号（登录提醒、系统通知）——不是真人，不往会话里递
const SYSTEM_TALKERS = new Set(['844424930131964'])

/** 私信正文有时是 JSON（系统通知），抠出能读的那句 */
function dmText(raw) {
  const s = String(raw || '')
  if (!s.trim().startsWith('{')) return cut(s, 120)
  try {
    const j = JSON.parse(s)
    return cut(j.text || j.title || j.desc || s, 120)
  } catch { return cut(s, 120) }
}

/** 私信：有未读、且最后一条不是我发的。
 *  只有「自己人」（主人的 B站 号）的私信才往会话里递；
 *  陌生人的记进账本、不打扰（除非设置里放开）。 */
async function collectDm(cred, seen, out, opts = {}) {
  const owners = opts.owners instanceof Set ? opts.owners : new Set()
  const allowStrangers = opts.allowStrangers === true
  const d = await jget('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&Build=0&mobi_app=web', cred)
  const list = Array.isArray(d?.session_list) ? d.session_list : []
  for (const s of list) {
    if (!(Number(s.unread_count) > 0)) continue
    if (SYSTEM_TALKERS.has(String(s.talker_id))) continue
    const lm = s.last_msg || {}
    if (Number(lm.sender_uid) === cred.mid) continue
    const isOwner = owners.has(Number(s.talker_id))
    if (!isOwner && !allowStrangers) {
      // 陌生人不打扰，但要记账，免得每一跳都去拉一遍
      const k = String(lm.msg_key || `${s.talker_id}:${lm.timestamp || 0}`)
      if (!seen.dm[k]) {
        seen.dm[k] = Date.now()
        out.ignored = (out.ignored || 0) + 1
      }
      continue
    }
    await sleep(350)
    const m = await jget('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=' + encodeURIComponent(s.talker_id) + '&session_type=1&size=5&build=0&mobi_app=web', cred)
    const arr = Array.isArray(m?.messages) ? m.messages : []
    const last = [...arr].reverse().find((x) => Number(x.sender_uid) !== cred.mid)
    if (!last) continue
    const key = String(last.msg_key || `${s.talker_id}:${last.timestamp}`)
    if (seen.dm[key]) continue
    out.push({
      kind: 'dm',
      key,
      who: isOwner ? '自己人' : '有人',
      byOwner: isOwner,
      text: dmText(last.content),
      quote: '',
      at: Number(last.timestamp) * 1000,
      url: 'https://message.bilibili.com/',
    })
  }
}

/** @我的 / 回复我的：同一个接口形状 */
async function collectFeed(cred, seen, out, kind, slug, opts = {}) {
  const owners = opts.owners instanceof Set ? opts.owners : new Set()
  const d = await jget(`https://api.bilibili.com/x/msgfeed/${slug}?platform=web&build=0&mobi_app=web&pn=1&ps=10`, cred)
  const items = Array.isArray(d?.items) ? d.items : []
  for (const it of items) {
    const id = String(it.id || '')
    if (!id || seen[kind][id]) continue
    const item = it.item || {}
    const isReply = kind === 'reply'
    out.push({
      kind,
      key: id,
      who: cut(it.user?.nickname || '有人', 20),
      byOwner: owners.has(Number(it.user?.mid)),
      // 回复：对方写的话在 source_content；我自己那条在 title
      text: cut(isReply ? item.source_content || item.desc : item.source_content || item.desc || item.title, 120),
      quote: cut(isReply ? item.title : '', 60),
      at: Number(it.reply_time || it.time || 0) * 1000,
      url: String(item.uri || ''),
    })
  }
}

/** 把几条动静拼成一句话头 */
export function composeWatchHint(items, now = Date.now()) {
  const L = ['[泡泡] B站 那边有动静（这条不是哥哥在 QQ 里说话）']
  for (const x of items) {
    const ago = x.at ? ' · ' + agoText(now - x.at) : ''
    const mine = x.byOwner ? '（你自己 / 自己人）' : ''
    if (x.kind === 'dm') {
      L.push(`· 私信：${mine}「${x.text}」${ago}`)
    } else if (x.kind === 'reply') {
      L.push(`· ${x.who}${mine} 回了你的评论：「${x.text}」${x.quote ? `（你原来写的是「${x.quote}」）` : ''}${ago}`)
    } else {
      L.push(`· ${x.who}${mine} @了你：「${x.text}」${ago}`)
    }
    if (x.url) L.push(`  ${x.url}`)
  }
  L.push('', '要不要理、怎么理你自己看着办；不想被他看见就回 [HOLD]。')
  return L.join('\n')
}

const KIND_LABEL = { dm: '私信', reply: '回复', at: '@我' }

/** 哪几类来料算「打扰她」：设置页三个开关，默认都算。 */
export function allowedKinds(cfg = {}) {
  const ok = new Set()
  if (cfg.biliDm !== false) ok.add('dm')
  if (cfg.biliAt !== false) ok.add('at')
  if (cfg.biliReply !== false) ok.add('reply')
  return ok
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {() => string} deps.getHome      泡泡家（存去重账本）
 * @param {() => string} deps.dshHome      DSH 家（找 B站 凭证）
 * @param {(args) => Promise<object>} deps.deliver
 * @param {(msg: string) => void} [deps.log]
 */
export function createBiliWatch({ getConfig, getHome, dshHome, deliver, cue = null, log = () => {} }) {
  let timer = null
  let busy = false
  let lastAt = 0
  let lastResult = null
  let minutes = 0

  const seenFile = () => join(getHome(), 'bili-seen.json')

  function loadSeen() {
    const s = readJson(seenFile(), null) || {}
    return { dm: s.dm || {}, at: s.at || {}, reply: s.reply || {} }
  }

  function pruneSeen(seen, now) {
    for (const k of ['dm', 'at', 'reply']) {
      const m = seen[k] || {}
      const kept = Object.entries(m)
        .filter(([, ts]) => now - Number(ts || 0) < KEEP_MS)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 800)
      seen[k] = Object.fromEntries(kept)
    }
    return seen
  }

  async function poll({ manual = false } = {}) {
    const cfg = getConfig()
    if (!manual && cfg.biliWatch === false) return { ok: true, skipped: 'off' }
    if (busy) return { ok: true, skipped: 'busy' }
    busy = true
    const errors = []
    try {
      const cred = readBiliCred(dshHome())
      if (!cred) {
        lastResult = { ok: false, error: '没找到 B站 凭证（' + biliCredPath(dshHome()) + '）' }
        return lastResult
      }
      const seen = loadSeen()
      const firstRun = !existsSync(seenFile())
      let items = []
      // 谁算「自己人」：设置页里填的 B站 主人号（含本鱼自己在用的那个）
      const owners = new Set(
        (Array.isArray(cfg.biliOwnerUids) ? cfg.biliOwnerUids : [])
          .map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0),
      )
      if (cred.mid) owners.add(cred.mid)
      const opts = { owners, allowStrangers: cfg.biliDmStrangers === true }
      const jobs = [
        ['dm', () => collectDm(cred, seen, items, opts)],
        ['at', () => collectFeed(cred, seen, items, 'at', 'at', opts)],
        ['reply', () => collectFeed(cred, seen, items, 'reply', 'reply', opts)],
      ]
      for (const [kind, fn] of jobs) {
        try { await fn() } catch (e) { errors.push(kind + '：' + (e?.message ?? e)) }
        await sleep(350)
      }

      if (!items.length) {
        lastAt = Date.now()
        lastResult = { ok: true, n: 0, ignored: items.ignored || 0, errors }
        return lastResult
      }

      // 第一次接上：先把旧账全记下，一条都不提（不然一上来就把几天的旧消息糊他脸上）
      if (firstRun) {
        const now0 = Date.now()
        for (const x of items) seen[x.kind][x.key] = now0
        pruneSeen(seen, now0)
        ensureDir(getHome())
        writeJson(seenFile(), seen)
        lastAt = now0
        lastResult = { ok: true, seeded: items.length, errors }
        log(`B站 监看：第一次接上，先把 ${items.length} 条旧账记下（不提）`)
        return lastResult
      }

      // 哪几类算打扰（哥哥 11-08 要的分开关）
      const ok = allowedKinds(cfg)
      const pool = items.filter((x) => ok.has(x.kind))
      if (pool.length !== items.length) {
        errors.push(`按类型跳过 ${items.length - pool.length} 条`)
        items = pool
      }

      // 按时间正序，太多就只留最新的几条（老的不刷屏）
      items.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
      const take = items.slice(-MAX_ITEMS)
      const text = composeWatchHint(take)
      // 走收件箱：有人在 B站 叫她 —— 但开不开口由泡泡的门控（免打扰/限流/权重）定，
      // 不再直接 deliver 把她半夜叫起来。
      const r = cue
        ? await cue({ chatId: cfg.chatId, items: take, text })
        : await deliver({ chatId: cfg.chatId, text, cfg })
      // 真发出去了才记「看过了」；被门控拦下的（免打扰/限流）留着，下一拍再说
      const delivered = !!(r && (r.deliver?.ok === true || r.ok === true))

      const now = Date.now()
      if (delivered) {
        for (const x of items) {
          seen[x.kind][x.key] = now
        }
        pruneSeen(seen, now)
        ensureDir(getHome())
        writeJson(seenFile(), seen)
      }


      lastAt = now
      const mode = r?.deliver?.mode || r?.mode || (r?.skipped ? 'queued:' + r.skipped : 'none')
      lastResult = { ok: delivered, queued: !delivered, n: take.length, ignored: items.ignored || 0, mode, error: r?.deliver?.error || r?.error, errors }
      log(`B站 动静：${take.length} 条 → ${mode}`)
      return lastResult
    } catch (e) {
      lastAt = Date.now()
      lastResult = { ok: false, error: String(e?.message ?? e), errors }
      log('B站 监看出错：' + (e?.message ?? e))
      return lastResult
    } finally {
      busy = false
    }
  }

  function start(min) {
    const m = Math.max(1, Number(min) || 5)
    minutes = m
    if (timer) { clearInterval(timer); timer = null }
    timer = setInterval(() => { poll().catch((e) => log('B站 定时器异常：' + (e?.message ?? e))) }, m * 60_000)
    if (timer.unref) timer.unref()
    log(`B站 监看：每 ${m} 分钟看一眼（私信 / 回复 / @）`)
    return m
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return {
    poll,
    start,
    stop,
    status: () => ({ running: !!timer, minutes, lastAt, lastResult, busy }),
  }
}