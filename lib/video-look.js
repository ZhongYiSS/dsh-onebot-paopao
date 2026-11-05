/**
 * 看视频 —— 把一条视频变成「能读的证据」。
 * ============================================================================
 * 两条通道：字幕轨（文字，快）+ 抽帧宫格（画面，慢）。
 * 声音通道（ASR）还没接，先不做。
 *
 * 只产出证据，不写一句话（红线：会话自己说）。
 * 视觉模型由配置决定：默认 Sage-A1.5、备选 Agents-A1 —— 不许自己换模型。
 * ============================================================================
 * @module dsh-onebot/video-look
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describeImage, resolveApiKey } from './vision.js'
import { readCred, subtitleText } from './companion/adapters/bili.mjs'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const workRoot = () => join(dshHome(), 'bubble', 'video-work')
const cacheFile = () => join(dshHome(), 'bubble', 'video-cache.json')

const FIRST_BIN = (envName, list) => {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  for (const p of list) if (p && existsSync(p)) return p
  return list[0]
}

const FFMPEG = FIRST_BIN('BUBBLE_FFMPEG', [
  'C:/Users/hb109/.dsh/tools/ffmpeg/bin/ffmpeg.exe',
  'C:/Users/hb109/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/ffmpeg/ffmpeg.exe',
])
const FFPROBE = FIRST_BIN('BUBBLE_FFPROBE', [
  'C:/Users/hb109/.dsh/tools/ffmpeg/bin/ffprobe.exe',
  'C:/Users/hb109/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/ffmpeg/ffprobe.exe',
])
const YTDLP = FIRST_BIN('BUBBLE_YTDLP', [
  'C:/Users/hb109/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/Scripts/yt-dlp.exe',
  'C:/Users/hb109/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/Scripts/yt-dlp',
])

/** 跑一个子进程，收 stdout/stderr；超时就杀。 */
function run(bin, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经死了 */ }
      reject(new Error('超时 ' + timeoutMs + 'ms：' + bin))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ out, err })
      else reject(new Error(bin.split(/[\\/]/).pop() + ' 退出 ' + code + '：' + err.replace(/\s+/g, ' ').slice(-300)))
    })
  })
}

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
async function download(ref, dir, log) {
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).find((f) => /^v\.(mp4|mkv|webm|flv)$/.test(f))
  if (existing) return join(dir, existing)
  const target = ref.kind === 'file' ? ref.file : ref.url
  log('info', '[video] 下载 ' + String(target).slice(0, 80))
  await run(YTDLP, [
    '-f', 'bv*[height<=480]+ba/b[height<=480]/b',
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

/** 抠一帧出来。 */
async function still(file, at, out) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', file,
    '-frames:v', '1', '-vf', 'scale=384:-2', '-y', out], { timeoutMs: 20_000 })
}

/** 九帧拼一张九宫格（384 宽、3×3）。 */
async function grid(file, times, dir, tag) {
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
  return out
}

function pickTimes(start, end, cuts) {
  const times = []
  const inside = cuts.filter((t) => t > start && t < end)
  for (let i = 0; i < 9; i += 1) {
    const even = start + ((end - start) * (i + 0.5)) / 9
    // 有切点就优先贴着切点（画面刚变，信息多），没有就用均分。
    const near = inside.length === 0 ? null : inside.reduce((best, t) => (Math.abs(t - even) < Math.abs(best - even) ? t : best), inside[0])
    times.push(Math.min(end - 0.2, Math.max(start + 0.1, near ?? even)))
  }
  return times
}

/** 视觉模型配置（主 + 备），全部来自 QQ 插件设置。 */
function visionPlan(config) {
  const pick = (modelKey, urlKey, envKey, defModel, defUrl, defEnv) => ({
    model: config[modelKey] || defModel,
    baseURL: config[urlKey] || defUrl,
    apiKeyEnv: config[envKey] || defEnv,
  })
  const primary = pick('videoVisionModel', 'videoVisionBaseUrl', 'videoVisionApiKeyEnv',
    'Sage-A1.5', 'https://discovery-api.intern-ai.org.cn/v1', 'DUANYANG_API_KEY')
  const fallbackModel = config.videoVisionFallbackModel || 'Agents-A1'
  const fallback = {
    model: fallbackModel,
    baseURL: config.videoVisionFallbackBaseUrl || primary.baseURL,
    apiKeyEnv: config.videoVisionFallbackApiKeyEnv || primary.apiKeyEnv,
  }
  return { primary, fallback }
}

/** 去掉模型爱包的壳（<answer>、代码块、多余空行）。 */
function cleanLook(text) {
  return String(text)
    .replace(/^\s*<answer>\s*/i, '')
    .replace(/\s*<\/answer>\s*$/i, '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 问一张图，一次只问一件事；空正文就把预算翻倍重试，还空才换备选模型。
 * @returns {{text: string, model: string, ms: number}}
 */
async function ask(imagePath, prompt, plan, options, log) {
  const baseTokens = Math.max(1200, Number(options.maxTokens) || 8000)
  const timeoutMs = Math.max(20_000, Number(options.timeoutMs) || 120_000)
  const attempts = [
    { target: plan.primary, tokens: baseTokens },
    { target: plan.primary, tokens: Math.min(16_000, baseTokens * 2) },
    { target: plan.fallback, tokens: Math.min(16_000, baseTokens * 2) },
  ]
  const buffer = readFileSync(imagePath)
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
        maxChars: 700,
        detail: 'low',
        prompt,
        log,
      })
      if (text !== '') return { text: cleanLook(text), model: attempt.target.model, ms: Date.now() - t0 }
      lastError = '正文空（' + attempt.target.model + '，' + attempt.tokens + ' tokens）'
    } catch (e) {
      lastError = attempt.target.model + '：' + (e?.message ?? e)
      log('warn', '[video] 识图失败：' + lastError)
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

function writeCache(key, depth, evidence, days) {
  const all = readCache()
  all[key + '|' + depth] = { at: new Date().toISOString(), ttlDays: days, evidence }
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
export async function lookVideo(input, options = {}) {
  const depth = options.depth === 'quick' || options.depth === 'deep' ? options.depth : 'normal'
  const config = options.config || {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const t0 = Date.now()
  const ref = parseRef(input)
  const id = idOf(ref)
  const days = Math.max(0, Number(config.videoCacheDays ?? 7) || 0)

  const all = readCache()
  const hit = all[id + '|' + depth]
  if (hit && days > 0 && (Date.now() - Date.parse(hit.at)) < days * 86_400_000) {
    return { ...hit.evidence, id, cached: true, ms: 0 }
  }

  const dir = join(workRoot(), id)
  const cred = ref.kind === 'bili' ? readCred() : null
  let meta = { title: '', duration: 0, owner: '', bvid: ref.bvid || '' }

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
    writeCache(id, depth, { title: meta.title, duration: meta.duration, subtitle, looks: [] }, days)
    return { id, title: meta.title, duration: meta.duration, subtitle, looks: [], evidence, cached: false, ms: Date.now() - t0 }
  }

  const file = await download(ref, dir, log)
  const duration = meta.duration > 0 ? meta.duration : await durationOf(file)
  const cuts = await sceneCuts(file)
  const plan = visionPlan(config)
  const gridCount = Math.max(1, Math.min(10, Number(depth === 'deep' ? (config.videoDeepGrids ?? 6) : (config.videoGrids ?? 3)) || (depth === 'deep' ? 6 : 3)))
  const frameCount = Math.max(0, Math.min(10, Number(depth === 'deep' ? (config.videoDeepFrames ?? 4) : (config.videoFrames ?? 2)) || 0))
  const gridPrompt = '这是同一段视频里连续的九帧（左到右、上到下，按时间先后排）。只说画面里看得见的：谁、在哪、在做什么；画面上的字照抄。不猜剧情，90 字以内。'
  const framePrompt = '这一帧画面：谁、在哪、在做什么；画面上的字照抄。60 字以内。'

  const looks = []
  const tasks = []
  const windowSec = duration / gridCount
  for (let i = 0; i < gridCount; i += 1) {
    const start = i * windowSec
    const end = Math.min(duration, start + windowSec)
    if (end - start < 0.6) continue
    const img = await grid(file, pickTimes(start, end, cuts), dir, 'g' + i)
    tasks.push({ kind: 'grid', from: start, to: end, img, prompt: gridPrompt })
  }
  for (let i = 0; i < frameCount; i += 1) {
    const at = duration * ((i + 0.5) / frameCount)
    const img = join(dir, 'f' + i + '.png')
    await still(file, at, img)
    tasks.push({ kind: 'frame', at, img, prompt: framePrompt })
  }

  // 并发问（默认 3 张一起），不然一张一张等，一条视频要一分半。
  const concurrency = Math.max(1, Math.min(5, Number(config.videoConcurrency) || 3))
  const askOptions = { maxTokens: config.videoVisionMaxTokens, timeoutMs: config.videoVisionTimeoutMs }
  const answered = await pool(tasks, concurrency, async (task) => {
    try {
      const res = await ask(task.img, task.prompt, plan, askOptions, log)
      return { ...task, text: res.text, model: res.model, ms: res.ms }
    } catch (e) {
      return { ...task, text: '', error: String(e?.message ?? e) }
    }
  })
  for (const item of answered) looks.push(item)

  const evidence = buildEvidence(meta, subtitle, looks)
  writeCache(id, depth, { title: meta.title, duration, subtitle, looks }, days)
  return { id, title: meta.title, duration, subtitle, looks, evidence, cached: false, ms: Date.now() - t0 }
}

function buildEvidence(meta, subtitle, looks) {
  const lines = []
  const title = meta.title || '（没有标题）'
  lines.push('【视频】' + title + (meta.owner ? '｜UP：' + meta.owner : '') + '｜' + mmss(meta.duration))
  if (subtitle !== '') lines.push('【字幕】' + subtitle)
  else lines.push('【字幕】（没有字幕轨）')
  for (const look of looks) {
    if (look.text === '') {
      lines.push('【画面 ' + mmss(look.from ?? look.at) + (look.kind === 'grid' ? '-' + mmss(look.to) : '') + '】（没看出来：' + (look.error ?? '空') + '）')
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