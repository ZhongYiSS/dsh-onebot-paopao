// NapCat 的「快捷启动 / 二维码 / 状态」——纯工具函数，不碰网络也不碰进程。
// 拆出来是为了能单测：路径校验、命令行拼装、tasklist 解析都不用真起进程。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * 起 NapCat 的命令行。有机器号且允许快速登录时带 -q（免扫码），否则纯 launcher.bat。
 * 返回 { file, args }；目录不可用时返回 null。
 */
export function buildLaunchCommand(dir, { uin = '', quickLogin = true } = {}) {
  const v = validateNapcatDir(dir)
  if (!v.ok) return null
  const qq = String(uin || '').trim()
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

/**
 * 从 NapCat 的 config 目录里认机器人 QQ 号（文件名就带着号：`onebot11_3490240357.json`、
 * `napcat_3490240357.json`）。认不出来回空串 —— 空串时 buildLaunchCommand 会退回普通启动（扫码）。
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
