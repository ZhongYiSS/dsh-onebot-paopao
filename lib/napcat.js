// NapCat 的「快捷启动 / 二维码 / 状态」——纯工具函数，不碰网络也不碰进程。
// 拆出来是为了能单测：路径校验、命令行拼装、tasklist 解析都不用真起进程。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 目录 → launcher.bat 的绝对路径（不检查存在）。 */
export function launcherPath(dir) {
  return join(String(dir), 'launcher.bat')
}

/** 二维码文件路径：<NapCat>/cache/qrcode.png（NapCat 自己每分钟换一张）。 */
export function qrPath(dir) {
  return join(String(dir), 'cache', 'qrcode.png')
}

/**
 * 检查用户填的 NapCat 目录能不能用。
 * 返回 { ok, dir, launcher } 或 { ok:false, error }（error 是给人看的中文）。
 */
export function validateNapcatDir(dir) {
  const d = typeof dir === 'string' ? dir.trim() : ''
  if (d === '') return { ok: false, error: '还没填 NapCat 目录（设置页「QQ 通道 → 连接」里填）' }
  if (!existsSync(d)) return { ok: false, error: '这个目录不存在：' + d }
  const l = launcherPath(d)
  if (!existsSync(l)) return { ok: false, error: '这个目录里没有 launcher.bat：' + d }
  return { ok: true, dir: d, launcher: l }
}

/** 机器号只允许 5~12 位数字（且不以 0 开头）：这个值会进命令行/VBS，不能放别的字。 */
export const UIN_RE = /^[1-9]\d{4,11}$/

export function safeUin(uin) {
  const qq = String(uin ?? '').trim()
  return UIN_RE.test(qq) ? qq : ''
}

/**
 * 起 NapCat 的命令行。有机器号且允许快速登录时带 -q（免扫码），否则纯 launcher.bat。
 * 返回 { file, args }；目录不可用、或机器号里有奇怪字符时返回 null。
 */
export function buildLaunchCommand(dir, { uin = '', quickLogin = true } = {}) {
  const v = validateNapcatDir(dir)
  if (!v.ok) return null
  const raw = String(uin ?? '').trim()
  const qq = raw === '' ? '' : safeUin(raw)
  if (raw !== '' && qq === '') return null
  const line = qq !== '' && quickLogin ? '"' + v.launcher + '" -q ' + qq : '"' + v.launcher + '"'
  return { file: 'cmd.exe', args: ['/c', line] }
}

/** 从 `tasklist /FI "IMAGENAME eq NapCatWinBootMain.exe" /FO CSV /NH` 的输出里取 PID。没有就 0。 */
export function parseTasklist(stdout) {
  const text = String(stdout || '')
  // 正常一行：  "NapCatWinBootMain.exe","25308","Console","1","12,345 K"
  // 没进程时 tasklist 打一行中文提示：信息: 没有运行的任务匹配指定标准。
  const m = /"NapCatWinBootMain\.exe"\s*,\s*"(\d+)"/i.exec(text)
  if (m) return Number(m[1])
  const loose = /NapCatWinBootMain\.exe[^0-9]{0,8}(\d+)/i.exec(text)
  return loose ? Number(loose[1]) : 0
}

/** 二维码文件的现状：{ exists, at, bytes }。at 是毫秒时间戳（界面拿它判断换没换）。 */
/**
 * 二维码新鲜度：NapCat 每分钟会重写这张图，所以「几分钟没动」= 现在没在等你扫码。
 * 阈值 150 秒（一分钟转两圈的余量）——超过就别把旧图当新码给人扫（11-10 的坑：
 * 界面拿着一张 4 小时前的图，扫了当然说「已过期」）。
 */
export const QR_STALE_SEC = 150

export function qrInfo(dir, now = Date.now()) {
  const p = qrPath(dir)
  try {
    const st = statSync(p)
    const ageSec = Math.max(0, Math.round((now - st.mtimeMs) / 1000))
    return { ok: true, path: p, exists: true, at: st.mtimeMs, bytes: st.size, ageSec, stale: ageSec > QR_STALE_SEC }
  } catch {
    return { ok: true, path: p, exists: false, at: 0, bytes: 0, ageSec: -1, stale: false }
  }
}

/**
 * 用 VBScript 把 launcher.bat 藏起来跑（窗口样式 0 = 隐藏、不等待）。
 * 为什么不用 cmd.exe：launcher.bat 里直接 `"NapCatWinBootMain.exe" ...`，子进程继承控制台，
 * 用 cmd 起就会闪一个黑框（11-10 哥哥说「能隐藏那个命令行吗」）。wscript 起的话
 * 控制台从头到尾是隐藏的，子进程也跟着隐藏。
 */
export function buildVbsScript(dir, { uin = '', quickLogin = true, logPath = '', showWindow = false } = {}) {
  // VBS 里这些都是字符串字面量：引号/换行会把脚本撕开，必须清掉。
  const esc = (s) => String(s ?? '').replace(/["\r\n]/g, '')
  const bat = esc(join(dir, 'launcher.bat'))
  const dirLit = esc(dir)
  const qq = safeUin(uin)
  const arg = qq !== '' && quickLogin !== false ? ' -q ' + qq : ''
  const lines = [
    // 没有主窗口的 wscript 一旦抛错就会弹「Windows Script Host」对话框 —— 用 On Error 兜住，
    // 失败只写一行日志（11-10 实测：launcher.bat 不在时会弹一个模态框吓人）。
    'On Error Resume Next',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + dirLit + '"',
    // 用 Chr(34) 拼引号，避免多层引号转义出错
    'cmd = Chr(34) & "' + bat + '" & Chr(34) & "' + arg + '"',
    // 窗口样式：0 = 隐藏（默认，不闪黑框）；1 = 正常显示（想看登录二维码/掉线原因时开）
    'sh.Run cmd, ' + (showWindow ? 1 : 0) + ', False',
  ]
  if (String(logPath || '') !== '') {
    lines.push('If Err.Number <> 0 Then')
    lines.push('  Set fso = CreateObject("Scripting.FileSystemObject")')
    lines.push('  Set f = fso.CreateTextFile("' + esc(logPath) + '", True)')
    lines.push('  f.WriteLine "ERR " & Err.Number & " " & Err.Description')
    lines.push('  f.Close')
    lines.push('End If')
  }
  lines.push('')
  return lines.join('\r\n')
}

/**
 * 没填 napcatDir 时，猜几个常见位置（只认「里面有 launcher.bat」的目录）。
 * 顺序：环境变量 NAPCAT_DIR → 几个常见安装路径。都用 path 拼，不写死盘符以外的假设。
 */
export function guessNapcatDir(home = '', env = process.env) {
  const list = []
  if (env && typeof env.NAPCAT_DIR === 'string' && env.NAPCAT_DIR.trim() !== '') list.push(env.NAPCAT_DIR.trim())
  if (home) list.push(join(home, 'napcat'), join(home, 'NapCat'))
  const local = env && env.LOCALAPPDATA
  if (typeof local === 'string' && local !== '') list.push(join(local, 'NapCat'), join(local, 'NapCat.Shell'))
  list.push('C:\\NapCat', 'C:\\NapCat\\NapCat.Shell', 'D:\\NapCat', 'D:\\NapCat\\NapCat.Shell')
  for (const d of list) {
    if (existsSync(launcherPath(d))) return d
  }
  return ''
}

/**
 * 真正用的目录：填了就用填的（填错就报错，不偷偷换），没填才去猜。
 * 返回 validateNapcatDir 的形状，多一个 auto 字段表示「是猜出来的」。
 */
export function resolveNapcatDir(rawDir, opts = {}) {
  const raw = typeof rawDir === 'string' ? rawDir.trim() : ''
  if (raw !== '') return { ...validateNapcatDir(raw), auto: false }
  const guessed = guessNapcatDir(opts.home || '', opts.env || process.env)
  if (guessed !== '') return { ...validateNapcatDir(guessed), auto: true }
  return {
    ok: false,
    auto: false,
    error: '没找到 NapCat：在插件配置里填 napcatDir（含 launcher.bat 那个目录），或者设环境变量 NAPCAT_DIR',
  }
}

// ────────── QQ 版本自检 ──────────
// 2026-11-14：NapCat 上游已删库、不再跟着 QQ 发版。它每个 QQ 构建靠一份「内存偏移表」
// 工作（napcat.mjs 里 `"9.9.36-53644-x64": { send: "C3EE2F", recv: "24A6355" }`），
// 所以 QQ 一旦自更新到表里没有的构建，注入必挂——以前的表现是「悄悄连不上」。
// 这里只做一件事：把「QQ 现在这版 NapCat 认不认」算出来，面板和启动日志照着说人话。

/** 版本串形如 9.9.36-53644-x64；只认这一种写法。 */
const QQ_VER_RE = /9\.9\.\d+-\d+-x64/g

let verCache = { file: '', mtime: 0, list: [] }

function verRank(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)-(\d+)/.exec(String(v))
  if (m === null) return 0
  return Number(m[1]) * 1e12 + Number(m[2]) * 1e10 + Number(m[3]) * 1e8 + Number(m[4])
}

/**
 * NapCat 这份安装包认得哪些 QQ 构建（从 napcat.mjs 里扒出来，按新旧排序）。
 * 按 mtime 缓存：3MB 的文件不必每次状态查询都读一遍。
 */
export function supportedQqVersions(napcatDir) {
  const file = join(String(napcatDir || ''), 'napcat.mjs')
  try {
    const st = statSync(file)
    if (verCache.file === file && verCache.mtime === st.mtimeMs) return verCache.list
    const text = readFileSync(file, 'latin1')
    const list = [...new Set(text.match(QQ_VER_RE) || [])].sort((a, b) => verRank(a) - verRank(b))
    verCache = { file, mtime: st.mtimeMs, list }
    return list
  } catch {
    return []
  }
}

/** 读 QQ 自己的 versions/config.json（curVersion 就是下次启动会用的那版）。 */
export function qqVersionInfo(qqDir) {
  const file = join(String(qqDir || ''), 'versions', 'config.json')
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return {
      ok: true,
      dir: String(qqDir || ''),
      curVersion: String(j.curVersion || ''),
      baseVersion: String(j.baseVersion || ''),
      prevVersion: String(j.prevVersion || ''),
    }
  } catch {
    return { ok: false, dir: String(qqDir || ''), curVersion: '', baseVersion: '', prevVersion: '', error: '读不到 QQ 的 versions/config.json' }
  }
}

/** 从 `reg query ... /v UninstallString` 的输出里抠安装目录（去掉文件名那一层）。 */
export function qqInstallDirFromRegistry(stdout) {
  const m = /UninstallString\s+REG_SZ\s+(.+)/i.exec(String(stdout || ''))
  if (m === null) return ''
  const raw = m[1].trim().replace(/^"|"$/g, '')
  if (raw === '') return ''
  return dirname(raw)
}

/**
 * 判定：QQ 现在这一版，这台 NapCat 认不认。
 * ok = true / false / null（null = 看不出来，别瞎说）。
 * 注意两边写法不同：QQ 的 versions/config.json 是 `9.9.33-52230`，
 * NapCat 表里是 `9.9.33-52230-x64`，比较前统一抹掉 `-x64` 后缀。
 */
export function judgeQqVersion(curVersion, supported = []) {
  const norm = (v) => String(v || '').replace(/-x64$/i, '')
  const cur = String(curVersion || '')
  const list = Array.isArray(supported) ? supported : []
  const latest = list.length > 0 ? list[list.length - 1] : ''
  const set = new Set(list.map(norm))
  if (cur === '') return { ok: null, why: 'no-version', cur, latest, supported: list }
  if (set.size === 0) return { ok: null, why: 'no-table', cur, latest, supported: list }
  if (set.has(norm(cur))) return { ok: true, why: 'supported', cur, latest, supported: list }
  return { ok: false, why: 'unsupported', cur, latest, supported: list, newer: verRank(norm(cur)) > verRank(norm(latest)) }
}

/** 给面板/日志用的一句话；ok 为 null 时返回空串（没证据就不吓人）。 */
export function qqVersionHint(state) {
  if (state?.ok !== false) return ''
  const move = state.newer === false ? '这台机上的是' : 'QQ 已经升到'
  return `${move} ${state.cur}，这台 NapCat 只认到 ${state.latest}：注入多半会失败。`
    + '要么把 QQ 钉回旧版（versions\\config.json 的 curVersion），要么换后端（SnowLuma / LLOneBot）。'
}

/**
 * 从 NapCat 的 config 目录里认机器人 QQ 号（文件名就带着号：`onebot11_10001.json`、
 * `napcat_10001.json`）。认不出来回空串 —— 空串时 buildLaunchCommand 会退回普通启动（扫码）。
 */
export function detectBotQQ(dir) {
  const base = join(String(dir || ''), 'config')
  try {
    if (!existsSync(base)) return ''
    const names = readdirSync(base)
    for (const n of names) {
      const m = /^(?:onebot11|napcat|napcat_protocol)_(\d{5,})\.json$/i.exec(n)
      if (m !== null) return m[1]
    }
    for (const n of names) {
      const m = /_(\d{5,})\.json$/i.exec(n)
      if (m !== null) return m[1]
    }
  } catch {
    // 读不到就当不知道
  }
  return ''
}
