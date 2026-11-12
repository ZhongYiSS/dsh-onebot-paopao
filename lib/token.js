// accessToken 的兜底（2026-11-12）：
// reverse 模式要求 token 非空，可设置页写盘走宿主 configEditor.edit(entry, …)，只认「已激活」的条目；
// 于是「没 token → 条目挂不上 → 写不进去 → 永远没 token」成了死锁。这里把「人得先手填」改成
// 「插件先给你一个」：留空就当场生成一个、落盘到 $DSH_HOME/onebot/access-token.json，面板里能复制。
// fail-closed 没变——服务端永远拿非空 token 起来，空 token 的连接照样被拒。
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** token 落盘文件名（放在 $DSH_HOME/onebot/ 下）。 */
export const TOKEN_FILE = 'access-token.json'

/** 24 字节 = 48 位十六进制，和常见的 OneBot token 长度相当，肉眼粘贴不费劲。 */
export function makeToken() {
  return randomBytes(24).toString('hex')
}

/** 读回已经落盘的 token；读不到 / 坏文件都当空，绝不抛。 */
export function readTokenFile(file) {
  if (!file) return ''
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const t = j && typeof j.token === 'string' ? j.token.trim() : ''
    return t
  } catch {
    return ''
  }
}

/**
 * 定出这次真正要用的 token。
 * @param {{raw?: string, file?: string, log?: Function}} opts
 *   raw  配置里写的（空 = 没配）
 *   file 落盘路径（$DSH_HOME/onebot/access-token.json）
 * @returns {{token: string, source: 'config'|'file'|'generated'|'memory', error?: string}}
 *   source: config=配置里写的 / file=上次生成的 / generated=这次新生成并落盘 / memory=生成了但没写进去
 */
export function resolveAccessToken({ raw = '', file = '', log = () => {} } = {}) {
  const direct = String(raw ?? '').trim()
  if (direct) return { token: direct, source: 'config' }

  const saved = readTokenFile(file)
  if (saved) {
    log('info', 'accessToken 留空：沿用上次自动生成的那个（' + file + '）。要自己定就在设置里填。')
    return { token: saved, source: 'file' }
  }

  const fresh = makeToken()
  if (!file) {
    log('error', 'accessToken 留空，也没有落盘路径：这次用临时 token（重启会换）——面板「复制 token」里能拿到。')
    return { token: fresh, source: 'memory' }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ token: fresh, at: Date.now() }, null, 2) + '\n', 'utf8')
    log('warn', 'accessToken 留空：已自动生成一个并写进 ' + file + '。把它粘到 NapCat 的 WebSocket 客户端配置里（面板「复制 token」）。')
    return { token: fresh, source: 'generated' }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log('error', 'accessToken 留空，而且写不进 ' + file + '（' + message + '）：这次用临时 token，重启会换。')
    return { token: fresh, source: 'memory', error: message }
  }
}