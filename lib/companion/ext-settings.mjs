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
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { configPath as pickBiliConfigPath } from './bili-paths.mjs'
import { normalizeRolls } from './chatroll.mjs'

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
  if (f.type === 'switch') return v === undefined || v === null ? f.dft === true : v === true
  if (f.type === 'num') {
    const n = Number(v)
    if (!Number.isFinite(n)) return f.min ?? 0
    return Math.min(f.max ?? 1e12, Math.max(f.min ?? 0, n))
  }
  if (f.type === 'select') return f.options.includes(v) ? v : f.options[0]
  if (f.type === 'lines') return Array.isArray(v) ? v.map(String) : []
  if (f.type === 'tags') return Array.isArray(v) ? v.map(String) : []
  if (f.type === 'checks') {
    const known = new Set((f.options || []).map((o) => o.key))
    return Array.isArray(v) ? v.map(String).filter((k) => known.has(k)) : []
  }
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
  { key: 'promptExtra', group: '人设', label: '人设 / 说话风格', type: 'textarea', note: '这段原样插进每轮提示词开头：自称、口癖、情绪、回多长、怎么分段都写这儿。留空 = 用插件自带的默认人格' },
  { key: 'memeDir', group: '人设', label: '表情包目录', type: 'text', reveal: true, note: '往里丢图就能用；文件名就是内容' },
  // 表情包 / 语音这两个概率不在这儿：11-11 起并进「聊天强制事件」那张卡（chatRolls），能自己加条目
  { key: 'debounceMs', group: '互动', label: '防抖合并（秒）', type: 'num', scale: 1000, min: 0, max: 60, step: 1, note: '连着几条并成一轮；0 = 不等' },
  { key: 'debounceBusyWait', group: '互动', label: '忙的时候等一等', type: 'switch', note: '正在回上一条就先排队' },
  { key: 'debounceMaxMs', group: '互动', label: '合并最多拖多久（秒）', type: 'num', scale: 1000, min: 1, max: 300, step: 1, note: '一直有人说话也不会无限往后拖，到点就一起发' },
  { key: 'debounceMaxParts', group: '互动', label: '一个窗口最多并几条', type: 'num', min: 1, max: 100, step: 1, note: '超出的丢最早的' },
  { key: 'debounceBusyMaxMs', group: '互动', label: '忙时最多让路多久（秒）', type: 'num', scale: 1000, min: 5, max: 600, step: 5, note: '超时就不管它忙不忙，整把交出去' },
  { key: 'burstWindowMs', group: '互动', label: '连发合并窗口（秒）', type: 'num', scale: 1000, min: 0, max: 60, step: 1, note: '这段时间里他连发几条才算连发；0 = 不判断' },
  { key: 'burstThreshold', group: '互动', label: '连发几条开始合并', type: 'num', min: 1, max: 20, step: 1, note: '窗口内超过这个条数才压住' },
  { key: 'burstWaitMs', group: '互动', label: '合并后等多久（秒）', type: 'num', scale: 1000, min: 0, max: 60, step: 1, note: '等他发完；期间再发会自动顺延；0 = 关闭' },
  { key: 'interimMessages', group: '互动', label: '干活时先吱一声', type: 'switch', note: '每步的中间回复立刻发出来；关掉 = 只发最后一句' },
  { key: 'interimRecall', group: '互动', label: '中间消息自动撤回', type: 'switch', note: '发完过一会儿自己撤掉' },
  { key: 'interimRecallMs', group: '互动', label: '中间消息几秒后撤回', type: 'num', scale: 1000, min: 10, max: 110, step: 5, note: 'QQ 撤回时限约 2 分钟，别超过 110' },
  { key: 'maxImagesPerTurn', group: '互动', label: '一轮最多看几张图', type: 'num', min: 1, max: 9, step: 1, note: '被 @ 时只认最后一张；主动模式对象连发的图一轮最多看这么多' },
  { key: 'recentImageLookback', group: '互动', label: '没带图时往回找几条', type: 'num', min: 0, max: 10, step: 1, note: '被 @ 但这条没图：往回翻几条找最近的图，找一张就够' },
  { key: 'recentImageMaxAgeMs', group: '互动', label: '往回找的图最多几分钟前', type: 'num', scale: 1000, min: 0, max: 3600, step: 1, note: '超过就不认；0 = 不限时间' },
  // 「群里必须 @ 才回」不在这里——它在 QQ 设置面板的权限组，两处同键会打架。
  { key: 'groupKeywords', group: '群聊', label: '群聊关键词', type: 'tags', note: '听到这些词才会开口；逗号分隔' },
  { key: 'groupKeywordCooldownMs', group: '群聊', label: '关键词冷却（秒）', type: 'num', scale: 1000, min: 0, max: 3600, step: 1 },
  { key: 'mentionHistoryCount', group: '群聊', label: '被 @ 时补几条群聊', type: 'num', min: 0, max: 50, step: 1, note: '0 = 不补上下文' },
  { key: 'historyFocusRatio', group: '群聊', label: '追问时他的发言占比', type: 'num', min: 0, max: 1, step: 0.05, note: '主动追问时，上下文里目标对象发言的最低占比' },
  { key: 'mentionMaxImages', group: '群聊', label: '被 @ 时最多看几张图', type: 'num', min: 1, max: 9, step: 1, note: '默认 1 = 只看最后一张' },
  { key: 'restrictedMemberPrefix', group: '群聊', label: '非管理员加「受限」前缀', type: 'switch', dft: true, note: '软限制：标记这条是群成员说的，别当成主人下的命令；关掉就不加前缀' },
  { key: 'groupAbilities', group: '群聊', label: '群里允许她做的事', type: 'checks', options: [
      { key: 'voice', label: '发语音' },
      { key: 'sticker', label: '发表情包' },
      { key: 'image', label: '发图片' },
      { key: 'video', label: '发视频' },
      { key: 'forward', label: '合并转发' },
      { key: 'draw', label: '画图' },
      { key: 'search', label: '搜图' },
      { key: 'bili', label: '查 B站' },
  ], note: '只影响群成员说话的那一轮；全关 = 只能聊天。跑命令、改文件、改配置永远不允许' },
  { key: 'groupAbilitiesExtra', group: '群聊', label: '另外允许她做的事（自己写）', type: 'lines', note: '一行一条，原样写进提示词——上面那张表没列到的都写这儿，比如「查天气」「念新闻」；留空就不加' },
  { key: 'proactiveMaxFollowUps', group: '主动', label: '最多追几次', type: 'num', min: 0, max: 10, step: 1 },
  { key: 'proactiveFollowUpMs', group: '主动', label: '追问间隔（秒）', type: 'num', scale: 1000, min: 5, max: 600, step: 1 },
  { key: 'openChatDefaultMs', group: '主动', label: '随意聊默认多久（秒）', type: 'num', scale: 1000, min: 60, max: 86400, step: 60, note: '默认 600 = 10 分钟' },
  { key: 'openChatMaxMs', group: '主动', label: '随意聊最多多久（秒）', type: 'num', scale: 1000, min: 60, max: 86400, step: 60, note: '窗口的上限' },
  { key: 'proactiveDurationMs', group: '主动', label: '主动模式默认开多久（秒）', type: 'num', scale: 1000, min: 0, max: 7200, step: 30, note: '0 = 关闭主动模式' },
  { key: 'proactiveChunkChars', group: '主动', label: '主动模式每条多少字', type: 'num', min: 10, max: 200, step: 5, note: '按句子切，句子不切断' },
  { key: 'proactiveImageThreshold', group: '主动', label: '超过多少字转图片', type: 'num', min: 20, max: 2000, step: 10, note: '正文超过它才转图，否则拆成多条' },
  { key: 'ownerQQ', group: '其他', label: '主人 QQ', type: 'text' },
  { key: 'tempTtlHours', group: '其他', label: '临时媒体留几小时', type: 'num', min: 1, max: 240, step: 1, note: '收到/生成的临时图、语音到期自动清' },
  { key: 'ignoreSelf', group: '其他', label: '忽略自己发的消息', type: 'switch', dft: true, note: '防自循环，默认开' },
  { key: 'napcatQuickLogin', group: '其他', label: '启动时试快速登录', type: 'switch', dft: true, note: '带 -q <机器人 QQ> 免扫码；失败还是能在 NapCat 里扫' },

  { key: 'cardChunkChars', group: '长文', label: '长文卡片每张多少字', type: 'num', min: 50, max: 5000, step: 50, note: '超过就切成多张卡片发' },
  { key: 'cardFooter', group: '长文', label: '卡片页脚署名', type: 'text', note: '显示成「Powered by <这里>」；留空就不写' },
  { key: 'textImageThreshold', group: '长文', label: '正文超过多少字转图片', type: 'num', min: 0, max: 2000, step: 10, note: '0 = 不做文字卡片，一律当文本发' },
  { key: 'maxMessageParts', group: '长文', label: '长文本最多分几条', type: 'num', min: 0, max: 20, step: 1, note: '超出的并进最后一条；0 = 不限' },
  { key: 'dedupWindowSeconds', group: '安全', label: '重复消息去重窗口（秒）', type: 'num', min: 0, max: 3600, step: 10, note: '断线重连重放的重复消息只处理第一条；0 = 不去重' },
  { key: 'actionRatePerMinute', group: '安全', label: '主动发送每分钟上限', type: 'num', min: 0, max: 600, step: 1, note: '全桥合计，只约束工具发起的主动发送；0 = 不限' },
  { key: 'actionRatePerDay', group: '安全', label: '主动发送每天上限', type: 'num', min: 0, max: 100000, step: 10, note: '按本地自然日算，次日自动恢复；0 = 不限' },
  { key: 'sensitivePatterns', group: '安全', label: '出站敏感词正则', type: 'lines', note: '一行一条正则；留空 = 只用内置那套（rm -rf / 关机 / 删库 / 密钥）。写错一条只是那条不生效' },
  { key: 'allowPrivateHosts', group: '安全', label: '允许下载内网地址', type: 'switch', note: '默认拒绝私网/环回目标（防 SSRF）。NapCat 文件服务或反代在本机时才开；改完要重启' },
  { key: 'allowEnvOverrides', group: '安全', label: '允许环境变量改权限', type: 'switch', note: '默认关：权限只认配置，环境变量改不动。改完要重启' },
  { key: 'visionModel', group: '识图', label: '视觉模型', type: 'text', note: '先想再说的模型要留足 token，否则正文是空的' },
  { key: 'visionBaseUrl', group: '识图', label: '视觉网关', type: 'text' },
  { key: 'visionApiKeyEnv', group: '识图', label: '凭证名', type: 'text', note: '写 .credentials.yaml 里的键名，不写 key 本身' },
  { key: 'visionMaxTokens', group: '识图', label: '输出上限 tokens', type: 'num', min: 100, max: 8000, step: 100 },
  { key: 'visionTimeoutMs', group: '识图', label: '超时（秒）', type: 'num', scale: 1000, min: 5, max: 600, step: 5 },
  { key: 'visionHeaders', group: '识图', label: '请求头', type: 'text', note: '有的网关不带头就 400。JSON，例如 {"x-opencode-session":"paopao"}。看视频那段留空就用这里' },
  { key: 'autoOcr', group: '识图', label: '先试本地 OCR', type: 'switch', dft: true, note: '收到图先用 NapCat 的 OCR 认字，够用就不叫视觉模型（省钱、快）' },
  { key: 'visionMinOcrChars', group: '识图', label: 'OCR 认出几个字算够', type: 'num', min: 1, max: 100, step: 1, note: '少于这个字数才叫视觉模型' },
  { key: 'videoVisionModel', group: '看视频', label: '视觉模型', type: 'text', note: '留空 = 跟随「识图」那套（用这台机器上配的模型）；填本地模型名也行' },
  { key: 'videoVisionBaseUrl', group: '看视频', label: '视觉网关', type: 'text', note: '留空 = 跟随「识图」；本地就填 http://127.0.0.1:端口/v1' },
  { key: 'videoVisionApiKeyEnv', group: '看视频', label: '凭证名', type: 'text', note: '留空 = 跟随「识图」；写 .credentials.yaml 里的键名，不写 key 本身' },
  { key: 'videoVisionMaxTokens', group: '看视频', label: '单张图 token 上限', type: 'num', min: 1000, max: 32000, step: 500, note: '先想再说的模型要给足，不然正文是空的' },
  { key: 'videoVisionTimeoutMs', group: '看视频', label: '单张图超时（秒）', type: 'num', scale: 1000, min: 10, max: 600, step: 5 },
  { key: 'videoVisionHeaders', group: '看视频', label: '请求头', type: 'text', note: '有的网关不带头就 400。JSON，留空 = 跟「识图」那段共用' },
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
    // 读出来只做「非数字」兜底，不夹上下限：f.min/f.max 写的是界面单位（秒），
    // 而这里的 v 是存盘的毫秒 —— 拿它去比 max 会把 2000 夹成 60（显示 0.06 秒）。
    return n
  }
  if (f.type === 'tags') return Array.isArray(v) ? v.map(String) : []
  if (f.type === 'checks') {
    // 多选：正常是数组；老配置里可能被 String() 压成 "voice,sticker" 这种串，也认
    const known = new Set((f.options || []).map((o) => o.key))
    const list = Array.isArray(v) ? v.map(String) : (typeof v === 'string' && v.trim() ? v.split(/[，,\s]+/) : [])
    return list.map((x) => x.trim()).filter((k) => known.has(k))
  }
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
    // scale：min/max 写的是「界面单位」（秒），存的是毫秒 —— 夹取前要跟着放大，
    // 否则填 2 秒会被夹成 max=60（毫秒），存下去就是 0.06 秒（哥哥 m18313 抓到的 bug）。
    const sc = Number(f.scale) > 0 ? Number(f.scale) : 1
    const lo = Number.isFinite(Number(f.min)) ? Number(f.min) * sc : 0
    const hi = Number.isFinite(Number(f.max)) ? Number(f.max) * sc : 1e12
    return Math.min(hi, Math.max(lo, n))
  }
  if (f.type === 'lines') {
    if (Array.isArray(v)) return v.map(String)
    if (typeof v === 'string') return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    return undefined
  }
  if (f.type === 'checks') {
    if (typeof v === 'string') v = v.split(/[，,\s]+/)
    if (!Array.isArray(v)) return undefined
    const known = new Set((f.options || []).map((o) => o.key))
    return v.map(String).map((x) => x.trim()).filter((k) => known.has(k))
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

/* ------------------------- 聊天强制事件（每轮掷） ------------------------- */

/** 存盘：\$DSH_HOME/onebot/chatrolls.json（重启也认；文件优先于 yml） */
function chatRollsFile(home) {
  return join(String(home || ''), 'onebot', 'chatrolls.json')
}

function readRollsFile(home) {
  try {
    const raw = JSON.parse(readFileSync(chatRollsFile(home), 'utf8'))
    return Array.isArray(raw) ? raw : Array.isArray(raw?.rolls) ? raw.rolls : null
  } catch {
    return null
  }
}

/** 每轮掷一次的强制事件（表情包是内置那条，不能删） */
export function readChatRolls(onebot, home) {
  const saved = readRollsFile(home)
  if (saved) return normalizeRolls(saved, {})
  const cfg = onebot && typeof onebot.getConfig === 'function' ? onebot.getConfig() || {} : {}
  // 空数组 = 还没配过（schema 的 default([]) 会顶上来），照老的两个概率迁移
  const savedCfg = Array.isArray(cfg.chatRolls) && cfg.chatRolls.length ? cfg.chatRolls : null
  return normalizeRolls(savedCfg, { memeChance: cfg.memeChance, voiceChance: cfg.voiceChance })
}

export function writeChatRolls(onebot, list, home) {
  if (!onebot || typeof onebot.setConfig !== 'function') return { ok: false, error: 'QQ 插件还没接上' }
  const rolls = normalizeRolls(Array.isArray(list) ? list : [], {})
  try {
    onebot.setConfig({ chatRolls: rolls })
  } catch (e) {
    return { ok: false, error: '改不动：' + (e?.message ?? e) }
  }
  // 内存那份重启就回 yml，所以同时落一份文件；读的时候文件优先
  try {
    mkdirSync(join(String(home || ''), 'onebot'), { recursive: true })
    const tmp = chatRollsFile(home) + '.tmp'
    writeFileSync(tmp, JSON.stringify(rolls, null, 2))
    renameSync(tmp, chatRollsFile(home))
  } catch (e) {
    return { ok: true, rolls, fields: readChatRolls(onebot, home), warning: '存是改了，但没落盘：' + (e?.message ?? e) }
  }
  return { ok: true, rolls, fields: readChatRolls(onebot, home) }
}

export { pick }