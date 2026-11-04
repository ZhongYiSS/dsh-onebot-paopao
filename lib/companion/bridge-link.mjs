/**
 * 找 QQ 插件那道门 ==========================================================
 * QQ 插件（dsh-onebot-qq）在 apply 里把桥接能力露出来，可能落在三个地方：
 *   1. ctx.get('onebot')          —— 同一个 context 树上的服务（最正规）
 *   2. ctx.root.get('onebot')     —— 它挂在根上、我们挂在旁边的时候
 *   3. globalThis.__DSH_ONEBOT__  —— 宿主进程里同一个 node，兜底
 * 三个都没有就是真没接上，不许假装。
 */

export function resolveOnebot(ctx) {
  const ok = (s) => (s && (typeof s.dispatch === 'function' || typeof s.listChats === 'function') ? s : null)
  try { const s = ok(ctx?.get?.('onebot')); if (s) return s } catch { /* 没这个服务 */ }
  try { const s = ok(ctx?.root?.get?.('onebot')); if (s) return s } catch { /* 根上没有 */ }
  try { const s = ok(globalThis.__DSH_ONEBOT__); if (s) return s } catch { /* 没有全局 */ }
  return null
}
