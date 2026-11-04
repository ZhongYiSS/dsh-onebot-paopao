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
import { riseByTick, canSpeak, triggerChance, release, addBonus } from './weight.mjs'
import { drawEvent, mergePool } from './events.mjs'
import { canTrigger, pruneWindow } from './limit.mjs'
import { readBuckets, writeBuckets, bucketOf, normalizeBucket, appendHistory, dayKeyOf, agoText } from './state.mjs'
import { periodOf, inQuiet } from './period.mjs'
import { buildHint } from './prompt.mjs'

export function createTicker({
  /** () => { enabled, dryRun, bindings: [{ chatId, enabled, profile }] } */
  getPlan,
  getHome,
  prepare = async () => [],
  deliver = async () => ({ ok: false, mode: 'none' }),
  /** 他是不是正在聊？返回 true = 别打扰。 */
  idleCheck = async () => true,
  log = () => {},
  now = () => Date.now(),
  rnd = Math.random,
}) {
  let timer = null
  let busy = false

  /** 跑一个会话。b = { chatId, enabled, profile } */
  async function tickOne(b, buckets, t, force = false, dryRun = true) {
    const profile = b.profile || {}
    const home = getHome()
    const chatId = String(b.chatId || '')
    if (!chatId) return { chatId, skipped: 'nochat' }

    const state = bucketOf(buckets, chatId)
    const out = { at: t, chatId, profileId: profile.id || '', w0: state.w }
    buckets[chatId] = state
    let w = state.w
    const save = (extra = {}) => {
      state.w = typeof extra.w === 'number' ? extra.w : w
      writeBuckets(home, buckets)
      return { ...out, ...extra }
    }

    // ①.5 还没到点？每个会话按自己那套的 tickMinutes 走，手动跑不吃这条。
    // （放在上涨之前：没轮到的这一拍不涨，涨只认真跑过的那一拍。）
    const gap = Number(profile.tickMinutes || 5) * 60_000
    if (!force && Number(state.lastTickAt) && t - Number(state.lastTickAt) < gap - 1500) {
      return save({ skipped: 'notyet' })
    }
    state.lastTickAt = t

    // ① 每次抽卡涨一点（哥哥 11-04 改的：不再按小时流逝算）
    w = riseByTick(w, profile.risePerTick)
    state.lastRiseAt = t

    // ② 跨天
    const dk = dayKeyOf(t)
    if (state.dayKey !== dk) {
      state.dayKey = dk
      state.todayCount = 0
    }

    // ③ 这条绑定自己关了
    if (b.enabled === false) return save({ skipped: 'binding-off' })

    // ④ 免打扰
    const d = new Date(t)
    if (inQuiet(d, profile.quiet)) return save({ skipped: 'quiet' })

    // ④.5 他正在聊就别插嘴（沉默够久才算「没在聊」）
    if (Number(profile.idleMinutes) > 0) {
      try {
        const quietEnough = await idleCheck({ chatId, minutes: Number(profile.idleMinutes), now: t })
        if (quietEnough === false) return save({ skipped: 'chatting' })
      } catch (e) {
        out.idleError = String(e?.message ?? e)
      }
    }

    // ⑤ 滑动窗口
    state.window = pruneWindow(state.window, profile.limitHours, t)
    if (!canTrigger(state.window, profile.limitHours, profile.limitMax, t)) return save({ skipped: 'limit' })

    // ⑥ 阈值
    if (!canSpeak(w, profile.threshold)) return save({ skipped: 'below' })

    // ⑦ 掷骰
    const p = triggerChance(w, profile.threshold, profile.triggerPmax)
    const roll = rnd()
    if (roll >= p) return save({ skipped: 'roll', p, roll })

    // ⑧ 抽事件
    const pool = mergePool(profile.pool)
    const ev = drawEvent(pool, rnd)
    if (!ev) return save({ skipped: 'noevent' })

    // ⑨ 事件加分
    const w1 = addBonus(w, ev.bonus)
    out.event = ev.id
    out.eventLabel = ev.label
    out.w1 = w1

    // ⑩ 准备（刷视频会真去搜；别的先给话头）
    let prepared = []
    try {
      prepared = (await prepare(ev, { cfg: { ...profile, dryRun }, state, chatId, now: t })) || []
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
      event: ev,
      candidates: prepared,
      chatId,
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

    // ⑬ 释放（V1 没有会话反馈分数，先按 50 算；以后接上兴趣分再改）
    const score = Number.isFinite(Number(sent.score)) ? Number(sent.score) : 50
    const w2 = release(w1, score, { base: profile.releaseBase, span: profile.releaseSpan })
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
        return tickOne(one, buckets, t, force, dryRun)
      }
      const results = []
      for (const b of list) {
        try {
          results.push(await tickOne(b, buckets, t, force, dryRun))
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