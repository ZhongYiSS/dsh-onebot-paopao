/**
 * 话头模板 —— 哥哥 11-11 要的「话头能自己改、改完能预览」。
 * ============================================================================
 * 插件对会话说的**唯一一句话**由这里拼出来。红线还是那条（哥哥 m00171）：
 * 只说「什么时候、手上有什么」，正文一个字都不代写。
 *
 * 模板里能用的占位符（设置页里也照这张表提示，改完两边别忘同步）：
 *   {{mode}}    这套配置的名字（日常 / 主动 …）
 *   {{period}}  时段（深夜 / 上午 / 傍晚 …）
 *   {{count}}   今天第几次主动开口
 *   {{ago}}     「，上次是 40 分钟前」；没有上一次就整段空
 *   {{who}}     这次发给谁（私聊 哥哥 / 群 摸鱼群 …）
 *   {{w}}       现在的权重（整数）
 *   {{line}}    这一轮的由头：事件页里那个事件填的词
 *   {{label}}   同 {{line}}（老写法）
 *   {{candidates}} 备好的候选列表（视频 / 消息 …），没有就整段空
 *   {{note}}    备注（追聊、来料这些临时说明）
 *
 * 一行里只有占位符、而占位符渲染成空 → 这一行整行去掉（不留空行）。
 * ============================================================================
 */

export const CUE_MAX = 4000

/**
 * 机制说明：**固定，跟着每一条话头走，模板里改不了**
 * （哥哥 11-11：「我支持你固定两条机制说明」→ 晚一点又定：「不用交代来路」那句不要，
 *   让用户自己选择 → 所以固定的只剩 [HOLD] 一条，来路那句回到模板里当普通一行，
 *   想留就留、想删就删。）
 */
export const FIXED_FOOTER = [
  '不想发就写 [HOLD]，插件会替你吞掉。',
]

/**
 * 只压在「抽卡轮」（自由拍子这一拍抽中了、她主动开口）的话头最后。
 * 哥哥 11-11：「聊的久了鱼自己开始打分了」——这一轮是她的开场，没有他那句话可评，
 * 打出来的分是她随手给的；这一轮照固定 5 分算（不补不追），所以直接告诉她别打。
 */
export const TICK_FOOTER = [
  '本轮不用打分。',
]

/**
 * 用户模板里带的 [HOLD] 那句（老配置里有）→ 剥掉，免得和固定尾巴重复。
 * 只剥这一句，同一行上别的字（比如「不用交代来路…」）留着——那是用户自己的选择。
 */
const HOLD_SENT_RE = /不想发就写\s*\[HOLD\][^。]*。?/gi
const HOLD_ANY_RE = /\[HOLD\][^。]*。?/gi
export function stripFixed(template) {
  const out = []
  for (const raw of String(template ?? '').split(/\r?\n/)) {
    if (!/\[HOLD\]/i.test(raw)) { out.push(raw); continue }
    const cleaned = raw.replace(HOLD_SENT_RE, '').replace(HOLD_ANY_RE, '').replace(/\s+$/, '')
    // 这一行本来就是在讲 [HOLD] → 整行不要；行上还有别的话就留着
    if (cleaned.trim() === '' || /^[^。]*不想发就写[^。]*$/.test(cleaned.trim())) continue
    out.push(cleaned)
  }
  return out.join('\n')
}

/** 默认话头：哥哥 11-11 嫌原来那版太糙，这版是「场景 + 手边东西 + 一句引导」 */
export const DEFAULT_CUE = {
  template: [
    '[泡泡]（{{mode}} · {{period}} · 今天第 {{count}} 次主动找他{{ago}}）',
    '',
    '{{line}}',
    '{{hint}}',
    '{{candidates}}',
    '{{note}}',
    '',
    // 这行不是固定的：模板里的普通一行，想删就删
    '不用交代来路，像平时那样说就行。',
  ].join('\n'),
  // 候选列表默认不另起标题——上一行的台词已经带冒号了，再来一个「手上这些：」就叠了
  candidatesTitle: '',
  empty: '（这次没备到料，自己找也行，或者换个说法。）',
}

/** 设置页照这张表写提示 */
export const PLACEHOLDERS = [
  { key: '{{mode}}', desc: '这套配置的名字', example: '日常' },
  { key: '{{period}}', desc: '现在的时段', example: '深夜' },
  { key: '{{count}}', desc: '今天第几次主动开口', example: '3' },
  { key: '{{ago}}', desc: '上次多久前（没有就空）', example: '，上次是 40 分钟前' },
  { key: '{{who}}', desc: '这次发给谁', example: '私聊 哥哥' },
  { key: '{{w}}', desc: '现在的权重（整数）', example: '63' },
  { key: '{{line}}', desc: '这一轮的由头：事件页里那个事件填的「词」（追聊 / 来料是插件自带的一句）', example: '去b站找个视频' },
  { key: '{{label}}', desc: '同 {{line}}（老写法，两个一样）', example: '去b站找个视频' },
  { key: '{{hint}}', desc: '那个事件下面你自己填的补充（没填就空）', example: '补充：挑短的' },
  { key: '{{candidates}}', desc: '备好的候选（视频 / 消息），没有就整段空', example: '手上这些：\n- 标题 · UP · 3:20' },
  { key: '{{note}}', desc: '插件临时加的一句（追聊 / 来料），平时空', example: '他那边有点动静：' },
]

const s = (v, max) => {
  const t = String(v ?? '')
  return t.length > max ? t.slice(0, max) : t
}

/** 把一份 cue 洗干净（缺的补默认、坏的当默认、超长的截断） */
export function normalizeCue(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  // 两条机制说明是固定尾巴，模板里不许留（老配置里那两句在这儿剥掉）
  const tpl = stripFixed(String(r.template ?? DEFAULT_CUE.template)).replace(/\n+$/, '')
  return {
    template: tpl.slice(0, CUE_MAX) || DEFAULT_CUE.template,
    candidatesTitle: r.candidatesTitle === undefined ? DEFAULT_CUE.candidatesTitle : s(r.candidatesTitle, 40),
    empty: r.empty === undefined ? DEFAULT_CUE.empty : s(r.empty, 120),
  }
}

export function cloneCue(cue) {
  return JSON.parse(JSON.stringify(normalizeCue(cue)))
}

/** 候选列表 → 一整块文本（没候选返回空串） */
export function candidatesBlock(cue, list, { title } = {}) {
  const arr = (Array.isArray(list) ? list : [])
    .map((c) => String(typeof c === 'string' ? c : (c && c.text) || '').trim())
    .filter(Boolean)
  if (!arr.length) return ''
  const head = String(title ?? cue.candidatesTitle ?? '').trim()
  const out = arr.map((t) => '- ' + t)
  return (head ? [head, ...out] : out).join('\n')
}

/**
 * 渲染话头。
 * kind: bubble（抽卡）/ inbox（来料）/ followup（追聊）
 * event: { id, label, hint } —— 来料那轮传的是 watch，追聊传 null
 */
export function renderCue({
  cue,
  kind = 'bubble',
  modeLabel = '日常档',
  periodLabel = '',
  countToday = 1,
  lastAgoText = '',
  w = 0,
  event = null,
  candidates = [],
  chatLabel = '',
  chatId = '',
  note = '',
  emptyCandidates = false,
} = {}) {
  const c = normalizeCue(cue)
  // 「这一轮干什么」只有一处：事件页那个事件填的词（哥哥 11-11：台词表和事件那边冲突）
  const line = String(event?.label || '').trim()

  const candText = candidatesBlock(c, candidates)
  const fallbackEmpty = (emptyCandidates && !candText) ? String(c.empty || '').trim() : ''

  const vars = {
    mode: String(modeLabel || ''),
    period: String(periodLabel || ''),
    count: String(countToday),
    ago: lastAgoText ? '，上次是 ' + lastAgoText : '',
    who: String(chatLabel || chatId || ''),
    w: String(Math.round(Number(w) || 0)),
    line,
    label: String(event?.label || ''),
    hint: String(event?.hint || '').trim() ? '补充：' + String(event.hint).trim() : '',
    candidates: candText || fallbackEmpty,
    note: String(note || ''),
  }

  const out = []
  for (const rawLine of String(c.template || '').split(/\r?\n/)) {
    const keys = rawLine.match(/\{\{\s*[a-zA-Z]+\s*\}\}/g) || []
    // 只有占位符的一行：全渲染成空就整行不要
    if (keys.length && rawLine.replace(/\{\{\s*[a-zA-Z]+\s*\}\}/g, '').trim() === '') {
      const all = keys.map((k) => vars[k.replace(/[{}\s]/g, '')] ?? '')
      const joined = all.join('').trim()
      if (!joined) continue
      out.push(joined)
      continue
    }
    out.push(rawLine.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k) => vars[k] ?? ''))
  }

  // 收尾：去行尾空格、压掉三连空行、首尾空行
  let text = out.map((x) => x.replace(/[ \t]+$/, '')).join('\n')
  text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
  // 机制说明永远压在最后（模板里改不动、删不掉）；「本轮不用打分」只给抽卡轮
  const footer = kind === 'bubble' ? [...FIXED_FOOTER, ...TICK_FOOTER] : FIXED_FOOTER
  return [text, footer.join('\n')].filter(Boolean).join('\n\n')
}

/** 设置页预览用的假数据（和真跑一模一样的形状，就是内容是编的） */
export function previewSamples(cue) {
  const c = normalizeCue(cue)
  const cands = [
    '【假如生活欺骗了你】· 某UP主 · 4:12',
    '【我家的猫今天又发疯了】· 另一个UP · 1:30',
    '【深夜食堂：白饭的一百种吃法】· 第三个UP · 8:05',
  ]
  const base = {
    cue: c,
    modeLabel: '日常',
    periodLabel: '深夜',
    countToday: 3,
    lastAgoText: '40 分钟前',
    w: 63,
    chatLabel: '私聊 哥哥',
    chatId: 'private:10001',
  }
  const one = (extra) => renderCue({ ...base, ...extra })
  return [
    { id: 'video', name: '刷视频（有候选）', text: one({ kind: 'bubble', event: { id: 'video', label: '去b站找个视频' }, candidates: cands }) },
    { id: 'chat', name: '说句话（没候选）', text: one({ kind: 'bubble', event: { id: 'chat', label: '说句话' } }) },
    { id: 'followup', name: '追聊', text: one({ kind: 'followup', note: '（是你自己早先说想这会儿再聊的，不用解释为什么是这个点。）' }) },
    { id: 'inbox', name: '来料（B站 有动静）', text: one({ kind: 'inbox', note: '他那边有点动静：', candidates: ['某UP 回复了你：好啊好啊', '某人 私信你：在吗'] }) },
  ]
}