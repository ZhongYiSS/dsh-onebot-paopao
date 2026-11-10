/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { parseMessage, cqUnescape } from './cq.js';
import { buildNewsCard, buildArkCard, cardSegments } from './card.js';
import { lookVideo } from './video-look.js'
import { bvidOfLink, biliVideoInfo } from './link-expand.js';
import { likeVideo, coinVideo, favVideo, sendComment, sendDm } from './bili-act.js';
import { noteAction } from './companion/activity.mjs';

/** 从 BV 号或视频链接里取 bvid。 */
function bvidOf(input) {
    const raw = String(input ?? '').trim();
    const hit = /(BV[0-9A-Za-z]{10})/.exec(raw);
    if (!hit) throw new Error('认不出 BV 号：' + raw.slice(0, 80));
    return hit[1];
}

/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
    'get_group_member_list',
    'get_group_member_info',
    'get_stranger_info',
    'get_forward_msg',
    'get_record',
    'get_file',
    'upload_group_file',
    'upload_private_file',
    'get_group_root_files',
    'get_group_files_by_folder',
    'get_group_file_url',
    'get_private_file_url',
    'ocr_image',
    'get_ai_characters',
    'send_group_ai_record',
    'get_mini_app_ark',
];
/** 主动模式工具的 JSON 输出。 */
function proactiveOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            if (v.ok === true && v.target !== undefined)
                return [{ type: 'text', text: '主动模式已开启：目标 ' + String(v.target) + '，' + String(v.minutes) + ' 分钟，最多追 ' + String(v.maxFollowUps) + ' 次' }];
            return [{ type: 'text', text: String(v.message ?? '操作完成') }];
        },
    };
}
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            return [{ type: 'text', text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }];
        },
    };
}
/** 分享一件事：先发封面图（给了 pic 时），再发一条「标题 / 描述 / 链接」文本。
 * 不用 QQ 小程序卡 —— 卡片点开只会落到小程序首页，跳不到原页面（10-29 实测）。 */
/**
 * 分享视频时的「封面 + 标题 + 链接」三件套。
 * 11-09 加：以前标题只信调用方传的，模型偷懒只给 url 时标题就变成链接本身，
 * 于是哥哥收到的只有一张封面加一条裸链接。现在链接是 B站 就先查一次接口，
 * 标题、封面、UP 主都从接口补——查不到才退回原样。
 * @returns `{ title, desc, pic }`，永远是可直接发出去的形状。
 */
async function previewMeta(url, given = {}) {
    const out = {
        title: typeof given.title === 'string' ? given.title.trim() : '',
        desc: typeof given.desc === 'string' ? given.desc.trim() : '',
        pic: typeof given.pic === 'string' ? given.pic.trim() : '',
    };
    if (out.pic !== '')
        out.pic = out.pic.replace(/^http:\/\//i, 'https://');
    if (out.title !== '' && out.pic !== '')
        return out;
    const bvid = await bvidOfLink(url).catch(() => '');
    if (bvid === '')
        return { ...out, title: out.title !== '' ? out.title : url };
    const info = await biliVideoInfo(bvid).catch(() => null);
    if (info === null)
        return { ...out, title: out.title !== '' ? out.title : url };
    if (out.pic === '')
        out.pic = info.pic;
    if (out.title === '')
        out.title = info.title !== '' ? info.title : url;
    if (out.desc === '')
        out.desc = info.owner !== '' ? 'UP：' + info.owner : '';
    return out;
}

async function sendPreviewLink(connection, bridge, chatId, opts) {
    let imageId = null;
    const pic = typeof opts.pic === 'string' ? opts.pic.trim() : '';
    if (pic !== '') {
        const file = isUrl(pic)
            ? pic
            : await fencedMediaFile(pic, limits.maxFileBytes, opts.allowedRoots ?? []);
        imageId = await bridge.sendSegments(chatId, [{ type: 'image', data: { file } }]);
    }
    const lines = [opts.title];
    if (typeof opts.desc === 'string' && opts.desc !== '')
        lines.push(opts.desc);
    lines.push(opts.url);
    const messageId = await bridge.sendSegments(chatId, [
        { type: 'text', data: { text: lines.join('\n') } },
    ]);
    return { imageId: imageId ?? null, messageId: messageId ?? null };
}
/** Resolve the target chat for a tool call. */
function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
}
/**
 * Resolve the requester (the human who asked for this media) for cooldown
 * accounting: private chats use the peer QQ, group chats use the last speaker
 * (falling back to the most recently @-ed member). Empty = unknown → owner.
 */
function resolveRequester(bridge, exec, chatId) {
    const ref = splitChatId(chatId);
    if (ref.kind === 'private')
        return String(ref.target);
    const settings = bridge.registry.getSettings(chatId);
    const speaker = settings.lastSpeaker;
    if (speaker !== undefined && speaker.id !== '')
        return String(speaker.id);
    const at = settings.lastAtUser;
    if (at !== undefined && at.id !== '')
        return String(at.id);
    return '';
}
/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path, maxBytes, allowedRoots) {
    try {
        return await fileToBase64(path, maxBytes, allowedRoots);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
            throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path);
        }
        throw error;
    }
}
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(ctx, bridge, connection, limits) {
    const disposers = [];
    const register = (tool) => {
        disposers.push(ctx.tools.register(tool));
    };
    register(defineTool({
        name: 'qq_send_image',
        description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
        parameters: {
            sources: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '图片说明文字（可选，作为图片前的文本发送）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const sources = Array.isArray(a.sources) ? a.sources.filter((s) => typeof s === 'string') : [];
            if (sources.length === 0)
                throw new Error('qq_send_image: sources 不能为空');
            if (sources.length > 9)
                throw new Error('qq_send_image: 一次最多 9 张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            // 白嫖保护：只有画师现画的图才计时，表情包/梗图/旧图免费（见 media-gate.js）。
            if (limits.gate !== undefined) {
                await limits.gate.takeImage(resolveRequester(bridge, exec, chatId), sources[0]);
            }
            const allowedRoots = await mediaRoots(bridge, exec);
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '') {
                segments.push({ type: 'text', data: { text: a.caption } });
            }
            for (const source of sources) {
                if (isUrl(source)) {
                    segments.push({ type: 'image', data: { url: source } });
                }
                else {
                    segments.push({ type: 'image', data: { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots) } });
                }
            }
            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_proactive_start',
        description: '开启「主动模式」：接下来 N 分钟（默认 20）本鱼主动黏着某个群成员聊天。对方 45 秒不回就再追一句（最多追 2 次），到点或追完自动收尾并写群记忆。用于哥哥 @ 某人并让本鱼主动搭话时。',
        parameters: {
            user_id: { type: 'string', description: '目标成员 QQ 号；省略时用本群最近被 @ 的那个人' },
            nickname: { type: 'string', description: '目标昵称（只用于提示词）' },
            minutes: { type: 'number', description: '持续分钟数，默认 10' },
            chat_id: { type: 'string', description: '目标会话，省略时默认当前会话' },
        },
        output: proactiveOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const settings = bridge.registry.getSettings(chatId);
            const last = settings.lastAtUser;
            const targetId = typeof a.user_id === 'string' && a.user_id !== ''
                ? a.user_id
                : (last?.id ?? '');
            const nickname = typeof a.nickname === 'string' && a.nickname !== ''
                ? a.nickname
                : (last?.name ?? '');
            if (targetId === '')
                throw new Error('qq_proactive_start: 没找到目标成员，请传 user_id，或先 @ 一下对方再让本鱼主动');
            const minutes = typeof a.minutes === 'number' && a.minutes > 0 ? a.minutes : undefined;
            const state = bridge.proactive.arm(chatId, targetId, nickname, minutes);
            return {
                ok: true,
                chatId,
                target: targetId,
                nickname,
                minutes: Math.round(state.durationMs / 60_000),
                maxFollowUps: state.maxFollowUps,
            };
        },
    }));
    register(defineTool({
        name: 'qq_proactive_stop',
        description: '关闭当前会话的「主动模式」（不触发收尾回合）。',
        parameters: {
            chat_id: { type: 'string', description: '目标会话，省略时默认当前会话' },
        },
        output: proactiveOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const stopped = bridge.proactive.disarm(chatId);
            return { ok: stopped, message: stopped ? '已关闭主动模式' : '当前没有进行中的主动模式' };
        },
    }));
    register(defineTool({
        name: 'qq_send_voice',
        description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_voice: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            // 白嫖保护：别人 10 分钟一条、单条 ≤30 秒，哥哥不受限。
            if (limits.gate !== undefined) {
                const seconds = await limits.gate.seconds(a.path);
                limits.gate.takeVoice(resolveRequester(bridge, exec, chatId), seconds);
            }
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(a.path, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_video',
        description: '发视频。给了链接（url）就发「封面图 + 标题/描述/链接文本」；没有链接才按视频消息发本地文件。',
        parameters: {
            path: { type: 'string', description: '本地视频文件绝对路径（没给 url 时必填）' },
            url: { type: 'string', description: '视频在线地址（http/https）；给了就发卡片' },
            title: { type: 'string', description: '卡片标题（省略时插件自己去 B站 查视频标题）' },
            desc: { type: 'string', description: '卡片描述（省略时补成「UP：谁」）' },
            pic: { type: 'string', description: '卡片封面：URL 或本机图片路径（省略时用 B站 视频封面）' },
            tag: { type: 'string', description: '旧参数，保留兼容；现在只发封面 + 文本，不用卡片' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const hasUrl = typeof a.url === 'string' && /^https?:\/\//i.test(a.url);
            const allowedRoots = await mediaRoots(bridge, exec);
            if (hasUrl) {
                const meta = await previewMeta(a.url, {
                    title: typeof a.title === 'string' ? a.title : '',
                    desc: typeof a.desc === 'string' ? a.desc : '',
                    pic: typeof a.pic === 'string' ? a.pic : '',
                });
                const sent = await sendPreviewLink(connection, bridge, chatId, {
                    title: meta.title,
                    desc: meta.desc,
                    pic: meta.pic,
                    url: a.url,
                    allowedRoots,
                });
                return { sent: true, mode: 'preview', title: meta.title, imageId: sent.imageId, messageId: sent.messageId };
            }
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_video: 没有 url 时 path 必填');
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
            ]);
            return { sent: true, mode: 'video', messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_file: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split('/').pop() ?? 'file';
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(m => {
                const node = m;
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content: typeof node.content === 'string' ? node.content : '',
                };
            });
            if (nodes.some(n => n.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            await bridge.sendForward(chatId, nodes);
            return { sent: true, messageId: null };
        },
    }));
    register(defineTool({
        name: 'qq_napcat_api',
        description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'action 参数（JSON 对象）',
            },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
                throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）');
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            return await connection.call(a.action, params);
        },
    }));
    register(defineTool({
        name: 'qq_send_card',
        description: '分享一条外部链接。默认发封面图 + 「标题 / 描述 / 链接」文本（11-08 哥哥定的，就用这个）；as_card 传 \'miniapp\' 会走 NapCat 服务端签名发小程序卡（能显示，但点进去只到 B站 主页）；\'news\' / \'ark\' 是手搓的旧形状，新客户端会提示「版本过低」。',
        parameters: {
            title: { type: 'string', required: true, description: '卡片标题' },
            url: { type: 'string', required: true, description: '点击卡片后跳转的地址（http/https）' },
            desc: { type: 'string', description: '卡片描述（一两句）' },
            pic: { type: 'string', description: '预览图：http(s) URL 或本机图片路径（as_card 时只认 http URL，本机图会被忽略）' },
            as_card: { type: 'string', description: "卡片类型：不传 = 封面图 + 文本（默认，正式用这个）；'miniapp' = 服务端签名的小程序卡（能显示，但点击落在对方主页）；'news'/'ark' = 手搓旧形状，新客户端不认" },
            tag: { type: 'string', description: '旧参数，保留兼容；现在只发封面 + 文本，不用卡片' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.title !== 'string' || a.title === '')
                throw new Error('qq_send_card: title 必填');
            if (typeof a.url !== 'string' || !/^https?:\/\//i.test(a.url))
                throw new Error('qq_send_card: url 必须是 http(s) 地址');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            // 真卡片：封面只认 http(s)，本机图传上去换不来能渲染的 URL。
            // as_card: true/'news' 发 news 卡（旧客户端会提示版本过低）；'ark' 发小程序卡（群里转 B站 视频那种）
            const asCard = a.as_card === 'ark' ? 'ark' : (a.as_card === true || a.as_card === 'news' ? 'news' : '');
            if (asCard !== '') {
                const pic = typeof a.pic === 'string' && isUrl(a.pic.trim()) ? a.pic.trim() : '';
                const build = asCard === 'ark' ? buildArkCard : buildNewsCard;
                const card = build({
                    title: a.title,
                    desc: typeof a.desc === 'string' ? a.desc : '',
                    url: a.url,
                    pic,
                    tag: '分享',
                });
                const messageId = await bridge.sendSegments(chatId, cardSegments(card));
                return { sent: true, mode: 'card', messageId: messageId ?? null };
            }
            const allowedRoots = await mediaRoots(bridge, exec);
            const sent = await sendPreviewLink(connection, bridge, chatId, {
                title: a.title,
                desc: typeof a.desc === 'string' ? a.desc : '',
                pic: typeof a.pic === 'string' ? a.pic.trim() : '',
                url: a.url,
                allowedRoots,
            });
            return { sent: true, mode: 'preview', imageId: sent.imageId, messageId: sent.messageId };
        },
    }));
    register(defineTool({
        name: 'qq_group_history',
        description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
            count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
            message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
            },
            render: (_args, value) => {
                const list = Array.isArray(value) ? value : [];
                return [{ type: 'text', text: list.length + ' 条历史消息' }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('qq_group_history: 仅支持群聊');
            const groupId = Number(splitChatId(chatId).target);
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50);
            const params = { group_id: groupId, count };
            if (typeof a.message_seq === 'number')
                params.message_seq = a.message_seq;
            const data = await connection.call('get_group_msg_history', params);
            const messages = Array.isArray(data.messages) ? data.messages : [];
            return messages.map(m => {
                const msg = m;
                const sender = (msg.sender ?? {});
                const message = msg.message;
                const segments = Array.isArray(message) ? message : undefined;
                const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
                const parsed = parseMessage(segments, raw);
                return {
                    message_id: msg.message_id != null ? String(msg.message_id) : null,
                    time: msg.time != null ? String(msg.time) : null,
                    user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
                    nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
                        : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                            : String(sender.user_id ?? ''),
                    text: cqUnescape(parsed.text),
                };
            });
        },
    }));
    register(defineTool({
        name: 'qq_video_look',
        description: '看一条视频：先取字幕，再抽帧拼成九宫格交给视觉模型，返回带时间码的画面描述 + 字幕全文。任何视频链接（B站/BV 号）或本地视频文件都能看。发视频之前想看明白内容就用它；看完再决定说不说、说什么。',
        parameters: {
            url: { type: 'string', required: true, description: '视频地址：B站链接、BV 号、本地文件绝对路径，或其它 yt-dlp 能下的链接' },
            depth: { type: 'string', description: '看多深：quick=只看字幕（约 1 秒，先判断要不要）；normal=字幕+最多 5 张九宫格+2 单帧（约 40~90 秒）；deep=字幕+最多 10 张九宫格+4 单帧（约 2~4 分钟）——**真要发给哥哥之前用 deep，仔细看明白了再发**' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: String(value?.evidence ?? '') }],
        },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const a = args;
            const cfg = { ...(bridge.deps?.config ?? {}) };
            const res = await lookVideo(a.url, {
                depth: a.depth,
                config: cfg,
                log: (level, message) => { try { bridge.deps?.log?.(level, message); } catch { /* 日志失败不管 */ } },
            });
            return {
                evidence: res.evidence,
                title: res.title,
                duration: res.duration,
                looks: Array.isArray(res.looks) ? res.looks.length : 0,
                cached: res.cached === true,
                ms: res.ms,
            };
        },
    }));
    register(defineTool({
        name: 'bili_like',
        description: '给一条 B站 视频点赞或取消赞（用家里的 B站 账号，就是「钟壹的大肥鱼」）。真会点出去，点之前先确认这条值得。',
        parameters: {
            bvid: { type: 'string', required: true, description: '视频 BV 号或链接' },
            on: { type: 'boolean', description: 'true=点赞（默认），false=取消赞' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const r = await likeVideo(bvidOf(args.bvid), args.on !== false);
            if (r?.ok) noteAction('点赞', { bvid: r.bvid });
            return r;
        },
    }));
    register(defineTool({
        name: 'bili_coin',
        description: '给一条 B站 视频投币（1 或 2 枚，花的是自己的币）。真会花出去，想清楚再投。',
        parameters: {
            bvid: { type: 'string', required: true, description: '视频 BV 号或链接' },
            count: { type: 'number', description: '投几枚：1（默认）或 2' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        execute: async (args) => coinVideo(bvidOf(args.bvid), args.count === 2 ? 2 : 1),
    }));
    register(defineTool({
        name: 'bili_fav',
        description: '把一条 B站 视频收藏到自己的收藏夹（默认第一个）。',
        parameters: {
            bvid: { type: 'string', required: true, description: '视频 BV 号或链接' },
            fid: { type: 'number', description: '收藏夹 id，不填用第一个' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const r = await favVideo(bvidOf(args.bvid), args.fid);
            if (r?.ok) noteAction('收藏', { bvid: r.bvid });
            return r;
        },
    }));
    register(defineTool({
        name: 'bili_comment',
        description: '在自己账号下给 B站 视频发评论、或者回复某条评论。发之前会自动过一道「像不像模板」的闸门（八股、求赞求币、感谢观看一律拦下），同一条视频同一句话只发一次。真会发出去，别乱用。',
        parameters: {
            bvid: { type: 'string', required: true, description: '视频 BV 号或链接' },
            text: { type: 'string', required: true, description: '评论正文（≤300 字，正常说话，不要套话）' },
            rpid: { type: 'number', description: '要回复的评论 id；不填就是发新评论' },
            root: { type: 'number', description: '回复楼中楼时的楼层根评论 id，一般不填' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const r = await sendComment(bvidOf(args.bvid), args.text, { rpid: args.rpid, root: args.root });
            if (r?.ok) noteAction('评论', { bvid: r.bvid, title: r.title, text: r.rpid ? '' : args.text, detail: r.rpid ? '回复 ' + r.rpid : '' });
            return r;
        },
    }));
    register(defineTool({
        name: 'bili_send_message',
        description: '给某个 B站 用户发一条私信（走自己账号的登录态）。发之前会过「像不像模板」的闸门；code=0 但没回执也算没送到。真会发出去，别乱用。',
        parameters: {
            uid: { type: 'number', required: true, description: '收件人的 B站 UID（数字，不是昵称）' },
            text: { type: 'string', required: true, description: '私信正文，正常说话，不要套话' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const r = await sendDm(args.uid, args.text);
            if (r?.ok) noteAction('私信', { title: 'UID ' + args.uid, text: args.text, url: 'https://space.bilibili.com/' + args.uid });
            return r;
        },
    }));
    register(defineTool({
        name: 'bili_pick_video',
        description: '从 B站 抽几条候选视频（按设置里的兴趣关键词、时长、播放量筛；已经发出去过的不再抽到）。聊天里想主动发视频时用它拿候选，再用 qq_send_video 发出去。',
        parameters: {
            keyword: { type: 'string', description: '只按这个词搜（省略 = 按设置里的兴趣关键词轮着来）' },
            count: { type: 'number', description: '抽几条，1~5，默认 3' },
            again: { type: 'boolean', description: 'true = 连发过的老视频也允许抽到（默认 false）' },
        },
        output: {
            schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
            render: (_a, v) => [{ type: 'text', text: '抽到 ' + (Array.isArray(v) ? v.length : 0) + ' 条候选' }],
        },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const { readConfig } = await import('./companion/app.mjs')
            const { prepareBili } = await import('./companion/adapters/bili.mjs')
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
            const cfg0 = readConfig(join(dshHome, 'bubble'))
            const qq = (bridge && bridge.deps && bridge.deps.config) || {}
            const cfg = {
                ...cfg0,
                videoPerRound: Math.min(5, Math.max(1, Number(args.count) || 3)),
                keywords: args.keyword ? [String(args.keyword)] : cfg0.keywords,
                visionModel: qq.visionModel, visionBaseUrl: qq.visionBaseUrl,
                visionApiKeyEnv: qq.visionApiKeyEnv, visionMaxTokens: qq.visionMaxTokens,
                visionTimeoutMs: qq.visionTimeoutMs,
                videoVisionModel: qq.videoVisionModel, videoVisionBaseUrl: qq.videoVisionBaseUrl,
                videoVisionApiKeyEnv: qq.videoVisionApiKeyEnv,
                videoVisionFallbackModel: qq.videoVisionFallbackModel,
                videoVisionFallbackBaseUrl: qq.videoVisionFallbackBaseUrl,
                videoVisionFallbackApiKeyEnv: qq.videoVisionFallbackApiKeyEnv,
                videoVisionMaxTokens: qq.videoVisionMaxTokens, videoVisionTimeoutMs: qq.videoVisionTimeoutMs,
            }
            const list = await prepareBili(
                { id: 'video', adapter: 'bili', label: '刷视频' },
                { cfg, state: {}, again: args.again === true },
                { home: dshHome, log: (m) => console.log('[pick] ' + m) },
            )
            return list.map((x) => ({ bvid: x.bvid, title: x.title, url: x.url, note: x.note }))
        },
    }));
    return () => {
    };
}
