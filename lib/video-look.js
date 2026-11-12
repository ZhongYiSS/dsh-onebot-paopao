/**
 * 看视频 —— 把一条视频变成「能读的证据」。
 * ============================================================================
 * 三条通道：字幕轨（文字，快）+ 抽帧宫格（画面，慢）+ 没字幕时的 ASR 转写（assets/asr/transcribe.py）。
 *
 * 只产出证据，不写一句话（红线：会话自己说）。
 * 视觉模型由配置决定（默认空，必须自己填；代码不许擅自替你选模型）。
 * ============================================================================
 * @module dsh-onebot/video-look
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeImage, parseHeaderJson, resolveApiKey } from './vision.js'
import { readCred, subtitleText } from './companion/adapters/bili.mjs'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const workRoot = () => join(dshHome(), 'bubble', 'video-work')
// 插件自带的转写脚本（assets/asr/transcribe.py）；用户自己的优先
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheFile = () => join(dshHome(), 'bubble', 'video-cache.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 网关一喊限流，就把并发降到 1（继续并发只会更慢，还容易连累整轮）。
let slowMode = false

// 外部程序的找法（按顺序，找到就用）：
//   1. 环境变量（BUBBLE_FFMPEG / BUBBLE_FFPROBE / BUBBLE_YTDLP / BUBBLE_ASR_PY / BUBBLE_ASR_SCRIPT）
//   2. 数据目录里的 tools.json（`$DSH_HOME/onebot/tools.json`，写成 { "ffmpeg": "...", "ytdlp": "...",
//      "python": "...", "asrScript": "..." }），这样本机路径不进口仓库
//   3. 宿主自带的常见位置（$DSH_HOME 底下，跨机器通用）
//   4. PATH
// 找不到就返回 null —— 以前返回 list[0]，等于明知不存在也拿去 spawn，
// 把「没装」拖到运行时才炸（11-07 宿主被一条下载打死的直接原因之一）。
const localTools = () => {
  try {
    const f = join(dshHome(), 'onebot', 'tools.json')
    const raw = existsSync(f) ? readFileSync(f, 'utf8') : ''
    const got = raw === '' ? {} : JSON.parse(raw)
    return got && typeof got === 'object' ? got : {}
  } catch {
    return {}
  }
}
const fromPath = (name) => {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}
const FIRST_BIN = (envName, key, name, list = []) => {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  const local = localTools()[key]
  if (typeof local === 'string' && local !== '' && existsSync(local)) return local
  for (const p of list) if (p && existsSync(p)) return p
  return fromPath(name)
}
const FFMPEG = FIRST_BIN('BUBBLE_FFMPEG', 'ffmpeg', 'ffmpeg', [
  join(dshHome(), 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'ffmpeg', 'ffmpeg.exe'),
])
const FFPROBE = FIRST_BIN('BUBBLE_FFPROBE', 'ffprobe', 'ffprobe', [
  join(dshHome(), 'tools', 'ffmpeg', 'bin', 'ffprobe.exe'),
  join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'ffmpeg', 'ffprobe.exe'),
])
const YTDLP = FIRST_BIN('BUBBLE_YTDLP', 'ytdlp', 'yt-dlp', [
  join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'Scripts', 'yt-dlp.exe'),
  join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'Scripts', 'yt-dlp'),
])
// 声音通道：本地 faster-whisper 转写（离线 CPU），只给没有字幕轨的视频用。
// 脚本优先用插件自带那份（assets/asr/transcribe.py），用户想换自己的就设
// BUBBLE_ASR_SCRIPT，或在 tools.json 里写 asrScript。
const ASR_PY = FIRST_BIN('BUBBLE_ASR_PY', 'python', 'python')
const ASR_SCRIPT = FIRST_BIN('BUBBLE_ASR_SCRIPT', 'asrScript', '听写.py', [
  join(pkgRoot, 'assets', 'asr', 'transcribe.py'),
])

/**
 * 跑一个子进程，收 stdout/stderr；超时就杀。
 *
 * 两条铁律（11-07 的教训：一条视频下载失手，把整个宿主打死）：
 *   1. 先挂 `error` 监听，再去碰 stdout/stderr —— spawn 失败时这两个是 null，
 *      先碰会抛 TypeError 把 Promise 提前 reject，而 `error` 事件没人接就变成
 *      未捕获异常，宿主直接退出。
 *   2. 程序不存在要在 spawn 之前就说清楚（人话 + 路径），不要让它变成 ENOENT 裸奔。
 */
function run(bin, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin || typeof bin !== 'string') {
      reject(new Error('缺少可执行程序（没装，或被运行时重建清掉了）'))
      return
    }
    if (/[\\/]/.test(bin) && !existsSync(bin)) {
      reject(new Error('找不到程序：' + bin))
      return
    }

    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(new Error('启动不了 ' + bin + '：' + (e && e.message ? e.message : e)))
      return
    }

    let out = ''
    let err = ''
    let settled = false
    let timer = null
    const done = (fn, v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(v)
    }

    // 先挂 error（顺序不能动）
    child.on('error', (e) => {
      const code = e && e.code ? String(e.code) : ''
      const hint = code === 'ENOENT' ? '（找不到这个程序，可能没装、被清掉了，或者路径不对）' : ''
      done(reject, new Error(bin.split(/[\\/]/).pop() + ' 起不来' + hint + '：' + bin))
    })

    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经死了 */ }
      done(reject, new Error('超时 ' + timeoutMs + 'ms：' + bin))
    }, timeoutMs)

    if (child.stdout) child.stdout.on('data', (d) => { out += d })
    if (child.stderr) child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) done(resolve, { out, err })
      else done(reject, new Error(bin.split(/[\\/]/).pop() + ' 退出 ' + code + '：' + err.replace(/\s+/g, ' ').slice(-300)))
    })
  })
}

/** 给测试用：直接跑一个子进程，验证「程序不存在」不会变成未捕获异常。 */
export { run as runSubprocess }

/**
 * 从一句话里认出要看的视频。
 * @param input - B站 链接 / BV 号 / 本地文件 / 其它 yt-dlp 能下的地址。
 * @returns {{kind: 'bili'|'file'|'url', bvid?: string, file?: string, url?: string}}
 */
export function parseRef(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') throw new Error('没给视频地址')
  const bv = /(BV[0-9A-Za-z]{10})/.exec(raw)
  if (bv !== null) return { kind: 'bili', bvid: bv[1], url: raw.startsWith('http') ? raw : 'https://www.bilibili.com/video/' + bv[1] }
  if (existsSync(raw)) return { kind: 'file', file: raw }
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', url: raw }
  throw new Error('认不出这个地址：' + raw.slice(0, 80))
}

function idOf(ref) {
  if (ref.kind === 'bili') return 'bili-' + ref.bvid
  if (ref.kind === 'file') return 'file-' + Buffer.from(ref.file).toString('base64url').slice(0, 40)
  return 'url-' + Buffer.from(ref.url).toString('base64url').slice(0, 40)
}

const mmss = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/** B站 视频元信息（标题/时长/cid/UP 主）。 */
async function biliMeta(bvid, cred) {
  const cookie = cred ? 'SESSDATA=' + cred.sessdata + '; bili_jct=' + (cred.biliJct || '') : ''
  const response = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      ...(cookie === '' ? {} : { cookie }),
    },
    signal: AbortSignal.timeout(10_000),
  })
  const json = await response.json().catch(() => null)
  if (json === null || json.code !== 0 || !json.data) throw new Error('取视频信息失败：' + (json?.message ?? response.status))
  const d = json.data
  return {
    title: String(d.title || ''),
    duration: Number(d.duration) || 0,
    cid: d.cid,
    owner: String(d.owner?.name || ''),
    bvid,
  }
}

/** 下载（有缓存文件就不再下）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function biliHeaders(cred) {
  const parts = []
  if (cred?.sessdata) parts.push('SESSDATA=' + cred.sessdata)
  if (cred?.biliJct) parts.push('bili_jct=' + cred.biliJct)
  if (cred?.buvid3) parts.push('buvid3=' + cred.buvid3)
  if (cred?.uid) parts.push('DedeUserID=' + cred.uid)
  return {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    ...(parts.length > 0 ? { cookie: parts.join('; ') } : {}),
  }
}

async function biliJson(url, cred, timeoutMs = 15_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: biliHeaders(cred), signal: ctrl.signal })
    const body = await res.json().catch(() => null)
    if (!res.ok || body === null) throw new Error('HTTP ' + res.status)
    if (Number(body.code) !== 0) throw new Error('接口报错 code=' + body.code + ' ' + String(body.message || ''))
    return body.data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 分片下载 B站 的 dash 流（它支持 Range，实测 206）。
 * 不认 Range 的服务器会直接给整包（200），那时收一次就收工。
 */
async function fetchToFile(url, dest, cred, { timeoutMs = 300_000 } = {}) {
  const chunk = 8 * 1024 * 1024
  const deadline = Date.now() + timeoutMs
  const parts = []
  let start = 0
  for (;;) {
    if (Date.now() > deadline) throw new Error('下载超时')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.min(60_000, Math.max(5000, deadline - Date.now())))
    let res
    try {
      res = await fetch(url, {
        headers: { ...biliHeaders(cred), range: 'bytes=' + start + '-' + (start + chunk - 1) },
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    // 416 = 请求范围超出文件末尾，说明已经下完
    if (res.status === 416) break
    if (res.status !== 206 && res.status !== 200) throw new Error('分片下载失败 HTTP ' + res.status)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) break
    parts.push(buf)
    start += buf.length
    if (res.status === 200 || buf.length < chunk) break
  }
  if (parts.length === 0) throw new Error('一个字节都没下到')
  writeFileSync(dest, Buffer.concat(parts))
  return start
}

/** 挑一路视频：优先 avc1（ffmpeg 兼容最好），高度不超过目标，取最省的那档。 */
function pickDashStream(videos, targetHeight) {
  const avc = videos.filter((v) => String(v.codecs || '').toLowerCase().startsWith('avc1'))
  const pool = avc.length > 0 ? avc : videos
  const under = pool
    .filter((v) => Number(v.height) > 0 && Number(v.height) <= targetHeight)
    .sort((a, b) => Number(b.height) - Number(a.height) || Number(a.bandwidth) - Number(b.bandwidth))
  if (under.length > 0) return under[0]
  // 竖屏 / 只有大档的：退一步取最矮的那一档
  return [...pool].sort((a, b) => Number(a.height) - Number(b.height) || Number(a.bandwidth) - Number(b.bandwidth))[0]
}

/**
 * 直接用 B站 接口下一条视频：view 拿 cid → playurl(fnval=16) 拿 dash 流 → 分片下载 → ffmpeg 合成 mp4。
 * 这样 B站 视频不需要 yt-dlp（yt-dlp 只留给非 B站 的站外链接）。
 */
async function biliDashDownload(ref, dir, cred, log = () => {}) {
  const bvid = ref.bvid
  const view = await biliJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), cred)
  const cid = Number(view?.cid) || 0
  if (cid === 0) throw new Error('拿不到 cid')
  const pl = await biliJson(
    'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + '&qn=64&fnval=16&fourk=1&platform=pc',
    cred,
  )
  const dash = pl?.dash
  const videos = Array.isArray(dash?.video) ? dash.video.filter((v) => typeof v.baseUrl === 'string' && v.baseUrl !== '') : []
  if (videos.length === 0) throw new Error('没有 dash 流（付费、地区限制，或接口改了）')
  const video = pickDashStream(videos, 480)
  const audios = Array.isArray(dash.audio) ? dash.audio.filter((a) => typeof a.baseUrl === 'string' && a.baseUrl !== '') : []
  const audio = audios.sort((a, b) => Number(a.bandwidth) - Number(b.bandwidth))[0]

  log('info', '[video] 直连下载 ' + bvid + ' ' + (video.height || '?') + 'p' + (audio ? ' + 音轨' : '（无音轨）'))
  const vPath = join(dir, 'v.m4s')
  const aPath = join(dir, 'a.m4s')
  await fetchToFile(video.baseUrl, vPath, cred)
  if (audio) {
    try {
      await fetchToFile(audio.baseUrl, aPath, cred)
    } catch (e) {
      log('warn', '[video] 音轨没下成，先出无声版：' + String(e?.message || e))
    }
  }
  if (!FFMPEG) throw new Error('合并音视频需要 ffmpeg，但没找到')
  const out = join(dir, 'v.mp4')
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', vPath]
  if (existsSync(aPath)) args.push('-i', aPath, '-c:v', 'copy', '-c:a', 'copy')
  else args.push('-c:v', 'copy', '-an')
  args.push('-movflags', '+faststart', out)
  await run(FFMPEG, args, { timeoutMs: 180_000 })
  try { rmSync(vPath) } catch { /* 删不掉算了 */ }
  try { rmSync(aPath) } catch { /* 删不掉算了 */ }
  if (!existsSync(out)) throw new Error('合成了但没看到文件')
  return out
}

async function download(ref, dir, log) {
  // 本地文件直接用，不过 yt-dlp（拿路径当 URL 会报 Unsupported url scheme）
  if (ref.kind === 'file') {
    if (!existsSync(ref.file)) throw new Error('本地文件不存在：' + ref.file)
    return ref.file
  }
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).find((f) => /^v\.(mp4|mkv|webm|flv)$/.test(f))
  if (existing) return join(dir, existing)
  // B站 优先走自己的接口：不依赖 yt-dlp，也不会因为 yt-dlp 版本旧就下不动
  if (ref.kind === 'bili') {
    try {
      return await biliDashDownload(ref, dir, readCred(), log)
    } catch (e) {
      log('warn', '[video] B站 直连没成，改用 yt-dlp：' + String(e?.message || e))
    }
  }
  const target = ref.kind === 'file' ? ref.file : ref.url
  if (!YTDLP) throw new Error('下载站外视频需要 yt-dlp（B站 视频不用）：请装 yt-dlp 或填 BUBBLE_YTDLP')
  log('info', '[video] 下载 ' + String(target).slice(0, 80))
  await run(YTDLP, [
    // 竖屏视频的长边在 height 里（854/1280/1920），只筛 height<=480 会一个都选不到
    // （BV1nWxZ6AE8E 就是：最低一档 358x640）。先按高度、再按宽度、最后兜底最省的那档。
    '-f', 'bv*[height<=480]+ba/bv*[width<=480]+ba/bv*+ba/b',
    '--no-playlist', '--no-warnings', '--no-progress',
    '-o', join(dir, 'v.%(ext)s'), target,
  ], { timeoutMs: 300_000 })
  const file = readdirSync(dir).find((f) => /^v\.(mp4|mkv|webm|flv)$/.test(f))
  if (!file) throw new Error('下载完了没找到文件')
  return join(dir, file)
}

async function durationOf(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 20_000 })
  return Number(out.trim()) || 0
}

/** 把整条音轨转成文字（只给没有字幕轨的视频用；一次模型加载跑完所有片段）。 */
async function transcribeAudio(file, dir, duration, { maxSec = 300, chunkSec = 60, log = () => {} } = {}) {
  if (!existsSync(ASR_PY) || !existsSync(ASR_SCRIPT)) {
    log('warn', '[video] 找不到转写用的 python 或 听写.py，声音这层跳过')
    return ''
  }
  const limit = Math.min(duration > 0 ? duration : maxSec, maxSec)
  if (limit < 1) return ''
  const wav = join(dir, 'asr.wav')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-y', wav], { timeoutMs: 180_000 })
  const chunks = []
  for (let t = 0; t < limit; t += chunkSec) {
    const part = join(dir, 'asr_' + Math.round(t) + '.wav')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(Math.min(chunkSec, limit - t)), '-i', wav, '-y', part], { timeoutMs: 60_000 })
    chunks.push(part)
  }
  if (chunks.length === 0) return ''
  // 一次调用传所有片段：模型只加载一次，比一段一段跑省掉十几次加载。
  const { out } = await run(ASR_PY, [ASR_SCRIPT, ...chunks], { timeoutMs: 900_000 })
  let text = out
    .split(/\r?\n/)
    .filter((line) => line.startsWith('TEXT='))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== '' && line !== '-')
    .join(' ')
  // whisper 在没人说话时会脑补片尾语（「請訂閱…頻道」这类），别当真
  // whisper 在没人说话时会脑补片尾语（「請訂閱…頻道」这类）或干脆吐「(空)」，别当真
  const clean = text.replace(/\((?:空|音樂|音乐|掌声|笑聲)\)/gu, ' ').replace(/\s+/g, ' ').trim()
  const junk = /請訂閱|请订阅|訂閱|订阅|字幕由|字幕組|谢谢观看|感謝觀看|thanks for watching|amara\.org/i
  // 复读机：同一段 6 个字以上原样出现两次，基本是脑补（真说话不会完美复读）
  if (/(.{6,30}?)\1/.test(clean.replace(/\s+/g, ''))) return ''
  const han = (clean.match(/\p{Script=Han}/gu) ?? []).length
  const latin = (clean.match(/[A-Za-z]/g) ?? []).length
  // 中文要够 4 个字、英文要够 40 个字母，否则当成脑补（真说话不会这么短）
  if (junk.test(clean) || (han < 4 && latin < 40)) return ''
  text = clean
  for (const part of chunks) { try { rmSync(part) } catch { /* 删不掉算了 */ } }
  try { rmSync(wav) } catch { /* 删不掉算了 */ }
  const trimmed = text.trim()
  if (trimmed === '') return ''
  return limit < (duration || 0) - 1
    ? trimmed + '（只转写了前 ' + Math.round(limit / 60) + ' 分钟）'
    : trimmed
}

/** 宫格数（老算法，留着给设置页显示用）。 */
export function gridCountFor(depth, duration, config) {
  const base = Math.max(3, Math.min(10, Number(depth === 'deep' ? (config.videoDeepGrids ?? 6) : (config.videoGrids ?? 3)) || (depth === 'deep' ? 6 : 3)))
  if (!(duration > 0)) return base
  if (duration > 900) return 10
  const perSec = depth === 'deep' ? 90 : 120
  return Math.max(base, Math.min(10, Math.ceil(duration / perSec)))
}

/**
 * 抽帧时刻：先切镜头 → 再看每个镜头里画面动了多少 → 按变化量分帧，全片铺满。
 * 静止的段落少给帧，一直在动的段落多给帧；镜头比帧预算多就均匀丢镜头。
 * @param duration 秒
 * @param cuts 场景切点（秒）
 * @param maxGrids 宫格上限
 * @param motion [{t,s}] 逐帧变化分（0~1），没有就退回按时长分
 */
export function sampleTimes(duration, cuts, maxGrids = 10, motion = []) {
  const total = Number(duration) > 0 ? Number(duration) : 0
  if (!(total > 0.4)) return []
  const budget = Math.min(Math.max(9, Math.min(90, (Number(maxGrids) || 10) * 9)), Math.max(9, Math.ceil(total)))
  const inner = (Array.isArray(cuts) ? cuts : []).filter((t) => t > 0.4 && t < total - 0.4).sort((a, b) => a - b)
  const bounds = [0, ...inner, total]
  let shots = []
  for (let i = 0; i < bounds.length - 1; i += 1) shots.push([bounds[i], bounds[i + 1]])
  shots = shots.filter(([a, b]) => b - a >= 0.4)
  if (shots.length === 0) shots = [[0, total]]
  if (shots.length > budget) {
    shots = Array.from({ length: budget }, (_, k) => shots[Math.round((k * (shots.length - 1)) / (budget - 1))])
  }
  const marks = (Array.isArray(motion) ? motion : []).filter((m) => Number.isFinite(m.t) && Number.isFinite(m.s) && m.s > 0)
  // 每个镜头的「变化量」；没有变化分就退回按时长
  const weights = shots.map(([a, b]) => {
    if (marks.length === 0) return b - a
    let sum = 0
    for (const m of marks) if (m.t >= a && m.t < b) sum += m.s
    return sum > 0 ? sum : 0.01
  })
  const counts = shots.map(() => 1)
  const left = budget - shots.length
  if (left > 0) {
    const sum = weights.reduce((x, y) => x + y, 0) || 1
    const exact = weights.map((w) => (w / sum) * left)
    const base = exact.map((e) => Math.floor(e))
    const used = base.reduce((x, y) => x + y, 0)
    const order = exact.map((e, i) => ({ i, r: e - base[i] })).sort((x, y) => y.r - x.r)
    for (let k = 0; k < left - used && order.length > 0; k += 1) base[order[k % order.length].i] += 1
    for (let i = 0; i < counts.length; i += 1) counts[i] += base[i]
  }
  const times = []
  for (let i = 0; i < shots.length; i += 1) {
    const [a, b] = shots[i]
    const n = counts[i]
    const len = b - a
    const inside = marks.filter((m) => m.t >= a && m.t < b)
    const mass = inside.reduce((x, m) => x + m.s, 0)
    if (n === 1 || inside.length === 0 || mass <= 0) {
      for (let k = 0; k < n; k += 1) times.push(Number((a + (len * (k + 0.5)) / n).toFixed(2)))
      continue
    }
    // 按「变化量累计」切 n 等份：动作密集的地方自然多落几帧
    let acc = 0
    let next = mass / n
    const picked = []
    for (const m of inside) {
      acc += m.s
      while (picked.length < n - 1 && acc >= next) {
        picked.push(m.t)
        next += mass / n
      }
    }
    while (picked.length < n - 1) picked.push(a + (len * (picked.length + 1)) / n)
    const cell = [a, ...picked, b]
    for (let k = 0; k < n; k += 1) {
      const at = cell[k] + (cell[k + 1] - cell[k]) * 0.5
      times.push(Number(Math.min(b - 0.05, Math.max(a, at)).toFixed(2)))
    }
  }
  // 挨太近的两帧长得一样，白花钱
  const out = []
  for (const t of times) if (out.length === 0 || t - out[out.length - 1] >= 0.12) out.push(t)
  // 去重后不够预算就从最大的空当里补，别让一次动静多就少出一格
  while (out.length > 1 && out.length < budget) {
    let best = -1
    let gap = 0
    for (let i = 0; i < out.length - 1; i += 1) {
      const g = out[i + 1] - out[i]
      if (g > gap) { gap = g; best = i }
    }
    if (best < 0 || gap < 0.4) break
    out.splice(best + 1, 0, Number(((out[best] + out[best + 1]) / 2).toFixed(2)))
  }
  return out
}

/** 把一串时刻切成每 9 个一格（不够 9 个就用最后一帧补）。 */
export function gridChunks(times) {
  const list = Array.isArray(times) ? times : []
  if (list.length === 0) return []
  const chunks = []
  for (let i = 0; i < list.length; i += 9) {
    const chunk = list.slice(i, i + 9)
    if (chunk.length < 9) {
      // 末尾不够 9 帧：在这几个时刻之间均匀补满，别拿同一帧重复贴（模型会以为画面停住了）
      const from = chunk[0]
      const to = chunk[chunk.length - 1]
      const span = Math.max(1, to - from)
      const filled = []
      for (let k = 0; k < 9; k += 1) filled.push(Number((from + (span * k) / 8).toFixed(2)))
      chunks.push(filled)
    } else {
      chunks.push(chunk)
    }
  }
  return chunks
}

/** 采样方案版本：改了抽帧规则就换一个，别让老缓存盖住新结果。 */
const SAMPLE_VER = 'sec3-motion-audio-v4-s2'
// 提示词换了要加一档，旧的看视频结论自动作废（11-13：缓存键里一直没有模型名）
const PROMPT_VER = 'v1'

/** 场景切点（秒）。没有切点就返回空数组。 */
async function sceneCuts(file) {
  try {
    const { err } = await run(FFMPEG, ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { timeoutMs: 120_000 })
    const times = []
    for (const line of err.split(/\r?\n/)) {
      const m = /pts_time:\s*([0-9.]+)/.exec(line)
      if (m === null) continue
      const t = Number(m[1])
      if (Number.isFinite(t) && t > 0.5) times.push(t)
    }
    return times.sort((a, b) => a - b)
  } catch {
    return []
  }
}

/** 逐帧变化分（缩到 64×36 灰度再比，和 See Now 一个思路）：先看画面变化，再决定帧率。 */
export async function motionProfile(file) {
  try {
    const { out } = await run(FFMPEG, ['-hide_banner', '-i', file, '-an',
      '-vf', "fps=4,scale=64:36,format=gray,select='gte(scene,0)',metadata=print:file=-",
      '-f', 'null', '-'], { timeoutMs: 120_000 })
    const list = []
    let at = 0
    for (const line of String(out).split(/\r?\n/)) {
      const t = /pts_time:([0-9.]+)/.exec(line)
      if (t !== null) { at = Number(t[1]); continue }
      const v = /lavfi\.scene_score=([0-9.]+)/.exec(line)
      if (v !== null) list.push({ t: at, s: Number(v[1]) })
    }
    return list
  } catch {
    return []
  }
}

/** 音量曲线（每 0.1 秒一个 RMS，dB）：画成图底下那条带子，一眼看出哪里在说话。 */
export async function audioLevels(file) {
  try {
    const { out } = await run(FFMPEG, ['-hide_banner', '-i', file, '-vn',
      '-af', 'aresample=8000,asetnsamples=n=800,astats=metadata=1:reset=1,ametadata=print:file=-',
      '-f', 'null', '-'], { timeoutMs: 120_000 })
    const levels = []
    for (const line of String(out).split(/\r?\n/)) {
      const m = /lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-inf)/.exec(line)
      if (m !== null) levels.push(m[1] === '-inf' ? -70 : Number(m[1]))
    }
    return levels
  } catch {
    return []
  }
}

/** 在宫格底下画一条音轨：柱子越高越响，灰块是静音，白线是镜头切换。画不上就算了。 */
export async function drawLevelStrip(imgPath, levels, duration, cuts) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const img = await loadImage(imgPath)
  const stripH = 18
  const canvas = createCanvas(img.width, img.height + stripH)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0b0d10'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)
  const y0 = img.height + 3
  const hMax = 12
  for (let x = 0; x < canvas.width; x += 1) {
    const t = canvas.width <= 1 ? 0 : (x / (canvas.width - 1)) * duration
    const idx = levels.length === 0 ? 0 : Math.min(levels.length - 1, Math.max(0, Math.floor(t / 0.1)))
    const level = levels.length === 0 ? -70 : levels[idx]
    // 人声大概落在 -35~-10 dB，按这个区间铺满整条，安静的地方才看得出是空的
    const norm = Math.max(0, Math.min(1, (level + 45) / 35))
    const h = Math.max(level <= -45 ? 1 : 2, Math.round(norm * hMax))
    ctx.fillStyle = level <= -45 ? '#33383f' : (norm > 0.75 ? '#60a5fa' : '#2563eb')
    ctx.fillRect(x, y0 + (hMax - h), 1, h)
  }
  for (const c of Array.isArray(cuts) ? cuts : []) {
    const x = Math.round((c / Math.max(0.1, duration)) * (canvas.width - 1))
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.fillRect(x, y0, 2, hMax)
  }
  writeFileSync(imgPath, canvas.toBuffer('image/png'))
}

/** 抠一帧出来。 */
async function still(file, at, out) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', file,
    '-frames:v', '1', '-vf', 'scale=384:-2', '-y', out], { timeoutMs: 20_000 })
}

/** 九帧拼一张九宫格（384 宽、3×3）。 */
async function grid(file, times, dir, tag, paint) {
  const cells = []
  for (let i = 0; i < 9; i += 1) {
    const p = join(dir, tag + '_' + i + '.png')
    await still(file, times[i], p)
    cells.push(p)
  }
  const out = join(dir, tag + '.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', join(dir, tag + '_%d.png'),
    '-vf', 'tile=3x3:padding=4:margin=4:color=black', '-frames:v', '1', '-y', out], { timeoutMs: 30_000 })
  for (const p of cells) { try { rmSync(p) } catch { /* 删不掉就算了 */ } }
  if (paint && Array.isArray(paint.levels) && paint.levels.length > 0) {
    try {
      await drawLevelStrip(out, paint.levels, paint.duration, paint.cuts)
    } catch { /* 画不上就算了，图照给 */ }
  }
  return { img: out, times }
}

/** 把模型说的「第N格」换算成秒，省得姐姐自己数格子。 */
function mapCellTimes(text, times) {
  if (!Array.isArray(times) || times.length === 0) return text
  return String(text).replace(/第\s*(\d{1,2})\s*格/g, (whole, raw) => {
    const index = Number(raw) - 1
    const at = times[index]
    return Number.isFinite(at) ? '第' + raw + '格（' + mmss(at) + '）' : whole
  })
}

/** 视觉模型配置，全部来自 QQ 插件设置；没配就报清楚，别拿默认模型硬跑。 */
function visionPlan(config) {
  const primary = {
    model: String(config.videoVisionModel || config.visionModel || '').trim(),
    baseURL: String(config.videoVisionBaseUrl || config.visionBaseUrl || '').trim(),
    apiKeyEnv: String(config.videoVisionApiKeyEnv || config.visionApiKeyEnv || '').trim(),
  }
  if (primary.model === '' || primary.baseURL === '' || primary.apiKeyEnv === '') {
    throw new Error('还没配看视频的视觉模型：设置页里填「视觉模型 / 网关 / 凭证名」（videoVisionModel / videoVisionBaseUrl / videoVisionApiKeyEnv）')
  }
  return { primary }
}

/** 去掉模型爱包的壳（<answer>、代码块、多余空行）。 */
function cleanLook(text) {
  return String(text)
    .replace(/^\s*<answer>\s*/i, '')
    .replace(/\s*<\/answer>\s*$/i, '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 问一张图，一次只问一件事；空正文就把预算翻倍重试（不再换备选模型，2026-11-13 删掉）。
 * @returns {{text: string, model: string, ms: number}}
 */
async function ask(imagePath, prompt, plan, options, log) {
  const baseTokens = Math.max(1200, Number(options.maxTokens) || 8000)
  const timeoutMs = Math.max(20_000, Number(options.timeoutMs) || 120_000)
  const attempts = [
    { target: plan.primary, tokens: baseTokens },
    { target: plan.primary, tokens: Math.min(16_000, baseTokens * 2) },
  ]
  const buffer = imagePath === null || imagePath === undefined ? null : readFileSync(imagePath)
  let lastError = ''
  for (const attempt of attempts) {
    if (attempt.target.model === '' || attempt.target.model === undefined) continue
    const apiKey = resolveApiKey(attempt.target.apiKeyEnv)
    const t0 = Date.now()
    try {
      const text = await describeImage(buffer, {
        baseURL: attempt.target.baseURL,
        model: attempt.target.model,
        apiKey,
        maxTokens: attempt.tokens,
        timeoutMs,
        maxChars: 2600,
        detail: 'low',
        headers: options.headers,
        prompt,
        log,
      })
      if (text !== '') return { text: cleanLook(text), model: attempt.target.model, ms: Date.now() - t0 }
      lastError = '正文空（' + attempt.target.model + '，' + attempt.tokens + ' tokens）'
    } catch (e) {
      const message = e?.message ?? String(e)
      lastError = attempt.target.model + '：' + message
      log('warn', '[video] 识图失败：' + lastError)
      if (/429|too many|rate limit|频率/i.test(message)) {
        slowMode = true
        await sleep(2000)
      }
    }
  }
  throw new Error('画面没看出来：' + lastError)
}

/** 并发池：最多 limit 个同时跑，结果按原顺序放回。 */
async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function readCache() {
  try {
    const j = JSON.parse(readFileSync(cacheFile(), 'utf8'))
    if (j !== null && typeof j === 'object') return j
  } catch { /* 没有就算了 */ }
  return {}
}

function writeCache(key, evidence, days) {
  const all = readCache()
  all[key] = { at: new Date().toISOString(), ttlDays: days, evidence }
  const keys = Object.keys(all)
  if (keys.length > 80) {
    for (const k of keys.slice(0, keys.length - 80)) delete all[k]
  }
  try {
    mkdirSync(join(dshHome(), 'bubble'), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(all), 'utf8')
  } catch { /* 写不进去不影响这一轮 */ }
}

/**
 * 看一条视频，返回能读的证据。
 * @param input - 链接 / BV / 本地文件。
 * @param options.depth - quick（只字幕）| normal（3 宫格 + 2 单帧）| deep（6 宫格 + 4 单帧）。
 * @param options.config - QQ 插件配置（videoVision* / videoGrids / videoDeepFrames / videoCacheDays）。
 * @param options.log - (level, msg) => void。
 * @returns {{id, title, duration, subtitle, looks: Array, evidence, cached, ms}}
 */
/**
 * 外部程序都找到了没——给「检查环境」用，和真正跑的时候同一套解析逻辑。
 * 返回 null 表示没找到。
 */
export function toolPaths() {
  return {
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    ytdlp: YTDLP,
    python: ASR_PY,
    asrScript: ASR_SCRIPT,
    bundledAsr: join(pkgRoot, 'assets', 'asr', 'transcribe.py'),
  }
}

/**
 * 只下载、不看：返回本地文件路径。给调试和「先下好再慢慢看」用。
 * 走的是和 lookVideo 完全一样的 download()，所以 B站 也是直连、不用 yt-dlp。
 */
export async function downloadVideo(input, options = {}) {
  const ref = parseRef(input)
  const dir = join(workRoot(), idOf(ref))
  return download(ref, dir, typeof options.log === 'function' ? options.log : () => {})
}

export async function lookVideo(input, options = {}) {
  const depth = options.depth === 'quick' || options.depth === 'deep' ? options.depth : 'normal'
  const config = options.config || {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  slowMode = false
  const t0 = Date.now()
  const ref = parseRef(input)
  const id = idOf(ref)
  const days = Math.max(0, Number(config.videoCacheDays ?? 7) || 0)
  const maxGrids = Math.max(1, Math.min(10, Number(depth === 'deep' ? (config.videoDeepGrids ?? 10) : (config.videoGrids ?? 5)) || 10))
  // 换视觉模型 / 换提示词以后，旧结论不能再算数：键里带上模型和提示词版本
  const visionTag = String(config.videoVisionModel || config.visionModel || 'none').trim().replace(/\|/g, '_') || 'none'
  const cacheKey = id + '|' + depth + '|' + SAMPLE_VER + '|g' + maxGrids + '|m' + visionTag + '|p' + PROMPT_VER
  // 顺手清老视频文件（默认留 15 天）；清不动不影响这次看
  try { sweepWork(Math.max(1, Number(config.videoWorkDays ?? 15) || 15)) } catch { /* 清不动就算了 */ }

  const all = readCache()
  const hit = all[cacheKey]
  if (hit && days > 0 && (Date.now() - Date.parse(hit.at)) < days * 86_400_000) {
    return { ...hit.evidence, id, cached: true, ms: 0 }
  }

  const dir = join(workRoot(), id)
  const cred = ref.kind === 'bili' ? readCred() : null
  let meta = { title: '', duration: 0, owner: '', bvid: ref.bvid || '' }

  // 下载和拉字幕同时跑：下载要 3~5 秒，字幕 0.3 秒，串着做白等
  const downloadPromise = depth === 'quick' ? null : download(ref, dir, log)

  let subtitle = ''
  if (ref.kind === 'bili') {
    try {
      meta = await biliMeta(ref.bvid, cred)
    } catch (e) {
      log('warn', '[video] ' + (e?.message ?? e))
    }
    if (cred !== null) {
      try {
        subtitle = await subtitleText(ref.bvid, cred, '', 2000)
      } catch (e) {
        log('warn', '[video] 字幕没取到：' + (e?.message ?? e))
      }
    }
  }

  if (depth === 'quick') {
    const evidence = buildEvidence(meta, subtitle, [])
    writeCache(cacheKey, { title: meta.title, duration: meta.duration, subtitle, looks: [], evidence }, days)
    return { id, title: meta.title, duration: meta.duration, subtitle, looks: [], evidence, cached: false, ms: Date.now() - t0 }
  }

  const file = await downloadPromise
  const duration = meta.duration > 0 ? meta.duration : await durationOf(file)
  // 没字幕轨就上声音通道（转写和抽帧同时跑，不额外多等）
  const asrPromise = subtitle === '' && config.videoAsr !== false
    ? transcribeAudio(file, dir, duration, {
      maxSec: Math.max(30, Number(config.videoAsrMaxSec ?? 300) || 300),
      log,
    }).catch((e) => { log('warn', '[video] 转写失败：' + (e?.message ?? e)); return '' })
    : Promise.resolve('')
  const cuts = await sceneCuts(file)
  // 先看画面变化（变化分），再决定帧率：安静的段落少给帧，动的段落多给帧
  const motion = config.videoMotion === false ? [] : await motionProfile(file)
  const levels = config.videoAudioStrip === false ? [] : await audioLevels(file)
  const plan = visionPlan(config)
  const chunks = gridChunks(sampleTimes(duration, cuts, maxGrids, motion))
  const frameCount = Math.max(0, Math.min(10, Number(depth === 'deep' ? (config.videoDeepFrames ?? 4) : (config.videoFrames ?? 2)) || 0))
  const gridPrompt = '这是同一段视频里按时间连续的九帧：左到右、上到下，编号 1 到 9。逐格写，一格一行，格式「第N格：<是谁> | <在哪> | <在做什么、动作怎么变> | <表情情绪> | <画面氛围或镜头，比如逆光、俯拍、一片安静>」；是谁能认出来就写名字或身份（角色名、职业、up 主），认不出就照外表写（比如「蓝发双马尾的女孩」），**不许瞎猜名字**。每格 80 字以内，宁可写细别写空。九格写完另起一行「过程：」，用 150 字说这九帧之间到底发生了什么——谁从哪到哪、关系怎么变、情绪怎么走、画面怎么切。不猜剧情，不用照抄画面上的字，全用中文写，别夹英文或其他语言的词。'
  const framePrompt = '这一帧画面写详细一点：画面里是谁（能认出来就写名字或身份，认不出照外表写，别瞎猜）、在哪、在做什么、什么表情或姿势、手上身上有什么变化、光线和环境什么氛围、镜头是什么角度。160 字以内。不猜剧情，不用照抄画面上的字。'

  const looks = []
  const tasks = []
  for (let i = 0; i < chunks.length; i += 1) {
    const times = chunks[i]
    const g = await grid(file, times, dir, 'g' + i, { levels, duration, cuts })
    tasks.push({ kind: 'grid', from: times[0], to: times[times.length - 1], img: g.img, times: g.times, prompt: gridPrompt })
  }
  for (let i = 0; i < frameCount; i += 1) {
    const at = duration * ((i + 0.5) / frameCount)
    const img = join(dir, 'f' + i + '.png')
    await still(file, at, img)
    tasks.push({ kind: 'frame', at, img, prompt: framePrompt })
  }

  // 并发问（默认 3 张一起），不然一张一张等，一条视频要一分半。
  const concurrency = slowMode ? 1 : Math.max(1, Math.min(5, Number(config.videoConcurrency) || 3))
  const askOptions = { maxTokens: config.videoVisionMaxTokens, timeoutMs: config.videoVisionTimeoutMs, headers: parseHeaderJson(config.videoVisionHeaders || config.visionHeaders) }
  const answered = await pool(tasks, concurrency, async (task) => {
    try {
      const res = await ask(task.img, task.prompt, plan, askOptions, log)
      const text = task.kind === 'grid' ? mapCellTimes(res.text, task.times) : res.text
      return { ...task, text, model: res.model, ms: res.ms }
    } catch (e) {
      return { ...task, text: '', error: String(e?.message ?? e) }
    }
  })
  // 网关偶尔抽风（503 quota service unavailable），隔几秒补问一次，别让一格白丢
  for (let round = 0; round < 2; round += 1) {
    const hole = answered.find((x) => x.text === '' && /50[0-9]|quota|429|timeout|超时/i.test(String(x.error ?? '')))
    if (hole === undefined) break
    await new Promise((r) => setTimeout(r, 4000))
    for (const item of answered) {
      if (item.text !== '' || !/50[0-9]|quota|429|timeout|超时/i.test(String(item.error ?? ''))) continue
      try {
        const res = await ask(item.img, item.prompt, plan, askOptions, log)
        item.text = item.kind === 'grid' ? mapCellTimes(res.text, item.times) : res.text
        item.model = res.model
        item.ms = res.ms
        delete item.error
      } catch (e) {
        item.error = String(e?.message ?? e)
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  for (const item of answered) looks.push(item)

  // 看完了再问一遍：这条在讲什么、哪一幕最值得发（模型自己看，比文字描述准）
  let summary = ''
  if (config.videoSummary !== false) {
    const seen = looks.filter((x) => x.text !== '')
    if (seen.length > 0) {
      const digest = seen.map((x) => (x.kind === 'grid' ? '[' + mmss(x.from) + '-' + mmss(x.to) + ']' : '[' + mmss(x.at) + ']') + x.text).join('\n').slice(0, 6000)
      const q = '下面是你刚才逐帧看一条视频记下的观察。只根据这些观察回答三件事，一共 150 字以内，别客套、别复述观察：①这条视频在讲什么（一两句）②最值得发给朋友看的是哪一幕（说出时间点）③值不值得发，为什么。别给人物安名字，认不出就用外形说（比如「蓝发女仆」），只写你从观察里看得到的。\n\n' + digest
      try {
        const r = await ask(null, q, plan, askOptions, log)
        summary = r.text
      } catch (e) {
        log('warn', '[video] 总结失败：' + (e?.message ?? e))
      }
    }
  }
  let base = buildEvidence({ ...meta, duration: duration || meta.duration }, subtitle, looks, await asrPromise, summary)
  const evidence = base + (levels.length > 0 && looks.length > 0
    ? '\n【音轨】宫格最底下那条是音量：柱子越高越响，灰块是静音，白线是镜头切换。'
    : '')
  // 一格都没看成（模型全失败）就别写缓存：否则以后一直命中一堆空结论
  const sawSomething = looks.some((x) => String(x?.text ?? '') !== '')
  if (sawSomething) writeCache(cacheKey, { title: meta.title, duration, subtitle, looks, evidence }, days)
  return { id, title: meta.title, duration, subtitle, looks, evidence, cached: false, ms: Date.now() - t0 }
}

function buildEvidence(meta, subtitle, looks, asr = '', summary = '') {
  const lines = []
  const title = meta.title || '（没有标题）'
  lines.push('【视频】' + title + (meta.owner ? '｜UP：' + meta.owner : '') + '｜' + mmss(meta.duration))
  if (subtitle !== '') lines.push('【字幕】' + subtitle)
  else if (asr !== '') lines.push('【口播】' + asr)
  else lines.push('【字幕】（没有字幕轨，声音也没转出来）')
  if (looks.length > 0) {
    const seen = looks.filter((l) => l.text !== '').length
    if (summary !== '') lines.push('【概括】' + summary)
    lines.push('【看清】' + seen + '/' + looks.length + ' 张' + (seen === looks.length ? '' : '（没答出来的那几张别装作看见了）'))
  }
  for (const look of looks) {
    if (look.text === '') {
      lines.push('【画面 ' + mmss(look.from ?? look.at) + (look.kind === 'grid' ? '-' + mmss(look.to) : '') + '】（' + String(look.error ?? '空').replace(/^画面没看出来：/, '') + '）')
      continue
    }
    lines.push('【画面 ' + mmss(look.from ?? look.at) + (look.kind === 'grid' ? '-' + mmss(look.to) : '') + '】' + look.text)
  }
  return lines.join('\n')
}

/** 清理太老的视频工作目录（默认 7 天）。 */
export function sweepWork(days = 7) {
  const root = workRoot()
  if (!existsSync(root)) return 0
  let removed = 0
  const limit = Date.now() - days * 86_400_000
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try {
      if (statSync(p).mtimeMs < limit) { rmSync(p, { recursive: true, force: true }); removed += 1 }
    } catch { /* 删不掉就算了 */ }
  }
  return removed
}