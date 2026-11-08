// B站 动作接口：点赞 / 投币 / 收藏 / 评论。
// 只做「往外发」的那几个动作，读的那些在 lib/companion/bili-watch.mjs 和 adapters/bili.mjs 里。
// 凭证复用 $DSH_HOME/bili-duty/bili_credential.json（sessdata / bili_jct）。
// 规矩：① 发之前过一遍套话闸门（八股、求赞求币一律不发）；② 同一条视频、同一句正文只发一次；
//       ③ 每个动作有冷却；④ 全部失败都抛错，不装成功。
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CRED_OWN = join(HOME, 'bubble', 'bili', 'bili_credential.json')
const CRED_LEGACY = join(HOME, 'bili-duty', 'bili_credential.json')
/** 泡泡自己那份优先；没有就回落刷B站 的老位置；两份都在取 mtime 新的。 */
function credFile() {
  const own = existsSync(CRED_OWN) ? CRED_OWN : ''
  const legacy = existsSync(CRED_LEGACY) ? CRED_LEGACY : ''
  if (own && legacy) {
    try {
      return statSync(own).mtimeMs >= statSync(legacy).mtimeMs ? own : legacy
    } catch { return own }
  }
  return own || legacy
}
const SENT_FILE = join(HOME, 'bubble', 'bili-sent.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 冷却：同进程内按动作记最后一次（跨重启不记，够用）
const lastAt = new Map()
const COOL_MS = { like: 15_000, coin: 60_000, comment: 60_000, fav: 15_000, dm: 30_000 }
const COMMENT_MAX = 300

/** 读 B站 凭证；缺 sessdata 或 bili_jct 直接抛错（点赞/评论都要 csrf）。 */
export function readCred() {
  const file = credFile()
  if (!file) throw new Error('没有 B站 凭证：' + CRED_OWN + ' 或 ' + CRED_LEGACY)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error('凭证不是合法 JSON：' + (e?.message ?? e))
  }
  const sessdata = String(raw.sessdata ?? '').trim()
  const csrf = String(raw.bili_jct ?? '').trim()
  if (sessdata === '') throw new Error('凭证里没有 sessdata（没登录）')
  if (csrf === '') throw new Error('凭证里没有 bili_jct（做不了发评论/点赞）')
  return { sessdata, csrf, uname: String(raw.uname ?? ''), mid: String(raw.dedeuserid ?? '') }
}

/**
 * 套话闸门：撞一条就不发，把改法告诉模型。
 * 只管「一看就是模板/求互动」的，不管正常说话。
 */
const BANNED = [
  '作为一个',
  '首先，',
  '其次，',
  '总之，',
  '综上',
  '希望对你有所帮助',
  '点赞投币收藏',
  '一键三连',
  '求关注',
  '求点赞',
  '感谢观看',
  '感谢大家的支持',
  '这期视频就到这里',
  '以上就是全部内容',
  '希望对大家有帮助',
]
export function styleReason(text) {
  const t = String(text ?? '').trim()
  if (t === '') return '正文是空的'
  if (t.length > COMMENT_MAX) return '太长了（' + t.length + ' 字），评论最多 ' + COMMENT_MAX + ' 字'
  for (const bad of BANNED) {
    if (t.includes(bad)) return '这句像模板（撞到「' + bad + '」），换成你自己想说的'
  }
  if (/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(t)) return '只有表情，没内容——要么说句话，要么别发'
  return ''
}

function readSent() {
  try {
    const j = JSON.parse(readFileSync(SENT_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function writeSent(obj) {
  try {
    mkdirSync(join(HOME, 'bubble'), { recursive: true })
    writeFileSync(SENT_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  } catch {
    // 账本写不进去不能拦住发送，但下一次去重会失效
  }
}

const normText = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase()

/** 同一条视频说过没有（30 天内同文直接拦）。 */
export function alreadySaid(bvid, text, now = Date.now()) {
  const all = readSent()
  const rows = Array.isArray(all[bvid]) ? all[bvid] : []
  const want = normText(text)
  return rows.some((r) => normText(r.text) === want && now - Number(r.at || 0) < 30 * 86400_000)
}

function noteSaid(bvid, text, rpid, now = Date.now()) {
  const all = readSent()
  const rows = Array.isArray(all[bvid]) ? all[bvid] : []
  rows.push({ text: String(text ?? ''), at: now, rpid: rpid == null ? null : String(rpid) })
  all[bvid] = rows.slice(-30)
  writeSent(all)
}

function cool(action) {
  const last = Number(lastAt.get(action) || 0)
  const gap = COOL_MS[action] || 15_000
  const left = gap - (Date.now() - last)
  if (last && left > 0) throw new Error('太急了：' + action + ' 还要等 ' + Math.ceil(left / 1000) + ' 秒')
  lastAt.set(action, Date.now())
}

async function biliPost(url, form, cred) {
  const body = new URLSearchParams({ ...form, csrf: cred.csrf }).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Cookie: 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.csrf,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('B站 回了不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 120))
  }
  if (json.code !== 0) {
    throw new Error('B站 拒绝（code=' + json.code + '）：' + String(json.message || json.msg || '').slice(0, 120))
  }
  return json.data ?? {}
}

/** BV 号 → aid（评论要 aid，点赞其实 bvid 就行）。 */
export async function aidOf(bvid) {
  const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) })
  const json = await res.json()
  if (json.code !== 0) throw new Error('查视频失败（code=' + json.code + '）：' + json.message)
  const d = json.data || {}
  return { aid: d.aid, title: String(d.title ?? ''), owner: String(d.owner?.name ?? '') }
}

/** 点赞 / 取消点赞。on=false 是取消。 */
export async function likeVideo(bvid, on = true) {
  const cred = readCred()
  cool('like')
  await biliPost('https://api.bilibili.com/x/web-interface/archive/like', {
    bvid,
    like: on ? '1' : '2',
  }, cred)
  return { ok: true, action: on ? '点赞' : '取消赞', bvid }
}

/** 投币。count 1 或 2。 */
export async function coinVideo(bvid, count = 1) {
  const cred = readCred()
  cool('coin')
  const n = count === 2 ? 2 : 1
  await biliPost('https://api.bilibili.com/x/web-interface/coin/add', {
    bvid,
    multiply: String(n),
    select_like: '0',
  }, cred)
  return { ok: true, action: '投币 ' + n + ' 枚', bvid }
}

/** 收藏到某个收藏夹（不传 fid 就找第一个「默认收藏夹」）。 */
export async function favVideo(bvid, fid = 0) {
  const cred = readCred()
  cool('fav')
  const { aid } = await aidOf(bvid)
  let folder = Number(fid) || 0
  if (!folder) {
    const res = await fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all', {
      headers: { 'User-Agent': UA, Cookie: 'SESSDATA=' + cred.sessdata },
      signal: AbortSignal.timeout(12_000),
    })
    const json = await res.json()
    const list = Array.isArray(json?.data?.list) ? json.data.list : []
    if (!list.length) throw new Error('没有可用的收藏夹（code=' + json.code + '：' + (json.message || '') + '）')
    folder = Number(list[0].id)
  }
  await biliPost('https://api.bilibili.com/x/v3/fav/resource/deal', {
    rid: String(aid),
    type: '2',
    add_media_ids: String(folder),
    del_media_ids: '',
  }, cred)
  return { ok: true, action: '收藏到收藏夹 ' + folder, bvid, aid }
}

/**
 * 发评论 / 回复评论。
 * rpid=0 发新评论；rpid>0 回复那条（回复楼中楼时再给 root）。
 */
export async function sendComment(bvid, text, options = {}) {
  const cred = readCred()
  const body = String(text ?? '').trim()
  const reason = styleReason(body)
  if (reason) return { ok: false, blocked_by: 'style', error: reason }
  if (alreadySaid(bvid, body)) return { ok: false, blocked_by: 'dup', error: '这句话在这条视频下已经发过了' }
  cool('comment')
  const { aid, title } = await aidOf(bvid)
  const rpid = Number(options.rpid) || 0
  const root = Number(options.root) || 0
  const form = { oid: String(aid), type: '1', message: body }
  if (rpid) {
    form.root = String(root || rpid)
    form.parent = String(rpid)
  }
  const data = await biliPost('https://api.bilibili.com/x/v2/reply/add', form, cred)
  const got = data?.rpid ?? data?.rpid_str ?? null
  noteSaid(bvid, body, got)
  // 刚发完别立刻再发（B站 有风控），顺手把冷却重置
  await sleep(200)
  return { ok: true, action: rpid ? '回复了评论 ' + rpid : '发了评论', bvid, aid, title, rpid: got }
}

/* ── 私信（B站 web IM）─────────────────────────────────────────────
 * 接口：POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg
 * 关键：csrf=bili_jct；receiver_type=1 是个人；content 要再包一层 JSON。
 * 判成功看返回里的 msg_key —— code=0 但没 msg_key 也算没送到（刷B站 那边踩过）。
 */
const DM_DEV_ID = 'A7F1C2D3-4B5E-6F70-8A9B-0C1D2E3F4A5B'

/** 给某个 UID 发一条私信。真会发出去。 */
export async function sendDm(receiverUid, text) {
  const cred = readCred()
  const uid = Number(receiverUid)
  if (!Number.isFinite(uid) || uid <= 0) throw new Error('收件人 UID 不对：' + receiverUid)
  const body = String(text ?? '').trim()
  if (body === '') throw new Error('私信不能是空的')
  const reason = styleReason(body)
  if (reason) return { ok: false, blocked_by: 'style', error: reason }
  cool('dm')
  const form = {
    'msg[sender_uid]': cred.mid || '',
    'msg[receiver_id]': String(uid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[dev_id]': DM_DEV_ID,
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[content]': JSON.stringify({ content: body }),
    csrf: cred.csrf,
    csrf_token: cred.csrf,
    build: '0',
    mobi_app: 'web',
  }
  const res = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: 'https://message.bilibili.com/',
      Cookie: 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.csrf,
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await res.text()
  let json = null
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('B站 私信接口回了不是 JSON（HTTP ' + res.status + '）：' + raw.slice(0, 120))
  }
  if (json.code !== 0) {
    throw new Error('B站 拒绝（code=' + json.code + '）：' + String(json.message || json.msg || '').slice(0, 120))
  }
  const data = json.data || {}
  const key = data.msg_key ?? data?.data?.msg_key ?? null
  if (!key) {
    return { ok: false, blocked_by: 'noreceipt', error: '接口说成功但没给回执（msg_key），按没送到算', data }
  }
  const echoed = data?.msg_content ? (() => { try { return JSON.parse(data.msg_content).content || '' } catch { return '' } })() : ''
  return { ok: true, action: '发了私信', uid, msg_key: key, echo: echoed }
}
