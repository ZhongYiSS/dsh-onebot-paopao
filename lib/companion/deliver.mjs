/**
 * 投递 —— 把话头送到「选中的那个会话」。
 * ============================================================================
 * 两条路：
 *   dryRun = true  → 只写日志，不真发（V1 默认，安全）
 *   dryRun = false → 找 QQ 插件暴露的 onebot 服务：onebot.dispatch(chatId, text)
 *
 * 没接上就老老实实返回失败，不假装发成功。
 * ============================================================================
 */

import { resolveOnebot } from './bridge-link.mjs'

export function createDeliverer({ ctx, log = () => {} }) {
  return async function deliver({ chatId, text, cfg, origin }) {
    if (cfg.dryRun !== false) {
      log('[干跑] 本该发给 ' + (chatId || '（没选会话）') + '：' + String(text).slice(0, 120).replace(/\n/g, ' / '))
      return { ok: true, mode: 'dry' }
    }
    if (!chatId) return { ok: false, mode: 'none', error: '没选会话（设置页里挑一个）' }

    const onebot = resolveOnebot(ctx)
    if (!onebot || typeof onebot.dispatch !== 'function') {
      return { ok: false, mode: 'none', error: 'QQ 插件没接上（它还没暴露 onebot 服务）' }
    }
    // QQ 掉线的时候不硬发——发了也是丢进虚空，记一笔让人看得见。
    if (typeof onebot.status === 'function') {
      const st = onebot.status()
      if (st && st.connected === false) {
        return { ok: false, mode: 'qq', error: 'QQ 掉线了（' + (st.selfId ? st.selfId + ' ' : '') + '还没连回来）' }
      }
    }
    // role 只认 'admin' / 'member'；陪伴是替主人递话头，按 admin 走。
    // origin 一路带到 QQ 那边：抽卡='bubble'、B站 来料='inbox'（来料不动账时整段不扣不结）
    // 2026-11-12：追聊原来被折成 'bubble'，于是''他找上来''的判断、''追聊不扣分''那一支全失效
    const got = await onebot.dispatch(chatId, text, 'admin', '本鱼',
      origin === 'inbox' ? 'inbox' : origin === 'followup' ? 'followup' : 'bubble')
    // 被 [HOLD] 拦下、渠道路由失败都会走到这：如实回报，tick 才不会把这个来料当已发丢掉。
    if (got && got.ok === false) return { ok: false, mode: 'qq', error: String(got.error || got.reason || '没发出去'), held: !!got.held }
    return { ok: true, mode: 'qq' }
  }
}
