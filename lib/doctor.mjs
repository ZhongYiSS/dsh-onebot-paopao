/**
 * 检查环境 —— 「缺什么、去哪儿补」摆一屏。
 * ============================================================================
 * 为什么要有它：插件能用和用得全是两回事。ffmpeg 没装 → 看视频抽不出帧；
 * yt-dlp 没装 → 站外链接下不动；看到一句「失败」用户不知道该装什么。
 * 这里只管查，不下载、不改系统。
 *
 * 等级：ok 绿色 / warn 黄色（能用但少一半）/ bad 红色（这条功能直接不能用）
 * ============================================================================
 * @module dsh-onebot/doctor
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toolPaths } from './video-look.js'
import { resolveNapcatDir, launcherPath, qrPath, parseTasklist } from './napcat.js'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

function which(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try {
        if (existsSync(p)) return p
      } catch { /* 无权限的目录跳过 */ }
    }
  }
  return null
}

/** tasklist 问一次 NapCat 的 PID（Windows 专有；别的平台回 0）。 */
function tasklistPid() {
  if (process.platform !== 'win32') return Promise.resolve(0)
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/FO', 'CSV', '/NH'],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => resolve(error ? 0 : parseTasklist(String(stdout ?? ''))),
    ).on('error', () => resolve(0))
  })
}

function runQuiet(bin, args, timeoutMs = 8000) {  return new Promise((resolve) => {
    if (!bin) return resolve({ code: -1, out: '' })
    const child = execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout ?? '') })
    })
    child.on('error', () => resolve({ code: -1, out: '' }))
  })
}

const WINGET_FFMPEG = 'winget install --id Gyan.FFmpeg -e'
const YTDLP_HINT = 'winget install --id yt-dlp.yt-dlp -e（或把 yt-dlp.exe 放到 PATH）'
const PY_HINT = '装 Python 3.10+，然后 pip install faster-whisper'

/**
 * 命令行版拿不到运行中的插件配置，就从 profile 的 cordis.patch.yml 里读一份。
 * 只认「- id: dsh-onebot」那一段里的 `键: 值` 简单标量（块标量 `|` 跳过），够用就行。
 */
export function readProfileConfig(home = dshHome()) {
  const out = {}
  const profiles = join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(profiles)
  } catch {
    return out
  }
  for (const name of names) {
    const f = join(profiles, name, 'cordis.patch.yml')
    if (!existsSync(f)) continue
    let text = ''
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    let inside = false
    let inConfig = false
    let blockIndent = -1
    for (const line of lines) {
      if (/^-\s*id:\s*dsh-onebot\s*$/.test(line)) {
        inside = true
        inConfig = false
        blockIndent = -1
        continue
      }
      if (inside && /^-\s/.test(line)) break // 下一个条目
      if (!inside) continue
      // 只认 config: 底下的键（上面的 disabled / 下面的嵌套都跳过）
      if (/^\s*config:\s*$/.test(line)) {
        inConfig = true
        blockIndent = -1
        continue
      }
      if (!inConfig) continue
      const m = /^(\s+)([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
      if (m === null) continue
      const indent = m[1].length
      if (blockIndent === -1) blockIndent = indent
      if (indent !== blockIndent) continue // 嵌套结构不管
      const key = m[2]
      const raw = m[3].trim()
      if (raw === '' || raw === '|' || raw === '>') continue
      out[key] = raw.replace(/^['"]|['"]$/g, '')
    }
    if (Object.keys(out).length > 0) return out
  }
  return out
}

export async function runDoctor({ config = {}, napcat = null, home = dshHome() } = {}) {
  const items = []
  const add = (id, label, level, detail, fix = '') => items.push({ id, label, level, detail, fix })

  // 1 宿主与 Node
  const nodeMajor = Number(String(process.versions.node).split('.')[0])
  add(
    'node',
    'Node 版本',
    nodeMajor >= 22 ? 'ok' : 'bad',
    'v' + process.versions.node + (nodeMajor >= 22 ? '（要求 ≥22）' : '（要求 ≥22）'),
    nodeMajor >= 22 ? '' : '升级 DSH 到自带 Node 22 的版本',
  )

  // 2 三个原生/关键依赖
  for (const [id, label, mod] of [
    ['ws', 'ws（QQ 长连接）', 'ws'],
    ['canvas', '@napi-rs/canvas（图片缩放/音轨条）', '@napi-rs/canvas'],
    ['fontkit', 'fontkit（中文文字转图）', 'fontkit'],
  ]) {
    try {
      await import(mod)
      add(id, label, 'ok', '已安装')
    } catch (e) {
      add(id, label, 'bad', '加载失败：' + String(e?.message || e).slice(0, 120), '重新安装插件（依赖会一起装）')
    }
  }

  // 3 ffmpeg / ffprobe —— 看视频抽帧、语音解码都靠它
  const tp = toolPaths()
  for (const [id, label, bin, hint] of [
    ['ffmpeg', 'ffmpeg（看视频抽帧、音频解码）', tp.ffmpeg, WINGET_FFMPEG],
    ['ffprobe', 'ffprobe（量时长）', tp.ffprobe, WINGET_FFMPEG],
  ]) {
    if (bin && existsSync(bin)) {
      const { code, out } = await runQuiet(bin, ['-version'])
      add(id, label, code === 0 ? 'ok' : 'warn', code === 0 ? bin + '（' + (out.split('\n')[0] || '').slice(0, 60) + '）' : bin + ' 跑不起来', code === 0 ? '' : hint)
    } else {
      add(id, label, 'bad', '没找到', hint)
    }
  }

  // 4 yt-dlp —— 只有站外视频才需要（B站 走自己的接口）
  if (tp.ytdlp && existsSync(tp.ytdlp)) {
    add('ytdlp', 'yt-dlp（站外视频下载）', 'ok', tp.ytdlp)
  } else {
    add('ytdlp', 'yt-dlp（站外视频下载）', 'warn', '没装（B站 视频不受影响）', YTDLP_HINT)
  }

  // 5 python + 转写脚本 + faster-whisper —— 没字幕的视频靠它
  const py = tp.python && existsSync(tp.python) ? tp.python : which('python')
  if (!py) {
    add('python', 'Python（无字幕视频听声音）', 'warn', '没找到', PY_HINT)
    add('asr', '听写依赖 faster-whisper', 'warn', '没有 Python，跳过', PY_HINT)
  } else {
    const script = tp.asrScript && existsSync(tp.asrScript) ? tp.asrScript : ''
    add('python', 'Python（无字幕视频听声音）', 'ok', py + (script ? ' + ' + script : ''), script ? '' : '缺转写脚本')
    const check = await runQuiet(py, ['-c', 'import faster_whisper, numpy; print("ok")'], 20000)
    const ok = check.code === 0 && check.out.includes('ok')
    add('asr', '听写依赖 faster-whisper', ok ? 'ok' : 'warn', ok ? '已装' : '这个 Python 里没有 faster-whisper', ok ? '' : 'pip install faster-whisper（当前解释器：' + py + '）')
  }

  // 6 whisper CLI —— QQ 语音转文字（另一条路）
  // 也可以用 sttEngine=custom 指到任意「命令 + {file}/{out}」的转写器（比如本机已有的
  // faster-whisper 薄封装），那种情况不该再报「没装」。
  const wcli = which('whisper-cli') || which('whisper') || which('mlx_whisper')
  const sttCustom = config.sttEngine === 'custom' && config.sttCommand !== ''
  const sttCustomOk = sttCustom && existsSync(config.sttCommand)
  add('whisper', 'whisper CLI（QQ 语音转文字）',
    (wcli || sttCustomOk) ? 'ok' : 'warn',
    wcli || (sttCustom ? '自定义引擎：' + config.sttCommand + (sttCustomOk ? '' : '（文件不存在）') : '没装（收到语音会显示成 [语音]）'),
    (wcli || sttCustomOk) ? '' : (sttCustom ? 'sttCommand 指的文件不在' : '装 whisper.cpp 或 openai-whisper 放到 PATH，或用 sttEngine: custom 指向自己的转写器'))

  // 7 B站 登录
  const credFile = join(home, 'bili-duty', 'bili_credential.json')
  let credOk = false
  let credWho = ''
  if (existsSync(credFile)) {
    try {
      const c = JSON.parse(readFileSync(credFile, 'utf8'))
      credOk = typeof c?.sessdata === 'string' && c.sessdata !== ''
      credWho = credOk ? 'UID ' + String(c.dedeuserid || '?') : ''
    } catch { /* 坏文件 */ }
  }
  add('bili', 'B站 登录', credOk ? 'ok' : 'warn', credOk ? '已登录 ' + credWho : '没登录（刷视频/看视频都用不了）', credOk ? '' : '设置页「B站 登录」扫码')

  // 8 视觉模型（识图 + 看视频）
  const visionKeys = ['visionModel', 'visionBaseUrl', 'visionApiKeyEnv']
  const missing = visionKeys.filter((k) => String(config[k] ?? '') === '')
  const videoMissing = ['videoVisionModel', 'videoVisionBaseUrl', 'videoVisionApiKeyEnv'].filter((k) => String(config[k] ?? '') === '')
  if (missing.length === 0) {
    add('vision', '视觉模型（识图）', 'ok', String(config.visionModel) + ' @ ' + String(config.visionBaseUrl))
  } else {
    add('vision', '视觉模型（识图）', 'warn', '没配（收到图片只会有图内文字）', '设置页「QQ 通道 → 识图」填模型 / 网关 / 凭证名')
  }
  if (videoMissing.length === 0 || missing.length === 0) {
    add('videoVision', '视觉模型（看视频）', 'ok', videoMissing.length === 0 ? String(config.videoVisionModel) : '跟随识图：' + String(config.visionModel))
  } else {
    add('videoVision', '视觉模型（看视频）', 'warn', '没配（看视频只看字幕）', '要么填「看视频」那一组，要么填识图那组让它跟随')
  }

  // 9 NapCat
  const napDir = resolveNapcatDir(String(config.napcatDir ?? ''), { home })
  if (!napDir.ok) {
    add('napcat', 'NapCat（QQ 通道）', 'warn', String(napDir.error || '没找到目录'), '设置页填 NapCat 目录，或设环境变量 NAPCAT_DIR')
  } else if (!existsSync(launcherPath(napDir.dir))) {
    add('napcat', 'NapCat（QQ 通道）', 'bad', napDir.dir + ' 里没有 launcher.bat', '确认填的是 NapCat.Shell 目录')
  } else {
    // 插件实例会把自己的 PID 递进来；命令行版这里自己问一次 tasklist
    const pid = napcat && typeof napcat.pid === 'number' ? napcat.pid : await tasklistPid()
    const running = pid > 0
    const qr = qrPath(napDir.dir)
    let qrNote = ''
    try {
      const st = statSync(qr)
      qrNote = '，二维码 ' + new Date(st.mtimeMs).toLocaleString('zh-CN')
    } catch { /* 没二维码 */ }
    add(
      'napcat',
      'NapCat（QQ 通道）',
      running ? 'ok' : 'warn',
      napDir.dir + (napDir.auto === true ? '（自动找到）' : '') + (running ? '，进程在跑（PID ' + pid + '）' : '，进程没起') + qrNote,
      running ? '' : '点引导卡上的「启动 NapCat」',
    )
  }

  const bad = items.filter((i) => i.level === 'bad').length
  const warn = items.filter((i) => i.level === 'warn').length
  return { ok: bad === 0, bad, warn, items }
}
