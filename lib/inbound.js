/**
 * Inbound pipeline (M2-D1-PR4): the OneBot-11 → agent-turn path. Two pieces:
 * `normalizeOneBot11`, the pure protocol-adaptation seam that reduces one
 * raw message event to a neutral NormalizedInbound (null = not processable),
 * and `InboundPipeline`, which runs the normalized message through the
 * policy gate → mention gate → command router → media resolution →
 * quote/forward expansion → rate limit → turn dispatch. Extracted verbatim
 * from bridge.ts — gate order, prefix assembly, media annotation and
 * rate-limit behavior are identical; the bridge keeps same-name facade
 * methods so the onFrame call site, the command table and the M2-T0
 * pipeline-order overrides keep working unchanged.
 * @module dsh-onebot/inbound
 */
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extForInboundName } from './media.js';
import { normalizeRolls, pickRoll, rollLine } from './companion/chatroll.mjs';
import { describeImage, ocrText, parseHeaderJson, resolveApiKey } from './vision.js';
import { imageAction, imageTurn } from './image-gate.js';
import { transcriptLabel } from './stt.js';
import { cqUnescape, detectMention, detectUserMention, parseMessage, segmentText } from './cq.js';
import { biliLinkNote } from './link-expand.js';
import { buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, escapeBoundary, groupAllowed, RESTRICTED_PREFIX, sanitizeNickname, wrapUserMessage, } from './chat.js';
import { describeError } from './errors.js';
import { currentTrace, TRACE_REASONS } from './trace.js';
/**
 * 图片描述的磁盘缓存：同一张图（按内容 sha1）一周内只问一次。
 * 只给「真的问到」的消息用——图片注解本来就在过了关键词/@ 门槛之后才算。
 */
const VISION_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const VISION_CACHE_MAX = 400;
/** 缓存跟 qq-actions.log 一个屋：$DSH_HOME/onebot/vision-cache.json。 */
function visionCacheFile() {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'onebot', 'vision-cache.json');
}
/** 读缓存；文件坏了当没有。 */
function readVisionCache() {
    try {
        const raw = JSON.parse(readFileSync(visionCacheFile(), 'utf8'));
        return raw !== null && typeof raw === 'object' ? raw : {};
    }
    catch {
        return {};
    }
}
/** 写缓存：顺手清过期的，超上限只留最新的（写不进去不影响识图）。 */
function writeVisionCache(cache) {
    try {
        const now = Date.now();
        const rows = Object.entries(cache)
            .filter(([, v]) => v !== null && typeof v === 'object' && now - Number(v.at) < VISION_CACHE_TTL_MS)
            .sort((a, b) => Number(b[1].at) - Number(a[1].at));
        const keep = Object.fromEntries(rows.slice(0, VISION_CACHE_MAX));
        mkdirSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'onebot'), { recursive: true });
        writeFileSync(visionCacheFile(), JSON.stringify(keep), 'utf8');
    }
    catch {
        // 缓存是加速用的，坏了不该拖累识图。
    }
}
/**
 * Reduce one raw OneBot 11 event to the neutral inbound shape, or null when
 * the event is not a processable chat message (notice/recall, meta, unknown
 * message_type, or a missing sender id). Pure: no I/O, no state — the
 * connection's self_id learning stays in the transport layer and the
 * ignoreSelf comparison stays in the pipeline (both are runtime state).
 */
export function normalizeOneBot11(event) {
    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group')
        return null;
    const userId = String(event.user_id ?? '');
    if (userId === '')
        return null;
    const kind = messageType === 'private' ? 'private' : 'group';
    const groupId = kind === 'group' ? String(event.group_id ?? '') : '';
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const segments = Array.isArray(event.message) ? event.message : undefined;
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '');
    const messageId = event.message_id === undefined || event.message_id === null
        ? undefined
        : String(event.message_id);
    const parsed = parseMessage(segments, raw);
    const sender = event.sender ?? {};
    const nickname = typeof sender.card === 'string' && sender.card !== ''
        ? sender.card
        : typeof sender.nickname === 'string' && sender.nickname !== ''
            ? sender.nickname
            : userId;
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments,
        raw,
        text: parsed.text,
        media: parsed.media,
        replyId: parsed.replyId,
        forwardId: parsed.forwardId,
        messageId,
        nickname,
    };
}
/** W2-②: default (chatId, message_id) dedup window, aligned with the MIT
 * competitor's dedupWindowSeconds (300s). */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** 「随意聊聊」触发词（10-31 加，同晚放宽）：管理员在群里发「随意聊聊」或
 *  「随便聊聊 10 分钟」开一个全群开放窗口。容许「随意/随便」混写、中文数字
 *  （两/十/十五/二十）与单位词；称呼前缀交给 matchOpenChat 剥。 */
/** 「随意聊聊」触发词（11-07 改：只认哥哥本人发的；不再要求整句只有那几个字）。
 *  正文里出现「随意/随便 聊(聊)」就算发词；同一条里再带个时长（数字或中文数字 +
 *  分钟/分/小时/钟头）就用它；只写「几句/两句/一会儿」按 3 分钟；啥都没带用默认。
 *  谁能开窗由调用方保证：只有管理员（哥哥）。 */
export const OPEN_CHAT_WORD_RE = /随[意便]\s*聊\s*聊?/;
const OPEN_CHAT_TIME_RE = /(\d{1,3}|[一二三四五六七八九十]{1,3}|两|半)\s*个?\s*(分钟|分|小时|钟头|h|mins?)/i;
const OPEN_CHAT_SOFT_TIME_RE = /(几句|两句|一会儿|一会|会儿|一阵)/;
/** 窗口内每条群消息带的前置标记：告诉模型这条要接话，不用再等 @。 */
const OPEN_CHAT_TAG = '【随意聊聊中：这条要接话】';
/** 关窗词（11-07 加）：窗口开着时，哥哥说句「停止/关掉/停下随意聊聊」就收工。
 *  必须同时带上「停/关/结束」这类词和「随意聊/聊天」这类词才动手，光说「停」
 *  不算——免得被正常聊天里的一个「停」误关。 */
const OPEN_CHAT_CLOSE_RE = /(停止|停下|停一下|关掉|关闭|关了|关一下|结束|打住|打烊|收工|收摊|不聊了|别聊了|到此为止|散了吧)/;
const OPEN_CHAT_CHAT_RE = /(随意|随便|聊天|聊聊|聊会|聊了|聊吧)/;
/** 只回一个「关掉 / 停止」这种短句也算——但必须是整句就这几个字，
 *  免得「这视频停在那了」把窗口关了。 */
const OPEN_CHAT_BARE_RE = /^((好了|好|行|可以|嗯|那|就)[，,、\s]*)*(停止|停下|停一下|停|关掉|关闭|关了|关|结束|打住|打烊|收工|收摊|不聊了|别聊了|到此为止|散了吧)[吧啦呀哦。！!~—]*$/;
export function matchCloseChat(raw) {
    if (typeof raw !== 'string')
        return false;
    const text = raw.replace(/@\d+\s*/g, '').trim();
    if (!OPEN_CHAT_CLOSE_RE.test(text) && !OPEN_CHAT_BARE_RE.test(text))
        return false;
    if (OPEN_CHAT_CLOSE_RE.test(text) && OPEN_CHAT_CHAT_RE.test(text))
        return true;
    return OPEN_CHAT_BARE_RE.test(text);
}
/** 中文数字 → 数（只覆盖聊天里会用到的一百以内）。 */
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 半: 0.5 };
function cnToNumber(token) {
    if (token === '半')
        return 0.5;
    if (/^\d+$/.test(token))
        return Number(token);
    if (token === '十')
        return 10;
    if (/^十/.test(token))
        return 10 + (CN_DIGITS[token.slice(1)] ?? 0);
    if (/十$/.test(token))
        return (CN_DIGITS[token[0]] ?? 1) * 10;
    if (/十/.test(token)) {
        const [a, b] = token.split('十');
        return (CN_DIGITS[a] ?? 1) * 10 + (CN_DIGITS[b] ?? 0);
    }
    return CN_DIGITS[token] ?? 0;
}
/** 从哥哥的一条消息里认「随意聊聊 + 时长」：命中返回分钟数（没写时长 = 0，调用方用默认），
 *  没提到「随意/随便聊」返回 null。11-07 起不要求整句只有这几个字，也不要求时长写在后半截。 */
/** 11-07：递话头时把他的原话截一段，别把整段长文塞回去。 */
function clipForNudge(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) + '…' : t;
}
export function matchOpenChat(raw) {
    if (typeof raw !== 'string')
        return null;
    const text = raw.replace(/@\d+\s*/g, '');
    if (!OPEN_CHAT_WORD_RE.test(text))
        return null;
    const timed = OPEN_CHAT_TIME_RE.exec(text);
    if (timed !== null) {
        const amount = cnToNumber(timed[1]);
        if (!Number.isFinite(amount) || amount <= 0)
            return 0;
        const isHour = /小时|钟头|^h$/i.test(timed[2] ?? '');
        return Math.max(1, Math.round(isHour ? amount * 60 : amount));
    }
    if (OPEN_CHAT_SOFT_TIME_RE.test(text))
        return 3;
    return 0;
}
/** W2-②: max entries kept in the dedup window map (LRU-evicted beyond this)
 * so a flood of distinct message_ids cannot grow memory unbounded. */
export const DEDUP_MAX_ENTRIES = 4096;
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
/** 私聊记忆节流用：带这些字的二字组合不算「聊到了」。 */
const MEMORY_STOP_CHARS = new Set('的了是我你他她它不在也就都这那和吗呢吧啊么呀哦嗯亲个们把被给让对从与及要会能可说想来到很再又还');
/** 私聊记忆节流用：这些常用二字词天天出现，不能当话题信号。 */
const MEMORY_STOP_GRAMS = new Set([
    '什么', '怎么', '我们', '你们', '他们', '现在', '今天', '昨天', '明天', '后天',
    '还是', '就是', '不是', '可以', '这个', '那个', '一个', '没有', '已经', '因为',
    '所以', '但是', '然后', '时候', '自己', '知道', '觉得', '东西', '这样', '那样',
    '一下', '一点', '有点', '真的', '其实', '应该', '可能', '需要', '准备', '刚才',
    '测试', '在吗', '试试',
]);
export class InboundPipeline {
    ctx;
    /** W2-② dedup knobs (see InboundPipelineOptions). */
    dedupMaxEntries;
    now;
    /** W2-② dedup window state: "chatId#messageId" → first-seen epoch ms, in
     * insertion order (Map) so the oldest entry is the LRU victim. */
    seenMessages = new Map();
    /** 群聊关键词触发的冷却表：chatId → 上次主动回复的 epoch ms。 */
    keywordCooldowns = new Map();
    /** 「随意聊聊」窗口（10-31 加）：chatId → 到期 epoch ms；到期自动回潜水。 */
    openChatUntil = new Map();
    /** 窗口到点的收尾定时器：chatId → setTimeout 句柄。 */
    openChatTimers = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.dedupMaxEntries = options.dedupMaxEntries ?? DEDUP_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
        /** 11-04：按 chatId 的 2 秒防抖窗（见 queueCoalesced）。 */
        this.coalescing = new Map();
    }
    /** W1/T5 health snapshot: how many message_ids are currently held in the
     * dedup window (LRU-capped; see DEDUP_MAX_ENTRIES). */
    get dedupWindowEntries() {
        return this.seenMessages.size;
    }
    /** 每轮掷骰（11-04 哥哥要；11-11 改成可配置的「聊天强制事件」）：
     *  每条自己写一句、自己一个百分比，独立掷；中了才往这轮塞一句话，没中就一个字都不塞。
     *  语音那条（gate === 'voice'）还要本地服务在线（默认探 127.0.0.1:9880 = 嗓子），探不到就跳过。 */
    async rollTurnAttachments() {
        const cfg = this.ctx.config;
        // 空数组 = 还没配过（schema default([])），走老的两个概率迁移
        const saved = Array.isArray(cfg.chatRolls) && cfg.chatRolls.length ? cfg.chatRolls : null;
        const rolls = normalizeRolls(saved, {
            memeChance: cfg.memeChance,
            voiceChance: cfg.voiceChance,
        }, { ensureMeme: false });
        const hit = pickRoll(rolls);
        if (!hit)
            return '';
        if (hit.gate === 'voice' && !(await this.localStackOnline()))
            return '';
        return rollLine(hit) + String.fromCharCode(10);
    }
    /** 本地服务在线探测（端口来自配置，0 = 不探）：400ms 内连得上才算在线。 */
    async localStackOnline() {
        const host = this.ctx.config.voiceGateHost ?? '127.0.0.1';
        const port = this.ctx.config.voiceGatePort ?? 0;
        if (!port)
            return false;
        return await new Promise((resolve) => {
            const socket = net.connect({ host, port });
            const done = (ok) => {
                try {
                    socket.destroy();
                }
                catch { }
                resolve(ok);
            };
            socket.setTimeout(400, () => done(false));
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
        });
    }
    /** 群聊关键词触发判定：正文命中任一关键词，且该群已过冷却期。 */
    keywordTriggered(text, chatId) {
        const keywords = this.ctx.config.groupKeywords ?? [];
        if (keywords.length === 0 || typeof text !== 'string' || text === '')
            return false;
        if (!keywords.some((word) => word !== '' && text.includes(word)))
            return false;
        const cooldown = this.ctx.config.groupKeywordCooldownMs ?? 120_000;
        if (cooldown <= 0)
            return true;
        const last = this.keywordCooldowns.get(chatId);
        if (last === undefined)
            return true;
        return this.now() - last >= cooldown;
    }
    /** 记一次关键词主动回复，冷却从现在起重算。 */
    markKeywordReply(chatId) {
        this.keywordCooldowns.set(chatId, this.now());
    }
    /** 概率关键词触发（10-31 加）：probableKeywords 命中后本地掷骰，
     *  小于 ratio 才算（如「大肥鱼」配 0.5 = 一半概率接话）；与硬关键词
     *  共用每群冷却。 */
    probableTriggered(text, chatId) {
        const entries = this.ctx.config.probableKeywords ?? [];
        if (entries.length === 0 || typeof text !== 'string' || text === '')
            return false;
        const cooldown = this.ctx.config.groupKeywordCooldownMs ?? 120_000;
        if (cooldown > 0) {
            const last = this.keywordCooldowns.get(chatId);
            if (last !== undefined && this.now() - last < cooldown)
                return false;
        }
        for (const entry of entries) {
            const word = entry?.word ?? '';
            const ratio = typeof entry?.ratio === 'number' ? entry.ratio : 0;
            if (word === '' || ratio <= 0 || !text.includes(word))
                continue;
            if (Math.random() < ratio)
                return true;
        }
        return false;
    }
    /** 「随意聊聊」窗口是否仍在有效期内；已过期就顺手清掉（不算命中）。 */
    openChatActive(chatId) {
        const until = this.openChatUntil.get(chatId);
        if (until === undefined)
            return false;
        if (this.now() < until)
            return true;
        this.openChatUntil.delete(chatId);
        this.clearOpenChatTimer(chatId);
        return false;
    }
    /** 清掉某群的收尾定时器。 */
    clearOpenChatTimer(chatId) {
        const timer = this.openChatTimers.get(chatId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.openChatTimers.delete(chatId);
        }
    }
    /** 开一个「随意聊聊」窗口：minutes > 0 用它（受 openChatMaxMs 上限），
     *  不给时间用 openChatDefaultMs；到期自动清窗并送一句收尾。 */
    async startOpenChat(chatId, minutes) {
        const cap = this.ctx.config.openChatMaxMs ?? 1_200_000;
        const def = this.ctx.config.openChatDefaultMs ?? 600_000;
        const ms = minutes > 0 ? Math.min(minutes * 60_000, cap) : def;
        const until = this.now() + ms;
        this.openChatUntil.set(chatId, until);
        this.clearOpenChatTimer(chatId);
        const timer = setTimeout(() => {
            if (this.openChatUntil.get(chatId) !== until)
                return;
            this.openChatUntil.delete(chatId);
            this.openChatTimers.delete(chatId);
            // 11-07 B：到点不替她说话，只递个话头，让她自己收尾。
            this.nudgeSelf(chatId, '（随意聊的时间到了，随口说一句收尾，然后回潜水。）');
        }, ms);
        // 别让这个计时器把进程吊住（关窗/重启时它没到点也不该拦着退出）。
        if (typeof timer.unref === 'function')
            timer.unref();
        this.openChatTimers.set(chatId, timer);
        const totalMin = Math.max(1, Math.round(ms / 60_000));
        this.ctx.log('info', '随意聊窗口开启: ' + chatId + '，' + totalMin + ' 分钟');
        return totalMin;
    }
    /** 11-07 哥哥选 B：插件不替她说话，只把一个话头递进会话，让她自己开口。 */
    nudgeSelf(chatId, note) {
        try {
            const p = this.ctx.dispatchFollowup(chatId, note, 'admin', '本鱼');
            if (p !== undefined && p !== null && typeof p.then === 'function') {
                p.catch((e) => { this.ctx.log('warn', '话头递不进会话: ' + chatId + ' ' + ((e && e.message) || e)); });
            }
        }
        catch (e) {
            this.ctx.log('warn', '话头递不进会话: ' + chatId + ' ' + ((e && e.message) || e));
        }
    }
    /** 关「随意聊聊」窗口：清掉截止时间与收尾定时器，回一句（安静关就不吭声）。 */
    async stopOpenChat(chatId, quiet = false) {
        const had = this.openChatUntil.delete(chatId);
        this.clearOpenChatTimer(chatId);
        if (had) {
            this.ctx.log('info', '随意聊窗口关闭: ' + chatId);
            if (!quiet)
                this.nudgeSelf(chatId, '（随意聊到此为止，自然应一句收尾就行。）');
        }
        return had;
    }
    async processInbound(inbound) {
        if (this.duplicated(inbound))
            return;
        const { kind, userId, groupId, chatId } = inbound;
        if (this.ctx.config.ignoreSelf && this.ctx.selfId() !== '' && userId === this.ctx.selfId()) {
            // pipeline-hooks.md #5: this drop used to be fully silent.
            this.ctx.log('debug', '机器人自己的消息已忽略: ' + chatId);
            currentTrace()?.emit('self', { ok: false, reason: TRACE_REASONS.inboundSelf });
            return;
        }
        const policy = this.ctx.policy;
        if (kind === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
        else {
            if (!groupAllowed(groupId, policy)) {
                this.ctx.log('debug', 'ignoring group message from non-allowed group ' + groupId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundGroupBlocked });
                return;
            }
        }
        // 过了白名单才记「当前目标」（11-12 审计：原来记在闸之前，未授权用户也会成为目标）。
        this.ctx.noteTargetMessage?.(chatId, userId);
        // 管理员判定提前到 gate 之前（10-31）：「随意聊聊」触发只有管理员能开。
        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';
        const mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        // 哥哥被 @ 时本鱼也开口：只有「@本鱼」或「@哥哥」两种情况才发言。
        const ownerQQ = String(this.ctx.config.ownerQQ ?? '');
        const ownerMentioned = kind === 'group' && !mentioned
            && detectUserMention(inbound.segments, inbound.raw, ownerQQ);
        // 白嫖保护：记住这条群里是谁发的（语音/图片冷却按发言人算）。
        if (kind === 'group')
            this.ctx.getSettings(chatId).lastSpeaker = { id: String(userId), name: String(inbound.nickname ?? '') };
        // 记住本群最近被 @ 的那个人，主动模式默认拿他当目标。
        if (kind === 'group' && inbound.segments !== undefined) {
            const other = inbound.segments.find((seg) => seg.type === 'at' && typeof seg.data.qq === 'string'
                && seg.data.qq !== '' && seg.data.qq !== 'all' && seg.data.qq !== this.ctx.selfId());
            if (other !== undefined)
                this.ctx.getSettings(chatId).lastAtUser = { id: other.data.qq, name: String(other.data.name ?? '') };
        }
        // 主动模式：目标用户哪怕没 @ 本鱼，也要接话——黏人模式不看 @。
        const proactiveTarget = kind === 'group' ? (this.ctx.proactiveTargetId?.(chatId) ?? '') : '';
        const proactiveHit = !mentioned && proactiveTarget !== '' && proactiveTarget === String(userId);
        // 关键词硬触发（10-27 补）：groupKeywords 命中就不看 @，直接接话。
        const keywordHit = kind === 'group' && this.keywordTriggered(inbound.text, chatId);
        // 概率触发（10-31 加）：probableKeywords 命中后本地掷骰，中了才算。
        const probableHit = !keywordHit && !mentioned && !ownerMentioned && !proactiveHit
            && kind === 'group' && this.probableTriggered(inbound.text, chatId);
        // 「随意聊聊」窗口（10-31 加）：窗口内该群所有消息都接，不看 @。
        const openChat = kind === 'group' && this.openChatActive(chatId);
        if (kind === 'group' && isAdmin) {
            // 先认关窗：说了「关闭 / 停止 / 关掉 随意聊聊」就不许再被下面当成「开窗」——
            // 之前就是因为它排在有窗口判断里，窗口没开时「关闭随意聊聊」反而又开了一次。
            if (matchCloseChat(inbound.text)) {
                const had = await this.stopOpenChat(chatId, true);
                if (had)
                    this.nudgeSelf(chatId, '（他说「' + clipForNudge(inbound.text) + '」，随意聊到此为止，你自然应一句收尾。）');
                else
                    this.ctx.log('debug', '关窗指令但窗口没开: ' + chatId);
                currentTrace()?.emit('command', { ok: true, reason: '随意聊窗口关闭' });
                return;
            }
            const openChatMinutes = matchOpenChat(inbound.text);
            if (openChatMinutes !== null) {
                const totalMin = await this.startOpenChat(chatId, openChatMinutes);
                this.nudgeSelf(chatId, '（他对你说「' + clipForNudge(inbound.text) + '」。从现在起 ' + totalMin + ' 分钟他每条话都会到你这里；自然应一句就好，别提插件或设置。）');
                currentTrace()?.emit('command', { ok: true, reason: '随意聊窗口' });
                return;
            }
        }
        if (kind === 'group' && this.ctx.config.requireMention && !mentioned && !ownerMentioned && !proactiveHit && !keywordHit && !probableHit && !openChat) {
            this.ctx.log('debug', 'ignoring unmentioned group message in ' + groupId);
            currentTrace()?.emit('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned });
            return;
        }
        if (keywordHit) {
            this.markKeywordReply(chatId);
            this.ctx.log('info', '群聊关键词命中，主动接话: ' + chatId);
            currentTrace()?.emit('mention', { ok: true, reason: '关键词触发' });
        }
        if (probableHit) {
            this.markKeywordReply(chatId);
            this.ctx.log('info', '群聊概率关键词命中（掷骰通过），主动接话: ' + chatId);
            currentTrace()?.emit('mention', { ok: true, reason: '概率关键词触发' });
        }
        if (openChat) {
            this.ctx.log('debug', '随意聊窗口内，接话: ' + chatId);
            currentTrace()?.emit('mention', { ok: true, reason: '随意聊窗口' });
        }
        if (ownerMentioned) {
            this.ctx.log('info', '群里有人 @ 哥哥，本鱼接话: ' + chatId);
            currentTrace()?.emit('mention', { ok: true, reason: '主人被 @ 触发' });
        }
        if (proactiveHit) {
            this.ctx.log('info', '主动模式：目标用户发言，直接接话: ' + chatId);
            currentTrace()?.emit('mention', { ok: true, reason: '主动模式目标发言' });
        }
        // M3-D5 identity whitelist: the sanitized nickname feeds the single-line
        // prefix, the <user_message> attribute and lastNickname — one value,
        // provably line-safe and markup-free for all three surfaces.
        const nickname = sanitizeNickname(inbound.nickname);
        // B8c: lazy idle eviction before processing each inbound message (flush →
        // dispose → remove; the mapping is kept so the chat can resume).
        await this.ctx.sweepIdleChats();
        // A new user message starts a fresh reply cycle: drop any unmerged loop
        // residue from the previous cycle so interims never merge across turns.
        const priorChat = this.ctx.getChat(chatId);
        if (priorChat !== undefined) {
            priorChat.loopBuffer = [];
            priorChat.loopPending = null;
        }
        // Fire-and-forget temp cleanup on each inbound.
        void this.ctx.media.cleanupExpired();
        // C6a: route slash commands BEFORE any media/quote I/O — a message that
        // happens to carry media must not pay for downloads or get_msg calls just
        // to be consumed as a command (admin-only; unknown /-words still fall
        // through to the model). The most recent inbound image is registered from
        // parsed.media up front so /ocr still sees it (resolved lazily there).
        for (const ref of inbound.media) {
            if (ref.kind === 'image')
                this.ctx.getSettings(chatId).pendingImageRef = ref;
        }
        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {
            currentTrace()?.emit('command', { ok: true, reason: TRACE_REASONS.inboundCommand });
            return;
        }
        // 识图额度：只有本鱼要发言时才建。@ 只看最后一张；主动模式最多 3 张，
        // 聊天记录或超量图直接不认、让模型说「脑子不够用」。
        const directImageCount = inbound.media.filter((ref) => ref.kind === 'image').length;
        {
            const isPrivate = kind === 'private';
            const chatLog = proactiveHit && inbound.forwardId !== undefined;
            const tooMany = proactiveHit && directImageCount > (this.ctx.config.maxImagesPerTurn ?? 3);
            const allowImages = (proactiveHit || mentioned || ownerMentioned || keywordHit || probableHit || openChat || isPrivate) && !chatLog && !tooMany;
            const budget = proactiveHit ? (this.ctx.config.maxImagesPerTurn ?? 3) : (this.ctx.config.mentionMaxImages ?? 1);
            const settings = this.ctx.getSettings(chatId);
            settings.imageTurn = imageTurn({
                allow: allowImages,
                budget,
                // @ 场景只留最后一张：前面几张静默跳过。
                skipLeading: allowImages && budget === 1 ? Math.max(0, directImageCount - 1) : 0,
            });
            settings.imageSkipReason = chatLog ? '聊天记录' : tooMany ? '图片太多' : '';
        }
        // 群里发来的 B站 链接（尤其 b23.tv 短链）原样进会话等于没说：先展开成
        // 「标题｜UP｜时长｜播放」贴在正文后面。失败一律空串，不影响投递。
        const linkNote = await biliLinkNote(inbound.text, { log: (lvl, msg) => this.ctx.log(lvl, msg) });
        // 定时话头（哥哥 11-09 重做）：他说话/回她的这一轮才有资格排；抽卡那轮不提示。
        const cfgNow = this.ctx.config || {};
        // 哥哥 11-11：话头里不写具体条数（改次数重启也读不到对的值，还容易让她以为
        // 「今天就剩 N 次」）。只说「能自主定时追聊」，具体上限由插件自己管。
        const moreNote = cfgNow.followupEnabled === false
            ? `（末尾另起一行写 [SCORE n]，0-10：按你自己这会儿的心情——5 分一般、10 分特别开心、0 分被气到了。它决定你之后还肯不肯主动开口。）`
            : `（末尾另起一行写 [SCORE n]，0-10：按你自己这会儿的心情——5 分一般、10 分特别开心、0 分被气到了；它决定你之后还肯不肯主动开口。想晚点再主动说一句，就另起一行写 [LATER 25]（25 分钟后叫醒你再说；隔多久、什么时候说，你自己定）。）`;
        const bodyText = [inbound.text, linkNote, moreNote].filter((x) => x !== '').join('\n');
        const body = await this.ctx.buildBody(bodyText, inbound.media, chatId);
        // 被 @ 但本条没带图：往回看几条（默认 3 条、5 分钟内）有没有图，认一张就够。
        let recentImage = '';
        if (kind === 'group' && (mentioned || ownerMentioned) && directImageCount === 0) {
            const note = await this.recentImageNote(chatId);
            if (note !== '')
                recentImage = '（群友上一条发的图：' + note + '）';
        }
        let quote = '';
        if (inbound.replyId !== undefined) {
            quote = await this.ctx.expandQuote(inbound.replyId);
        }
        let forward = '';
        if (inbound.forwardId !== undefined) {
            const expansion = await this.expandForward(inbound.forwardId);
            forward = expansion.text;
            if (expansion.media.length > 0) {
                // Forward-embedded images ride the same buildBody pipeline (their
                // '[图片]' placeholders are inline in the expansion text). Preserve
                // the pre-routing /ocr ref so a direct image in the same message
                // stays the /ocr target.
                const pending = this.ctx.getSettings(chatId).pendingImageRef;
                forward = await this.ctx.buildBody(expansion.text, expansion.media, chatId);
                this.ctx.getSettings(chatId).pendingImageRef = pending;
            }
        }
        if (this.rateLimited(chatId))
            return;
        // M3-D5: the whole sender-controlled payload (body + quote/forward
        // expansions) enters the prompt inside the <user_message> boundary, so
        // forged prefix lines, restricted-member tags and system-prompt-like text
        // stay pure data. The framework-generated group prefix and
        // RESTRICTED_PREFIX remain outside — the only trusted metadata.
        const content = [forward, quote, body, recentImage].filter(part => part !== '').join('\n');
        if (content.trim() === '') {
            // pipeline-hooks.md #17: this drop used to be fully silent.
            this.ctx.log('debug', '消息展开后无有效文本内容，已丢弃: ' + chatId);
            currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.inboundEmptyContent });
            return;
        }
        let final = wrapUserMessage(content, userId, nickname);
        // 图太多 / 聊天记录太长：不认图，直接让本鱼认输。
        {
            const settings = this.ctx.getSettings(chatId);
            const skipReason = settings.imageSkipReason ?? '';
            if (settings.imageTurn?.overflow === true || skipReason !== '') {
                final += '\n[图片提示] 对方这次发的是' + (skipReason !== '' ? skipReason : '超过额度的多张图')
                    + '，本鱼没逐张看。别硬猜图里有什么，直接说一句「太多了，本鱼脑子不够用」之类的话就好，不用解释。';
            }
        }
        if (kind === 'group') {
            final = buildGroupMessagePrefix(nickname, userId, mentioned, ownerMentioned) + final;
            // 随意聊窗口内：给模型一个局内标记，这条不用等 @ 也要接。
            if (openChat)
                final = OPEN_CHAT_TAG + final;
            if (!isAdmin && this.ctx.config.restrictedMemberPrefix) {
                final = RESTRICTED_PREFIX + final;
            }
        }
        // 长期记忆：群聊照旧整份带；私聊只在「这轮真聊到」时才挑几行，省 token。
        const memoryBlock = this.memoryBlock(kind, chatId, content);
        if (memoryBlock !== '')
            final = '<chat_memory>\n' + escapeBoundary(memoryBlock.trim()) + '\n</chat_memory>\n' + final;
        // 被 @ 时补最近的群聊上下文（默认 10 条），省得接不上话；读不到就算了。
        if (kind === 'group' && (mentioned || ownerMentioned) && this.ctx.recentHistory !== undefined) {
            const history = (await this.ctx.recentHistory(chatId, this.ctx.config.mentionHistoryCount ?? 10)) ?? '';
            if (history !== '')
                final = '<chat_history name="被 @ 前的最近群聊">\n' + escapeBoundary(history.trim()) + '\n</chat_history>\n' + final;
        }
        const role = isAdmin ? 'admin' : 'member';
        // `plain` = no media, no quote, no forward: the only shape eligible for steer (media-bearing
        // messages always queue so the full media pipeline runs for their own turn).
        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;
        // 这一轮真正的派发（含每轮掷骰）：合并窗关闭之后才走到这里，所以骰子一轮只掷一次。
        const proceed = async (mergedText, mergedPlain) => {
            // 每轮掷骰：表情包 / 语音发不发，由插件定（11-04），标记写进本轮文本。
            const text = await this.rollTurnAttachments() + mergedText;
            // 目标用户连发太快（默认 10 秒内超过 3 条）时先压住，等他安静 5 秒再合并成一轮回。
            if (proactiveHit && this.ctx.burstOffer !== undefined
                && this.ctx.burstOffer(chatId, text, role, nickname) === true) {
                this.ctx.log('debug', '对方连发过快，已进缓冲: ' + chatId);
                currentTrace()?.emit('dispatch', { ok: true, reason: '连发缓冲' });
                return;
            }
            // T2 (P1): the busy-turn policy seam runs AFTER every gate above (dedup /
            // self / policy / mention / command / rate-limit) and only around the
            // final dispatch — a queued or steered message has already paid for its
            // rate-limit slot and passed the whole pipeline.
            if (this.ctx.interceptBusyTurn !== undefined
                && await this.ctx.interceptBusyTurn(chatId, text, role, nickname, mergedPlain)) {
                return;
            }
            await this.ctx.dispatchFollowup(chatId, text, role, nickname);
        };
        // 11-04 哥哥要的「先攒一把」：消息过完所有闸门先等 2 秒，期间每来一条合规消息就再延 2 秒；
        // 安静满 2 秒才把窗口里的全部消息合成一轮（debounceMs = 0 关掉，退回原来即刻进会话）。
        const debounceMs = typeof this.ctx.config.debounceMs === 'number' ? this.ctx.config.debounceMs : 2000;
        if (debounceMs > 0) {
            this.queueCoalesced(chatId, { text: final, plain, role, nickname }, proceed, debounceMs);
            return;
        }
        await proceed(final, plain);
    }

    /** 11-04：防抖合并窗。每条合规消息进来就重置计时，安静满 debounceMs 才把窗口里
     *  的全部消息拼成一轮交给 flush；debounceMaxMs 是硬上限，免得被源源不断的消息饿死。
     *  11-04 晚补的「排队 B」：这一轮还在跑时不插话，窗口保留到它空闲再整把派发。 */
    queueCoalesced(chatId, payload, flush, ms) {
        let entry = this.coalescing.get(chatId);
        if (entry === undefined) {
            entry = { parts: [], plain: true, role: 'member', nickname: '', timer: null, hardTimer: null, fired: false, startedAt: 0 };
            this.coalescing.set(chatId, entry);
        }
        if (entry.fired)
            return;
        if (entry.startedAt === 0)
            entry.startedAt = Date.now();
        // 每条都带自己的来源：合并几条时不能只留最后一条的角色/昵称（11-12 审计）。
        entry.parts.push({ text: payload.text, role: payload.role ?? 'member', nickname: payload.nickname ?? '' });
        entry.plain = entry.plain && payload.plain;
        // 角色取「全部都是管理员才算管理员」——混进来的普通成员不能搭管理员的便车。
        entry.role = entry.parts.every((p) => p.role === 'admin') ? 'admin' : 'member';
        const names = [...new Set(entry.parts.map((p) => p.nickname).filter((n) => n !== ''))];
        entry.nickname = names.length === 1 ? names[0] : names.join('、');
        const maxParts = this.ctx.config.debounceMaxParts ?? 30;
        if (entry.parts.length > maxParts)
            entry.parts.splice(0, entry.parts.length - maxParts);
        if (entry.timer !== null)
            clearTimeout(entry.timer);
        const fire = () => {
            if (entry.fired)
                return;
            // 11-04 哥哥要的「排队 B」：这一轮还在跑就**不插话**，窗口继续攒着，等它空下来
            // 再整把当成一轮交出去（半路 steer 会把它的思路打断）。最多再等 debounceBusyMaxMs，
            // 之后照旧按忙时策略走，免得一轮卡死把消息永远扣着。
            if (this.ctx.config.debounceBusyWait !== false
                && this.ctx.isChatBusy?.(chatId) === true
                && Date.now() - entry.startedAt < (this.ctx.config.debounceBusyMaxMs ?? 120_000)) {
                if (entry.timer !== null)
                    clearTimeout(entry.timer);
                entry.timer = setTimeout(fire, 250);
                return;
            }
            entry.fired = true;
            if (entry.timer !== null)
                clearTimeout(entry.timer);
            if (entry.hardTimer !== null)
                clearTimeout(entry.hardTimer);
            this.coalescing.delete(chatId);
            const names = [...new Set(entry.parts.map((p) => p.nickname).filter((n) => n !== ''))];
            const merged = entry.parts.length > 1
                ? '（这 ' + entry.parts.length + ' 条消息是连着来的，插件已合并成一整轮，一起回）\n\n'
                    + entry.parts.map((p) => (names.length > 1 && p.nickname !== '' ? p.nickname + '：' : '') + p.text).join('\n\n')
                : entry.parts[0].text;
            Promise.resolve()
                .then(() => flush(merged, entry.plain))
                .catch((err) => this.ctx.log('warn', '合并派发失败: ' + String(err)));
        };
        entry.timer = setTimeout(fire, ms);
        if (entry.hardTimer === null) {
            const maxMs = this.ctx.config.debounceMaxMs ?? 20000;
            entry.hardTimer = setTimeout(fire, Math.max(maxMs, ms));
        }
    }

    /** 插件停止/卸载时丢掉还没到点的合并窗：宁可丢这一把，也别把消息打给已经停掉的 bridge。 */
    disposeCoalesced() {
        for (const entry of this.coalescing.values()) {
            entry.fired = true;
            if (entry.timer !== null)
                clearTimeout(entry.timer);
            if (entry.hardTimer !== null)
                clearTimeout(entry.hardTimer);
        }
        this.coalescing.clear();
    }
    /** W2-②: (chatId, message_id) sliding-window dedup against OneBot
     * re-delivery (reconnect replay / ws retry). Runs before every other gate
     * so a redelivered message can neither re-trigger a command nor reset the
     * loop residue; only events that normalize to processable chat messages
     * reach this — notice/meta/request events never enter the pipeline (see
     * docs/m1-characterization/pipeline-hooks.md #1/#3). Events without a
     * message_id are not deduped (nothing to key on). Window entries live in
     * an LRU-capped map: hits refresh recency (keeping the first-seen time, so
     * the window opens at first delivery), the oldest entry is evicted beyond
     * the cap. Returns true when the delivery must be silently skipped. */
    duplicated(inbound) {
        const windowSeconds = this.ctx.config.dedupWindowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS;
        if (windowSeconds <= 0)
            return false;
        if (inbound.messageId === undefined || inbound.messageId === '')
            return false;
        const now = this.now();
        const key = inbound.chatId + '#' + inbound.messageId;
        const seenAt = this.seenMessages.get(key);
        if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) {
            this.seenMessages.delete(key);
            this.seenMessages.set(key, seenAt);
            this.ctx.log('debug', 'dedup hit in ' + inbound.chatId + ': message_id ' + inbound.messageId
                + ' redelivered within ' + windowSeconds + 's window, message skipped');
            currentTrace()?.emit('dedup', { ok: false, reason: TRACE_REASONS.inboundDedup });
            return true;
        }
        this.seenMessages.delete(key);
        while (this.seenMessages.size >= this.dedupMaxEntries) {
            const oldest = this.seenMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.seenMessages.delete(oldest);
        }
        this.seenMessages.set(key, now);
        return false;
    }
    /** B7: sliding-window inbound rate limit for normal (non-command) messages.
     * Commands consumed by tryHandleCommand never reach this. Returns true when
     * the message must be dropped; at most one notice is sent per window. */
    rateLimited(chatId) {
        const limit = this.ctx.config.rateLimitPerMinute ?? 30;
        if (limit <= 0)
            return false;
        const chat = this.ctx.getChat(chatId);
        if (chat === undefined)
            return false;
        const now = Date.now();
        chat.dispatchTimes = chat.dispatchTimes.filter(t => now - t < 60_000);
        if (chat.dispatchTimes.length < limit) {
            chat.dispatchTimes.push(now);
            return false;
        }
        // pipeline-hooks.md #16: the drop decision itself used to be silent (only
        // the user-facing notice text existed).
        currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateLimited });
        if (chat.rateLimitNoticeAt === undefined || now - chat.rateLimitNoticeAt >= 60_000) {
            chat.rateLimitNoticeAt = now;
            void this.ctx.sendToChat(chatId, '⏳ 消息太频繁，请稍后再试。').catch((error) => {
                this.ctx.log('debug', '限流提示发送失败: ' + describeError(error));
                currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateNoticeFailed });
            });
        }
        return true;
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    async buildBody(text, media, chatId) {
        if (media.length === 0)
            return text;
        let out = text;
        for (const ref of media) {
            const placeholder = placeholderFor(ref);
            const idx = out.indexOf(placeholder);
            const annotation = await this.resolveMediaRef(ref, chatId);
            if (idx >= 0 && annotation !== '') {
                out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length);
            }
            else if (idx >= 0) {
                // pipeline-hooks.md #10: a failed resolution used to leave the
                // placeholder silently unresolved.
                this.ctx.log('debug', '媒体解析失败，占位符保留原文: ' + placeholder);
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.mediaResolveFailed });
            }
        }
        return out;
    }
    /**
     * 长期记忆区块：群聊读 groupMemory，私聊读 privateMemory；读不到返回空串。
     * @param kind - 'group' / 'private'。
     * @param chatId - 会话 id。
     * @returns 带 [..长期记忆] 标记的文本块（或 ''）。
     */
    memoryBlock(kind, chatId, userText = '') {
        if (kind === 'group') {
            const memory = this.ctx.groupMemory?.(chatId) ?? '';
            return memory === '' ? '' : '[本群长期记忆]\n' + memory + '\n[/本群长期记忆]\n';
        }
        if (kind === 'private') {
            const memory = this.ctx.privateMemory?.(chatId) ?? '';
            const picked = this.pickMemory(memory, userText);
            return picked === '' ? '' : '[私聊长期记忆]\n' + picked + '\n[/私聊长期记忆]\n';
        }
        return '';
    }
    /**
     * 私聊记忆节流：只在「这一轮真谈到」时才挑几行带上（最多 3 行 / 400 字）。
     * 一条都没碰上就整块不带 —— 省下的就是这个。
     * @param memory - 记忆正文（已是尾部 2000 字）。
     * @param userText - 这轮用户说的话（含引用/转发展开）。
     * @returns 挑中的几行；没碰上返回 ''。
     */
    pickMemory(memory, userText) {
        // 先剔掉图片/语音/文件的本地路径占位符：路径里的「dsh」「onebot」会把不相干的记忆拽进来。
        const text = (userText ?? '')
            .replace(/\[(?:图片|语音|视频|文件|表情包|动画表情|合并转发)[^\]\n]*\]/g, ' ')
            .replace(/[A-Za-z]:[\\/][^\s，。；、）)]*/g, ' ')
            .replace(/https?:\/\/\S+/gi, ' ')
            .trim();
        if (memory === '' || text === '')
            return '';
        const query = new Set();
        for (let i = 0; i + 1 < text.length; i++) {
            const gram = text.slice(i, i + 2);
            if (/[\u4e00-\u9fa5]{2}|[A-Za-z0-9]{2}/.test(gram))
                query.add(gram);
        }
        if (query.size === 0)
            return '';
        const lines = memory.split('\n').map(line => line.trim()).filter(line => line.length >= 4);
        const scored = [];
        for (const line of lines) {
            // 只认实词：虚词、代词、时间词全剔掉，不然「今天」「可以」天天误伤。
            const hitSet = new Set();
            for (const gram of query) {
                if (!line.includes(gram))
                    continue;
                if (MEMORY_STOP_GRAMS.has(gram) || gram.split('').some(ch => MEMORY_STOP_CHARS.has(ch)))
                    continue;
                hitSet.add(gram);
            }
            // 碰上一个实词就算「聊到了」（画师 / 怪猎 / ComfyUI 这种就够）。
            if (hitSet.size >= 1)
                scored.push({ line, hits: hitSet.size });
        }
        if (scored.length === 0)
            return '';
        scored.sort((a, b) => b.hits - a.hits);
        const out = [];
        let chars = 0;
        for (const item of scored) {
            if (out.length >= 3 || chars + item.line.length > 400)
                break;
            out.push(item.line);
            chars += item.line.length;
        }
        return out.join('\n');
    }
    /**
     * 图片注解：先跑本机 OCR（快、认字准），字太少或没认出再叫视觉模型（慢但看得懂画面）。
     * 视觉模型只在「没认出字」时上，避免每张图都等十几秒；失败一律静默。
     * @param path - 本地图片路径。
     * @returns '（图片内容：…）' 或 '（图内文字：…）' 或 ''。
     */
    async imageNote(path) {
        const config = this.ctx.config;
        let buffer;
        try {
            buffer = readFileSync(path);
        }
        catch {
            return '';
        }
        if (buffer.length === 0)
            return '';
        // 同一张图一周内只问一次（按内容 sha1）；没问到就不写缓存。
        const cacheKey = createHash('sha1').update(buffer).digest('hex');
        const cached = readVisionCache()[cacheKey];
        if (cached !== null && typeof cached === 'object' && typeof cached.note === 'string' && cached.note !== ''
            && Date.now() - Number(cached.at) < VISION_CACHE_TTL_MS) {
            this.ctx.log('debug', '识图命中缓存: ' + cacheKey.slice(0, 8));
            return cached.note;
        }
        const note = await this.visionNoteFor(buffer, config);
        if (note !== '') {
            const cache = readVisionCache();
            cache[cacheKey] = { note, at: Date.now() };
            writeVisionCache(cache);
        }
        return note;
    }
    /**
     * 真正去问 OCR + 视觉模型（imageNote 的里子；命中缓存时不会走到这儿）。
     * @param buffer - 图片字节。
     * @param config - QQ 通道配置。
     * @returns 图片注解（'' = 什么都没问出来）。
     */
    async visionNoteFor(buffer, config) {
        const hasVision = typeof config.visionModel === 'string' && config.visionModel !== ''
            && typeof config.visionBaseUrl === 'string' && config.visionBaseUrl !== ''
            && typeof config.visionApiKeyEnv === 'string' && config.visionApiKeyEnv !== '';
        let ocr = '';
        if (config.autoOcr !== false) {
            try {
                ocr = await Promise.race([
                    ocrText((action, params) => this.ctx.call(action, params), buffer),
                    new Promise((resolve) => setTimeout(() => resolve(''), 8000)),
                ]);
            }
            catch (error) {
                this.ctx.log('debug', 'OCR 识图失败: ' + describeError(error));
            }
        }
        const ocrEnough = ocr !== '' && [...ocr].length >= (config.visionMinOcrChars ?? 6);
        if (ocr !== '' && (ocrEnough || !hasVision))
            return '（图内文字：' + ocr + '）';
        if (hasVision) {
            // 顺序就是 cloud → 兜底：云端快且能看懂画面，本地（小弟）只在云端挂了时接。
            const attempts = [{
                    model: config.visionModel,
                    baseURL: config.visionBaseUrl ?? '',
                    keyEnv: config.visionApiKeyEnv ?? '',
                }];
            if (typeof config.visionFallbackModel === 'string' && config.visionFallbackModel !== '') {
                attempts.push({
                    model: config.visionFallbackModel,
                    baseURL: config.visionFallbackBaseUrl ?? '',
                    keyEnv: config.visionFallbackApiKeyEnv ?? '',
                });
            }
            for (const attempt of attempts) {
                try {
                    const budget = Number(config.visionMaxTokens) > 0 ? Number(config.visionMaxTokens) : 3000;
                    const call = (tokens) => describeImage(buffer, {
                        baseURL: attempt.baseURL,
                        model: attempt.model,
                        apiKey: resolveApiKey(attempt.keyEnv),
                        timeoutMs: config.visionTimeoutMs ?? 40_000,
                        maxTokens: tokens,
                        headers: parseHeaderJson(config.visionHeaders),
                        log: (level, message) => this.ctx.log(level, message),
                    });
                    let desc = await call(budget);
                    if (desc === '' && budget < 6000) {
                        // 思考型模型偶尔把额度全花在思考上：翻一倍再来一次。
                        this.ctx.log('warn', '识图正文为空，翻倍重试：' + budget + ' → ' + budget * 2 + ' tokens');
                        desc = await call(budget * 2);
                    }
                    if (desc !== '')
                        return '（图片内容：' + desc + '）';
                }
                catch (error) {
                    // 这条以前是 debug，等于「死了没人看得见」——改成 warn（2026-11-05）。
                    this.ctx.log('warn', '视觉模型识图失败(' + attempt.model + '/' + attempt.keyEnv + '): ' + describeError(error));
                }
            }
        }
        if (ocr !== '')
            return '（图内文字：' + ocr + '）';
        return '';
    }
    /**
     * 被 @ 但本条没带图：往回看几条（默认 3 条、5 分钟内）有没有图，认一张就够。
     * 有上限、找到就停，不会无限往回翻。
     * @param chatId - 会话 id。
     * @returns 图片注解（'' = 没找到或没认出来）。
     */
    async recentImageNote(chatId) {
        if (this.ctx.recentImages === undefined)
            return '';
        let refs;
        try {
            refs = (await this.ctx.recentImages(chatId, this.ctx.config.recentImageLookback ?? 3)) ?? [];
        }
        catch {
            return '';
        }
        for (const ref of refs.slice(0, 1)) {
            const resolved = await this.ctx.media.resolve(ref, async (kind, file) => {
                if (kind !== 'image')
                    return undefined;
                const data = await this.ctx.call('get_image', { file });
                return { url: data.url, file: data.file };
            }).catch(() => undefined);
            if (resolved === undefined || resolved.kind !== 'image')
                continue;
            this.ctx.markRecognizing?.(chatId, true);
            try {
                const note = await this.imageNote(resolved.path);
                if (note !== '')
                    return note;
            }
            finally {
                this.ctx.markRecognizing?.(chatId, false);
            }
        }
        return '';
    }
    /** Resolve one media ref to a text annotation with a local path. */
    async resolveMediaRef(ref, chatId) {
        if (ref.kind === 'file') {
            return await this.resolveNasFile(ref);
        }
        const resolved = await this.ctx.media.resolve(ref, async (kind, file) => {
            if (kind === 'image') {
                const data = await this.ctx.call('get_image', { file });
                return { url: data.url, file: data.file };
            }
            if (kind === 'voice') {
                const data = await this.ctx.call('get_record', { file, out_format: 'mp3' });
                return { file: data.file };
            }
            return undefined;
        });
        if (resolved === undefined)
            return '';
        switch (resolved.kind) {
            case 'image': {
                // Remember the most recent inbound image for /ocr (survives /new);
                // consume the pre-routing pending ref so /ocr never re-resolves it.
                const settings = this.ctx.getSettings(chatId);
                settings.lastImagePath = resolved.path;
                settings.pendingImageRef = undefined;
                // 表情包跟普通图走同一道闸：只有私聊 / 被 @ / 主动模式 / 关键词叫出来时才识图，群里刷图照样跳过。
                const action = imageAction(settings.imageTurn);
                if (action === 'ignore')
                    return '[图片:' + resolved.path + ']';
                if (action === 'skip')
                    return '[图片:' + resolved.path + ']（这张先不看了）';
                if (action === 'overflow')
                    return '[图片:' + resolved.path + ']（图太多，没看）';
                // 识图期间挂上「忙」标记：主动模式不追问、不在这时候插话。
                this.ctx.markRecognizing?.(chatId, true);
                try {
                    const note = await this.imageNote(resolved.path);
                    return '[图片:' + resolved.path + ']' + note;
                }
                finally {
                    this.ctx.markRecognizing?.(chatId, false);
                }
            }
            case 'voice': {
                // M3-D4c: dispatch must not wait on STT — the [语音] placeholder ships
                // now and the transcript steers into the turn when it completes. A
                // failure/timeout keeps the placeholder as the final state.
                if (this.ctx.transcriber.enabled) {
                    void this.transcribeLater(resolved.path, chatId);
                }
                return '[语音]';
            }
            case 'video':
                return '[视频:' + resolved.path + ']';
            default:
                return '[文件:' + resolved.path + ']';
        }
    }
    /** M3-D4c: transcribe in the background and deliver the labeled transcript
     * into the chat's turn (steer at the running turn's nearest step boundary,
     * or a new turn when the agent is idle). Failure keeps [语音] as final. */
    async transcribeLater(path, chatId) {
        try {
            const text = await this.ctx.transcriber.transcribe(path);
            if (transcriptLabel(text) === '') {
                this.ctx.log('debug', '语音转写结果为空: ' + path);
                currentTrace()?.emit('transcribe', { ok: false, reason: TRACE_REASONS.sttEmpty });
                return;
            }
            this.ctx.steerTranscript(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'STT failed: ' + describeError(error));
            currentTrace()?.emit('transcribe', { ok: false, reason: '语音转写失败: ' + describeError(error) });
        }
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    async expandQuote(messageId) {
        try {
            const data = await this.ctx.call('get_msg', { message_id: Number(messageId) });
            const segments = Array.isArray(data.message) ? data.message : undefined;
            const raw = typeof data.raw_message === 'string' ? data.raw_message : '';
            const text = cqUnescape(segmentText(segments, raw));
            if (text.trim() === '')
                return '';
            const name = data.sender?.nickname ?? '';
            return '[引用]' + (name !== '' ? name + ': ' : '') + text;
        }
        catch (error) {
            this.ctx.log('debug', 'quote expansion failed: ' + describeError(error));
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息展开失败，已降级为空引用: ' + describeError(error) });
            return '';
        }
    }
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    async resolveNasFile(ref) {
        const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file';
        // The sender-controlled name never becomes the on-disk path (it could
        // otherwise overwrite chat-sessions.json etc.); only a whitelisted
        // extension survives into the fresh media_* name.
        const ext = extForInboundName(name);
        // Streaming size cap for both URL branches below (0 = uncapped).
        const maxBytes = this.ctx.config.maxInboundFileBytes > 0 ? this.ctx.config.maxInboundFileBytes : undefined;
        const fid = ref.fileId ?? ref.file ?? '';
        if (fid === '')
            return '';
        try {
            // 1. Private-chat direct link (works without any container access).
            const direct = await this.ctx.call('get_private_file_url', { file_id: fid });
            if (direct.url !== undefined && direct.url !== '') {
                try {
                    const localPath = await this.ctx.media.downloadUrl(direct.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via direct link: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_private_file_url failed (falling back to get_file): ' + describeError(error));
        }
        // 2. get_file: with NapCat's file server enabled it returns a `base64`
        //    payload or an http(s) `url`; otherwise a container path we cannot reach.
        try {
            const data = await this.ctx.call('get_file', { file: fid });
            const size = Number(data.file_size ?? 0);
            if (this.ctx.config.maxInboundFileBytes > 0 && size > this.ctx.config.maxInboundFileBytes) {
                this.ctx.log('warn', 'qq file too large (' + size + 'B), skipping fetch');
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                return '';
            }
            if (data.base64 !== undefined && data.base64 !== '') {
                const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), ext);
                if (localPath !== '') {
                    this.ctx.log('info', 'qq file fetched via get_file base64: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
            }
            if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
                try {
                    const localPath = await this.ctx.media.downloadUrl(data.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via get_file url: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_file base64/url path failed: ' + describeError(error));
        }
        this.ctx.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid);
        currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileFailed });
        return '';
    }
    /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
    async writeMediaFile(buffer, ext) {
        try {
            // freshPath mints media_<ts>_<uuid><ext>: inbound data can never land
            // on a known name (chat-sessions.json etc.) no matter what the sender
            // chose as the file name.
            await this.ctx.media.ensure();
            const localPath = this.ctx.media.freshPath(ext);
            await writeFile(localPath, buffer);
            return localPath;
        }
        catch (error) {
            this.ctx.log('warn', 'media write failed: ' + describeError(error));
            return '';
        }
    }
    /**
     * Expand a combined-forward id into "name: content" lines, collecting
     * embedded image segments into the media list (they flow through the same
     * buildBody pipeline as inbound media). Failure or an empty expansion no
     * longer returns a silent placeholder: the resId plus a short reason
     * (api-error / empty-response / no-text-nodes) stays in the model context
     * so it can self-serve via the whitelisted get_forward_msg tool.
     */
    async expandForward(forwardId) {
        try {
            // NapCat's get_forward_msg accepts `message_id` or `id`; sending both
            // also covers go-cqhttp-style implementations. Its response nodes are
            // OneBot node segments: { type: 'node', data: { nickname, user_id,
            // message: [...] } } — the flat `sender`/`content` shape is kept as a
            // fallback for other implementations.
            const data = await this.ctx.call('get_forward_msg', { id: forwardId, message_id: forwardId });
            const nodes = data.messages ?? [];
            const lines = [];
            const media = [];
            for (const node of nodes) {
                const nodeData = node.data;
                const name = nodeData?.nickname ?? node.sender?.nickname
                    ?? String(nodeData?.user_id ?? node.sender?.user_id ?? '未知');
                const text = nodeContentText(nodeData?.message ?? nodeData?.content ?? node.content, name, media, lines);
                if (text !== '')
                    lines.push(name + ': ' + text);
            }
            if (lines.length === 0) {
                const reason = nodes.length === 0 ? 'empty-response' : 'no-text-nodes';
                currentTrace()?.emit('forward', { ok: false, reason: '合并转发未展开: ' + reason });
                return { text: '[合并转发 id=' + forwardId + ' 未展开: ' + reason + ']', media };
            }
            return { text: '[合并转发]\n' + lines.join('\n'), media };
        }
        catch (error) {
            this.ctx.log('info', 'forward expansion failed: resId=' + forwardId + ': ' + describeError(error));
            currentTrace()?.emit('forward', { ok: false, reason: '合并转发展开失败: ' + describeError(error) });
            return { text: '[合并转发 id=' + forwardId + ' 未展开: api-error]', media: [] };
        }
    }
}
/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref) {
    switch (ref.kind) {
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'video': return '[视频]';
        default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]';
    }
}
/**
 * Extract text from a forward-node content (segment array or CQ string).
 * Image segments are collected into `media` and contribute a '[图片]'
 * placeholder (annotated by buildBody like inbound media, `name` carries the
 * owning node's nickname). Nested node segments recurse: their text joins
 * `lines` as their own "name: text" entry instead of being swallowed as
 * '[非文本]'.
 */
function nodeContentText(content, ownerName, media, lines) {
    if (Array.isArray(content)) {
        return content
            .map(seg => {
            const s = seg;
            if (s?.type === 'text')
                return String(s.data?.text ?? '');
            if (s?.type === 'face')
                return '😀';
            if (s?.type === 'image') {
                media.push({
                    kind: 'image',
                    url: typeof s.data?.url === 'string' && s.data.url !== '' ? s.data.url : undefined,
                    file: typeof s.data?.file === 'string' && s.data.file !== '' ? s.data.file : undefined,
                    name: ownerName,
                });
                return '[图片]';
            }
            if (s?.type === 'node' && typeof s.data === 'object' && s.data !== null) {
                const nested = s.data;
                const nestedName = nested.nickname ?? String(nested.user_id ?? ownerName);
                const nestedText = nodeContentText(nested.message ?? nested.content, nestedName, media, lines);
                if (nestedText !== '')
                    lines.push(nestedName + ': ' + nestedText);
                return '';
            }
            return '[非文本]';
        })
            .join('')
            .trim();
    }
    if (typeof content === 'string')
        return content.trim();
    return '';
}
