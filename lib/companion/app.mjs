/**
 * dsh-bubble —— 陪伴插件（泡泡）
 * ============================================================================
 * 只做三件事：掐表（权重 + 抽卡）、递话头、记状态。
 * 说什么是会话自己的事；插件不代写一个字。
 *
 * 结构：配置（profiles）× 会话（bindings）。
 *   - 一套「配置」= 阈值/上升/频率/免打扰/事件池……可以有几套，能改名。
 *   - 一个会话（私聊或群）绑一套配置，各算各的权重，互不抢额度。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createTicker } from './tick.mjs'
import { createFollowup } from './followup.mjs'
import { parseHM, formatHM } from './period.mjs'
import { createDeliverer } from './deliver.mjs'
import { resolveOnebot } from './bridge-link.mjs'
import { createBiliWatch } from './bili-watch.mjs'
import { pushInbox } from './inbox.mjs'
import { prepareBili } from './adapters/bili.mjs'
import { EVENT_POOL, mergePool, normalizePercent } from './events.mjs'
import { readBuckets, writeBuckets, bucketOf, normalizeBucket, readHistory, defaultState, noteScore, readScore } from './state.mjs'
import { readBili, writeBili, readQq, writeQq } from './ext-settings.mjs'
import { startLogin, pollLogin, currentUser } from './bili-login.mjs'
import { biliVideoInfo, bvidOfLink } from '../link-expand.js'
import { buildNewsCard } from '../card.js'


// 跟包的版本走：三合一之后没有「单独一个陪伴插件」了，别再报 0.3.0 让人以为
// 装的还是老的 dsh-bubble。
const VERSION = '0.9.6-companion.1'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function homeDir() {
  const dir = join(dshHome(), 'bubble')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const num = (v, d, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return d
  return Math.min(max, Math.max(min, n))
}

// ---------------------------------------------------------------- 两套默认配置
const PRESET_DAILY = {
  mode: 'daily', threshold: 30, risePerTick: 0.5, tickMinutes: 5, triggerPmax: 0.12,
  releaseBase: 20, limitHours: 3, limitMax: 2, idleMinutes: 20,
  quiet: { enabled: true, from: '00:00', to: '07:00' },
}
const PRESET_ACTIVE = {
  mode: 'active', threshold: 15, risePerTick: 1, tickMinutes: 3, triggerPmax: 0.25,
  releaseBase: 20, limitHours: 1, limitMax: 3, idleMinutes: 15,
  quiet: { enabled: true, from: '02:00', to: '07:00' },
}

function defaultPool() {
  return EVENT_POOL.map((e) => ({ id: e.id, label: e.label, weight: e.weight, bonus: e.bonus, enabled: true }))
}

function makeProfile(id, name, preset = PRESET_DAILY) {
  return {
    id: String(id),
    name: String(name),
    ...JSON.parse(JSON.stringify(preset)),
    pool: defaultPool(),
  }
}

export function defaultConfig() {
  return {
    enabled: true,
    dryRun: true,           // V1 默认干跑：只记账，不真发
    profiles: [
      makeProfile('daily', '日常', PRESET_DAILY),
      makeProfile('active', '主动', PRESET_ACTIVE),
    ],
    bindings: [],           // [{ chatId, profileId, enabled }]
    // 下面这些是全家共用的，不按配置分
    keywords: [],           // 刷视频：关键词为空就用 B站 热门兜底
    videoPerRound: 3,
    videoFreshDays: 14,
    videoMinPlay: 1000,
    videoMinSec: 60,
    videoMaxSec: 1800,
    videoExclude: [],
    biliWatch: true,
    biliWatchMinutes: 5,
    biliOwnerUids: [233078950],
    biliDmStrangers: false,
    // 追聊（哥哥 11-08 做、11-08 傍晚暂停）：会话自己写 [MORE] 才追，插件不判断。
    // 现在默认关 —— 哥哥说暂时去掉，等想到办法再加回来（打开开关即可复活）。
    followupEnabled: false,
    followupDelayMinSec: 12,
    followupDelayMaxSec: 20,
    followupMaxPerHour: 3,
  }
}

/**
 * 「每拍涨多少」：新配置直接读 risePerTick；老配置只有 risePerHour，
 * 按老节奏换算一次（每小时 × tickMinutes/60 = 每拍），之后只存新字段。
 */
function risePerTickOf(r, d) {
  if (r.risePerTick != null) return r.risePerTick
  if (r.risePerHour != null) {
    const tm = num(r.tickMinutes, d.tickMinutes, 1, 240)
    return Number(r.risePerHour) * tm / 60
  }
  return d.risePerTick
}

/** 把一套配置洗干净（缺的补默认、数值夹在范围内） */
export function normalizeProfile(raw, fallback = PRESET_DAILY, id = 'p', name = '配置') {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = fallback
  return {
    id: String(r.id || id),
    name: String(r.name || name).slice(0, 20),
    mode: r.mode === 'active' ? 'active' : r.mode === 'custom' ? 'custom' : 'daily',
    threshold: num(r.threshold, d.threshold, -20, 99),
    risePerTick: num(risePerTickOf(r, d), d.risePerTick, 0, 50),
    tickMinutes: num(r.tickMinutes, d.tickMinutes, 1, 240),
    triggerPmax: num(r.triggerPmax, d.triggerPmax, 0.01, 1),
    releaseBase: num(r.releaseBase, d.releaseBase, 0, 100),
    limitHours: num(r.limitHours, d.limitHours, 0.1, 72),
    limitMax: num(r.limitMax, d.limitMax, 1, 100),
    idleMinutes: num(r.idleMinutes, d.idleMinutes, 0, 1440),
    quiet: {
      enabled: (r.quiet && typeof r.quiet === 'object' ? r.quiet.enabled : d.quiet.enabled) !== false,
      from: formatHM(parseHM((r.quiet && r.quiet.from) || d.quiet.from)),
      to: formatHM(parseHM((r.quiet && r.quiet.to) || d.quiet.to)),
    },
    pool: mergePool(r.pool),
  }
}

/** 老配置（扁平的一份）搬成一套配置 */
function migrateLegacy(raw, d) {
  const legacy = normalizeProfile({
    id: 'daily',
    name: raw.mode === 'active' ? '主动' : '日常',
    mode: raw.mode,
    threshold: raw.threshold,
    risePerTick: raw.risePerTick,
    risePerHour: raw.risePerHour,
    tickMinutes: raw.tickMinutes,
    triggerPmax: raw.triggerPmax,
    releaseBase: raw.releaseBase,
    limitHours: raw.limitHours,
    limitMax: raw.limitMax,
    idleMinutes: raw.idleMinutes,
    quiet: raw.quiet,
    pool: raw.pool,
  }, raw.mode === 'active' ? PRESET_ACTIVE : PRESET_DAILY, 'daily', raw.mode === 'active' ? '主动' : '日常')
  return [legacy]
}

export function readConfig(home) {
  let raw = {}
  try {
    const f = join(home, 'config.json')
    if (existsSync(f)) raw = JSON.parse(readFileSync(f, 'utf8'))
  } catch { raw = {} }
  const d = defaultConfig()
  const cfg = { ...d }

  cfg.enabled = raw.enabled !== false
  cfg.dryRun = raw.dryRun !== false
  cfg.keywords = (Array.isArray(raw.keywords) ? raw.keywords : d.keywords)
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20)
  cfg.videoPerRound = num(raw.videoPerRound, d.videoPerRound, 1, 5)
  cfg.videoFreshDays = num(raw.videoFreshDays, d.videoFreshDays, 1, 365)
  cfg.videoMinPlay = num(raw.videoMinPlay, d.videoMinPlay, 0, 1e9)
  cfg.videoMinSec = num(raw.videoMinSec, d.videoMinSec, 0, 7200)
  cfg.videoMaxSec = num(raw.videoMaxSec, d.videoMaxSec, 10, 7200)
  cfg.videoExclude = (Array.isArray(raw.videoExclude) ? raw.videoExclude : d.videoExclude)
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50)
  cfg.biliWatch = raw.biliWatch !== false
  // 来料分类开关（哥哥 11-08）：哪几类算「有人叫她」；biliWeight=false 时这轮不动权重
  cfg.biliDm = raw.biliDm !== false
  cfg.biliAt = raw.biliAt !== false
  cfg.biliReply = raw.biliReply !== false
  cfg.biliWeight = raw.biliWeight !== false
  cfg.biliWatchMinutes = num(raw.biliWatchMinutes, d.biliWatchMinutes, 1, 240)
  cfg.biliDmStrangers = raw.biliDmStrangers === true
  cfg.biliOwnerUids = (Array.isArray(raw.biliOwnerUids) ? raw.biliOwnerUids : d.biliOwnerUids)
    .map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n > 0).slice(0, 10)
  // 追聊（已暂停）：只有显式写 true 才开，默认关
  cfg.followupEnabled = raw.followupEnabled === true
  cfg.followupDelayMinSec = num(raw.followupDelayMinSec, d.followupDelayMinSec, 3, 600)
  cfg.followupDelayMaxSec = num(raw.followupDelayMaxSec, d.followupDelayMaxSec, cfg.followupDelayMinSec, 900)
  cfg.followupMaxPerHour = num(raw.followupMaxPerHour, d.followupMaxPerHour, 0, 60)

  // 配置表：新格式直接用；老格式（没有 profiles）搬一份出来
  if (Array.isArray(raw.profiles) && raw.profiles.length) {
    cfg.profiles = raw.profiles.slice(0, 12).map((p, i) => normalizeProfile(p, PRESET_DAILY, 'p' + (i + 1), '配置' + (i + 1)))
  } else if (raw.threshold !== undefined || raw.chatId) {
    cfg.profiles = migrateLegacy(raw, d)
  }
  // id 去重
  const seen = new Set()
  for (const p of cfg.profiles) {
    let id = p.id || 'p'
    let n = 1
    while (seen.has(id)) id = p.id + '-' + (n++)
    seen.add(id)
    p.id = id
  }

  // 会话绑定
  const ids = new Set(cfg.profiles.map((p) => p.id))
  if (Array.isArray(raw.bindings)) {
    cfg.bindings = raw.bindings
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        chatId: String(b.chatId || '').trim(),
        profileId: String(b.profileId || cfg.profiles[0].id),
        enabled: b.enabled !== false,
      }))
      .filter((b) => b.chatId)
      .slice(0, 30)
    for (const b of cfg.bindings) if (!ids.has(b.profileId)) b.profileId = cfg.profiles[0].id
  } else if (raw.chatId) {
    // 老格式：一个 chatId，归到搬出来的那套配置
    cfg.bindings = [{ chatId: String(raw.chatId), profileId: cfg.profiles[0].id, enabled: true }]
  } else {
    cfg.bindings = []
  }
  return cfg
}

export function writeConfig(home, cfg) {
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
}

/** 老界面/老接口用的扁平视图：全家共用的 + 第一套配置（或指定会话那套） */
export function flatView(cfg, chatId) {
  const b = chatId
    ? cfg.bindings.find((x) => x.chatId === chatId)
    : cfg.bindings[0]
  const p = (b && cfg.profiles.find((x) => x.id === b.profileId)) || cfg.profiles[0] || makeProfile('daily', '日常')
  return {
    ...cfg,
    ...p,
    chatId: (b && b.chatId) || '',
    profileId: p.id,
    profileName: p.name,
  }
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj)
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch { /* 忽略 */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => { s += c; if (s.length > 1_000_000) req.destroy() })
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

/** 只收本机同源（跟刷B站那页一个口径） */
function sameOriginOk(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const host = req.headers.host || ''
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const GLOBAL_KEYS = ['enabled', 'dryRun', 'keywords', 'videoPerRound', 'videoFreshDays',
  'videoMinPlay', 'videoMinSec', 'videoMaxSec', 'videoExclude', 'biliWatch',
  'biliWatchMinutes', 'biliOwnerUids', 'biliDmStrangers', 'biliDm', 'biliAt', 'biliReply', 'biliWeight',
  'followupEnabled', 'followupDelayMinSec', 'followupDelayMaxSec', 'followupMaxPerHour']

export function mountCompanion(ctx, api) {
/** 每次现取：QQ 通道那个对象可能被插件重建，缓存住会拿到过期的。 */
function onebotApi() {
  try {
    const a = typeof api === 'function' ? api() : api
    if (a) return a
  } catch { /* 回落到探测 */ }
  return resolveOnebot(ctx)
}

  const home = homeDir()
  const log = (...a) => { try { console.log('[bubble]', ...a) } catch { /* 忽略 */ } }

  // 兴趣分：QQ 那边从会话正文里读到 [SCORE n] 就叫我们一声，落到 scores.json。
  // tick 下一拍取走，按分数校正权重（50 分 = 不动）。
  const armScoreHook = () => {
    try {
      const api = onebotApi()
      if (api && typeof api.setScoreHook === 'function') {
        api.setScoreHook((chatId, score) => {
          try { noteScore(home, chatId, score) } catch { /* 落盘失败不吵 */ }
        })
        return true
      }
    } catch { /* QQ 还没接上，等下一拍再挂 */ }
    return false
  }
  armScoreHook()

  const plan = () => {
    const cfg = readConfig(home)
    const bindings = cfg.bindings.map((b) => ({
      chatId: b.chatId,
      enabled: b.enabled !== false,
      profile: cfg.profiles.find((p) => p.id === b.profileId) || cfg.profiles[0],
    }))
    return { enabled: cfg.enabled, dryRun: cfg.dryRun, bindings }
  }

  const ticker = createTicker({
    getPlan: plan,
    getHome: () => home,
    // 抽中什么就去把它摆到桌上（现在只接了刷视频；别的先空着）
    // 注意：这里传的是 DSH 家目录（找 B站 凭证用），不是泡泡自己的家目录
    prepare: (ev, info) => prepareBili(ev, info, { home: dshHome(), log }),
    deliver: createDeliverer({ ctx, log }),
    // 会话自己打的兴趣分（她回复最后写的 [SCORE n]），下一拍按它校正权重
    scoreOf: (chatId) => readScore(home, chatId),
    // 话头里给她一个看得懂的称呼（群 摸鱼群 / 私聊 哥哥），别只丢一串 private:…
    labelOf: (chatId) => {
      try {
        const api = onebotApi()
        if (!api || typeof api.listChats !== 'function') return ''
        const list = api.listChats() || []
        const hit = list.find((c) => c && String(c.chatId) === String(chatId))
        if (!hit) return ''
        const kind = hit.kind === 'group' ? '群' : '私聊'
        const name = hit.label && String(hit.label) !== String(chatId) ? String(hit.label) : ''
        return name ? kind + ' ' + name : kind
      } catch { return '' }
    },
    // 他刚说过话就别插嘴；拿不到最后动静就当没在聊
    idleCheck: async ({ chatId, minutes, now }) => {
      const onebot = onebotApi()
      if (!onebot || typeof onebot.lastActivityAt !== 'function') return true
      const last = Number(onebot.lastActivityAt(chatId)) || 0
      if (!last) return true
      return now - last >= minutes * 60_000
    },
    log,
  })

  // 追聊：会话自己写 [MORE] 才追（哥哥 11-08）。
  // 到点先看他有没有接上话 —— 接上了就作废；没接上才叫 tick 跑一轮（免打扰 / 限流 / 绑定照判）。
  const followup = createFollowup({
    home,
    getConfig: () => readConfig(home),
    userSpokeAt: (chatId) => {
      try {
        const a = onebotApi()
        return a && typeof a.lastInboundAt === 'function' ? Number(a.lastInboundAt(chatId)) || 0 : 0
      } catch { return 0 }
    },
    fire: async (chatId, { askedAt }) => {
      if (followup.userSpokeSince(chatId, askedAt)) return { skipped: 'user-spoke' }
      return ticker.tick(chatId, { followup: true })
    },
    log,
  })

  // QQ 那边从会话正文里读到 [MORE] 就叫我们一声，排一个定时器。
  const armMoreHook = () => {
    try {
      const api = onebotApi()
      if (api && typeof api.setMoreHook === 'function') {
        api.setMoreHook((chatId, secs) => {
          try {
            const r = followup.request(chatId, secs)
            if (!r.ok) log('追聊没排队（' + r.reason + '）：' + chatId)
          } catch (e) { log('追聊排队失败：' + (e?.message ?? e)) }
        })
        return true
      }
    } catch { /* QQ 还没接上，等下一拍再挂 */ }
    return false
  }
  armMoreHook()

  // 换参数就重排节拍。节拍取所有会话里最短的那一档，每个会话自己再按
  // 自己的 tickMinutes 判「还没到点」，所以快慢不会互相拖。
  const restart = () => {
    // QQ 服务可能被重建过，钩子每次跟着重挂一遍（挂了就幂等覆盖同一个函数）
    armScoreHook()
    armMoreHook()
    const cfg = readConfig(home)
    if (!cfg.enabled) {
      ticker.stop()
      watcher.stop()
      followup.stop()
      log('已停（开关关着）')
      return 0
    }
    const gaps = cfg.bindings
      .map((b) => cfg.profiles.find((p) => p.id === b.profileId)?.tickMinutes)
      .filter((x) => Number.isFinite(x))
    const fastest = gaps.length ? Math.min(...gaps) : 5
    const ms = ticker.start(fastest)
    // B站 那边有动静是独立的眼睛：不占权重、不算概率
    if (cfg.biliWatch !== false) watcher.start(cfg.biliWatchMinutes)
    else watcher.stop()
    log(`已开：每 ${Math.round(ms / 60000)} 分钟看一眼（${cfg.bindings.length} 个会话 / ${cfg.profiles.length} 套配置），干跑=${cfg.dryRun !== false}，B站 监看=${cfg.biliWatch !== false ? '每 ' + cfg.biliWatchMinutes + ' 分钟' : '关'}`)
    return ms
  }

  // B站 那边有动静（私信 / 回复 / @）——只递话头，理不理看会话
  const watcher = createBiliWatch({
    getConfig: () => readConfig(home),
    getHome: () => home,
    dshHome,
    deliver: createDeliverer({ ctx, log }),
    // 来料先排队，再叫节拍跑一拍（fresh 跳过「没到点」，其余门槛照走）
    cue: async ({ chatId, items }) => {
      pushInbox(home, chatId, items)
      return ticker.tick(chatId, { fresh: true })
    },
    log,
  })

  try { restart() } catch (e) { log('起节拍失败：' + (e?.message ?? e)) }
  ctx.effect(() => () => { try { ticker.stop() } catch { /* 收摊 */ } }, 'bubble: 停节拍')
  ctx.effect(() => () => { try { followup.stop() } catch { /* 收摊 */ } }, 'bubble: 停追聊')

  // 每 6 小时清一次看视频留下的视频文件（默认留 15 天，设置页可改）
  try {
    const sweep = () => {
      import('../video-look.js')
        .then(({ sweepWork }) => {
          const cfg = readConfig(home)
          const days = Math.max(1, Number(cfg.videoWorkDays ?? 15) || 15)
          const n = sweepWork(days)
          if (n > 0) log(`清掉 ${n} 个 ${days} 天前的视频工作目录`)
        })
        .catch(() => { /* 清不动算了，别打扰看视频 */ })
    }
    sweep()
    const timer = setInterval(sweep, 6 * 3600_000)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => { clearInterval(timer) }, 'bubble: 停视频清理')
  } catch (e) {
    log('起视频清理失败：' + (e?.message ?? e))
  }
  ctx.effect(() => () => { try { watcher.stop() } catch { /* 收摊 */ } }, 'bubble: 停 B站 监看')

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bubble',
      handler: async (req, res) => {
        if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
        const url = new URL(req.url, 'http://127.0.0.1')
        const p = url.pathname.replace(/^\/api\/bubble/, '') || '/'
        try {
          // 看状态
          if (req.method === 'GET' && (p === '/state' || p === '/')) {
            const cfg = readConfig(home)
            const wantChat = String(url.searchParams.get('chatId') || '')
            const view = flatView(cfg, wantChat || undefined)
            const buckets = readBuckets(home, view.chatId || '_default')
            const state = wantChat ? bucketOf(buckets, wantChat) : (buckets[view.chatId] || normalizeBucket(null))
            const history = readHistory(home, Number(url.searchParams.get('limit')) || 30)
            return sendJson(res, 200, {
              ok: true,
              version: VERSION,
              cfg: view,            // 老界面照旧读这一份
              profiles: cfg.profiles,
              bindings: cfg.bindings,
              state,
              states: buckets,
              percent: normalizePercent(view.pool),
              history,
              running: ticker.running,
              home,
            })
          }

          // 存配置：global / profile / bindings / profiles 四种补丁都收
          if (req.method === 'POST' && p === '/config') {
            const body = (await readBody(req)) || {}
            const cfg = readConfig(home)

            // ① 全家共用的
            for (const k of GLOBAL_KEYS) {
              if (k in body) cfg[k] = body[k]
            }
            // ② 某套配置
            if (body.profileId && body.patch && typeof body.patch === 'object') {
              const i = cfg.profiles.findIndex((x) => x.id === String(body.profileId))
              if (i >= 0) {
                const merged = { ...cfg.profiles[i], ...body.patch }
                if (body.patch.quiet && typeof body.patch.quiet === 'object') {
                  merged.quiet = { ...cfg.profiles[i].quiet, ...body.patch.quiet }
                }
                if (Array.isArray(body.patch.pool)) merged.pool = mergePool(body.patch.pool)
                cfg.profiles[i] = normalizeProfile(merged, PRESET_DAILY, cfg.profiles[i].id, cfg.profiles[i].name)
              }
            }
            // ③ 整组配置（新建 / 复制 / 删掉）
            if (Array.isArray(body.profiles)) {
              cfg.profiles = body.profiles.slice(0, 12)
                .map((x, i) => normalizeProfile(x, PRESET_DAILY, 'p' + (i + 1), '配置' + (i + 1)))
            }
            // ④ 会话绑定
            if (Array.isArray(body.bindings)) {
              cfg.bindings = body.bindings.slice(0, 30).map((b) => ({
                chatId: String(b?.chatId || '').trim(),
                profileId: String(b?.profileId || cfg.profiles[0].id),
                enabled: b?.enabled !== false,
              })).filter((b) => b.chatId)
            }
            // ⑤ 老界面的扁平补丁（阈值那些）落到第一套配置上
            const flatKeys = ['mode', 'threshold', 'risePerTick', 'risePerHour', 'tickMinutes', 'triggerPmax',
              'releaseBase', 'limitHours', 'limitMax', 'idleMinutes', 'quiet', 'pool']
            const flatPatch = {}
            for (const k of flatKeys) if (k in body) flatPatch[k] = body[k]
            if (Object.keys(flatPatch).length && cfg.profiles.length) {
              const first = cfg.profiles[0]
              const merged = { ...first, ...flatPatch }
              if (body.quiet && typeof body.quiet === 'object') merged.quiet = { ...first.quiet, ...body.quiet }
              if (Array.isArray(body.pool)) merged.pool = mergePool(body.pool)
              cfg.profiles[0] = normalizeProfile(merged, PRESET_DAILY, first.id, first.name)
            }
            // 老界面直接改 chatId → 当成「只绑这一个」
            if (typeof body.chatId === 'string' && !Array.isArray(body.bindings)) {
              cfg.bindings = body.chatId
                ? [{ chatId: body.chatId, profileId: cfg.profiles[0].id, enabled: true }]
                : []
            }

            // 洗完再写
            writeConfig(home, readConfigFromObject(cfg))
            restart()
            const now = readConfig(home)
            return sendJson(res, 200, { ok: true, cfg: flatView(now), profiles: now.profiles, bindings: now.bindings })
          }

          // 立刻跑一次（可指定只跑某个会话；手动跑不吃「还没到点」）
          if (req.method === 'POST' && p === '/run') {
            const body = (await readBody(req)) || {}
            const r = await ticker.tick(body.chatId ? String(body.chatId) : undefined, { force: true })
            return sendJson(res, 200, { ok: true, result: r })
          }

          // 归零（可以只清某一个会话）
          if (req.method === 'POST' && p === '/reset') {
            const body = (await readBody(req)) || {}
            const cfg = readConfig(home)
            const buckets = readBuckets(home, flatView(cfg).chatId || '_default')
            if (body.chatId) {
              delete buckets[String(body.chatId)]
            } else {
              for (const k of Object.keys(buckets)) delete buckets[k]
            }
            writeBuckets(home, buckets)
            return sendJson(res, 200, { ok: true, states: buckets })
          }

          // 发一张链接卡片（B站 视频自动补标题/封面）；设置页测试按钮和排查都用它
          if (req.method === 'POST' && p === '/card') {
            const body = (await readBody(req)) || {}
            const cfg0 = readConfig(home)
            const chatId = String(body.chatId || flatView(cfg0).chatId || '').trim()
            if (!chatId) return sendJson(res, 200, { ok: false, error: '没给 chatId' })
            const onebot = onebotApi()
            if (!onebot || typeof onebot.sendCard !== 'function') {
              return sendJson(res, 200, { ok: false, error: 'QQ 通道没接上，发不了' })
            }
            const rawUrl = String(body.url || '').trim()
            let bvid = String(body.bvid || '').trim()
            if (!bvid && rawUrl) bvid = await bvidOfLink(rawUrl, { log })
            const info = bvid ? await biliVideoInfo(bvid, { log }) : null
            const card = buildNewsCard({
              title: String(body.title || info?.title || 'B站 视频'),
              desc: String(body.desc || info?.desc || (info ? 'UP：' + info.owner : '')),
              url: rawUrl || (bvid ? 'https://www.bilibili.com/video/' + bvid : ''),
              pic: String(body.pic || info?.pic || ''),
              tag: '哔哩哔哩',
            })
            try {
              const messageId = await onebot.sendCard(chatId, card)
              return sendJson(res, 200, { ok: true, chatId, bvid, mode: 'card', messageId: messageId ?? null })
            } catch (e) {
              return sendJson(res, 200, { ok: false, chatId, bvid, error: String(e?.message ?? e), card })
            }
          }

          // 诊断：QQ 那边到底接没接上（三个位置各看一眼）
          if (req.method === 'GET' && p === '/channel') {
            const out = { ok: false, connected: null, selfId: '', hasService: false }
            try {
              const onebot = onebotApi()
              out.hasService = !!onebot
              if (onebot && typeof onebot.status === 'function') {
                const st = onebot.status() || {}
                out.connected = st.connected !== false
                out.selfId = String(st.selfId || '')
                out.ok = true
              }
            } catch (e) { out.error = String(e?.message ?? e) }
            return sendJson(res, 200, out)
          }

          if (req.method === 'GET' && p === '/probe') {
            const out = { version: VERSION, hasService: false, hasRootService: false, hasGlobal: false, ok: false }
            try { out.hasService = !!ctx.get('onebot') } catch { /* 没有 */ }
            try { out.hasRootService = !!ctx.root?.get?.('onebot') } catch { /* 没有 */ }
            try { out.hasGlobal = !!globalThis.__DSH_ONEBOT__ } catch { /* 没有 */ }
            out.ok = !!onebotApi()
            // 顺手看一眼「他最近什么时候动过嘴」——闸门靠这个判断
            try {
              const cfg = readConfig(home)
              const onebot = onebotApi()
              const b = cfg.bindings[0]
              const prof = (b && cfg.profiles.find((x) => x.id === b.profileId)) || cfg.profiles[0]
              if (b?.chatId && onebot && typeof onebot.lastActivityAt === 'function' && prof) {
                const last = Number(onebot.lastActivityAt(b.chatId)) || 0
                out.idle = {
                  chatId: b.chatId,
                  lastActivityAt: last,
                  agoMinutes: last ? Math.floor((Date.now() - last) / 60000) : null,
                  idleMinutes: prof.idleMinutes,
                  wouldSkip: last ? Date.now() - last < prof.idleMinutes * 60000 : false,
                }
              }
            } catch (e) { out.idleError = String(e?.message ?? e) }
            return sendJson(res, 200, out)
          }

          // 会话列表（QQ 插件接上了才有）
          if (req.method === 'GET' && p === '/chats') {
            const onebot = onebotApi()
            if (!onebot || typeof onebot.listChats !== 'function') {
              return sendJson(res, 200, { ok: true, chats: [], hint: 'QQ 插件还没暴露会话列表，先手填 private:<QQ> 或 group:<群号>' })
            }
            const chats = await onebot.listChats()
            return sendJson(res, 200, { ok: true, chats: Array.isArray(chats) ? chats : [] })
          }

          // 会话自选（本鱼补丁 2026-11-08）：每个聊天现在接哪个会话 + 钉了哪个
          if (req.method === 'GET' && p === '/sessions') {
            const onebot = onebotApi()
            if (!onebot || typeof onebot.sessionTable !== 'function') {
              return sendJson(res, 200, { ok: false, error: 'QQ 通道没接上，读不到会话', table: {} })
            }
            try {
              return sendJson(res, 200, { ok: true, table: await onebot.sessionTable() })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), table: {} })
            }
          }

          // 换会话 / 改回自动：填 id 就立刻切，空 id 就是改回自动
          if (req.method === 'POST' && p === '/session') {
            const body = (await readBody(req)) || {}
            const chatId = String(body.chatId || '').trim()
            if (!chatId) return sendJson(res, 200, { ok: false, error: '没给 chatId' })
            const onebot = onebotApi()
            if (!onebot || typeof onebot.pinSession !== 'function') {
              return sendJson(res, 200, { ok: false, error: 'QQ 通道没接上，换不了会话' })
            }
            const want = String(body.sessionId || '').trim()
            try {
              const r = want === '' ? await onebot.unpinSession(chatId) : await onebot.pinSession(chatId, want)
              log('换会话 ' + chatId + ' → ' + (want || '(自动)') + '：' + (r.ok ? '好' : (r.message || r.reason)))
              return sendJson(res, 200, { ok: r.ok !== false, result: r, table: await onebot.sessionTable() })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
            }
          }

          // 别家插件的设置：B站（改 config.json）+ QQ（改内存里的 config）
          if (req.method === 'GET' && p === '/ext') {
            return sendJson(res, 200, {
              ok: true,
              bili: readBili(dshHome()),
              qq: readQq(onebotApi()),
            })
          }

          if (req.method === 'POST' && p === '/ext') {
            const body = await readBody(req)
            const out = { ok: true }
            if (body?.bili && typeof body.bili === 'object') out.bili = writeBili(dshHome(), body.bili)
            if (body?.qq && typeof body.qq === 'object') out.qq = writeQq(onebotApi(), body.qq)
            out.ok = out.bili?.ok !== false && out.qq?.ok !== false
            return sendJson(res, 200, out)
          }

          // B站 扫码登录（泡泡自己那份，不靠刷B站插件）
          if (req.method === 'POST' && p === '/bili/login/start') {
            try {
              const r = await startLogin()
              return sendJson(res, 200, { ok: true, ...r })
            } catch (e) {
              return sendJson(res, 200, { ok: false, state: 'error', message: e?.message ?? String(e) })
            }
          }

          if (req.method === 'GET' && p === '/bili/login/poll') {
            const key = url.searchParams.get('key') || ''
            try {
              return sendJson(res, 200, await pollLogin(dshHome(), key))
            } catch (e) {
              return sendJson(res, 200, { ok: false, state: 'error', message: e?.message ?? String(e) })
            }
          }

          if (req.method === 'GET' && p === '/bili/who') {
            try {
              return sendJson(res, 200, await currentUser(dshHome()))
            } catch (e) {
              return sendJson(res, 200, { ok: false, message: e?.message ?? String(e) })
            }
          }

          // 客户端（浏览器那边）自己报错回来：设置页里渲染/输入出问题时，
          // 控制台我们看不到，就让它写进 bubble\client-errors.log。
          if (req.method === 'POST' && p === '/client-log') {
            const body = (await readBody(req)) || {}
            try {
              const file = join(home, 'client-errors.log')
              try {
                if (statSync(file).size > 512 * 1024) writeFileSync(file, '')
              } catch (e) { /* 文件还不存在就算了 */ }
              appendFileSync(file, JSON.stringify({
                at: Date.now(),
                where: String(body.where ?? ''),
                message: String(body.message ?? ''),
                stack: String(body.stack ?? '').slice(0, 4000),
                extra: body.extra ?? null,
              }) + '\n')
            } catch (e) { /* 记不下来也不该把面板拖死 */ }
            return sendJson(res, 200, { ok: true })
          }

          // B站 那边有动静：看状态 / 立刻看一次
          if (req.method === 'GET' && p === '/watch') {
            const cfg = readConfig(home)
            return sendJson(res, 200, {
              ok: true,
              enabled: cfg.biliWatch !== false,
              minutes: cfg.biliWatchMinutes,
              ...watcher.status(),
            })
          }

          if (req.method === 'POST' && p === '/watch/run') {
            const r = await watcher.poll({ manual: true })
            return sendJson(res, 200, { ok: true, result: r })
          }

          return sendJson(res, 404, { ok: false, error: '没有这个接口：' + p })
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bubble: /api/bubble 路由')
  } catch (e) {
    log('路由没挂上：' + (e?.message ?? e))
  }

  log(`已挂载 v${VERSION}（家=${home}）`)
}

/** 写盘前把对象过一遍 readConfig 那套清洗（不落脏数据） */
export function readConfigFromObject(cfg) {
  return {
    enabled: cfg.enabled !== false,
    dryRun: cfg.dryRun !== false,
    profiles: cfg.profiles.map((p, i) => normalizeProfile(p, PRESET_DAILY, 'p' + (i + 1), '配置' + (i + 1))),
    bindings: cfg.bindings.map((b) => ({ chatId: b.chatId, profileId: b.profileId, enabled: b.enabled !== false })),
    keywords: cfg.keywords,
    videoPerRound: cfg.videoPerRound,
    videoFreshDays: cfg.videoFreshDays,
    videoMinPlay: cfg.videoMinPlay,
    videoMinSec: cfg.videoMinSec,
    videoMaxSec: cfg.videoMaxSec,
    videoExclude: cfg.videoExclude,
    biliWatch: cfg.biliWatch !== false,
    biliWatchMinutes: cfg.biliWatchMinutes,
    biliOwnerUids: cfg.biliOwnerUids,
    biliDmStrangers: cfg.biliDmStrangers === true,
    // 来料四个开关必须一起写回，不然存一次就被抹成默认（哥哥 11-08 报的「关不掉」）
    biliDm: cfg.biliDm !== false,
    biliAt: cfg.biliAt !== false,
    biliReply: cfg.biliReply !== false,
    biliWeight: cfg.biliWeight !== false,
  }
}