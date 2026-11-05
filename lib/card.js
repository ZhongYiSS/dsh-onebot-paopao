/**
 * QQ 链接卡片（news 型）：把一条外部链接包成能在聊天窗里点的卡片，而不是
 * 干巴巴一串网址。走 OneBot 的 `json` 段——NapCat 会把 `data.data` 里那串
 * JSON 当卡片渲染，点开直达 `jumpUrl`。
 *
 * 只构造数据，不发；发送由调用方的 `sendSegments` 负责（那边有闸和审计）。
 * @module dsh-onebot/card
 */

/** 标题/描述截断，别让长标题撑爆卡片。 */
const TITLE_MAX = 60;
const DESC_MAX = 120;

/** 截断并压掉换行（卡片里换行会显示成怪样子）。 */
export function clampText(value, max) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * 构造一张 news 卡片。
 * @param opts - `{ title, desc, url, pic, tag }`；title/url 必填。
 * @returns 卡片对象（可直接 JSON.stringify 进 `json` 段）。
 */
export function buildNewsCard(opts) {
    const title = clampText(opts.title, TITLE_MAX);
    const desc = clampText(opts.desc ?? '', DESC_MAX);
    const url = String(opts.url ?? '').trim();
    const pic = String(opts.pic ?? '').trim();
    const tag = clampText(opts.tag ?? '分享', 20);
    return {
        app: 'com.tencent.structmsg',
        desc: '新闻',
        view: 'news',
        ver: '0.0.0.1',
        prompt: '[分享] ' + title,
        meta: {
            news: {
                title,
                desc,
                jumpUrl: url,
                ...(pic !== '' ? { preview: pic } : {}),
                tag,
                tagIcon: 'https://www.bilibili.com/favicon.ico',
            },
        },
        config: {
            type: 'normal',
            width: 0,
            height: 0,
            forward: true,
            autoSize: true,
            ctime: Math.floor(Date.now() / 1000),
            token: '',
        },
    };
}

/**
 * 卡片 → OneBot 段数组（`json` 段里再套一层字符串，NapCat 的约定）。
 * @param card - `buildNewsCard` 的返回值。
 * @returns `[{ type: 'json', data: { data } }]`。
 */
export function cardSegments(card) {
    return [{ type: 'json', data: { data: JSON.stringify(card) } }];
}