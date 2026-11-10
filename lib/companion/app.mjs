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
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createTicker } from './tick.mjs'
import { spend, settle } from './weight.mjs'
import { createFollowup } from './followup.mjs'
import { readLater } from './prompt.mjs'
import { parseHM, formatHM } from './period.mjs'
import { createDeliverer } from './deliver.mjs'
import { resolveOnebot } from './bridge-link.mjs'
import { createBiliWatch } from './bili-watch.mjs'
import { pushInbox } from './inbox.mjs'
import { bumpTaste } from './taste.mjs'
import { appendLedger, readLedger, hourlyBuckets } from './ledger.mjs'
import { readVideos, noteSentVideo, blockVideo, unblockVideo } from './video-log.mjs'
import { prepareBili } from './adapters/bili.mjs'
import { EVENT_POOL, mergePool, normalizePercent } from './events.mjs'
import { readBuckets, writeBuckets, bucketOf, normalizeBucket, readHistory, defaultState, noteScore, readScore } from './state.mjs'
import { readBili, writeBili, readQq, writeQq } from './ext-settings.mjs'
import { startLogin, pollLogin, currentUser } from './bili-login.mjs'
import { biliVideoInfo, bvidOfLink } from '../link-expand.js'
import { buildNewsCard, buildArkCard } from '../card.js'


// 跟包的版本走：三合一之后没有「单独一个陪伴插件」了，别再报 0.3.0 让人以为
// 装的还是老的 dsh-bubble。这里直接读 package.json，免得发版时忘了改常数。
import { createRequire } from 'node:module'
const PKG = createRequire(import.meta.url)('../../package.json')
const VERSION = PKG.version || '0.0.0'

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
// 11-11 哥哥：把「他现在实际在用的那套」定成默认值（最低分 = wFloor 已经改到 -50）。
const PRESET_DAILY = {
  mode: 'daily', threshold: 30, risePerTick: 2, tickMinutes: 5, triggerPmax: 0.1,
  releaseBase: 40, wFloor: -50, limitHours: 1, limitMax: 20, idleMinutes: 3, inboundBonus: 1,
  quiet: { enabled: true, from: '00:00', to: '09:00' },
}
const PRESET_ACTIVE = {
  mode: 'active', threshold: 0, risePerTick: 3, tickMinutes: 3, triggerPmax: 0.5,
  releaseBase: 30, wFloor: -20, limitHours: 1, limitMax: 30, idleMinutes: 1, inboundBonus: 3,
  quiet: { enabled: true, from: '02:00', to: '09:00' },
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
    videoExclude: [],       // 不感兴趣的词：标题 / UP 名 / 标签 / 分区命中就丢
    videoBlockUids: [],     // 拉黑的 UP 主 mid
    videoBlockUps: [],      // 拉黑的 UP 主名字（整串一致才算）
    videoKeywordsPerRound: 3, // 关键词多了就轮着用，每轮取几个
    videoDetail: true,      // 关键词结果补一次 detail（时长/播放量才筛得动）
    // 11-11 哥哥：B站 那边的开关默认全关（间隔本来就长，需要了再自己打开）
    biliWatch: false,
    biliWatchMinutes: 180,
    biliOwnerUids: [233078950],
    biliDmStrangers: false,
    biliDm: false,
    biliAt: false,
    biliReply: false,
    biliWeight: false,
    // 定时话头（哥哥 11-09 重做）：只有「他说话/回她」的那一轮能排，到点再叫醒她一轮。
    // 抽卡叫起来的那一轮不给排（闸门在 bridge）。默认开，但一天最多 3 条。
    followupEnabled: true,
    followupPerDay: 20,
    followupMaxHours: 12,
    followupMinSec: 60,
    // 老配置的键留着，只为了不报错（新逻辑不再用随机区间）
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
    // 权重地板：哥哥 11-10 开放到 -100 ~ 0，每套模式自己定
    wFloor: num(r.wFloor, d.wFloor, -100, 0),
    // 11-11 哥哥：他找上门多给几分，跟着模式走（日常 +1、主动 +3），可填负数
    inboundBonus: num(r.inboundBonus, d.inboundBonus ?? 1, -10, 10),
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
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50)
  cfg.videoPerRound = num(raw.videoPerRound, d.videoPerRound, 1, 5)
  cfg.videoFreshDays = num(raw.videoFreshDays, d.videoFreshDays, 1, 365)
  cfg.videoMinPlay = num(raw.videoMinPlay, d.videoMinPlay, 0, 1e9)
  cfg.videoMinSec = num(raw.videoMinSec, d.videoMinSec, 0, 7200)
  cfg.videoMaxSec = num(raw.videoMaxSec, d.videoMaxSec, 10, 7200)
  cfg.videoExclude = (Array.isArray(raw.videoExclude) ? raw.videoExclude : d.videoExclude)
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50)
  cfg.videoBlockUids = (Array.isArray(raw.videoBlockUids) ? raw.videoBlockUids : d.videoBlockUids)
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 100)
  cfg.videoBlockUps = (Array.isArray(raw.videoBlockUps) ? raw.videoBlockUps : d.videoBlockUps)
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 100)
  cfg.videoKeywordsPerRound = num(raw.videoKeywordsPerRound, d.videoKeywordsPerRound, 1, 10)
  cfg.videoDetail = raw.videoDetail !== false
  // 11-11 哥哥：B站 相关的开关默认全关（显式打开才生效）
  cfg.biliWatch = raw.biliWatch === true
  // 来料分类开关（哥哥 11-08）：哪几类算「有人叫她」；biliWeight=false 时这轮不动权重
  cfg.biliDm = raw.biliDm === true
  cfg.biliAt = raw.biliAt === true
  cfg.biliReply = raw.biliReply === true
  cfg.biliWeight = raw.biliWeight === true
  cfg.biliWatchMinutes = num(raw.biliWatchMinutes, d.biliWatchMinutes, 1, 240)
  cfg.biliDmStrangers = raw.biliDmStrangers === true
  cfg.biliOwnerUids = (Array.isArray(raw.biliOwnerUids) ? raw.biliOwnerUids : d.biliOwnerUids)
    .map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n > 0).slice(0, 10)
  // 定时话头：默认开；上限都能自己调
  cfg.followupEnabled = raw.followupEnabled !== false
  cfg.followupPerDay = num(raw.followupPerDay, d.followupPerDay, 1, 20)
  cfg.followupMaxHours = num(raw.followupMaxHours, d.followupMaxHours, 1, 12)
  cfg.followupMinSec = num(raw.followupMinSec, d.followupMinSec, 30, 3600)

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

/**
 * B站 动静该递给哪个会话。
 * 优先显式指定的 chatId，其次老配置的 cfg.chatId，其次私聊绑定，最后第一个启用的绑定。
 * 11-08 加：配置迁到 bindings 之后 cfg.chatId 没了，原来直接拿它当钥匙
 * → 收件箱落进 "undefined" 桶，谁都取不到。这里给一个明确的落点。
 */
export function pickCueChat(cfg, chatId) {
  const on = ((cfg && cfg.bindings) || []).filter((b) => b && b.enabled !== false)
  const priv = on.find((b) => String(b.chatId || '').startsWith('private:'))
  return chatId || (cfg && cfg.chatId) || (priv || on[0] || {}).chatId || ''
}

const GLOBAL_KEYS = ['enabled', 'dryRun', 'keywords', 'videoPerRound', 'videoFreshDays',
  'videoMinPlay', 'videoMinSec', 'videoMaxSec', 'videoExclude', 'videoBlockUids', 'videoBlockUps',
  'videoKeywordsPerRound', 'videoDetail', 'biliWatch',
  'biliWatchMinutes', 'biliOwnerUids', 'biliDmStrangers', 'biliDm', 'biliAt', 'biliReply', 'biliWeight',
  'followupEnabled', 'followupPerDay', 'followupMaxHours', 'followupMinSec']

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
        api.setScoreHook((chatId, score, meta) => {
          try { noteScore(home, chatId, score, { inbound: meta?.inbound === true, origin: meta?.origin }) } catch { /* 落盘失败不吵 */ }
        })
        return true
      }
    } catch { /* QQ 还没接上，等下一拍再挂 */ }
    return false
  }
  armScoreHook()

  // 回合消耗（哥哥 11-10）：不管谁起的轮、发没发出去，一轮结束就扣一格「标准扣分」。
  // 扣的基数和地板跟着这个会话绑定的那套配置走；扣完写回 state.json。
  const armTurnHook = () => {
    try {
      const api = onebotApi()
      if (api && typeof api.setTurnHook === 'function') {
        api.setTurnHook((chatId, meta) => {
          try {
            // 11-11（哥哥 m16697）：扣和补都在这一轮结束时当场算完，不等下一拍。
            //   ① 每轮先扣一格（发没发都扣；追聊也算）
            //   ② 这一轮她打了分，就按同一张表当场补/追（5 分 = 0%，不补不追）
            //   ③ 分里的 +N 只给他起的这一轮；抽卡、追聊那一下不给；N 可以是负数
            const cfg = readConfig(home)
            // B站 来料：biliWeight 关掉时这一段不动账（不扣也不结，两边同一个口径）
            if (meta?.origin === 'inbox' && cfg.biliWeight === false) return
            // 追聊那一下不扣分（哥哥 11-11：追聊纯亏是个问题）——它本来就是她排队等着的补充
            if (meta?.origin === 'followup') return
            const b = (cfg.bindings || []).find((x) => x.chatId === chatId)
            if (!b || b.enabled === false) return
            const profile = (cfg.profiles || []).find((p) => p.id === b.profileId) || cfg.profiles?.[0]
            if (!profile) return
            const base = Number(profile.releaseBase)
            if (!Number.isFinite(base) || base <= 0) return
            const floor = Number.isFinite(Number(profile.wFloor)) ? Number(profile.wFloor) : -20
            const buckets = readBuckets(home)
            const bucket = bucketOf(buckets, chatId)
            const now = Date.now()
            const origin = String(meta?.origin || 'host')
            const w0 = Number(bucket.w) || 0
            let w = w0

            // ① 这一轮的消耗
            w = spend(w, base, { floor })
            appendLedger(home, {
              at: now, chatId, kind: 'spend', delta: Math.round((w - w0) * 10) / 10, w0, w1: w, origin,
              note: origin === 'bubble' ? '她主动开口的这一轮'
                : origin === 'inbox' ? 'B站 有人找上来的这一轮'
                : '他找她聊的这一轮',
            })

            // ② 她这一轮给自己打的分 → 按表补/追（base 跟①同一个，计次才对称）
            const sc = readScore(home, chatId)
            const scAt = Number(sc?.at) || 0
            const fresh = !!sc && scAt > Number(bucket.lastSettleAt || 0) && (now - scAt) <= 24 * 3600_000
            if (fresh && Number.isFinite(Number(sc.score))) {
              const score = Math.max(0, Math.min(120, Number(sc.score)))
              // 这份加分跟着会话绑定的那套配置走（日常 +1、主动 +3，11-11 哥哥定）
              const inboundBonus = Number.isFinite(Number(profile.inboundBonus)) ? Number(profile.inboundBonus) : 1
              const w1 = w
              w = settle(w, score, {
                base, floor,
                // 抽卡/追聊那一下：inbound=false → 不吃这份加分
                inbound: sc.inbound === true,
                inboundBonus,
              })
              const delta = Math.round((w - w1) * 10) / 10
              appendLedger(home, {
                at: now, chatId, kind: 'settle', delta, w0: w1, w1: w,
                score, inbound: sc.inbound === true,
                note: (sc.inbound === true ? '他找上来的这一轮' : '她主动开口的这一轮')
                  + '，她打了 ' + (score / 10) + ' 分',
              })
              try { bumpTaste(home, bucket.lastPicks, score, now) } catch (e) { log('口味账失败：' + String(e?.message ?? e)) }
            }
            bucket.lastSettleAt = scAt
            bucket.lastSpendAt = now
            bucket.lastSpendOrigin = origin
            bucket.w = w
            writeBuckets(home, buckets)
          } catch (e) { log('回合结算失败：' + String(e?.message ?? e)) }
        })
        return true
      }
    } catch { /* QQ 还没接上，等下一拍再挂 */ }
    return false
  }
  armTurnHook()

  const plan = () => {
    const cfg = readConfig(home)
    const bindings = cfg.bindings.map((b) => ({
      chatId: b.chatId,
      enabled: b.enabled !== false,
      profile: cfg.profiles.find((p) => p.id === b.profileId) || cfg.profiles[0],
    }))
    // 整份配置上的键（兴趣关键词、刷视频筛选参数）：必须单独往下传，
    // 否则 prepare 只拿到 profile，关键词永远是空的、一直走热门兜底。
    const globals = {}
    for (const k of GLOBAL_KEYS) if (k in cfg) globals[k] = cfg[k]
    return { enabled: cfg.enabled, dryRun: cfg.dryRun, bindings, globals }
  }

  const ticker = createTicker({
    getPlan: plan,
    getHome: () => home,
    // 抽中什么就去把它摆到桌上（现在只接了刷视频；别的先空着）
    // 注意：这里传的是 DSH 家目录（找 B站 凭证用），不是泡泡自己的家目录。
    // 看视频要的视觉模型在 QQ 那份配置里（visionModel/visionBaseUrl/…），
    // 这里补进去——不补的话「发前仔细看」会报「还没配视觉模型」。
    prepare: (ev, info) => {
      let vision = {}
      try {
        const api = onebotApi()
        const qq = api && typeof api.getConfig === 'function' ? api.getConfig() : null
        if (qq) {
          vision = {
            visionModel: qq.visionModel, visionBaseUrl: qq.visionBaseUrl,
            visionApiKeyEnv: qq.visionApiKeyEnv, visionMaxTokens: qq.visionMaxTokens,
            visionTimeoutMs: qq.visionTimeoutMs,
            videoVisionModel: qq.videoVisionModel, videoVisionBaseUrl: qq.videoVisionBaseUrl,
            videoVisionApiKeyEnv: qq.videoVisionApiKeyEnv, videoVisionFallbackModel: qq.videoVisionFallbackModel,
            videoVisionFallbackBaseUrl: qq.videoVisionFallbackBaseUrl,
            videoVisionFallbackApiKeyEnv: qq.videoVisionFallbackApiKeyEnv,
            videoVisionMaxTokens: qq.videoVisionMaxTokens, videoVisionTimeoutMs: qq.videoVisionTimeoutMs,
          }
        }
      } catch { /* QQ 通道没接上就按空配置走，会报清楚 */ }
      const cfg = { ...vision, ...(info?.cfg || {}) }
      return prepareBili(ev, { ...info, cfg }, { home: dshHome(), log })
    },
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

  // 定时话头：会话自己写 [LATER 25] 才排（哥哥 11-09）。
  // 到点只是再叫醒她一轮，看到的是最新上下文，不是发固定内容。
  // 免打扰照管（tick 里判），限流不管（tick 里 followup 跳过 limit）。
  const followup = createFollowup({
    home,
    getConfig: () => readConfig(home),
    fire: async (chatId) => ticker.tick(chatId, { followup: true }),
    log,
  })
  followup.restore()

  // QQ 那边从会话正文里读到 [LATER 25] 就叫我们一声，排一个定时器。
  const armMoreHook = () => {
    try {
      const api = onebotApi()
      if (api && typeof api.setMoreHook === 'function') {
        api.setMoreHook((chatId, text) => {
          try {
            const sec = readLater(text, Date.now(), (readConfig(home).followupMaxHours || 12) * 3600)
            if (!sec) return
            const r = followup.request(chatId, sec)
            if (!r.ok) log('定时话头没排上（' + r.reason + '）：' + chatId)
            else log('info', '定时话头已排：' + chatId + ' ' + Math.round(sec / 60) + ' 分钟后')
          } catch (e) { log('定时话头排队失败：' + (e?.message ?? e)) }
        })
        return true
      }
    } catch { /* QQ 还没接上，等下一拍再挂 */ }
    return false
  }
  armMoreHook()

  // QQ 那边每发出一条正文就叫我们一声：正文里带 BV 号，就当「这条视频发出去了」记账。
  // 只认发出去的（哥哥 11-10 定的口径：抽到没发不算），30 天内不再自动抽到。
  const armSentHook = () => {
    try {
      const api = onebotApi()
      if (api && typeof api.setSentHook === 'function') {
        api.setSentHook((chatId, text) => {
          try {
            const hits = String(text || '').match(/BV[0-9A-Za-z]{10}/g) || []
            for (const bvid of new Set(hits)) {
              noteSentVideo(home, { bvid, url: 'https://www.bilibili.com/video/' + bvid, chatId })
            }
          } catch (e) { log('视频记账失败：' + (e?.message ?? e)) }
        })
        return true
      }
    } catch { /* QQ 还没接上，等下一拍再挂 */ }
    return false
  }
  armSentHook()

  // 换参数就重排节拍。节拍取所有会话里最短的那一档，每个会话自己再按
  // 自己的 tickMinutes 判「还没到点」，所以快慢不会互相拖。
  const restart = () => {
    // QQ 服务可能被重建过，钩子每次跟着重挂一遍（挂了就幂等覆盖同一个函数）
    armScoreHook()
    armTurnHook()
    armMoreHook()
    armSentHook()
    const cfg = readConfig(home)
    if (!cfg.enabled) {
      ticker.stop()
      watcher.stop()
      followup.stop()
      log('已停（开关关着）')
      return 0
    }
    // 节拍只按「开着的那几条」算：全关掉了就没必要每 3 分钟空跑一趟
    // （哥哥 11-11：关掉开关后拍子还在走——一半是流水记账，一半是这个）。
    const onBindings = cfg.bindings.filter((b) => b.enabled !== false)
    const gaps = (onBindings.length ? onBindings : cfg.bindings)
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
    // 11-08 修：B站 动静原来写死用 cfg.chatId，可迁移到 bindings 之后这个键已经没了
    // → 收件箱被塞进 "undefined" 这把钥匙下，任何会话的 tick 都取不到，动静就静默丢了。
    // 现在按「私聊优先、否则第一个启用绑定」定一个明确落点。
    cue: async ({ chatId, items }) => {
      const cfg = readConfig(home)
      const target = pickCueChat(cfg, chatId)
      if (!target) {
        log('B站 有动静，但没有可投的会话（绑定全是关着的），先记着')
        return { ok: false, queued: false, mode: 'nochat' }
      }
      pushInbox(home, target, items)
      return ticker.tick(target, { fresh: true })
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
              'releaseBase', 'wFloor', 'limitHours', 'limitMax', 'idleMinutes', 'quiet', 'pool']
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
            const kind = String(body.kind || body.card || '').toLowerCase()
            const title0 = String(body.title || info?.title || 'B站 视频')
            const desc0 = String(body.desc || info?.desc || (info ? 'UP：' + info.owner : ''))
            const url0 = rawUrl || (bvid ? 'https://www.bilibili.com/video/' + bvid : '')
            const pic0 = String(body.pic || info?.pic || '')
            // 小程序卡：先让 NapCat 找服务端签好名（get_mini_app_ark），再原样发出去。
            // 自己手搓的 ark / news 在新版客户端上会被判「发送者版本过低」。
            if (kind === 'miniapp' || kind === 'lightapp') {
              if (typeof onebot.callAction !== 'function' || typeof onebot.sendSegments !== 'function') {
                return sendJson(res, 200, { ok: false, error: '插件还没换到新代码，点一下刷新' })
              }
              try {
                const got = await onebot.callAction('get_mini_app_ark', {
                  type: 'bili',
                  title: title0,
                  desc: desc0,
                  picUrl: pic0,
                  jumpUrl: url0,
                })
                const raw = got?.data ?? got
                if (!raw || typeof raw !== 'object') throw new Error('没拿到签名后的卡片')
                if (body.debug === true) return sendJson(res, 200, { ok: true, chatId, bvid, mode: 'miniapp', raw })
                const messageId = await onebot.sendSegments(chatId, [
                  { type: 'json', data: { data: JSON.stringify(raw) } },
                ])
                return sendJson(res, 200, { ok: true, chatId, bvid, mode: 'miniapp', messageId: messageId ?? null })
              } catch (e) {
                return sendJson(res, 200, { ok: false, chatId, bvid, mode: 'miniapp', error: String(e?.message ?? e) })
              }
            }
            const build = kind === 'ark' ? buildArkCard : buildNewsCard
            const card = build({
              title: title0,
              desc: desc0,
              url: url0,
              pic: pic0,
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
              const retired = typeof onebot.retiredSessions === 'function' ? await onebot.retiredSessions() : []
              return sendJson(res, 200, { ok: true, table: await onebot.sessionTable(), retired })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), table: {} })
            }
          }

          // 把一条会话从退休名单里放出来（退休 = 永久拉黑，这里给个正规出口）
          if (req.method === 'POST' && p === '/unretire') {
            const body = (await readBody(req)) || {}
            const onebot = onebotApi()
            if (!onebot || typeof onebot.unretireSession !== 'function') {
              return sendJson(res, 200, { ok: false, error: 'QQ 通道没接上' })
            }
            try {
              const r = await onebot.unretireSession(String(body.sessionId || '').trim())
              log('解退休 ' + body.sessionId + '：' + (r.ok ? '好' : (r.message || '')))
              return sendJson(res, 200, { ok: r.ok !== false, result: r })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
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

          // 打开某个设置项指向的目录（现在只给「表情包目录」用）
          if (req.method === 'POST' && p === '/ext/reveal') {
            const body = await readBody(req)
            const key = String(body?.key ?? '')
            const allowed = ['memeDir']
            if (!allowed.includes(key)) return sendJson(res, 400, { ok: false, error: '这个设置项不让打开目录' })
            const api = onebotApi()
            const cfg = api?.getConfig ? api.getConfig() : {}
            const dir = String(cfg?.[key] ?? '').trim()
            if (dir === '') return sendJson(res, 200, { ok: false, error: '还没填目录' })
            try {
              if (!statSync(dir).isDirectory()) return sendJson(res, 200, { ok: false, error: '这个路径不是目录' })
            } catch {
              return sendJson(res, 200, { ok: false, error: '目录不存在：' + dir })
            }
            try {
              spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
              return sendJson(res, 200, { ok: true, dir })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
            }
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

          // 积分流水：原始账 + 按小时折叠（哥哥 11-10 要的全量记录）
          if (req.method === 'GET' && p === '/ledger') {
            const u = new URL(req.url, 'http://x')
            const chatId = String(u.searchParams.get('chatId') || '')
            const hours = Math.max(1, Math.min(24 * 60, Number(u.searchParams.get('hours') || 48)))
            const limit = Math.max(0, Math.min(20000, Number(u.searchParams.get('limit') || 0)))
            const since = Date.now() - hours * 3600_000
            const rows = readLedger(home, { chatId, since, limit })
            const cfg = readConfig(home)
            const nameOf = (id) => {
              const b = (cfg.bindings || []).find((x) => x.chatId === id)
              return b ? (b.label || id) : id
            }
            const hoursOut = hourlyBuckets(rows).map((b) => ({
              ...b,
              chatName: nameOf(b.rows[0]?.chatId || ''),
              rows: b.rows.slice(0, 60),
            }))
            return sendJson(res, 200, { ok: true, hours: hoursOut, rows: rows.slice(0, 400) })
          }

          // 视频账：发出去过的（30 天不再推）+ 黑名单 + 抽到过的（只做记录，不占名额）
          if (req.method === 'GET' && p === '/videos') {
            const data = readVideos(home)
            const sent = Object.entries(data.sent)
              .map(([bvid, rec]) => ({ bvid, title: rec.title || '', url: rec.url || ('https://www.bilibili.com/video/' + bvid), at: Number(rec.at) || 0, chatId: rec.chatId || '' }))
              .sort((a, b) => b.at - a.at)
              .slice(0, 200)
            const blocked = Object.keys(data.blocked)
            const picked = readHistory(home, 400)
              .filter((row) => row && row.event === 'video' && !row.kind)
              .flatMap((row) => (Array.isArray(row.targets) ? row.targets : []).map((t) => ({
                bvid: String(t.bvid || ''), title: String(t.title || ''),
                url: String(t.url || ''), at: Number(row.at) || 0,
                chatId: String(row.chatId || ''), delivered: !!row.delivered,
              })))
              .filter((x) => x.bvid !== '')
              .slice(0, 200)
            return sendJson(res, 200, { ok: true, sent, blocked, picked })
          }
          if (req.method === 'POST' && p === '/videos/block') {
            const body = (await readBody(req)) || {}
            const bvid = String(body.bvid || '').trim()
            if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return sendJson(res, 200, { ok: false, error: '认不出这个 BV 号' })
            const on = blockVideo(home, bvid)
            if (!on) return sendJson(res, 200, { ok: false, error: '没记上' })
            log('视频不再推：' + bvid)
            return sendJson(res, 200, { ok: true, blocked: Object.keys(readVideos(home).blocked) })
          }
          if (req.method === 'POST' && p === '/videos/unblock') {
            const body = (await readBody(req)) || {}
            const bvid = String(body.bvid || '').trim()
            unblockVideo(home, bvid)
            return sendJson(res, 200, { ok: true, blocked: Object.keys(readVideos(home).blocked) })
          }

          // 检查环境（2026-11-10）：只查不装，把「缺什么、去哪儿补」一次说清。
          if (req.method === 'GET' && p === '/doctor') {
            let out = { ok: false, error: '检查没跑起来' }
            try {
              const api = onebotApi()
              const cfg = api && typeof api.getConfig === 'function' ? api.getConfig() || {} : {}
              const nap = api && typeof api.napcatStatus === 'function' ? await api.napcatStatus() : null
              const { runDoctor, readProfileConfig } = await import('../doctor.mjs')
              // 运行中的 getConfig 是白名单，未必带全（比如刚加的 napcatDir）；
              // 缺的从 profile 的 cordis.patch.yml 补，保证「刷新就能看对」。
              const merged = { ...readProfileConfig() }
              for (const [k, v] of Object.entries(cfg)) {
                if (v !== undefined && v !== null && v !== '') merged[k] = v
              }
              const got = await runDoctor({ config: merged, napcat: nap })
              out = { ok: true, doctor: got }
            } catch (e) {
              out = { ok: false, error: String(e?.message ?? e) }
            }
            return sendJson(res, 200, out)
          }

          // 「第一次用」引导（2026-11-10）：只看状态，不动任何配置。
          if (req.method === 'GET' && p === '/setup') {
            let info = null
            try {
              const api = onebotApi()
              if (api && typeof api.setupInfo === 'function') info = api.setupInfo()
            } catch (e) { log('读连接状态失败：' + (e?.message ?? e)) }
            return sendJson(res, 200, { ok: info !== null, setup: info })
          }
          // 复制 token 用：就地交给本机界面，不写日志、不进状态。
          if (req.method === 'GET' && p === '/setup/token') {
            let token = ''
            try {
              const api = onebotApi()
              if (api && typeof api.plainToken === 'function') token = String(api.plainToken() || '')
            } catch { /* 拿不到就是空 */ }
            return sendJson(res, 200, { ok: token !== '', token })
          }

          // NapCat 快捷启动 / 二维码（2026-11-10）：只做启动、重启、看码，不做停止。
          if (req.method === 'GET' && p === '/napcat') {
            let out = { ok: false, error: '拿不到 NapCat 状态' }
            try {
              const api = onebotApi()
              if (api && typeof api.napcatStatus === 'function') out = { ok: true, napcat: await api.napcatStatus() }
            } catch (e) { out = { ok: false, error: String(e?.message ?? e) } }
            return sendJson(res, 200, out)
          }
          if (req.method === 'GET' && p === '/napcat/qr') {
            let out = { ok: false, error: '拿不到二维码' }
            try {
              const api = onebotApi()
              if (api && typeof api.napcatQr === 'function') out = await api.napcatQr()
            } catch (e) { out = { ok: false, error: String(e?.message ?? e) } }
            return sendJson(res, 200, out)
          }
          if (req.method === 'GET' && p === '/napcat/auto') {
            let out = { ok: false, error: '读不到开关' }
            try {
              const api = onebotApi()
              if (api && typeof api.napcatAutoStatus === 'function') out = await api.napcatAutoStatus()
            } catch (e) { out = { ok: false, error: String(e?.message ?? e) } }
            return sendJson(res, 200, out)
          }
          if (req.method === 'POST' && p === '/napcat/auto') {
            let out = { ok: false, error: '改不了开关' }
            try {
              const body = await readBody(req)
              const api = onebotApi()
              if (api && typeof api.setNapcatAuto === 'function') out = await api.setNapcatAuto(body || {})
              log('NapCat 自动开关：' + JSON.stringify(out))
            } catch (e) { out = { ok: false, error: String(e?.message ?? e) } }
            return sendJson(res, 200, out)
          }
          if (req.method === 'POST' && (p === '/napcat/start' || p === '/napcat/restart')) {
            const which = p.endsWith('restart') ? 'napcatRestart' : 'napcatStart'
            let out = { ok: false, error: '起不来' }
            try {
              const api = onebotApi()
              if (api && typeof api[which] === 'function') {
                out = await api[which]()
                log('NapCat ' + (which === 'napcatRestart' ? '重启' : '启动') + '：' + JSON.stringify(out))
              }
            } catch (e) { out = { ok: false, error: String(e?.message ?? e) } }
            return sendJson(res, 200, out)
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
    ...globalKeysForWrite(cfg),
  }
}

/**
 * 全局键一律原样写回。漏掉一个，那一项就是「存一次被抹成默认」
 * —— 11-08 的来料开关、11-10 的定时聊（条数/最长小时/间隔）都栽在这上面。
 * 类型按 defaultConfig 里的默认值走：布尔按默认值取向、数组只收数组、数字转数值。
 */
function globalKeysForWrite(cfg) {
  const d = defaultConfig()
  const out = {}
  for (const k of GLOBAL_KEYS) {
    if (k === 'enabled' || k === 'dryRun') continue
    const dv = d[k]
    const v = cfg[k]
    if (v === undefined) out[k] = dv
    else if (typeof dv === 'boolean') out[k] = dv ? v !== false : v === true
    else if (Array.isArray(dv)) out[k] = Array.isArray(v) ? v : dv
    else if (typeof dv === 'number') out[k] = Number.isFinite(Number(v)) ? Number(v) : dv
    else out[k] = v
  }
  return out
}