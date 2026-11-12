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
import { riseByTick, canSpeak, triggerChance, settle, addBonus, W_FLOOR_DEFAULT } from './weight.mjs'
import { drawEvent, mergePool } from './events.mjs'
import { canTrigger, pruneWindow } from './limit.mjs'
import { readTaste, bumpTaste } from './taste.mjs'
import { readBuckets, writeBuckets, bucketOf, normalizeBucket, appendHistory, dayKeyOf, agoText } from './state.mjs'
import { periodOf, inQuiet } from './period.mjs'
import { buildHint } from './prompt.mjs'
import { peekInbox, dropInbox, formatItem } from './inbox.mjs'
import { appendLedger } from './ledger.mjs'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 每拍记账：这一拍为什么没发、p 是多少、roll 是多少。
 * history.jsonl 只记「发出去的」，光看它没法确认掷骰有没有在拦人（哥哥 11-04 问过）。
 * 「没到点」那种不记，不然一分钟一行全是废话。
 */
const TICK_LOG = 'ticks.jsonl'
const TICK_LOG_MAX = 512 * 1024
/** 流水里给「这一拍为什么没动」配个人话 */
const SKIP_NOTE = {
  notyet: '没到点',
  'binding-off': '这条关了',
  quiet: '免打扰',
  chatting: '他正在聊',
  limit: '限流',
  below: '没到阈值',
  roll: '掷骰没过',
  noevent: '没抽到事件',
  nochat: '没有会话',
}
function skipNote(k) {
  return SKIP_NOTE[k] || String(k || '')
}
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
  /** () => { enabled, dryRun, bindings: [{ chatId, enabled, profile }], globals } */
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
  /** QQ 机器人是不是整个关着——关着就一拍都不跑。 */
  isQqOff = () => false,
  log = () => {},
  now = () => Date.now(),
  rnd = Math.random,
}) {
  let timer = null
  let busy = false

  /** 跑一个会话。b = { chatId, enabled, profile } */
  async function tickOne(b, buckets, t, force = false, dryRun = true, fresh = false, biliWeight = true, followup = false, globals = {}) {
    const profile = b.profile || {}
    const home = getHome()
    const chatId = String(b.chatId || '')
    if (!chatId) return { chatId, skipped: 'nochat' }

    const state = bucketOf(buckets, chatId)
    const out = { at: t, chatId, profileId: profile.id || '', w0: state.w }
    buckets[chatId] = state
    let w = state.w

    // ⓪.0 这条绑定自己关了：这一拍什么都没发生——不结算分数、不涨、不抽卡、不记账。
    //     （哥哥 11-11：两个群开关一直是关的，权重却还在涨。根因是「评分结算」排在
    //      开关判断之前：关掉的会话手里攒着上一轮的分，一拍就按分补/追扣，权重就动了。
    //      关掉就该彻底不动，分留着，等再打开时再结。）
    if (b.enabled === false) {
      state.w = w
      writeBuckets(home, buckets)
      return { ...out, skipped: 'binding-off' }
    }

    // ⓪.0b QQ 机器人整个关着（哥哥 11-11 的总开关）：不涨、不抽、不投递、不记账。
    if (typeof isQqOff === 'function' && isQqOff()) {
      state.w = w
      writeBuckets(home, buckets)
      return { ...out, skipped: 'qq-off' }
    }

    // ⓪ 分数结算不在这儿了（哥哥 11-11：加扣分当场算，不等下一拍）。
    //    那一轮结束时 QQ 侧 turn/end 会把「扣一格 + 按分补/追」一次做完，
    //    免得分数跨拍、跨段、被 consumedScoreAt 这些状态绕出 bug。
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
      // 积分流水：没到点的那一拍也要留一笔（delta=0），不然一小时的「拍了几次」对不上。
      // 关掉的那条不记——它根本没在拍，记了就像「关了还在走」（哥哥 11-11）。
      if (extra.skipped === 'binding-off' || extra.skipped === 'qq-off') {
        /* 不记 */
      } else if (extra.skipped === 'notyet') {
        appendLedger(home, { at: t, chatId, kind: 'tick', delta: 0, w0: state.w, w1: state.w, note: '没到点' })
      } else if (extra.skipped) {
        appendLedger(home, { at: t, chatId, kind: 'tick', delta: 0, w0: state.w, w1: state.w, note: skipNote(extra.skipped) })
      }
      return { ...out, ...extra }
    }

    // ① 这条绑定自己关了：整条停摆（已经在 ⓪.0 判过，这里只是兜底）。
    //    （哥哥 11-09：以前关掉开关照样涨权重，等于关了还在攒，一开就喷出来。）
    if (b.enabled === false) return save({ skipped: 'binding-off' })

    // ①.5 还没到点？每个会话按自己那套的 tickMinutes 走，手动跑不吃这条。
    // 容差给到 5 秒：定时器常常差几十毫秒提前醒来，卡太死会让这一拍白跑，
    // 下一次又得等一整轮——看起来就是「每分钟抽卡其实两分钟才动一次」。
    const gap = Number(profile.tickMinutes || 5) * 60_000
    if (!force && !fresh && !followup && Number(state.lastTickAt) && t - Number(state.lastTickAt) < gap - 5000) {
      return save({ skipped: 'notyet' })
    }
    state.lastTickAt = t

    // ② 免打扰：这段时间既不发、也**不涨权重**（哥哥 11-08：干脆停止计时）。
    //    所以必须在涨之前判——不然一晚上攒到顶，早上七点一到就立刻开口。
    const d = new Date(t)
    if (!force && inQuiet(d, profile.quiet)) return save({ skipped: 'quiet' })

    // ③ 每次抽卡涨一点（哥哥 11-04 改的：不再按小时流逝算）
    const wRise0 = w
    w = riseByTick(w, profile.risePerTick, profile.wFloor)
    state.lastRiseAt = t
    if (w !== wRise0) {
      appendLedger(home, { at: t, chatId, kind: 'rise', delta: w - wRise0, w0: wRise0, w1: w, note: '这一拍' })
    }

    // ④ 跨天
    const dk = dayKeyOf(t)
    if (state.dayKey !== dk) {
      state.dayKey = dk
      state.todayCount = 0
    }

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
    // ⑤ 限流（哥哥 11-09：定时话头不受它限制——它本来就是她主动排的，一天有单独上限）
    state.window = pruneWindow(state.window, profile.limitHours, t)
    if (!force && !followup && !canTrigger(state.window, profile.limitHours, profile.limitMax, t)) return save({ skipped: 'limit' })

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
      if (!force && !canSpeak(w, profile.threshold, profile.wFloor)) return save({ skipped: 'below' })

      // ⑦ 掷骰（手动是「一定要发」，不掷）
      if (!force) {
        p = triggerChance(w, profile.threshold, profile.triggerPmax, profile.wFloor)
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

    // ⑨ 事件加分（哥哥 11-11：一段对话只加一次——扣分改成按段算，加分就得按段算，
    //    计次口径必须对称，不能「扣按回合、加按抽中」）
    // 11-11：抽中就按事件那份加分，数值全交给设置页（哥哥：「其他交给数值」）。
    // 「同一段对话只加一次」那套跟着对话间隔一起拆掉了。
    const bonus = Number(ev.bonus) || 0
    const w1 = addBonus(w, bonus, profile.wFloor)
    out.event = ev.id
    out.eventLabel = ev.label
    out.bonus = bonus
    out.w1 = w1
    if (bonus) {
      appendLedger(home, { at: t, chatId, kind: 'bonus', delta: w1 - w, w0: w, w1, event: ev.id, note: ev.label || ev.id })
    }

    // ⑩ 准备（刷视频会真去搜；别的先给话头）
    let prepared = []
    try {
      // 配置分两层：globals 是整份配置上的键（兴趣关键词、视频筛选参数），
      // profile 是这套模式自己的（阈值、事件池）。漏了 globals 就会一直走热门兜底。
      if (!followup && pending.length === 0) prepared = (await prepare(ev, { cfg: { ...globals, ...profile, dryRun, taste: readTaste(home) }, state, chatId, now: t })) || []
    } catch (e) {
      out.prepareError = String(e?.message ?? e)
    }

    // ⑪ 话头
    const text = buildHint({
      // 话头模板在整份配置上（设置页「话头」那张卡里改），不跟着单套配置走
      cue: globals?.cue || null,
      kind: pending.length ? 'inbox' : followup ? 'followup' : 'bubble',
      modeLabel: profile.name || (profile.mode === 'active' ? '主动档' : '日常档'),
      countToday: state.todayCount + 1,
      lastAgoText: state.lastTriggerAt ? agoText(t - state.lastTriggerAt) : '',
      periodLabel: periodOf(d).label,
      w: w1,
      event: followup ? null : ev,
      candidates: pending.length ? pending.map((x) => ({ text: formatItem(x, t) })) : prepared,
      chatId,
      chatLabel: String(labelOf(chatId) || ''),
      // 追聊 / 来料各带一句临时备注；平时空着（哥哥 11-11：这轮干嘛只看事件页那个词）
      note: followup
        ? '（是你自己早先说想这会儿再聊的，不用解释为什么是这个点。）'
        : pending.length ? '他那边有点动静：' : '',
    })

    // ⑫ 投递
    let sent
    try {
      // 来料那一段标成 inbox：biliWeight 关掉时，那一段既不扣分也不结算（两边同一个口径）。
      // 追聊单独标一格：回合结算那边要认出来（追聊不扣分）
      sent = await deliver({ chatId, text, event: ev, origin: pending.length ? 'inbox' : followup ? 'followup' : 'bubble', cfg: { ...profile, dryRun } })
    } catch (e) {
      sent = { ok: false, mode: 'error', error: String(e?.message ?? e) }
    }
    sent = sent || { ok: false, mode: 'none' }
    out.deliver = sent
    if (pending.length && sent.ok !== false) dropInbox(home, chatId, pending.map((x) => x.key))

    // ⑬ 释放（先按 5 分、系数 1 扣；她这轮写的 [SCORE n] 晚一点到，下一拍在 ⓪ 补差额）
    // ⑬ 不再在这儿扣：这一轮的消耗在 QQ 那边回合结束时已经扣过了（11-10 改的口径）。
    const w2 = w1
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
    // 口味账要等下一拍她打完分才记，所以先把这轮推过去的「谁 + 哪个词」留下来
    if (targets.length) {
      state.lastPicks = (Array.isArray(prepared) ? prepared : []).slice(0, 5).map((c) => ({
        bvid: String(c?.bvid ?? ''),
        upMid: String(c?.upMid ?? ''),
        kw: String(c?.kw ?? ''),
      }))
    }
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
        return tickOne(one, buckets, t, force, dryRun, fresh, plan.biliWeight !== false, !!opts?.followup, plan.globals || {})
      }
      const results = []
      for (const b of list) {
        try {
          results.push(await tickOne(b, buckets, t, force, dryRun, fresh, plan.biliWeight !== false, false, plan.globals || {}))
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