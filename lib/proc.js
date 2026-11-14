// 进程探测的唯一实现（官方 NapCat.Shell / 雪猫 / 官方 Lite / 远程共用）。
//
// 为什么单独一个文件：原来 index.js 里有两份、napcat.js 里一份、doctor.mjs 里一份，
// 而且都只认镜像名 `NapCatWinBootMain.exe`。雪猫（QQ.exe + winmm.dll 注入）和
// Lite 都没有这个进程 → 状态灯永远「未运行」，点重启还会 taskkill /IM QQ.exe
// 把用户日常那个 QQ 一起杀掉。
//
// 判据改成「镜像名 ∪ 进程路径在 napcatDir 之下」：
//   · 官方 Shell：镜像名命中，快路径，不查路径；
//   · 雪猫 / Lite：进程叫 QQ.exe，靠路径区分「插件这个」和「用户日常那个」；
//   · 远程 / Docker：本机没有进程，hits 为空，调用方要按「真的没有」处理。
//
// 取舍：tasklist 快（~80ms）但拿不到路径，CIM 能拿路径但要 ~600ms。
// 常态只跑 tasklist，只有「候选里出现 QQ.exe 且配了 napcatDir」时才补一次 CIM。
import { execFile } from 'node:child_process'

const WIN = process.platform === 'win32'

// 只有官方启动器的镜像名进这个集合。
// 注意：千万不要把 qq.exe 放进来 —— 那正是「点重启把用户日常 QQ 杀掉」的根源。
const PROBE_NAMES = new Set(['napcatwinbootmain.exe', 'napcatwinbootmain_x64.exe'])

const CACHE_MS = 3000
let cache = { at: 0, list: [] }

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
        // 11-14：区分「命令执行失败」和「没有输出」。以前失败也 resolve('')，
        // 上层就把「查不到进程」当成「没有进程」→ 重启时会再拉一个新的，两个 NapCat 抢同一个号。
        (err, stdout) => resolve(err ? null : String(stdout || '')))
      // 没挂 error 监听时，spawn 失败会让 EventEmitter 抛未捕获的 error（能带走主进程）。
      child.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/** 全部进程：[{ pid, name }]，name 已小写。非 Windows 返回 []。
 *  查不到（tasklist 失败/超时）返回 null —— 调用方必须把「不知道」和「没有」分开，
 *  否则会把「查不到 NapCat」当成「NapCat 没在跑」再拉一个起来。 */
export async function listProcs({ fresh = false } = {}) {
  if (!WIN) return []
  const now = Date.now()
  if (!fresh && now - cache.at < CACHE_MS) return cache.list
  const out = await run('tasklist', ['/FO', 'CSV', '/NH']) // 不用中文表头（表头会被本地化）
  if (out === null) return null
  const list = out.split(/\r?\n/).map((line) => {
    const m = /^"([^"]+)","(\d+)"/.exec(line)
    return m ? { pid: Number(m[2]), name: m[1].toLowerCase() } : null
  }).filter(Boolean)
  cache = { at: now, list }
  return list
}

/** 只查指定 pid 的可执行路径：{ pid: exePath }。整表一次拿回再过滤，比逐个查快得多。 */
async function resolvePaths(pids) {
  if (!WIN || pids.length === 0) return {}
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress'],
  12000)
  const map = {}
  try {
    const raw = JSON.parse(out.trim() === '' ? '[]' : out)
    for (const r of Array.isArray(raw) ? raw : [raw]) {
      const pid = Number(r.ProcessId)
      if (pids.includes(pid) && r.ExecutablePath) map[pid] = String(r.ExecutablePath)
    }
  } catch {
    // PowerShell 被策略禁 / 输出被截断：拿不到路径就退回纯名字判据（= 原来的行为）
  }
  return map
}

/** 路径是否在 napcatDir 之下（大小写与分隔符都归一）。 */
export function pathUnder(exePath, napcatDir) {
  const dir = String(napcatDir || '').toLowerCase().replace(/[\\/]+$/, '')
  if (dir === '' || !exePath) return false
  const p = String(exePath).toLowerCase()
  return p.startsWith(dir + '\\') || p.startsWith(dir + '/')
}

/**
 * 找 NapCat：返回 { pid, hits }。
 * hits 是全部命中的进程 —— 自动重启多起实例时要全杀，别只杀第一个。
 */
export async function findNapcat(napcatDir) {
  const list = await listProcs()
  // 查不到进程表：明确回「不知道」，别回「没有」（见 listProcs 的注释）
  if (list === null) return { pid: 0, hits: [], unknown: true }
  const byName = list.filter((p) => PROBE_NAMES.has(p.name))
  if (byName.length > 0) return { pid: byName[0].pid, hits: byName }
  if (!napcatDir) return { pid: 0, hits: [] }
  // 雪猫 / Lite：进程是 QQ.exe，只能靠路径区分「插件这个」和「用户日常那个」
  const candidates = list.filter((p) => p.name === 'qq.exe')
  if (candidates.length === 0) return { pid: 0, hits: [] }
  const paths = await resolvePaths(candidates.map((p) => p.pid))
  const hits = candidates
    .filter((p) => pathUnder(paths[p.pid], napcatDir))
    .map((p) => ({ ...p, exePath: paths[p.pid] }))
  return { pid: hits.length > 0 ? hits[0].pid : 0, hits }
}

/** 杀一棵进程树。返回 boolean（成功与否），不再用「pid 是 0 也算成功」的假语义。 */
export async function killTree(pid) {
  if (!WIN || !(pid > 0)) return false
  const out = await run('taskkill', ['/PID', String(pid), '/T', '/F'], 8000)
  if (out === null) return false
  return out.trim() !== ''
}

/** 等一批进程消失（最多 timeoutMs），返回还在的 pid。
 *  进程表查不到时**抛错**（`unknown:true` 的 Error）——调用方不能拿「不知道」当「都死了」。 */
export async function waitGone(pids, { timeoutMs = 8000, stepMs = 300 } = {}) {
  if (!WIN || pids.length === 0) return []
  const want = new Set(pids)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = await listProcs({ fresh: true })
    if (list === null) {
      const err = new Error('查不到进程表（tasklist 失败），不能确认旧进程是否已退出')
      err.unknown = true
      throw err
    }
    const alive = list.filter((p) => want.has(p.pid)).map((p) => p.pid)
    if (alive.length === 0 || Date.now() >= deadline) return alive
    await new Promise((r) => setTimeout(r, stepMs))
  }
}