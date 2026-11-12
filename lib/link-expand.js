/**
 * 短链展开：群友/哥哥发来 b23.tv 短链或 B站 视频链接时，认出 BV 号再查一次
 * 视频信息，拼成一句说明塞给会话——不然她只看到一串网址，不知道那是哪条视频。
 *
 * 只做两件事：短链 → BV、BV → 标题/UP/时长/播放。任何一步失败都返回空串，
 * 绝不能因为一个链接把消息卡住或挡掉。纯出站请求，不带任何写操作。
 * @module dsh-onebot/link-expand
 */

/** 短链展开的 UA：B站 对空 UA 会拦。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 dsh-onebot';
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
/** 同一个链接多久之内不重复查（B站 接口有频率限制）。 */
const TTL_MS = 30 * 60 * 1000;
const MAX_CACHE = 200;
/** 单次展开的总预算，超时就当没展开。 */
const TIMEOUT_MS = 3500;
/** 一条消息最多展开两个链接，多了纯浪费。 */
const MAX_LINKS = 2;

const SHORT_RE = /https?:\/\/b23\.tv\/[0-9A-Za-z]+/g;
/** 同一形状但不带 g：.test() 不会推进 lastIndex（带 g 的 test 会，第二次判断可能翻脸）。 */
const SHORT_TEST_RE = /https?:\/\/b23\.tv\/[0-9A-Za-z]+/;
const VIDEO_RE = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/g;
const BV_RE = /BV[0-9A-Za-z]{10}/;
const BARE_BV_RE = /(?<![0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/g;

/** url/bvid → { at, note }，进程内缓存，够了。 */
const cache = new Map();

/**
 * 找出文本里值得展开的 B站 引用（去重、最多两条）。
 * @param text - 消息正文。
 * @returns `[{ kind: 'bv'|'short', bvid?, url?, raw }]`。
 */
export function findBiliRefs(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return [];
    const found = [];
    for (const m of text.matchAll(VIDEO_RE))
        found.push({ at: m.index ?? 0, ref: { kind: 'bv', bvid: m[1], raw: m[0] } });
    for (const m of text.matchAll(SHORT_RE))
        found.push({ at: m.index ?? 0, ref: { kind: 'short', url: m[0], raw: m[0] } });
    // 单独甩出来的 BV 号（没带网址）也算，很多人只贴号。
    for (const m of text.matchAll(BARE_BV_RE))
        found.push({ at: m.index ?? 0, ref: { kind: 'bv', bvid: m[1], raw: m[1] } });
    found.sort((a, b) => a.at - b.at);
    const out = [];
    const seen = new Set();
    for (const { ref } of found) {
        const key = ref.bvid ?? ref.url;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(ref);
    }
    return out.slice(0, MAX_LINKS);
}

/** 秒 → mm:ss / h:mm:ss。 */
export function formatDuration(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0)
        return '';
    const total = Math.round(s);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 播放数 → 12.3万 / 1.2亿。 */
export function formatCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0)
        return '';
    if (v >= 100000000)
        return `${(v / 100000000).toFixed(1)}亿`;
    if (v >= 10000)
        return `${(v / 10000).toFixed(1)}万`;
    return String(Math.round(v));
}

/** 手动跟一次跳转拿 BV；拿不到就让 fetch 自己跟，再读最终 URL。 */
async function bvidOfShort(url, fetchImpl) {
    const init = { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    try {
        const res = await fetchImpl(url, { ...init, redirect: 'manual' });
        const location = res.headers?.get?.('location') ?? '';
        const hit = location.match(BV_RE);
        if (hit !== null)
            return hit[0];
    }
    catch {
        // 手动跟失败就再试一次自动跟，下面统一兜底。
    }
    const res = await fetchImpl(url, { ...init, redirect: 'follow' });
    const hit = String(res.url ?? '').match(BV_RE);
    return hit === null ? '' : hit[0];
}

/** 查一次视频信息；失败返回 null。 */
async function fetchView(bvid, fetchImpl) {
    const res = await fetchImpl(`${VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json();
    if (!json || json.code !== 0 || !json.data)
        return null;
    const d = json.data;
    return {
        bvid,
        title: String(d.title ?? '').trim(),
        owner: String(d.owner?.name ?? '').trim(),
        duration: Number(d.duration),
        view: Number(d.stat?.view),
        pic: String(d.pic ?? '').trim(),
        desc: String(d.desc ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
    };
}

/**
 * 查一条视频的完整信息（发卡片用）：标题 / UP / 封面 / 时长 / 播放 / 简介。
 * @param bvid - BV 号。
 * @param opts - `{ fetchImpl }`，测试用注入。
 * @returns 信息对象；失败返回 null（调用方退回发链接文本）。
 */
export async function biliVideoInfo(bvid, opts = {}) {
    if (typeof bvid !== 'string' || !BV_RE.test(bvid))
        return null;
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
    try {
        return await fetchView(bvid, fetchImpl);
    }
    catch (error) {
        opts.log?.('debug', '视频信息查询失败: ' + String(error));
        return null;
    }
}

/**
 * 短链（或任意 B站 链接）→ BV 号。
 * @param url - b23.tv 短链或视频链接。
 * @param opts - `{ fetchImpl }`。
 * @returns BV 号；认不出返回 ''。
 */
export async function bvidOfLink(url, opts = {}) {
    if (typeof url !== 'string' || url.trim() === '')
        return '';
    const direct = url.match(BV_RE);
    if (direct !== null)
        return direct[0];
    if (!SHORT_TEST_RE.test(url))
        return '';
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
    try {
        return await bvidOfShort(url.trim(), fetchImpl);
    }
    catch {
        return '';
    }
}

/** 一条视频信息 → 一句人话。 */
export function formatViewInfo(info) {
    const bits = [];
    if (info.title !== '')
        bits.push(info.title);
    if (info.owner !== '')
        bits.push('UP：' + info.owner);
    const dur = formatDuration(info.duration);
    if (dur !== '')
        bits.push(dur);
    const view = formatCount(info.view);
    if (view !== '')
        bits.push('播放 ' + view);
    return bits.join('｜');
}

/**
 * 把文本里的 B站 链接展开成一句说明（可能为空串）。
 * @param text - 消息正文。
 * @param opts - `{ fetchImpl, log }`，测试用注入。
 * @returns 形如 `（B站：标题｜UP：xx｜3:25｜播放 12.3万）`；没有链接或全失败返回 ''。
 */
export async function biliLinkNote(text, opts = {}) {
    const refs = findBiliRefs(text);
    if (refs.length === 0)
        return '';
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
    const notes = [];
    for (const ref of refs) {
        const key = ref.bvid ?? ref.url;
        const hit = cache.get(key);
        if (hit !== undefined && Date.now() - hit.at < TTL_MS) {
            if (hit.note !== '')
                notes.push(hit.note);
            continue;
        }
        let note = '';
        try {
            const bvid = ref.kind === 'bv' ? ref.bvid : await bvidOfShort(ref.url, fetchImpl);
            if (bvid !== '') {
                const info = await fetchView(bvid, fetchImpl);
                if (info !== null && info.title !== '')
                    note = `（B站：${formatViewInfo(info)}）`;
            }
        }
        catch (error) {
            opts.log?.('debug', '短链展开失败: ' + String(error));
        }
        cache.set(key, { at: Date.now(), note });
        if (cache.size > MAX_CACHE) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined)
                cache.delete(oldest);
        }
        if (note !== '')
            notes.push(note);
    }
    return notes.join(' ');
}