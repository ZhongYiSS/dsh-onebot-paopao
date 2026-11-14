// 「这个请求是不是本机面板发来的」
//
// 11-14 的教训：0.5.26 为了挡 CSRF 把规则收紧成「Origin 必须跟 Host 一模一样」，
// 结果桌面壳（Origin: dsh-app://app）和通过局域网地址打开的页面全被 403 挡死，
// 面板上只剩「读不到状态：HTTP 403」。
// 现在的规则按「来源像不像本机」判，而不是按字符串相等：
//   · dsh-app: / app: / file: 这类本地外壳scheme 直接放行；
//   · Origin 的主机 == 请求的 Host → 放行；
//   · 两边都是本机地址（回环 / 私网段）→ 放行（有人用 192.168.x.x 打开面板）；
//   · 都没有 Origin 时看 Sec-Fetch-Site；
//   · 其余情况要么带对令牌，要么拒。
// 公网页面（https://evil.com）永远落在最后一条 —— 它拿不到令牌。

const LOCAL_SCHEMES = new Set(['dsh-app:', 'app:', 'file:', 'chrome-extension:', 'moz-extension:']);

export function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * @param {{origin?: string, host?: string, site?: string, token?: string, want?: string}} p
 */
export function originAllowed(p) {
  const origin = String(p.origin || '').trim();
  const host = String(p.host || '').trim();
  const site = String(p.site || '').toLowerCase();
  const tok = String(p.token || '');
  const want = String(p.want || '');
  const tokOk = tok !== '' && want !== '' && tok === want;

  if (!origin) {
    if (site === 'same-origin' || site === 'none') return true;
    return tokOk;
  }
  let u;
  try { u = new URL(origin); } catch { return tokOk; }
  if (LOCAL_SCHEMES.has(u.protocol)) return true;
  if (u.host && host && u.host.toLowerCase() === host.toLowerCase()) return true;
  if (isLocalHost(u.hostname) && isLocalHost(String(host).split(':')[0])) return true;
  return tokOk;
}
