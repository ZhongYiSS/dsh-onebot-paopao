/**
 * 抽卡器 —— 每 N 分钟跑一次，逐个会话决定「这一轮要不要、做什么」。
 * ============================================================================
 * 顺序（每一步都能在测试里单独看）：
 *   时间上升 → 跨天 → 开关 → 免打扰 → 滑动窗口限流 → 阈值 → 掷骰 →
 *   抽事件 → 事件加分 → 准备候选 → 生成话头 → 投递 → 释放 → 记账
 *
 * 会话 = 绑定了某个「配置」的一个 chatId，各自有独立账本，互不抢额度。
 * 所有 IO 都从外面注入，所以这个文件不 import 任何宿主 API，测试里能直接跑。
 * ============================================================================
 */
import { riseByTick, canSpeak, triggerChance, release, releaseFactor, addBonus } from './weight.mjs'
import { drawEvent, mergePool } from './events.mjs'
import { canTrigger, pruneWindow } from './limit.mjs'
import { readBuckets, writeBuckets, bucketOf, normalizeBucket, appendHistory, dayKeyOf, agoText } from './state.mjs'
import { periodOf, inQuiet } from './period.mjs'
import { buildHint } from './prompt.mjs'
import { peekInbox, dropInbox, formatItem } from './inbox.mjs'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 每拍记账：这一拍为什么没发、p 是多少、roll 是多少。
 * history.jsonl 只记「发出去的」，光看它没法确认掷骰有没有在拦人（哥哥 11-04 问过）。
 * 「没到点」那种不记，不然一分钟一行全是废话。
 */
const TICK_LOG = 'ticks.jsonl'
const TICK_LOG_MAX = 512 * 1024
function logTick(home, rec) {
  try {
    const file = path.join(home, TICK_LOG)
    fs.appendFileSync(file, JSON.stringify(rec) + '\n')
    if (fs.statSync(file).size > TICK_LOG_MAX) {
      const keep = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-400)
      fs.writeFileSync(file, keep.join('\n') + '\n')
    }
  } catch {
    /* 记账失败不影响抽卡 */
  }
}

export function createTicker({
  /** () => { enabled, dryRun, bindings: [{ chatId, enabled, profile }] } */
  getPlan,
  getHome,
  prepare = async () => [],
  deliver = async () => ({ ok: false, mode: 'none' }),
  /** 他是不是正在聊？返回 true = 别打扰。 */
  idleCheck = async () => true,
  /** (chatId) => {score, at}|null —— 会话自己打的兴趣分，后到的先存着，下一拍取走 */
  scoreOf = () => null,
  /** (chatId) => '群 摸鱼群' —— 话头里给她一个看得懂的称呼，取不到就空着 */
  labelOf = () => '',
  log = () => {},
  now = () => Date.now(),
  rnd = Math.random,
}) {
  let timer = null
  let busy = false

  /** 跑一个会话。b = { chatId, enabled, profile } */
  async function tickOne(b, buckets, t, force = false, dryRun = true, fresh = false, biliWeight = true, followup = false) {
    const profile = b.profile || {}
    const home = getHome()
    const chatId = String(b.chatId || '')
    if (!chatId) return { chatId, skipped: 'nochat' }

    const state = bucketOf(buckets, chatId)
    const out = { at: t, chatId, profileId: profile.id || '', w0: state.w }
    buckets[chatId] = state
    let w = state.w

    // ⓪ 上一轮她给自己打了分？按分数校正。（投递那一刻她还来不及写，
    //    所以当时先按 50 扣了；这里只补差额：分数越高，这一轮扣得越多。）
    try {
      const sc = scoreOf(chatId)
      // 只认「上一轮发出去之后 30 分钟内」的分：平时聊天她也每轮打分，
      // 那种分不该算到泡泡头上（否则聊得越多越容易被扣，跟设计相反）。
      // 30 分钟是 11-08 放宽的：看视频那一轮 deep 要两分钟上下，原来的 10 分钟容易漏掉。
      const last = Number(state.lastTriggerAt) || 0
      const fresh = sc && last > 0 && Number(sc.at) >= last - 5000 && Number(sc.at) <= last + 30 * 60_000
      const base = Number(profile.releaseBase)
      if (!biliWeight && fresh) {
        // 来料不动账：分数照记「已消费」，但不拿它调权重（否则下一拍还是会动）
        state.consumedScoreAt = Number(sc.at) || 0
      } else if (fresh && Number(sc.at) > Number(state.consumedScoreAt || 0)) {
        const score = Math.max(0, Math.min(100, Number(sc.score)))
        if (Number.isFinite(base) && base > 0 && Number.isFinite(score)) {
          // 投递时按 5 分（系数 1）扣过了；这里补差额：分越高系数越低，把多扣的加回来。
          const delta = Math.round((1 - releaseFactor(score)) * base * 10) / 10
          w = Math.max(0, Math.min(100, w + delta))
          out.score = score
          out.scoreDelta = delta
        }
        state.consumedScoreAt = Number(sc.at) || 0
      }
    } catch (e) {
      out.scoreError = String(e?.message ?? e)
    }
    const save = (extra = {}) => {
      state.w = typeof extra.w === 'number' ? extra.w : w
      writeBuckets(home, buckets)
      if (extra.skipped !== 'notyet') {
        logTick(home, {
          at: t,
          chatId,
          profileId: profile.id || '',
          w0: out.w0,
          w: state.w,
          skipped: extra.skipped || '',
          p: extra.p,
          roll: extra.roll,
          event: extra.event || '',
          score: out.score,
          scoreDelta: out.scoreDelta,
          ok: extra.ok === true ? true : undefined,
          mode: extra.mode || '',
          error: extra.error || '',
        })
      }
      return { ...out, ...extra }
    }

    // ①.5 还没到点？每个会话按自己那套的 tickMinutes 走，手动跑不吃这条。
    // 容差给到 5 秒：定时器常常差几十毫秒提前醒来，卡太死会让这一拍白跑，
    // 下一次又得等一整轮——看起来就是「每分钟抽卡其实两分钟才动一次」。
    const gap = Number(profile.tickMinutes || 5) * 60_000
    if (!force && !fresh && !followup && Number(state.lastTickAt) && t - Number(state.lastTickAt) < gap - 5000) {
      return save({ skipped: 'notyet' })
    }
    state.lastTickAt = t

    // ① 免打扰：这段时间既不发、也**不涨权重**（哥哥 11-08：干脆停止计时）。
    //    所以必须在涨之前判——不然一晚上攒到顶，早上七点一到就立刻开口。
    const d = new Date(t)
    if (!force && inQuiet(d, profile.quiet)) return save({ skipped: 'quiet' })

    // ② 每次抽卡涨一点（哥哥 11-04 改的：不再按小时流逝算）
    w = riseByTick(w, profile.risePerTick)
    state.lastRiseAt = t

    // ③ 跨天
    const dk = dayKeyOf(t)
    if (state.dayKey !== dk) {
      state.dayKey = dk
      state.todayCount = 0
    }

    // ④ 这条绑定自己关了（免打扰在上面已经判过、也不涨权重）
    if (b.enabled === false) return save({ skipped: 'binding-off' })

    // ④.5 他正在聊就别插嘴（手动同样不看；追聊是「他还没接上」才发的，同样不判）
    if (!force && !followup && Number(profile.idleMinutes) > 0) {
      try {
        const quietEnough = await idleCheck({ chatId, minutes: Number(profile.idleMinutes), now: t })
        if (quietEnough === false) return save({ skipped: 'chatting' })
      } catch (e) {
        out.idleError = String(e?.message ?? e)
      }
    }

    // ⑤ 滑动窗口
    state.window = pruneWindow(state.window, profile.limitHours, t)
    if (!force && !canTrigger(state.window, profile.limitHours, profile.limitMax, t)) return save({ skipped: 'limit' })

    // ⑥ 来料优先：有人私信 / 评论 / @ 她 —— 这轮就回这条，不抽事件、不掷骰。
    //    （免打扰、限流、绑定开关在上面已经判过，所以半夜不会叫醒、额度也照样算。）
    const pending = followup ? [] : peekInbox(home, chatId)
    let p = 1
    let roll = 1
    let ev = null
    if (followup) {
      // ⑥.0 追聊：会话自己要求的「再补一句」。不判阈值、不掷骰、不抽事件、不准备，
      //      只走一遍上面那些「不该打扰」的门（免打扰 / 限流 / 绑定开关），并照常占额度。
      ev = { id: 'followup', label: '追聊', bonus: 0, hint: '' }
    } else if (pending.length === 0) {
      // ⑥.1 阈值
      if (!force && !canSpeak(w, profile.threshold)) return save({ skipped: 'below' })

      // ⑦ 掷骰（手动是「一定要发」，不掷）
      if (!force) {
        p = triggerChance(w, profile.threshold, profile.triggerPmax)
        roll = rnd()
        if (roll >= p) return save({ skipped: 'roll', p, roll })
      }

      // ⑧ 抽事件
      ev = drawEvent(mergePool(profile.pool), rnd)
      if (!ev) return save({ skipped: 'noevent' })
    } else {
      ev = { id: 'watch', label: '回消息', bonus: biliWeight ? 6 : 0, hint: '' }
      out.inbox = pending.map((x) => String(x.key || ''))
    }

    // ⑨ 事件加分
    const w1 = addBonus(w, ev.bonus)
    out.event = ev.id
    out.eventLabel = ev.label
    out.w1 = w1

    // ⑩ 准备（刷视频会真去搜；别的先给话头）
    let prepared = []
    try {
      if (!followup && pending.length === 0) prepared = (await prepare(ev, { cfg: { ...profile, dryRun }, state, chatId, now: t })) || []
    } catch (e) {
      out.prepareError = String(e?.message ?? e)
    }

    // ⑪ 话头
    const text = buildHint({
      modeLabel: profile.name || (profile.mode === 'active' ? '主动档' : '日常档'),
      countToday: state.todayCount + 1,
      lastAgoText: state.lastTriggerAt ? agoText(t - state.lastTriggerAt) : '',
      periodLabel: periodOf(d).label,
      w: w1,
      event: followup ? null : ev,
      candidates: pending.length ? pending.map((x) => ({ text: formatItem(x, t) })) : prepared,
      chatId,
      chatLabel: String(labelOf(chatId) || ''),
      note: followup ? '（你刚发出去那条，是你自己说想再补一句。补就补，没话就回 [HOLD]；补的话比刚才短。）' : '',
    })

    // ⑫ 投递
    let sent
    try {
      sent = await deliver({ chatId, text, event: ev, cfg: { ...profile, dryRun } })
    } catch (e) {
      sent = { ok: false, mode: 'error', error: String(e?.message ?? e) }
    }
    sent = sent || { ok: false, mode: 'none' }
    out.deliver = sent
    if (pending.length && sent.ok !== false) dropInbox(home, chatId, pending.map((x) => x.key))

    // ⑬ 释放（先按 5 分、系数 1 扣；她这轮写的 [SCORE n] 晚一点到，下一拍在 ⓪ 补差额）
    const score = Number.isFinite(Number(sent.score)) ? Number(sent.score) : 50
    const w2 = pending.length && !biliWeight ? w1 : release(w1, score, { base: profile.releaseBase })
    out.w2 = w2

    // ⑭ 记账
    state.lastTriggerAt = t
    state.todayCount += 1
    state.lastByEvent[ev.id] = t
    state.window.push(t)
    // 只留给人看的那几样：抽中了什么、分数怎么变、看了什么（不存整份候选对象）
    const targets = (Array.isArray(prepared) ? prepared : []).slice(0, 5).map((c) => ({
      title: String(c?.title ?? c?.name ?? ''),
      url: String(c?.url ?? ''),
      bvid: String(c?.bvid ?? ''),
      note: String(c?.note ?? ''),
    })).filter((c) => c.title || c.url || c.bvid)
    appendHistory(home, {
      chatId,
      profileId: profile.id || '',
      event: ev.id,
      label: ev.label,
      w0: out.w0,
      w1,
      w2,
      delivered: !!sent.ok,
      mode: sent.mode || 'none',
      error: sent.error || '',
      targets,
      text,
    })

    return save({ ok: true, w: w2 })
  }

  /** 跑一轮。给了 chatId 就只跑那一条绑定（设置页的「立刻抽一次」）。 */
  async function tick(onlyChatId, opts = {}) {
    const force = !!opts?.force
    const fresh = !!opts?.fresh
    if (busy) return { skipped: 'busy' }
    busy = true
    try {
      const plan = getPlan() || {}
      if (!plan.enabled) return { skipped: 'off' }
      const t = now()
      const home = getHome()
      const legacyKey = String((plan.bindings?.[0] && plan.bindings[0].chatId) || '_default')
      const buckets = readBuckets(home, legacyKey)
      const list = Array.isArray(plan.bindings) ? plan.bindings : []
      // 干跑是整份配置的开关，不在每套配置里 —— 得跟着往下传，否则投递永远当它是 undefined 而干跑。
      const dryRun = plan.dryRun !== false
      if (onlyChatId) {
        const one = list.find((b) => String(b.chatId) === String(onlyChatId))
        if (!one) return { skipped: 'nochat', chatId: onlyChatId }
        return tickOne(one, buckets, t, force, dryRun, fresh, plan.biliWeight !== false, !!opts?.followup)
      }
      const results = []
      for (const b of list) {
        try {
          results.push(await tickOne(b, buckets, t, force, dryRun, fresh, plan.biliWeight !== false))
        } catch (e) {
          log('抽卡出错（' + b?.chatId + '）：' + (e?.message ?? e))
          results.push({ chatId: b?.chatId, error: String(e?.message ?? e) })
        }
      }
      return { at: t, count: list.length, results }
    } finally {
      busy = false
    }
  }

  function start(tickMinutes = 5) {
    stop()
    const ms = Math.max(30_000, Math.round((Number(tickMinutes) || 5) * 60_000))
    timer = setInterval(() => {
      tick().catch((e) => log('抽卡出错：' + (e?.message ?? e)))
    }, ms)
    timer.unref?.()
    return ms
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { tick, start, stop, get running() { return !!timer } }
}