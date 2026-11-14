// 「这个请求是不是自己人发来的」
//
// 目的只有一个：挡住「网页里偷偷 fetch 127.0.0.1 的接口」这种 CSRF。
// 判定原则是「挡住明确的坏人，放过不明确的自己人」——
// 0.5.26 那版要求 Origin 与 Host 一字不差，把桌面壳（dsh-app://app）和局域网地址
// 全挡在外面，面板上只剩「读不到状态：HTTP 403」。所以现在的规则是：
//   · Origin 是个真实 http(s) 来源、主机又不是本机 → 拒（公网页面就在这一条里被挡掉）；
//   · 其余一律放行：没有 Origin、Origin: null、dsh-app:/app:/file: 等本地壳、
//     同 Host、回环 / 私网地址（有人用 192.168.x.x 打开面板）；
//   · 任何时候带对 x-bubble-token 都放行。

const LOCAL_SCHEMES = new Set(['dsh-app:', 'app:', 'file:', 'chrome-extension:', 'moz-extension:', 'vscode-webview:']);

export function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 只看主机名（去掉端口 / 协议） */
function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = raw.includes('://') ? new URL(raw) : new URL('http://' + raw);
    return u.hostname.toLowerCase();
  } catch {
    return raw.split(':')[0].toLowerCase();
  }
}

/**
 * 判定并顺手给出「为什么」——判定结果要能回给面板，
 * 免得下次再靠猜（0.5.29 就是因为看不到真正的 Origin 又白跑一轮）。
 * @param {{origin?: string, host?: string, site?: string, referer?: string, token?: string, want?: string}} p
 */
export function judgeOrigin(p) {
  const origin = String(p.origin ?? '').trim();
  const host = String(p.host ?? '').trim();
  const site = String(p.site ?? '').toLowerCase();
  const tok = String(p.token ?? '');
  const want = String(p.want ?? '');
  const seen = { origin, host, site, referer: String(p.referer ?? '') };

  if (tok !== '' && want !== '' && tok === want) return { ok: true, why: 'token', seen };

  // 没有 Origin：同源 GET 浏览器就不带 Origin，curl 也不带 —— 放行
  if (!origin) return { ok: true, why: 'no-origin', seen };

  const lower = origin.toLowerCase();
  if (lower === 'null') {
    // 沙箱 iframe / data: 页面。跨站的那种照样拒。
    return site === 'cross-site'
      ? { ok: false, why: 'origin-null-cross-site', seen }
      : { ok: true, why: 'origin-null', seen };
  }

  let u;
  try { u = new URL(origin); } catch { return { ok: true, why: 'origin-unparsable', seen }; }

  if (LOCAL_SCHEMES.has(u.protocol)) return { ok: true, why: 'local-scheme', seen };

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const oh = u.hostname.toLowerCase();
    if (isLocalHost(oh)) return { ok: true, why: 'origin-local-host', seen };
    if (host && u.host.toLowerCase() === host.toLowerCase()) return { ok: true, why: 'same-host', seen };
    if (host && oh === hostOf(host)) return { ok: true, why: 'same-hostname', seen };
    const rh = hostOf(p.referer);
    if (rh && rh === oh && isLocalHost(rh)) return { ok: true, why: 'same-as-referer', seen };
    return { ok: false, why: 'foreign-origin', seen };
  }

  // 别的自定义协议：只要不是明确的公网 http(s) 就放过
  return { ok: true, why: 'other-scheme', seen };
}

/** 兼容老调用：只要布尔 */
export function originAllowed(p) {
  return judgeOrigin(p).ok;
}
