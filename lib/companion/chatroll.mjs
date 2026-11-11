/**
 * 聊天强制事件（哥哥 11-11）：跟「什么时候开口」的事件池不是一回事——
 * 这个是**每一轮聊天**都掷一次的，命中了就往这轮提示词里塞一句话，
 * 比如「这轮必须发个表情包，除非做不到」。掷不到就一个字都不塞。
 *
 * 每条：{ id, label, chance(0-100), enabled, builtin, gate }
 *   - builtin 那条（表情包）是固定参考，界面上不给删；
 *   - gate === 'voice' 的那条要先探本地嗓子在不在线，不在线这轮跳过。
 */
export const ROLL_MAX = 12
export const LABEL_MAX = 60

/** 内置那条：固定参考，不参与迁移，也不许删 */
export const MEME_ROLL = {
  id: 'meme',
  label: '这轮必须发个表情包，除非做不到',
  chance: 33,
  enabled: true,
  builtin: true,
  gate: '',
}

const s = (v, n) => String(v ?? '').trim().slice(0, n)
const clampPct = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0
}

/** 老配置（memeChance / voiceChance 两个 0-1 的数字）转成列表 */
function migrate(legacy) {
  const mc = legacy?.memeChance
  const vc = legacy?.voiceChance
  const memeChance = Number.isFinite(Number(mc)) && mc !== null && mc !== '' ? Number(mc) : 0.33
  const voiceChance = Number.isFinite(Number(vc)) && vc !== null && vc !== '' ? Number(vc) : 0.1
  const out = [{
    ...MEME_ROLL,
    chance: clampPct(memeChance * 100),
    enabled: memeChance > 0,
  }]
  if (voiceChance > 0) {
    out.push({
      id: 'voice',
      label: '这轮必须发一条语音，除非做不到',
      chance: clampPct(voiceChance * 100),
      enabled: true,
      builtin: false,
      gate: 'voice',
    })
  }
  return out
}

/**
 * 洗一遍。raw 不是数组（老配置从没存过）就走迁移；
 * 存过就用存的，但表情包那条永远在（缺了就补回默认）。
 */
export function normalizeRolls(raw, legacy = {}, opts = {}) {
  const ensureMeme = opts.ensureMeme !== false
  if (!Array.isArray(raw)) return migrate(legacy)
  const out = []
  const seen = new Set()
  for (const it of raw.slice(0, ROLL_MAX)) {
    if (!it || typeof it !== 'object') continue
    const id = s(it.id, 32).replace(/[^0-9A-Za-z_-]/g, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = s(it.label, LABEL_MAX)
    out.push({
      id,
      label: label || (id === 'meme' ? MEME_ROLL.label : ''),
      chance: clampPct(it.chance),
      enabled: it.enabled !== false,
      builtin: id === 'meme',
      gate: s(it.gate, 16) === 'voice' ? 'voice' : '',
    })
  }
  if (!seen.has('meme') && ensureMeme) out.unshift({ ...MEME_ROLL })
  return out
}

/** 活着的：开着、有概率、有词 */
export function isLiveRoll(r) {
  return !!r && r.enabled !== false && Number(r.chance) > 0 && String(r.label || '').trim() !== ''
}

/**
 * 每轮掷一次：每条独立掷自己的百分比；中了多条只算一条（概率大的优先，平手按列表顺序）。
 * 一条都没中 → null（这轮不塞任何东西）。
 */
export function pickRoll(rolls, rnd = Math.random) {
  const live = normalizeRolls(Array.isArray(rolls) ? rolls : [], {}, { ensureMeme: false }).filter(isLiveRoll)
  let best = null
  for (const r of live) {
    if (rnd() * 100 < Number(r.chance)) {
      if (!best || Number(r.chance) > Number(best.chance)) best = r
    }
  }
  return best
}

/** 轮到这轮该塞进提示词的那一句（没中返回空串，一个字都不塞） */
export function rollLine(hit) {
  const text = String(hit?.label || '').trim()
  return text ? '[本轮] ' + text : ''
}

/** 新加一条时的默认形状（id 由调用方给，或者这儿随手生一个） */
export function newRoll(seed = Date.now().toString(36)) {
  return {
    id: 'r' + String(seed).replace(/[^0-9a-z]/gi, '').slice(-6),
    label: '',
    chance: 20,
    enabled: true,
    builtin: false,
    gate: '',
  }
}