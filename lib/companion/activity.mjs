/**
 * 动作账 —— 点赞 / 投币 / 收藏 / 评论 / 私信 这些「她动手做过的事」也记进同一本账。
 * ============================================================================
 * 为什么：以前只有泡泡主动开口才进 history.jsonl，B站 那边干了什么都不留痕，
 * 「做过的事」只看得见一半。现在动作也写一条，界面上用 kind='bili-act' 区分。
 * 记失败不算数：只有真成功（ok:true）才记。
 * ============================================================================
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendHistory } from './state.mjs'

function home() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * @param action 中文动作名（点赞 / 投币 / 收藏 / 评论 / 私信）
 * @param info   { title?, url?, bvid?, text?, detail? }
 */
export function noteAction(action, info = {}) {
  try {
    const target = {
      title: String(info.title || info.bvid || info.url || ''),
      url: String(info.url || (info.bvid ? 'https://www.bilibili.com/video/' + info.bvid : '')),
      note: String(info.detail || ''),
    }
    appendHistory(join(home(), 'bubble'), {
      kind: 'bili-act',
      chatId: 'bili',
      event: 'bili-act',
      label: action,
      w0: 0,
      w1: 0,
      w2: 0,
      mode: 'bili',
      text: String(info.text || ''),
      targets: target.title || target.note ? [target] : [],
    })
    return true
  } catch {
    return false
  }
}
