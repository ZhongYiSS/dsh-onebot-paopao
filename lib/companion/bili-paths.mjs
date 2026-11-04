/**
 * 泡泡自己的 B站 数据放哪。
 * ============================================================================
 * 以前泡泡借刷B站插件的地盘（`$DSH_HOME/bili-duty/`）。哥哥 11-04 定：换成自己
 * 一份，放 `$DSH_HOME/bubble/bili/`，B站 插件卸了、重装了都不影响。
 *
 * - config.json（关键词 / 过滤）：**自己那份说了算**，没有才回落到 bili-duty。
 * - bili_credential.json（凭证）：两边都可能被登录写过，**取 mtime 新的那份**——
 *   刷B站 里重新扫码登录后，泡泡这边自动跟上，不会拿过期 cookie 去撞 -101。
 * ============================================================================
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 宿主家目录；调用方不传就自己算（模块被单独 import 也不至于炸）。 */
function homeOf(dshHome) {
  return dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function biliHome(dshHome) {
  return join(homeOf(dshHome), 'bubble', 'bili')
}

function mtimeOf(p) {
  try { return statSync(p).mtimeMs } catch { return -1 }
}

export function credPath(dshHome) {
  const own = join(biliHome(dshHome), 'bili_credential.json')
  const legacy = join(homeOf(dshHome), 'bili-duty', 'bili_credential.json')
  const hasOwn = existsSync(own)
  const hasLegacy = existsSync(legacy)
  if (hasOwn && hasLegacy) return mtimeOf(legacy) > mtimeOf(own) ? legacy : own
  return hasOwn ? own : legacy
}

export function configPath(dshHome) {
  const own = join(biliHome(dshHome), 'config.json')
  return existsSync(own) ? own : join(homeOf(dshHome), 'bili-duty', 'config.json')
}