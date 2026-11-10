/**
 * 积分流水（权重账本）
 * ============================================================================
 * 哥哥 11-10 要的：所有积分变化都要能查——哪一拍涨了多少、哪句话/哪一轮扣了多少、
 * 她给自己打了多少分补回来多少、抽中事件加了多少。拍子多，界面按小时折叠。
 *
 * 一行 = 一笔：
 *   { at, chatId, kind, delta, w0, w1, note, score, inbound, event, origin }
 *   kind: 'tick'（每拍，没到点也记，delta=0）/ 'rise'（这一拍涨了多少）
 *       / 'spend'（一轮结束扣多少）/ 'settle'（评分补/追扣）/ 'bonus'（抽中事件加分）
 *
 * 只追加，不整份重写；长了就滚（上限 8MB / 60 天）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEDGER_FILE = 'ledger.jsonl'
export const LEDGER_MAX_BYTES = 8 * 1024 * 1024
export const LEDGER_KEEP_DAYS = 60
const KEEP_ROWS = 40000

const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10

export function ledgerPath(home) {
  return join(home, LEDGER_FILE)
}

function rollIfBig(home) {
  const p = ledgerPath(home)
  try {
    if (!existsSync(p) || statSync(p).size <= LEDGER_MAX_BYTES) return
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const floor = Date.now() - LEDGER_KEEP_DAYS * 86400_000
    const kept = lines.slice(-KEEP_ROWS).filter((l) => {
      try { return (Number(JSON.parse(l).at) || 0) >= floor } catch { return false }
    })
    writeFileSync(p, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
  } catch { /* 滚不动就算了，下笔再试 */ }
}

/** 记一笔。失败不抛（记账不该拖垮一拍） */
export function appendLedger(home, rec) {
  try {
    const row = {
      at: Number(rec?.at) || Date.now(),
      chatId: String(rec?.chatId || ''),
      kind: String(rec?.kind || ''),
      delta: round1(rec?.delta),
    }
    if (Number.isFinite(Number(rec?.w0))) row.w0 = round1(rec.w0)
    if (Number.isFinite(Number(rec?.w1))) row.w1 = round1(rec.w1)
    if (rec?.note) row.note = String(rec.note).slice(0, 120)
    if (Number.isFinite(Number(rec?.score))) row.score = round1(rec.score)
    if (rec?.inbound === true) row.inbound = true
    if (rec?.event) row.event = String(rec.event).slice(0, 40)
    if (rec?.origin) row.origin = String(rec.origin).slice(0, 20)
    mkdirSync(home, { recursive: true })
    appendFileSync(ledgerPath(home), JSON.stringify(row) + '\n', 'utf8')
    rollIfBig(home)
    return row
  } catch {
    return null
  }
}

/** 读流水（新→旧）。chatId 空 = 全部会话 */
export function readLedger(home, { chatId = '', since = 0, limit = 0 } = {}) {
  const p = ledgerPath(home)
  if (!existsSync(p)) return []
  let lines = []
  try { lines = readFileSync(p, 'utf8').split('\n') } catch { return [] }
  const want = String(chatId || '')
  const out = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]
    if (!l) continue
    let row
    try { row = JSON.parse(l) } catch { continue }
    if (!row || !row.at) continue
    if (since && Number(row.at) < since) break
    if (want && String(row.chatId) !== want) continue
    out.push(row)
    if (limit && out.length >= limit) break
  }
  return out
}

/**
 * 按小时折叠（新→旧）。每小时一行：
 *   { hour: '09', at, start, end, delta, rise, spend, settle, bonus, ticks, sends, rows: [...] }
 */
export function hourlyBuckets(rows) {
  const map = new Map()
  for (const r of rows) {
    const d = new Date(Number(r.at))
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`
    let b = map.get(key)
    if (!b) {
      b = {
        key,
        hour: key.slice(11),
        at: Number(r.at),
        start: Number(r.w0 ?? r.w1 ?? 0),
        end: Number(r.w1 ?? r.w0 ?? 0),
        delta: 0, rise: 0, spend: 0, settle: 0, bonus: 0, ticks: 0, sends: 0,
        rows: [],
      }
      map.set(key, b)
    }
    b.rows.push(r)
    b.delta = round1(b.delta + Number(r.delta || 0))
    if (r.kind === 'rise') b.rise = round1(b.rise + Number(r.delta || 0))
    else if (r.kind === 'spend') { b.spend = round1(b.spend + Number(r.delta || 0)); b.sends += 1 }
    else if (r.kind === 'settle') b.settle = round1(b.settle + Number(r.delta || 0))
    else if (r.kind === 'bonus') b.bonus = round1(b.bonus + Number(r.delta || 0))
    if (r.kind === 'tick' || r.kind === 'rise') b.ticks += 1
    const a = Number(r.at)
    if (a <= b.at) { b.at = a; if (Number.isFinite(Number(r.w0))) b.start = Number(r.w0) }
    if (a >= (b.lastAt || 0)) { b.lastAt = a; b.end = Number(r.w1 ?? r.w0 ?? b.end) }
  }
  const list = [...map.values()]
  // 一小时内的行倒过来（新的在上），跟别处一致
  for (const b of list) b.rows.reverse()
  list.sort((x, y) => y.lastAt - x.lastAt)
  return list.map((b) => {
    delete b.lastAt
    return b
  })
}
