/**
 * 别家插件的设置，借陪伴设置页来改。
 * ============================================================================
 * B站：`BILI_FIELDS` 原本是刷B站插件的设置（`$DSH_HOME/bili-duty/config.json`）。
 *   11-04 起泡泡自己有一份 `$DSH_HOME/bubble/bili/config.json`，刷B站 卸了也能用；
 *   面板上的「B站那边」已经撤掉，这组字段只剩 `/api/bubble/ext` 老接口在用。
 * QQ（dsh-onebot-qq）：Config 是 cordis.patch.yml 的静态配置，没有 volatile、也不读
 *   ctx.settings → 只能在内存里就地改 bridge.deps.config（热生效、重启回 yml 值）。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { configPath as pickBiliConfigPath } from './bili-paths.mjs'

const pick = (v, d) => (v === undefined || v === null ? d : v)

/* ---------------------------------- B站 ---------------------------------- */

export const BILI_FIELDS = [
  { key: 'perDay', group: '挑视频', label: '每天挑几条', type: 'num', min: 0, max: 50, step: 1, note: '0 = 不主动挑' },
  { key: 'searchSort', group: '挑视频', label: '搜索排序', type: 'select', options: ['pubdate', 'click', 'dm', 'totalrank'], note: 'pubdate=最新 click=播放 dm=弹幕 totalrank=综合' },
  { key: 'keywords', group: '挑视频', label: '兴趣关键词', type: 'tags', note: '挑视频就按这些词搜；逗号分隔' },
  { key: 'excludeWords', group: '挑视频', label: '排除词', type: 'tags', note: '标题里带这些就不看' },
  { key: 'peakValley', group: '挑视频', label: '峰谷自动刷', type: 'switch', note: '按时间段自动挑' },
  { key: 'noon', group: '挑视频', label: '峰谷 · 中午', type: 'switch', note: '只在开了峰谷时有效' },
  { key: 'night', group: '挑视频', label: '峰谷 · 晚上', type: 'switch', note: '只在开了峰谷时有效' },
  { key: 'manualMax', group: '挑视频', label: '手动跑最多几条', type: 'num', min: 1, max: 20, step: 1 },
  { key: 'autoComment', group: '评论', label: '自动评论并 @', type: 'switch', note: '关着就不会在 B站 底下说话' },
  { key: 'commentPerRound', group: '评论', label: '每轮评论几条', type: 'num', min: 0, max: 20, step: 1 },
  { key: 'mentionName', group: '评论', label: '评论里 @ 谁', type: 'text', note: '留空就不 @' },
  { key: 'dmMode', group: '私信', label: '私信投递', type: 'select', options: ['off', 'only', 'both'], note: 'off=不投 only=只给主人 both=都投' },
  { key: 'dmUid', group: '私信', label: '私信发给谁', type: 'num', min: 0, max: 9999999999, step: 1, note: 'B站 UID' },
  { key: 'dmWatch', group: '私信', label: '私信监听', type: 'switch', note: '定时看有没有人给你发私信' },
  { key: 'dmWatchMinutes', group: '私信', label: '监听间隔（分钟）', type: 'num', min: 1, max: 1440, step: 1 },
  { key: 'transcribe', group: '其他', label: '本地转写', type: 'switch', note: '没字幕时自己转' },
  { key: 'reportLevel', group: '其他', label: '日报形态', type: 'select', options: ['full', 'brief', 'off'] },
]

/** 泡泡自己那份 bili 配置在 bubble/bili，没有才回落到 bili-duty */
export function biliConfigPath(dshHome) {
  return pickBiliConfigPath(dshHome)
}

export function readBili(dshHome) {
  const p = biliConfigPath(dshHome)
  let raw = {}
  try {
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch { raw = {} }
  const fields = BILI_FIELDS.map((f) => ({
    ...f,
    value: normalizeBiliValue(f, raw[f.key], raw),
  }))
  return { available: existsSync(p), path: p, fields, touched: Array.isArray(raw._set) ? raw._set : [] }
}

function normalizeBiliValue(f, v, raw) {
  if (f.type === 'switch') return v === true
  if (f.type === 'num') {
    const n = Number(v)
    if (!Number.isFinite(n)) return f.min ?? 0
    return Math.min(f.max ?? 1e12, Math.max(f.min ?? 0, n))
  }
  if (f.type === 'select') return f.options.includes(v) ? v : f.options[0]
  if (f.type === 'tags') return Array.isArray(v) ? v.map(String) : []
  return v === undefined || v === null ? '' : String(v)
}

/** 写进去：合并 + 把改过的键记到 `_set`（bili 的 loadCfg 认这个）。 */
export function writeBili(dshHome, patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: '没有要改的' }
  const p = biliConfigPath(dshHome)
  let raw = {}
  try {
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch { return { ok: false, error: 'B站 的 config.json 读不动' } }

  const changed = []
  for (const f of BILI_FIELDS) {
    if (!(f.key in patch)) continue
    const v = normalizeBiliValue(f, patch[f.key], raw)
    raw[f.key] = v
    changed.push(f.key)
  }
  if (!changed.length) return { ok: true, changed: [] }

  const set = new Set(Array.isArray(raw._set) ? raw._set.map(String) : [])
  for (const k of changed) set.add(k)
  raw._set = [...set]

  try {
    const tmp = p + '.tmp-bubble'
    writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
    renameSync(tmp, p)
  } catch (e) {
    return { ok: false, error: '写不进去：' + (e?.message ?? e) }
  }
  return { ok: true, changed, fields: readBili(dshHome).fields }
}

/* ---------------------------------- QQ ----------------------------------- */

export const QQ_FIELDS = [
  { key: 'promptExtra', group: '人设', label: '额外人设', type: 'textarea', note: '原样插进每轮提示词开头；留空 = 不加（情绪、口癖、自称都写这里）' },
  { key: 'memeDir', group: '人设', label: '表情包目录', type: 'text', reveal: true, note: '往里丢图就能用；文件名就是内容' },
  { key: 'memeChance', group: '互动', label: '表情包概率', type: 'num', min: 0, max: 1, step: 0.01, note: '0.33 = 每轮三成' },
  { key: 'voiceChance', group: '互动', label: '语音概率', type: 'num', min: 0, max: 1, step: 0.01 },
  { key: 'debounceMs', group: '互动', label: '防抖合并（毫秒）', type: 'num', min: 0, max: 60000, step: 100, note: '连着几条并成一轮' },
  { key: 'debounceBusyWait', group: '互动', label: '忙的时候等一等', type: 'switch', note: '正在回上一条就先排队' },
  // 「群里必须 @ 才回」不在这里——它在 QQ 设置面板的权限组，两处同键会打架。
  { key: 'groupKeywords', group: '群聊', label: '群聊关键词', type: 'tags', note: '听到这些词才会开口；逗号分隔' },
  { key: 'groupKeywordCooldownMs', group: '群聊', label: '关键词冷却（毫秒）', type: 'num', min: 0, max: 3600000, step: 1000 },
  { key: 'proactiveMaxFollowUps', group: '主动', label: '最多追几次', type: 'num', min: 0, max: 10, step: 1 },
  { key: 'proactiveFollowUpMs', group: '主动', label: '追问间隔（毫秒）', type: 'num', min: 5000, max: 600000, step: 1000 },
  { key: 'openChatDefaultMs', group: '主动', label: '随意聊默认多久', type: 'num', min: 60000, max: 86400000, step: 60000, note: '毫秒；默认 600000 = 10 分钟' },
  { key: 'ownerQQ', group: '其他', label: '主人 QQ', type: 'text' },
  { key: 'visionModel', group: '识图', label: '视觉模型', type: 'text', note: '先想再说的模型要留足 token，否则正文是空的' },
  { key: 'visionBaseUrl', group: '识图', label: '视觉网关', type: 'text' },
  { key: 'visionApiKeyEnv', group: '识图', label: '凭证名', type: 'text', note: '写 .credentials.yaml 里的键名，不写 key 本身' },
  { key: 'visionMaxTokens', group: '识图', label: '输出上限 tokens', type: 'num', min: 100, max: 8000, step: 100 },
  { key: 'videoVisionModel', group: '看视频', label: '视觉模型', type: 'text', note: '留空 = 跟随「识图」那套（用这台机器上配的模型）；填本地模型名也行' },
  { key: 'videoVisionBaseUrl', group: '看视频', label: '视觉网关', type: 'text', note: '留空 = 跟随「识图」；本地就填 http://127.0.0.1:端口/v1' },
  { key: 'videoVisionApiKeyEnv', group: '看视频', label: '凭证名', type: 'text', note: '留空 = 跟随「识图」；写 .credentials.yaml 里的键名，不写 key 本身' },
  { key: 'videoVisionFallbackModel', group: '看视频', label: '备选模型', type: 'text', note: '留空 = 跟随「识图」的备选；主模型正文空了才换它' },
  { key: 'videoVisionMaxTokens', group: '看视频', label: '单张图 token 上限', type: 'num', min: 1000, max: 32000, step: 500, note: '先想再说的模型要给足，不然正文是空的' },
  { key: 'videoVisionTimeoutMs', group: '看视频', label: '单张图超时（毫秒）', type: 'num', min: 10000, max: 600000, step: 5000 },
  { key: 'videoGrids', group: '看视频', label: '最多几张九宫格（平时）', type: 'num', min: 1, max: 10, step: 1 },
  { key: 'videoFrames', group: '看视频', label: '平时额外抠几帧', type: 'num', min: 0, max: 10, step: 1 },
  { key: 'videoDeepGrids', group: '看视频', label: '最多几张九宫格（仔细看）', type: 'num', min: 1, max: 10, step: 1 },
  { key: 'videoDeepFrames', group: '看视频', label: '仔细看时额外抠几帧', type: 'num', min: 0, max: 10, step: 1 },
  { key: 'videoCacheDays', group: '看视频', label: '证据缓存几天', type: 'num', min: 0, max: 30, step: 1 },
  { key: 'videoWorkDays', group: '看视频', label: '视频文件留几天', type: 'num', min: 1, max: 90, step: 1, note: '过了自动删；证据缓存不受影响' },
  { key: 'videoAsr', group: '看视频', label: '没字幕时听声音', type: 'switch', note: '用本机 whisper 转写（离线），有字幕轨就不转' },
  { key: 'videoAsrMaxSec', group: '看视频', label: '最多转多少秒', type: 'num', min: 30, max: 3600, step: 30, note: '一秒钟音频约 0.3 秒 CPU；超出的部分不转' },
]

export function readQq(onebot) {
  let snap = null
  try {
    if (onebot && typeof onebot.getConfig === 'function') snap = onebot.getConfig()
  } catch { snap = null }
  if (!snap || typeof snap !== 'object') return { available: false, hint: 'QQ 插件还没接上（或没刷新）', fields: [] }
  const fields = QQ_FIELDS.map((f) => ({ ...f, value: normalizeQqValue(f, snap[f.key]) }))
  return { available: true, fields }
}

/** 读出来给人看的：没设过就保持 undefined，别拿 min 冒充默认（会把「没配置」显示成 1 张宫格）。 */
function normalizeQqValue(f, v) {
  if (f.type === 'switch') return v === true
  if (f.type === 'num') {
    if (v === undefined || v === null || v === '') return undefined
    const n = Number(v)
    if (!Number.isFinite(n)) return undefined
    return Math.min(f.max ?? 1e12, Math.max(f.min ?? 0, n))
  }
  if (f.type === 'tags') return Array.isArray(v) ? v.map(String) : []
  return v === undefined || v === null ? '' : String(v)
}

/**
 * 写入用的严格转换：拿不出有效值就返回 undefined，让调用方跳过这个键。
 * （以前这里把空值夹到 min，输入框失焦一次就能把整套配置写成最小值。）
 */
function writeValue(f, v) {
  if (f.type === 'switch') return v === true || v === 'true'
  if (f.type === 'num') {
    if (v === '' || v === null || v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n)) return undefined
    return Math.min(f.max ?? 1e12, Math.max(f.min ?? 0, n))
  }
  if (f.type === 'tags') {
    if (Array.isArray(v)) return v.map(String)
    if (typeof v === 'string') return v.split(/[，,\s]+/).filter(Boolean)
    return undefined
  }
  if (typeof v !== 'string') return undefined
  const text = v.trim()
  return text === '' ? undefined : text
}

export function writeQq(onebot, patch) {
  if (!onebot || typeof onebot.setConfig !== 'function') return { ok: false, error: 'QQ 插件还没接上' }
  if (!patch || typeof patch !== 'object') return { ok: false, error: '没有要改的' }
  const clean = {}
  const skipped = []
  for (const f of QQ_FIELDS) {
    if (!(f.key in patch)) continue
    const value = writeValue(f, patch[f.key])
    if (value === undefined) { skipped.push(f.key); continue }
    clean[f.key] = value
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: '没有能用的值（空值不会写进去）', skipped }
  try {
    onebot.setConfig(clean)
  } catch (e) {
    return { ok: false, error: '改不动：' + (e?.message ?? e) }
  }
  return { ok: true, changed: Object.keys(clean), skipped, fields: readQq(onebot).fields }
}

export { pick }