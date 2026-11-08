/**
 * 收件箱 —— 外面的来料先放这儿，什么时候开口由节拍（tick）统一决定。
 * ============================================================================
 * 为什么要有它：B站 私信 / 评论 / @ 以前是直接在监看里 deliver 的，
 * 绕过了免打扰、限流和权重 —— 半夜来条私信她也会说话。
 * 现在监看只往这儿塞，节拍在门控都过了之后才取走。
 *
 * 文件：$DSH_HOME/bubble/inbox.json
 * 形状：{ "<chatId>": [ { key, kind, who, text, url, at } ] }
 * 去重看 key；同一会话最多留 20 条，超了丢最老的。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'inbox.json'
const MAX_PER_CHAT = 20

function fileOf(home) {
  return path.join(home, FILE)
}

function readAll(home) {
  try {
    const raw = fs.readFileSync(fileOf(home), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function writeAll(home, all) {
  try {
    fs.mkdirSync(home, { recursive: true })
    const tmp = fileOf(home) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8')
    fs.renameSync(tmp, fileOf(home))
  } catch {
    /* 写不进去就算了，下一拍还在内存里等不到就算了——不能因为这个崩 */
  }
}

/** 塞进来的东西：{ kind: 'dm'|'reply'|'at', who, text, url, at } */
export function pushInbox(home, chatId, items) {
  const id = String(chatId || '')
  if (!id || !Array.isArray(items) || items.length === 0) return 0
  const all = readAll(home)
  const list = Array.isArray(all[id]) ? all[id] : []
  let added = 0
  for (const it of items) {
    const key = String(it?.key || it?.kind + ':' + (it?.url || '') + ':' + (it?.at || '') + ':' + (it?.text || '').slice(0, 40))
    if (list.some((x) => x.key === key)) continue
    list.push({ key, kind: String(it?.kind || 'dm'), who: String(it?.who || ''), text: String(it?.text || ''), url: String(it?.url || ''), at: Number(it?.at) || Date.now() })
    added += 1
  }
  all[id] = list.slice(-MAX_PER_CHAT)
  writeAll(home, all)
  return added
}

/** 只看不取（门控没过的时候不能把料弄丢） */
export function peekInbox(home, chatId) {
  const list = readAll(home)[String(chatId || '')]
  return Array.isArray(list) ? list : []
}

/** 真发出去了才拿走 */
export function dropInbox(home, chatId, keys) {
  const id = String(chatId || '')
  const all = readAll(home)
  const list = Array.isArray(all[id]) ? all[id] : []
  const wanted = new Set((keys || []).map(String))
  all[id] = list.filter((x) => !wanted.has(String(x.key)))
  if (all[id].length === 0) delete all[id]
  writeAll(home, all)
  return list.length - (all[id]?.length || 0)
}

const KIND_LABEL = { dm: '私信', reply: '评论回复', at: '@' }

/** 一行话说清「谁·多久前·说了什么」 */
export function formatItem(it, now = Date.now()) {
  const kind = KIND_LABEL[it.kind] || it.kind || '消息'
  const ago = (() => {
    const gap = Math.max(0, now - Number(it.at || 0))
    if (!Number(it.at)) return ''
    if (gap < 60_000) return '刚刚'
    if (gap < 3600_000) return Math.round(gap / 60_000) + ' 分钟前'
    if (gap < 86400_000) return Math.round(gap / 3600_000) + ' 小时前'
    return Math.round(gap / 86400_000) + ' 天前'
  })()
  const head = [kind, it.who].filter(Boolean).join(' · ')
  const tail = it.text ? '：' + String(it.text).slice(0, 160) : ''
  const link = it.url ? '（' + it.url + '）' : ''
  return `${head}${ago ? ' ' + ago : ''}${tail}${link}`
}
