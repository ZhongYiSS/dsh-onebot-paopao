/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitChatId } from './chat.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { extractForwardBlocks, scanSensitive, stripMarkdown, stripProtocolJunk } from './split.js';
import { renderTextImage } from './t2i/index.js';
import { describeError } from './errors.js';
import { TRACE_REASONS } from './trace.js';
/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000;
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20;
/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export const DEFAULT_ACTION_RATE_PER_MINUTE = 20;
export const DEFAULT_ACTION_RATE_PER_DAY = 500;
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log';
/** Body chars per rendered card: keeps every PNG at a readable height. */
const CARD_CHUNK_CHARS = 1200;
/**
 * Cut a long body into card-sized pieces: prefer paragraph breaks, then line
 * breaks, then sentence punctuation, and hard-cut only as a last resort.
 * @param text - body text.
 * @param maxChars - hard cap per piece.
 * @returns the pieces, in order.
 */
export function splitForCards(text, maxChars) {
    // 上限 <= 0 时直接原样返回：否则 cut 恒为 0，下面的 while 永远出不去。
    if (!(maxChars > 0))
        return [text];
    if (text.length <= maxChars)
        return [text];
    const separators = ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? '];
    const pieces = [];
    let rest = text;
    while (rest.length > maxChars) {
        let cut = -1;
        for (const separator of separators) {
            const index = rest.lastIndexOf(separator, maxChars);
            if (index > -1 && index + separator.length > cut)
                cut = index + separator.length;
        }
        if (cut < Math.floor(maxChars * 0.4))
            cut = maxChars;
        // 硬切落在代理对中间时往回退一格，否则 emoji 会变成半个乱码。
        if (cut > 1 && cut < rest.length) {
            const code = rest.charCodeAt(cut - 1);
            if (code >= 0xd800 && code <= 0xdbff)
                cut -= 1;
        }
        pieces.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest !== '')
        pieces.push(rest);
    return pieces.filter((piece) => piece !== '');
}
/**
 * 纯文本分条：按段落/句子切到 maxChars 以内，必要时硬切。
 * @param text - 正文。
 * @param maxChars - 每条上限。
 * @returns 分好的若干条。
 */
export function splitPlainText(text, maxChars) {
    if (!(maxChars > 0))
        return [text];
    if (text.length <= maxChars)
        return [text];
    const separators = ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? '];
    const parts = [];
    let rest = text;
    while (rest.length > maxChars) {
        let cut = -1;
        for (const separator of separators) {
            const index = rest.lastIndexOf(separator, maxChars);
            if (index > -1 && index + separator.length > cut)
                cut = index + separator.length;
        }
        if (cut < Math.floor(maxChars * 0.4))
            cut = maxChars;
        // 硬切落在代理对中间时往回退一格，否则 emoji 会变成半个乱码。
        if (cut > 1 && cut < rest.length) {
            const code = rest.charCodeAt(cut - 1);
            if (code >= 0xd800 && code <= 0xdbff)
                cut -= 1;
        }
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest !== '')
        parts.push(rest);
    return parts.filter((part) => part !== '');
}
/**
 * 按句子切分，保证句子不被切断：每段尽量 ≤ maxChars，单句超长就单独成段。
 * @param text - 正文。
 * @param maxChars - 每段目标上限（单句超过它时允许超出，不切句）。
 * @returns 句子完整的若干段。
 */
export function splitBySentence(text, maxChars) {
    if (maxChars <= 0 || text.length <= maxChars)
        return [text];
    const sentences = text.match(/[^。！？!?…；;\n]+[。！？!?…；;\n]*|\n+/g) ?? [text];
    const parts = [];
    let current = '';
    for (const raw of sentences) {
        const piece = raw.trim();
        if (piece === '')
            continue;
        if (current !== '' && current.length + piece.length > maxChars) {
            parts.push(current);
            current = piece;
        }
        else {
            current = current === '' ? piece : current + piece;
        }
    }
    if (current !== '')
        parts.push(current);
    return parts.length > 0 ? parts : [text];
}
/** 混进正文里的「（过程纪律提醒）…」是运行时的纪律提示，不该发到 QQ：
 * 从标记处一直截到该行行尾，标记前的内容保留。 */
export function scrubDisciplineReminder(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    const re = /[（(]过程纪律提醒[）)]/;
    const kept = [];
    for (const line of text.split(/\r?\n/)) {
        const hit = re.exec(line);
        if (hit === null) {
            kept.push(line);
            continue;
        }
        const head = line.slice(0, hit.index).trim();
        if (head !== '')
            kept.push(head);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * 把 `[at:QQ]` / `[CQ:at,qq=QQ]` 标记转成真正的 @ 段（其余仍是纯文本）。
 * @param text - 一条消息的正文。
 * @returns OneBot 消息段数组。
 */
export function buildTextSegments(text) {
    const re = /\[(?:at:(\d+|all)|CQ:at,qq=([^,\]]+))\]/gi;
    const segments = [];
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
        const before = text.slice(last, match.index);
        if (before !== '')
            segments.push({ type: 'text', data: { text: before } });
        segments.push({ type: 'at', data: { qq: match[1] ?? match[2] } });
        last = match.index + match[0].length;
    }
    const rest = text.slice(last);
    if (rest !== '')
        segments.push({ type: 'text', data: { text: rest } });
    return segments.length > 0 ? segments : [{ type: 'text', data: { text } }];
}
/**
 * 把一段正文拆成「要分几次发送」的若干条：换行先算一条边界，
 * 再按句子切（chunkChars > 0 时），最后压到 maxParts 条以内。
 * @param text - 正文。
 * @param chunkChars - 每条目标字数（<=0 表示不按句子切，换行各自成条）。
 * @param maxParts - 最多几条。
 * @returns 每条消息的正文。
 */
export function splitForMessages(text, chunkChars, maxParts) {
    const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter((line) => line !== '');
    const pieces = [];
    for (const line of lines) {
        if (chunkChars > 0)
            pieces.push(...splitBySentence(line, chunkChars));
        else
            pieces.push(line);
    }
    return capParts(pieces.length > 0 ? pieces : [text.trim()], maxParts);
}
/**
 * 把分好的若干段压到 maxParts 条以内：多出来的并进最后一条。
 * @param parts - 已经分好的段。
 * @param maxParts - 最多几条（<=0 表示不限制）。
 * @returns 不超过 maxParts 条。
 */
export function capParts(parts, maxParts) {
    if (maxParts <= 0 || parts.length <= maxParts)
        return parts;
    const head = parts.slice(0, maxParts - 1);
    const tail = parts.slice(maxParts - 1).join('');
    return [...head, tail];
}
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
    ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    pendingSends = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        // Lazy default: read Date.now through a wrapper so an injected clock is
        // optional and callers without one keep the dynamic global lookup (fake
        // timers in tests must keep influencing the wall-clock path).
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        return this.enqueue(chatId, async () => {
            if (!this.ctx.connected()) {
                if (options.queuable === true) {
                    // pipeline-hooks.md #23: the park used to be silent.
                    this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                    this.queuePendingSend(chatId, text);
                    return [];
                }
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(text, this.ctx.config.sensitivePatterns);
            if (hits.length > 0) {
                this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } });
            }
            const ids = [];
            // 模型偶尔把工具调用的协议标签当正文吐出来（全角竖线版 DSML），
            // 壳认不出就原样发出去 —— 发出前先剪掉这些标签行。
            const { body: rawBody, nodes } = extractForwardBlocks(scrubDisciplineReminder(text), '助手');
            const body = stripProtocolJunk(rawBody);
            if (nodes.length > 0) {
                // Passive reply path: [[qq_forward]] blocks inside a turn reply are
                // NOT gated as proactive writes (see the W2-③ 口径 note).
                await this.sendForwardNodes(chatId, nodes);
                ids.push('forward');
            }
            let sentCard = false;
            // 主动模式：卡片阈值放大到 200 字；没到阈值的一律拆成多条纯文本。
            const proactive = this.ctx.isProactive?.(chatId) === true;
            const threshold = proactive
                ? (this.ctx.config.proactiveImageThreshold ?? 200)
                : this.ctx.config.textImageThreshold;
            if (threshold > 0 && body.length > threshold) {
                const chat = this.ctx.getChat(chatId);
                const title = chat !== undefined && chat.lastNickname !== ''
                    ? 'To ' + chat.lastNickname
                    : undefined;
                // 长正文切成多张卡片（段落 → 换行 → 句号 → 硬切），
                // 避免一张图高到手机上不好读。
                const pieces = capParts(splitForCards(body, this.ctx.config.cardChunkChars ?? 500), this.ctx.config.maxMessageParts ?? 3);
                const cards = [];
                let tooLarge = false;
                try {
                    for (const piece of pieces) {
                        const png = renderTextImage(piece, {
                            title,
                            footerBrand: this.ctx.config.cardFooter,
                            fontFiles: this.ctx.config.fontFiles,
                            fontFamilies: this.ctx.config.fontFamilies,
                        });
                        const b64 = 'base64://' + png.toString('base64');
                        if (b64.length > this.ctx.config.maxImageBytes) {
                            tooLarge = true;
                            break;
                        }
                        cards.push(b64);
                    }
                }
                catch (error) {
                    this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error));
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) });
                    cards.length = 0;
                }
                if (cards.length > 0 && !tooLarge) {
                    for (const b64 of cards) {
                        const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options);
                        if (id !== undefined)
                            ids.push(id);
                    }
                    sentCard = true;
                }
                else if (tooLarge) {
                    this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text');
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge });
                }
            }
            if (!sentCard) {
                const plain = stripMarkdown(body);
                if (plain !== '') {
                    // 「分两条」= 发两条消息，不是一条里换行：先把换行拆成独立消息，
                    // 主动模式再按句子切、每条 ≤30 字左右（句子不切断），最多 3 条。
                    const chunkChars = proactive ? (this.ctx.config.proactiveChunkChars ?? 30) : 0;
                    const parts = splitForMessages(plain, chunkChars, this.ctx.config.maxMessageParts ?? 3);
                    for (const part of parts) {
                        const id = await this.sendMsg(chatId, buildTextSegments(part), options);
                        if (id !== undefined)
                            ids.push(id);
                    }
                }
                else {
                    // pipeline-hooks.md #30: the empty-body skip used to be silent.
                    this.ctx.log('debug', '正文为空，未发送: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText });
                }
            }
            this.ctx.noteBotMessage?.(chatId);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '回复已发送', data: { segments: ids.length } });
            return ids;
        });
    }
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    queuePendingSend(chatId, text) {
        const queue = this.pendingSends.get(chatId) ?? [];
        if (queue.length >= PENDING_SEND_MAX) {
            queue.shift();
            this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest');
            this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
        }
        queue.push({ text, sentAt: this.now() });
        this.pendingSends.set(chatId, queue);
    }
    // ── W2-③ proactive-write gate (minute/day caps + audit) ─────────────────
    // 口径（per outbound.ts structure）：「主动写」= 模型/命令经 qq_* 工具发起、
    // 不属于某个入站回合回复链的出站写 —— 即 sendSegments（qq_send_image/voice/
    // video/file/segments）与公开 sendForward（qq_send_forward）。被动回复不受此
    // 闸：sendToChat 整条链（最终回复/interim/错误与命令通知、[[qq_forward]] 块，
    // 后者走未设闸的 sendForwardNodes）由入站 rateLimitPerMinute + B6 队列上限
    // 约束。两类计数都是全桥合计（不分会话）。
    /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
    writeActionTimes = [];
    /** Calendar-day (local) counter of allowed proactive writes. */
    writeDayKey = '';
    writeDayCount = 0;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    auditChain = Promise.resolve();
    /** W1/T5 health snapshot: the write gate's current usage against its
     * limits (minute sliding window pruned at read time; day counter). */
    writeGateStats() {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        const now = this.now();
        const minuteUsed = perMinute > 0
            ? this.writeActionTimes.filter(t => now - t < 60_000).length
            : 0;
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const dayUsed = perDay > 0 && this.writeDayKey === dayKey ? this.writeDayCount : 0;
        return { minuteUsed, minuteLimit: perMinute, dayUsed, dayLimit: perDay };
    }
    /** W2-③: check + consume one proactive-write slot. Returns a non-empty
     * Chinese rejection reason when the write must be dropped (a warn with the
     * chatId and the limit name is logged and the rejection is audited);
     * returns null when allowed (slot consumed). Rejected attempts do not
     * consume quota. */
    writeGateRejectReason(chatId, action) {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        if (perMinute <= 0 && perDay <= 0)
            return null;
        const now = this.now();
        this.writeActionTimes = this.writeActionTimes.filter(t => now - t < 60_000);
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (this.writeDayKey !== dayKey) {
            this.writeDayKey = dayKey;
            this.writeDayCount = 0;
        }
        if (perMinute > 0 && this.writeActionTimes.length >= perMinute) {
            const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        if (perDay > 0 && this.writeDayCount >= perDay) {
            const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        this.writeActionTimes.push(now);
        this.writeDayCount += 1;
        return null;
    }
    /** W2-③: append one proactive-write (or rejection / send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    auditWrite(chatId, action, ok, reason) {
        if (this.ctx.config.actionAuditEnabled === false)
            return;
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n';
        this.auditChain = this.auditChain.then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8');
        }).catch(error => {
            this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error));
        });
    }
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends() {
        if (this.ctx.isStopping())
            return;
        const now = this.now();
        const batch = [];
        for (const [chatId, queue] of this.pendingSends) {
            this.pendingSends.delete(chatId);
            for (const item of queue) {
                if (now - item.sentAt < PENDING_SEND_TTL_MS) {
                    batch.push({ chatId, text: item.text });
                }
                else {
                    // pipeline-hooks.md #25: the TTL drop used to be silent.
                    this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                }
            }
        }
        for (const { chatId, text } of batch) {
            void this.sendToChat(chatId, text, { queuable: true }).catch((error) => {
                this.ctx.log('warn', 'queued resend failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) });
            });
        }
    }
    /**
     * Send raw OneBot segments (used by the media tools). W2-③: counts as a
     * proactive write — subject to the minute/day caps and audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.enqueue(chatId, async () => {
            const reject = this.writeGateRejectReason(chatId, 'send_msg');
            if (reject !== null)
                throw new OneBotActionError(reject);
            try {
                const id = await this.sendMsg(chatId, segments, {});
                this.auditWrite(chatId, 'send_msg', true, '发送成功');
                return id;
            }
            catch (error) {
                this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
                throw error;
            }
        });
    }
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    sendChains = new Map();
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const chain = this.sendChains.get(chatId) ?? Promise.resolve();
        const run = chain.then(work, work);
        const tail = run.catch(() => undefined);
        this.sendChains.set(chatId, tail);
        void tail.then(() => {
            if (this.sendChains.get(chatId) === tail)
                this.sendChains.delete(chatId);
        });
        return run;
    }
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId) {
        return this.sendChains.get(chatId) ?? Promise.resolve();
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        const ref = splitChatId(chatId);
        const params = {};
        let target;
        try {
            target = Number(ref.target);
            if (!Number.isFinite(target))
                throw new Error('bad target');
        }
        catch {
            throw new OneBotActionError('invalid chat target: ' + chatId);
        }
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        const data = await this.ctx.call('send_msg', params, chatId);
        return data.message_id !== undefined ? String(data.message_id) : undefined;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
     * from the qq_send_forward tool). W2-③: subject to the minute/day caps
     * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
     * this gate via sendForwardNodes. */
    async sendForward(chatId, nodes) {
        const reject = this.writeGateRejectReason(chatId, 'send_forward_msg');
        if (reject !== null)
            throw new OneBotActionError(reject);
        try {
            await this.sendForwardNodes(chatId, nodes);
            this.auditWrite(chatId, 'send_forward_msg', true, '发送成功');
        }
        catch (error) {
            this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
            throw error;
        }
    }
    /** Ungated merged-forward send (shared by the gated tool path and the
     * passive [[qq_forward]] blocks inside sendToChat). */
    async sendForwardNodes(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        const messages = nodes.map(node => ({
            type: 'node',
            data: {
                uin: this.ctx.selfId() || this.ctx.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId);
        }
        else {
            await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId);
        }
    }
}
