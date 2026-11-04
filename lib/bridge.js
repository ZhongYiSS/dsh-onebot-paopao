/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { realpath } from 'node:fs/promises';
import { transcriptLabel } from './stt.js';
import { buildChatId, classifyUserRole, splitChatId } from './chat.js';
import { formatGroupHistory, recentImagesFromHistory } from './history.js';
import { memoryPathFor, memoryTail } from './memory.js';
import { buildPlatformPrompt } from './prompt.js';
import { registerTools } from './tools.js';
import { MediaGate, FREE_DIRS, DRAW_DIRS } from './media-gate.js';
import { tryHandleCommand as routeCommand, STEER_ACCEPTED_NOTICE } from './commands.js';
import { relayHostCards as relayCards } from './card-relay.js';
import { OutboundPipeline } from './outbound.js';
import { ChatRegistry } from './registry.js';
import { InboundPipeline, normalizeOneBot11 } from './inbound.js';
import { InterimTracker } from './interim.js';
import { DeferredDelivery } from './deferred.js';
import { DEFAULT_DEFERRED_TIMEOUT_MS } from './deferred.js';
import { ProactiveManager } from './proactive.js';
import { BurstBuffer } from './burst.js';
import { readFileSync } from 'node:fs';
import { describeError, errorStack } from './errors.js';
import { currentTrace, newTraceId, runWithTrace, TRACE_REASONS } from './trace.js';
import { runInjectRound, currentInjectRound, isWriteAction, INTERCEPTED_MESSAGE_ID } from './inject.js';
import { healthReport, exportDiagnostics } from './health.js';
import { FailureRefRegistry, failureRefSuffix } from './ref.js';
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export const QUEUE_NOTICE_TEXT = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。';
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export class ChatBridge {
    deps;
    /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
    outbound;
    /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
     * persistence pair, per-chat settings and the create/resume assembly. */
    registry;
    /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
     * dispatch path; the same-name bridge methods below delegate here. */
    inbound;
    /** Interim domain (D1-PR5): the assistant/message interim routing, the
     * per-message recall timers and the turn/end settlement. */
    interim;
    /** T3 (P2): the deferred-delivery tracker (超时补发) — timeout timers, the
     * JSONL registry, bounded send retries and restart recovery. */
    deferred;
    /** 主动模式（20 分钟粘人）：轮到时间追问目标用户，追完/到点收尾。 */
    proactive;
    /** 连发缓冲：目标用户 10 秒内超过 3 条时，压住 5 秒合并成一轮再回。 */
    burst;
    /** T4 (P3): the bounded registry of recent fault references — every minted
     * QQ-CONN-/MF- number is recorded here for the /healthcheck report and the
     * diagnostics archive file name. */
    failureRefs = new FailureRefRegistry();
    /** Live registry indexes — the inbound/outbound/interim/turn links keep
     * reading them through these same-name views. */
    get chats() { return this.registry.chats; }
    get bySession() { return this.registry.bySession; }
    sessionEventOff;
    sessionFlushOff;
    /** W1: chat-level traceId association table — session events arrive on a
     * different async chain than the inbound pipeline, so dispatchFollowup
     * records the initiating traceId per chat here and onSessionEvent reads it
     * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
     * dropped when the chat is removed. Not cleared at turn/end: the interim
     * settle loop sends the final reply AFTER turn/end, and clearing there
     * would orphan exactly that reply's outbound events. One entry per chat
     * id (bounded by the chat population), so growth is not a concern. */
    traceByChat = new Map();
    /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
     * (independent of the trace sink, so the dry-run guard covers the async
     * agent reply even with tracing off). Cleared by a real dispatch to the
     * chat or when the chat is removed. */
    injectRoundByChat = new Map();
    /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
     * running turn (one notice per turn; cleared at turn/end and on chat
     * removal — bounded by the chat population). */
    queueNoticeChats = new Set();
    /** 正在识图/长耗时处理中的会话：期间主动模式不追问、不插话。 */
    recognizingChats = new Set();
    /** 群历史短缓存（5 秒）：被 @ 时「找图」和「补上下文」共用一次拉取，别拉两遍。 */
    historyCache = new Map();
    /** Plugin version + git commit, read once for /ver. */
    pluginVersion;
    pluginCommit;
    stopping = false;
    constructor(deps) {
        this.deps = deps;
        this.registry = new ChatRegistry({
            agents: deps.agents,
            sessions: deps.sessions,
            sessionPersistence: deps.sessionPersistence,
            workspaceRegistry: deps.workspaceRegistry,
            agentPresets: deps.agentPresets,
            defaultModel: deps.defaultModel,
            config: deps.config,
            log: (level, message) => deps.log(level, message),
            isStopping: () => this.stopping,
            onChatRemoved: chat => {
                this.stopTyping(chat);
                this.recognizingChats.delete(chat.chatId);
                this.historyCache.delete(chat.chatId);
                // W1/T5: forget the chat's injected round (and its trace mapping).
                this.deps.config.inject?.clearChat(chat.chatId);
                this.traceByChat.delete(chat.chatId);
                this.injectRoundByChat.delete(chat.chatId);
                this.queueNoticeChats.delete(chat.chatId);
            },
            installChannelScope: agentCtx => this.installChannelScope(agentCtx),
        });
        this.outbound = new OutboundPipeline({
            getChat: chatId => this.chats.get(chatId),
            connected: () => this.deps.connection.connected,
            selfId: () => this.deps.connection.selfId,
            call: (action, params, chatId) => this.guardedConnectionCall(action, params, chatId),
            isStopping: () => this.stopping,
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
            isProactive: chatId => this.proactive.isActive(chatId),
            noteBotMessage: chatId => this.proactive.noteBot(chatId),
            // W1: outbound decision events ride the chat's initiating traceId; a
            // write with no mapped trace (proactive tool sends) starts a fresh one.
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
        });
        this.proactive = new ProactiveManager({
            config: deps.config,
            log: (level, message) => this.deps.log(level, message),
            now: () => Date.now(),
            isStopping: () => this.stopping,
            dispatch: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
            memoryPath: chatId => this.groupMemoryPath(chatId),
            // 追问前看看群里最近的发言，以目标对象为主（默认占比 80%）。
            recentHistory: (chatId, targetId) => this.recentGroupHistory(chatId, this.deps.config.mentionHistoryCount ?? 10, { userId: String(targetId), ratio: this.deps.config.historyFocusRatio ?? 0.8 }),
            isBusy: chatId => this.recognizingChats.has(chatId),
            onClose: chatId => this.burst?.clear(chatId),
        });
        this.burst = new BurstBuffer({
            config: deps.config,
            now: () => Date.now(),
            log: (level, message) => this.deps.log(level, message),
            dispatch: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
        });
        this.inbound = new InboundPipeline({
            call: (action, params) => this.guardedConnectionCall(action, params),
            noteTargetMessage: (chatId, userId) => this.proactive.noteTarget(chatId, userId),
            proactiveTargetId: chatId => this.proactive.stateOf(chatId)?.targetId ?? '',
            burstOffer: (chatId, text, role, nickname) => this.burst.offer(chatId, text, role, nickname),
            groupMemory: chatId => this.groupMemoryText(chatId),
            privateMemory: chatId => this.privateMemoryText(chatId),
            recentHistory: (chatId, count) => this.recentGroupHistory(chatId, count),
            recentImages: (chatId, count) => this.recentGroupImages(chatId, count),
            markRecognizing: (chatId, on) => {
                if (on)
                    this.recognizingChats.add(chatId);
                else
                    this.recognizingChats.delete(chatId);
            },
            selfId: () => this.deps.connection.selfId,
            policy: deps.policy,
            getChat: chatId => this.chats.get(chatId),
            getSettings: chatId => this.registry.getSettings(chatId),
            sweepIdleChats: () => this.registry.sweepIdleChats(),
            media: deps.media,
            transcriber: deps.transcriber,
            steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
            tryHandleCommand: (chatId, text, userId, nickname) => this.tryHandleCommand(chatId, text, userId, nickname),
            buildBody: (text, media, chatId) => this.buildBody(text, media, chatId),
            expandQuote: messageId => this.expandQuote(messageId),
            dispatchFollowup: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
            interceptBusyTurn: (chatId, text, role, nickname, plain) => this.interceptBusyTurn(chatId, text, role, nickname, plain),
            isChatBusy: chatId => this.chats.get(chatId)?.agent.status === 'running',
            sendToChat: (chatId, text) => this.sendToChat(chatId, text),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.interim = new InterimTracker({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
            sendMsg: (chatId, segments, options) => this.sendMsg(chatId, segments, options),
            call: (action, params) => this.guardedConnectionCall(action, params),
            chainTail: chatId => this.outbound.chainTail(chatId),
            relayHostCards: (chatId, content) => this.relayHostCards(chatId, content),
            effectiveInterim: chatId => this.effectiveInterim(chatId),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.deferred = new DeferredDelivery({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
            isTurnRunning: chatId => this.chats.get(chatId)?.agent.status === 'running',
            takePendingText: chatId => {
                const chat = this.chats.get(chatId);
                if (chat === undefined || chat.loopPending === null)
                    return null;
                const text = chat.loopPending;
                chat.loopPending = null;
                return text;
            },
            traceIdFor: chatId => this.traceByChat.get(chatId),
            log: (level, message) => this.deps.log(level, message),
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
            mediaDir: deps.config.mediaDir,
            timeoutMs: deps.config.deferredTimeoutMs ?? DEFAULT_DEFERRED_TIMEOUT_MS,
            isStopping: () => this.stopping,
        });
    }
    /** Start listening: wire connection handlers and the session event feed. */
    start() {
        const { connection, ctx: sessionEvents } = this.deps;
        connection.selfId = this.deps.config.botQQ;
        this.sessionEventOff = sessionEvents.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        this.sessionFlushOff = sessionEvents.on('session/flush', (session) => {
            void this.onSessionFlush(session);
        });
        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
            if (connected)
                this.outbound.drainPendingSends();
        };
        this.proactive.start();
        this.registry.mappingLoaded = this.ready().then(async () => {
            await this.registry.loadRetired();
            await this.registry.loadSwitchable();
            await this.registry.loadMapping();
            // T3 (P2): restore deferred-delivery tracking（未完结条目在该会话的
            // 下一次 turn/end 兑现；损坏行降级跳过）。
            await this.deferred.loadPersisted();
        }).then(() => {
            if (this.stopping)
                return;
            this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))');
        });
    }
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    async stop() {
        this.stopping = true;
        if (this.sessionEventOff !== undefined) {
            this.sessionEventOff();
            this.sessionEventOff = undefined;
        }
        if (this.sessionFlushOff !== undefined) {
            this.sessionFlushOff();
            this.sessionFlushOff = undefined;
        }
        await this.registry.stop();
        // T3 (P2): disarm the deferred silent-wait timers（pending 条目已落盘，
        // 重启后 loadPersisted 恢复跟踪续投）。
        this.deferred.stopAll();
        this.proactive.stop();
        this.burst.stop();
        // 11-04：2 秒合并窗里还没派发的消息直接丢（重载/关停时不该再往停掉的 bridge 打）。
        this.inbound.disposeCoalesced();
    }
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /** 记忆文件路径：群聊 → groupMemoryDir/<群号>.md；私聊 → privateMemoryDir/<QQ>.md。 */
    memoryPathFor(chatId) {
        const { kind, target } = splitChatId(chatId);
        return memoryPathFor(kind, target, {
            groupMemoryDir: this.deps.config.groupMemoryDir,
            privateMemoryDir: this.deps.config.privateMemoryDir,
        });
    }
    /** 群记忆文件路径（只有群聊 + 配了 groupMemoryDir 才有）。 */
    groupMemoryPath(chatId) {
        return splitChatId(chatId).kind === 'group' ? this.memoryPathFor(chatId) : '';
    }
    /** 私聊记忆文件路径（只有私聊 + 配了 privateMemoryDir 才有）。 */
    privateMemoryPath(chatId) {
        return splitChatId(chatId).kind === 'private' ? this.memoryPathFor(chatId) : '';
    }
    /** 读记忆正文（最多 limit 字，尾部优先）；没有就返回空串。 */
    memoryText(path, limit) {
        if (path === '')
            return '';
        try {
            return memoryTail(readFileSync(path, 'utf8'), limit);
        }
        catch {
            return '';
        }
    }
    /** 读群记忆正文（最多 2000 字，尾部优先）；没有就返回空串。 */
    groupMemoryText(chatId) {
        return this.memoryText(this.groupMemoryPath(chatId), 2000);
    }
    /** 读私聊记忆正文（最多 2000 字，尾部优先）；没有就返回空串。 */
    privateMemoryText(chatId) {
        return this.memoryText(this.privateMemoryPath(chatId), 2000);
    }
    /**
     * 补最近的群聊上下文（被 @ 时用）：读不到/超时就返回空串，绝不阻塞回复。
     * @param chatId - 目标会话。
     * @param count - 最多几条。
     * @param focus - 可选：以某人的发言为主（追问时用，默认对象占 80%）。
     * @returns 形如「昵称：内容」的多行文本。
     */
    async recentGroupHistory(chatId, count, focus) {
        const parts = splitChatId(chatId);
        if (parts.kind !== 'group')
            return '';
        const limit = Math.min(Math.max(Math.floor(count), 1), 50);
        // 5 秒内刚拉过历史就直接用（找图 + 补上下文共用一次请求）。
        const cached = this.historyCache.get(chatId);
        if (cached !== undefined && Date.now() - cached.at <= 5000)
            return formatGroupHistory(cached.messages, limit, focus);
        try {
            const data = await Promise.race([
                this.deps.connection.call('get_group_msg_history', {
                    group_id: Number(parts.target),
                    count: limit,
                }),
                new Promise((resolve) => setTimeout(() => resolve(undefined), 2500)),
            ]);
            const messages = Array.isArray(data?.messages) ? data.messages : [];
            this.historyCache.set(chatId, { messages, at: Date.now() });
            return formatGroupHistory(messages, limit, focus);
        }
        catch (error) {
            this.deps.log('debug', '群历史读取失败（不影响回复）: ' + describeError(error));
            return '';
        }
    }
    /**
     * 往回找「最近一条带图片的群消息」里的图（被 @ 但本条没带图时用）。
     * 有上限：最多看 count 条、只认 maxAgeMs 内的、找到一张就停——绝不无限翻。
     * @param chatId - 会话 id。
     * @param count - 最多回看几条消息（默认 3）。
     * @param maxAgeMs - 多久之内的消息才算数（默认 5 分钟）。
     * @returns 图片 ref 数组（只包含最近那一条带图消息里的图，可能为空）。
     */
    async recentGroupImages(chatId, count, maxAgeMs) {
        const maxAge = typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs)
            ? maxAgeMs
            : (this.deps.config.recentImageMaxAgeMs ?? 300_000);
        const parts = splitChatId(chatId);
        if (parts.kind !== 'group')
            return [];
        const limit = Math.min(Math.max(Math.floor(count), 1), 10);
        // 5 秒内刚拉过历史就直接用，避免同一条 @ 消息拉两遍。
        const cached = this.historyCache.get(chatId);
        if (cached !== undefined && Date.now() - cached.at <= 5000)
            return recentImagesFromHistory(cached.messages, { maxAgeMs: maxAge });
        try {
            const data = await Promise.race([
                this.deps.connection.call('get_group_msg_history', {
                    group_id: Number(parts.target),
                    count: limit,
                }),
                new Promise((resolve) => setTimeout(() => resolve(undefined), 2500)),
            ]);
            const messages = Array.isArray(data?.messages) ? data.messages : [];
            this.historyCache.set(chatId, { messages, at: Date.now() });
            return recentImagesFromHistory(messages, { maxAgeMs: maxAge });
        }
        catch (error) {
            this.deps.log('debug', '回看群图片失败（不影响回复）: ' + describeError(error));
            return [];
        }
    }
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the currently running turn's initiator to be an admin (role frozen
     * from the dispatch queue at turn/start); non-QQ sessions (Web and other
     * channels) are trusted by default (A1 scoping). Unknown states fail closed
     * as member. */
    canEditFiles(sessionId) {
        const chatId = this.bySession.get(sessionId);
        if (chatId === undefined)
            return true;
        return this.chats.get(chatId)?.activeTurnRole === 'admin';
    }
    /**
     * Outbound media fence roots for one agent session's current turn (M1-A3b):
     * the plugin media dir always, plus the chat's workspace directory when the
     * running turn's initiator is an admin. The role reuses the M1-A2 turn-level
     * semantics (canEditFiles: frozen at turn/start, fail-closed member); a
     * session with no known chat stays mediaDir-only even though canEditFiles
     * would trust it — the media gate itself fails closed. Roots are
     * realpath-normalized here; the MediaStore fence re-checks containment
     * (the double check is harmless).
     */
    async mediaSendRoots(sessionId) {
        const isTurnAdmin = sessionId !== undefined && this.canEditFiles(sessionId);
        const chatId = sessionId !== undefined ? this.bySession.get(sessionId) : undefined;
        const candidates = [this.deps.config.mediaDir];
        if (chatId !== undefined && isTurnAdmin)
            candidates.push(this.effectiveCwd(chatId));
        // 10-29 哥哥定：表情包目录和画师出图目录也放进发图白名单，
        // 省掉每次先把图拷到 media\onebot\stickers 的一步。只取绝对路径，
        // media\onebot\* 那几条相对路径本来就在 mediaDir 底下，不用管。
        for (const extra of [...FREE_DIRS, ...DRAW_DIRS]) {
            if (/^[a-zA-Z]:[\\/]/.test(extra))
                candidates.push(extra);
        }
        const roots = [];
        for (const root of candidates) {
            try {
                roots.push(await realpath(root));
            }
            catch {
                roots.push(root); // missing root: kept as-is; the fence skips it (cannot contain anything)
            }
        }
        return { roots, isTurnAdmin };
    }
    /** Whether the connection is usable for sends. */
    get connected() {
        return this.deps.connection.connected;
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
        // 陪伴插件（dsh-bubble）：会话自己按住了这一轮（[HOLD] / [SKIP]），
        // 正文一个字都不许漏出去。标记在 assistant/message 那一步就被摘掉了。
        const chat = this.chats.get(chatId);
        if (chat?.bubbleHold) {
            this.deps.log('info', '陪伴：这一轮被会话按住（' + chat.bubbleHold.toUpperCase() + '），不往 QQ 发：' + String(text).slice(0, 40));
            return [];
        }
        // 兜底：万一标记漏到这儿，剥掉再发，别把 [HOLD] 三个字印到聊天框里。
        const clean = String(text).replace(/\[(HOLD|SKIP)\]/gi, '').trim();
        if (clean === '') return [];
        return this.outbound.sendToChat(chatId, clean, options);
    }
    /**
     * 陪伴插件（dsh-bubble）的「按住」判定：会话回 [HOLD]（做了但不想发）或
     * [SKIP]（不想做）→ 这一轮正文不再往外发。返回 true 表示已经按住。
     * 只认文本块里独立出现的标记，正文里顺手提一句不算。
     */
    bubbleHoldsTurn(chatId, chat, message) {
        try {
            const text = (message?.content || [])
                .filter((b) => b && b.type === 'text')
                .map((b) => String(b.text || ''))
                .join('');
            if (!text) return false;
            const m = text.match(/\[(hold|skip)\]/i);
            if (!m) return false;
            chat.bubbleHold = String(m[1]).toLowerCase();
            chat.bubbleHoldAt = Date.now();
            chat.lastActivityAt = Date.now();
            this.deps.log('info', '陪伴：会话回 [' + m[1].toUpperCase() + ']，这一轮不往 QQ 发（chat=' + chatId + '）');
            this.deps.log('info', '陪伴：被按住的话：' + text.replace(/\[(hold|skip)\]/gi, '').trim().slice(0, 60));
            return true;
        } catch {
            return false;
        }
    }
    /**
     * 给陪伴插件看：某个会话最近一次「按住」是什么时候、按的什么。
     * 账本里记一笔用的（没有就说空串）。
     */
    lastBubbleHold(chatId) {
        try {
            const c = this.chats.get(chatId);
            if (!c?.bubbleHold) return null;
            return { kind: c.bubbleHold, at: Number(c.bubbleHoldAt) || 0 };
        } catch { return null; }
    }
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.outbound.sendSegments(chatId, segments);
    }
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    async ready() {
        await this.deps.hostReady?.();
    }
    // ------------------------------------------------------------ inbound
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     * W1: the whole inbound chain runs inside one trace scope (ALS), so every
     * pipeline decision point can attribute its event to this message's
     * traceId; disabled = no scope, no id, 0.6.0 behavior. W1/T5: injected
     * events (opts.injected) run inside their inject round (ALS) so the
     * dry-run guard covers the whole synchronous chain, and real events are
     * recorded by the inbound recorder when recordInbound is on (injected
     * events are never recorded — no inject→record→replay feedback loop).
     */
    async handleInbound(event, opts = {}) {
        const run = () => this.handleInboundOnce(event, opts.injected === true);
        return opts.injected === true
            ? runInjectRound({ traceId: newTraceId(), intercepted: 0 }, run)
            : run();
    }
    async handleInboundOnce(event, injected) {
        // Recording: skipped for injected events (they would otherwise feed the
        // injector again through replay) and skipped when no recorder exists.
        const recorder = injected ? undefined : this.deps.config.recorder;
        const session = recorder?.begin(event) ?? undefined;
        const trace = this.beginInboundTrace(event);
        const scope = trace !== undefined
            ? (session !== undefined ? session.wrapScope(trace) : trace)
            : session?.captureScope();
        try {
            await runWithTrace(scope, async () => {
                if (this.stopping) {
                    this.deps.log('debug', '插件停止中，入站消息丢弃');
                    scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping });
                    return;
                }
                const inbound = normalizeOneBot11(event);
                if (inbound === null) {
                    this.deps.log('debug', '非聊天消息事件，不处理（post_type=' + String(event.post_type) + '）');
                    scope?.emit('normalize', { ok: false, reason: TRACE_REASONS.inboundNotChat });
                    return;
                }
                await this.processInbound(inbound);
            });
        }
        catch (error) {
            scope?.emit('dispatch', { ok: false, reason: '入站处理失败: ' + describeError(error) });
            this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));
        }
        finally {
            session?.end();
        }
    }
    /** W1: mint the inbound traceId + scope and record the first (收到消息)
     * event; undefined when tracing is off (zero overhead, zero difference).
     * W1/T5: an injected event REUSES its inject round's traceId, so the whole
     * injected round (pipeline decisions + intercepted outbound calls) shares
     * one traceId in the trace stream. */
    beginInboundTrace(event) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const kind = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined;
        const chatId = kind !== undefined
            ? buildChatId(kind, String(kind === 'group' ? event.group_id ?? '' : event.user_id ?? ''))
            : '';
        const messageId = event.message_id === undefined || event.message_id === null ? undefined : String(event.message_id);
        const traceId = currentInjectRound()?.traceId ?? newTraceId(sink.now());
        const scope = sink.scope(traceId, chatId, messageId);
        sink.emit({ traceId: scope.traceId, stage: 'inbound', ok: true, chatId, messageId, data: { messageType: String(event.message_type ?? '') } });
        return scope;
    }
    async processInbound(inbound) {
        await this.inbound.processInbound(inbound);
    }
    /** Feed one user message into a chat's agent (create on demand). Records
     * the base text for /retry, queues the initiator's turn role, and applies
     * per-chat /goal + /plan prefixes. */
    async dispatchFollowup(chatId, text, role, nickname) {
        const final = this.prefixTurn(chatId, text);
        const fallback = this.chats.get(chatId)?.lastNickname ?? '';
        const chat = await this.ensureChat(chatId, nickname ?? fallback);
        if (nickname !== undefined && nickname !== '')
            chat.lastNickname = nickname;
        chat.lastFollowup = text;
        chat.lastActivityAt = Date.now();
        // M3-D2a: a dispatched user turn starts a fresh interim cycle (the
        // inbound residue reset already cleared the loop fields directly).
        this.interim.onNewUserTurn(chat);
        // Queue this turn's initiator role; the host's turn/start freezes it as
        // the running turn's role (M1-A2). Push and followup happen synchronously,
        // so the role cannot interleave with another dispatch.
        chat.pendingTurnRoles.push(role);
        this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120));
        // Plugin-originated user message: the session log attributes QQ inbound
        // messages to this plugin's own producer-owned source kind, keeping them
        // distinguishable from host/web UI inputs.
        chat.agent.followup(createUserMessage({
            content: [{ type: 'text', text: final }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        // W1 cross-stream join: the turn's session events arrive on a different
        // async chain, so record this dispatch's traceId per chat for
        // onSessionEvent to pick up (runs inside the inbound ALS scope — command
        // dispatches reach here through the same await chain).
        const trace = currentTrace();
        if (trace !== undefined) {
            this.traceByChat.set(chatId, trace.traceId);
            trace.emit('dispatch', { ok: true, reason: '消息已投递给模型' });
        }
        // W1/T5 inject bookkeeping: an injected dispatch registers its round for
        // this chat (the async reply stays attributable — INDEPENDENT of tracing,
        // so the dry-run guard also works with the trace sink off); a real
        // dispatch clears any leftover injected round so real users are never
        // collaterally intercepted by the dry-run guard.
        const injectedRound = currentInjectRound();
        if (injectedRound !== undefined)
            this.injectRoundByChat.set(chatId, injectedRound.traceId);
        else
            this.injectRoundByChat.delete(chatId);
        this.deps.config.inject?.noteDispatch(chatId);
        this.startTyping(chat);
    }
    /** Prepend per-chat context directives (/goal reminder) to a turn's user
     * text. Plan mode is host-owned now (/plan forwards to the host command),
     * so the agent's own plan-mode instruction section governs planning. */
    prefixTurn(chatId, text) {
        let out = text;
        const goal = this.registry.getSettings(chatId).goal;
        if (goal !== undefined && goal.trim() !== '') {
            out = '【当前目标】' + goal + '\n' + out;
        }
        return out.trim();
    }
    /** Per-chat outbound-mode override (/mode), falling back to the global config. */
    effectiveInterim(chatId) {
        return this.registry.getSettings(chatId).interimOverride ?? this.deps.config.interimMessages;
    }
    /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
    relayHostCards(chatId, content) {
        relayCards(this.cardRelayCtx, chatId, content);
    }
    /** The CardRelayContext handed to the card relay (D1-PR2): the outbound
     * send path plus the bridge log — the only capabilities the relay touches. */
    get cardRelayCtx() {
        return {
            sendToChat: (chatId, text) => this.sendToChat(chatId, text),
            log: (level, message) => this.deps.log(level, message),
        };
    }
    /**
     * Slash-command router. Commands are admin-only (the Hermes member
     * slash-command block) and are matched on the first word; a leading
     * @mention glued to the command (QQ group at + text) is stripped first.
     * A path like /tmp/x is never a command (command words are
     * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
     * message reaches the model, matching the Hermes "fall through" behavior.
     * @param chatId - the chat the command arrived in.
     * @param text - parsed inbound text.
     * @param userId - sender QQ number.
     * @param nickname - sender display name (pre-sanitized; T9-A /steer boundary).
     * @returns true when the message was consumed by a command.
     */
    tryHandleCommand(chatId, text, userId, nickname) {
        return routeCommand(this.commandCtx, chatId, text, userId, nickname);
    }
    /**
     * The CommandContext handed to the command table (D1-PR1): exposes exactly
     * the bridge capabilities the routed commands use, resolved live per
     * invocation (the llm catalog especially must stay a live service lookup).
     */
    get commandCtx() {
        const bridge = this;
        return {
            sendToChat: (chatId, text) => bridge.sendToChat(chatId, text),
            log: (level, message) => bridge.deps.log(level, message),
            isAdmin: userId => classifyUserRole(userId, bridge.deps.policy.adminUsers) === 'admin',
            getChat: chatId => bridge.chats.get(chatId),
            hasChat: chatId => bridge.chats.has(chatId),
            resetChat: chatId => bridge.resetChat(chatId),
            dispatchFollowup: (chatId, text, role, nickname) => bridge.dispatchFollowup(chatId, text, role, nickname),
            // T3 (P2): /stop 也显式终止该聊天的超时补发跟踪（其他聊天不受影响）。
            stopDeferredTracking: chatId => bridge.deferred.cancelChat(chatId),
            // T2 (P1): /steer — the bridge-owned steer core keeps the createUserMessage
            // source write point in bridge.ts (producer-owned kind, session-v4 guard).
            steerRunningTurn: (chatId, text) => bridge.steerMessage(chatId, text),
            effectiveCwd: chatId => bridge.effectiveCwd(chatId),
            sessionIdFromMapping: chatId => bridge.sessionIdFromMapping(chatId),
            resolvePresetId: chatId => bridge.resolvePresetId(chatId),
            // T3: /workspace persists with the chat mapping (debounced). When the
            // chat is not live, noteWorkspaceOverride snapshots it into the registry
            // so the flush actually reaches the mapping file instead of being
            // dropped by the chats/evictedChats-only rewrite.
            setChatWorkspacePath: (chatId, path) => {
                bridge.registry.getSettings(chatId).workspacePath = path;
                bridge.registry.noteWorkspaceOverride(chatId);
                bridge.registry.saveMappingDebounced();
            },
            presetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride,
            setPresetOverride: (chatId, id) => { bridge.registry.getSettings(chatId).presetOverride = id; },
            hasPresetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride !== undefined,
            interimOverride: chatId => bridge.registry.getSettings(chatId).interimOverride,
            // D4b: /mode and /goal persist with the chat mapping (debounced).
            setInterimOverride: (chatId, value) => { bridge.registry.getSettings(chatId).interimOverride = value; bridge.registry.saveMappingDebounced(); },
            goal: chatId => bridge.registry.getSettings(chatId).goal,
            setGoal: (chatId, value) => { bridge.registry.getSettings(chatId).goal = value; bridge.registry.saveMappingDebounced(); },
            deleteGoal: chatId => { bridge.registry.getSettings(chatId).goal = undefined; bridge.registry.saveMappingDebounced(); },
            lastImagePath: chatId => bridge.registry.getSettings(chatId).lastImagePath,
            // R2: pending serial-number selection snapshot (lazy TTL lives in commands).
            pendingSelection: chatId => bridge.registry.getSettings(chatId).pendingSelection,
            setPendingSelection: (chatId, value) => { bridge.registry.getSettings(chatId).pendingSelection = value; },
            // /session: the per-chat switchable history and the switch itself.
            switchableSessions: chatId => bridge.registry.switchableSessions(chatId),
            switchSession: (chatId, targetSessionId) => bridge.registry.switchSession(chatId, targetSessionId),
            // /session list previews: cold-read each retired session's first user
            // input through the persistence port (read handle, small prefix).
            sessionPersistence: bridge.deps.sessionPersistence,
            takePendingImageRef: chatId => {
                const settings = bridge.registry.getSettings(chatId);
                const ref = settings.pendingImageRef;
                if (ref !== undefined)
                    settings.pendingImageRef = undefined;
                return ref;
            },
            resolveMediaRef: (ref, chatId) => bridge.resolveMediaRef(ref, chatId),
            llmCatalog: bridge.deps.llmCatalog,
            workspaceRegistry: bridge.deps.workspaceRegistry,
            agentDefaultModel: bridge.deps.agentDefaultModel,
            agentPresets: bridge.deps.agentPresets,
            commands: bridge.deps.commands,
            connection: bridge.deps.connection,
            dshHome: bridge.deps.dshHome,
            // W1/T5: the healthcheck command renders/packs through the bridge.
            healthReport: () => bridge.buildHealthReport(),
            // T4 (P3): export takes an optional trigger reference (file-name stamp).
            exportDiagnostics: triggerRef => bridge.exportDiagnosticsPackage(triggerRef),
            // T4 (P3): command-plane failures (/retry) mint an MF- reference through
            // the bridge's single entry point (registry + trace + structured log).
            reportFailure: (chatId, stage, detail) => bridge.registerMessageFailure(chatId, stage, detail),
            config: { interimMessages: bridge.deps.config.interimMessages, maxImageBytes: bridge.deps.config.maxImageBytes, unknownCommand: bridge.deps.config.unknownCommand },
        };
    }
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    async sessionIdFromMapping(chatId) {
        return this.registry.sessionIdFromMapping(chatId);
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    buildBody(text, media, chatId) {
        return this.inbound.buildBody(text, media, chatId);
    }
    /** Resolve one media ref to a text annotation with a local path. */
    resolveMediaRef(ref, chatId) {
        return this.inbound.resolveMediaRef(ref, chatId);
    }
    /** M3-D4c: steer a completed voice transcript into the chat's agent — the
     * running turn consumes it at its nearest step boundary; an idle agent
     * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
    steerTranscript(chatId, text) {
        if (this.steerMessage(chatId, transcriptLabel(text)))
            return;
        this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId);
        currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.transcriptNoChat });
    }
    /** T2 (P1): the single agent.steer write point — one createUserMessage with
     * the producer-owned source kind (the session-v4 guard counts the source
     * write points; this and dispatchFollowup are the only two). Shared by the
     * voice transcript path (steerTranscript), the 'steer' policy and /steer.
     * Returns false when the chat has no live agent (nothing was steered). */
    steerMessage(chatId, text) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return false;
        chat.agent.steer(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        return true;
    }
    /**
     * T2 (P1): the busy-turn policy seam (inbound ctx.interceptBusyTurn).
     * Called for every non-command message AFTER all gates, only when deciding
     * what to do with it while the chat's task is running:
     * - no running turn → false (caller dispatches normally; the 0.8.1 path,
     *   byte-identical — also the path for newMessagePolicy缺省 idle traffic);
     * - 'steer' policy + plain text + non-restricted sender + autoSteerPolicy
     *   eligibility ('admin' 档缺省 = 仅管理员；'all' 档不限，T9-B 用户裁决
     *   2026-10-12) → the message is submitted into the running turn via the
     *   steerMessage kernel (consumed at the nearest step boundary, NO new turn)
     *   and a submit notice goes out;
     * - otherwise (queue policy default / media-quote-forward message /
     *   restricted group member / 不具备自动插话资格) → the 0.8.1 dispatch path
     *   (agent.followup queues it as the next turn: consumed after the current
     *   turn ends, in arrival order) plus the queue notice at most once per
     *   running turn.
     * The running check reads the agent's own lifecycle state — the same
     * authoritative signal /stop uses; chat.busy (turn/start..turn/end view)
     * can lag the host driver and is deliberately NOT consulted.
     */
    async interceptBusyTurn(chatId, text, role, nickname, plain) {
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.agent.status !== 'running')
            return false;
        // The restricted-member soft limit ([受限用户:仅问答]) is never widened by
        // the steer policy: restricted senders' messages queue like everyone
        // else's media. The condition mirrors the RESTRICTED_PREFIX application
        // in the inbound pipeline (group + non-admin + restrictedMemberPrefix).
        const restricted = splitChatId(chatId).kind === 'group'
            && role !== 'admin' && this.deps.config.restrictedMemberPrefix;
        // T9-B: auto-steer eligibility (user ruling 2026-10-12) — 'admin' (缺省)
        // = admins only; 'all' = anyone. Restricted members stay excluded under
        // both; /steer remains admin-only regardless of this knob; queue mode is
        // untouched.
        const autoSteerAllowed = (this.deps.config.autoSteerPolicy ?? 'admin') === 'all' || role === 'admin';
        if ((this.deps.config.newMessagePolicy ?? 'queue') === 'steer' && plain && !restricted && autoSteerAllowed) {
            this.steerMessage(chatId, text);
            currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnSteered });
            // 本地改动（10-31）：自动插话的「✅ 已提交」提示默认关（哥哥要求，
            // 跟排队提示一个规矩）；想恢复就在 dsh-onebot 配置里加
            // steerNoticeEnabled: true。手动 /steer 的回执不受影响。
            if (this.deps.config.steerNoticeEnabled === true) {
                this.sendToChat(chatId, STEER_ACCEPTED_NOTICE).catch((error) => {
                    this.deps.log('debug', '插话提交提示发送失败: ' + describeError(error));
                    currentTrace()?.emit('notice', { ok: false, reason: '插话提交提示发送失败: ' + describeError(error) });
                });
            }
            return true;
        }
        await this.dispatchFollowup(chatId, text, role, nickname);
        currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnQueued });
        if (!this.queueNoticeChats.has(chatId)) {
            this.queueNoticeChats.add(chatId);
            // 本地改动：默认不再发「⏳ 当前任务运行中…」排队提示（哥哥要求）。
            // 想恢复就在 dsh-onebot 配置里加 queueNoticeEnabled: true。
            if (this.deps.config.queueNoticeEnabled === true) {
                this.sendToChat(chatId, QUEUE_NOTICE_TEXT).catch((error) => {
                    this.deps.log('debug', '排队提示发送失败: ' + describeError(error));
                    currentTrace()?.emit('notice', { ok: false, reason: '排队提示发送失败: ' + describeError(error) });
                });
            }
        }
        return true;
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    expandQuote(messageId) {
        return this.inbound.expandQuote(messageId);
    }
    // ------------------------------------------------------------ outbound
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        return this.outbound.sendMsg(chatId, segments, options);
    }
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    async sendForward(chatId, nodes) {
        return this.outbound.sendForward(chatId, nodes);
    }
    // ------------------------------------------------------------ inject dry-run guard
    /**
     * W1/T5: the single connection-call gate every bridge pipeline
     * (inbound/outbound/interim/typing) routes through. In inject dry-run
     * mode, WRITE actions of an injected round are intercepted at this
     * outbound action layer: counted, traced with the original text, resolved
     * with the marker message id — the real OneBot connection never sees them.
     * Attribution: (a) the synchronous chain via the inject round's ALS, (b)
     * the async agent reply via the chat→round association (injectRoundByChat,
     * independent of the trace sink), (c) recalls of already-intercepted sends
     * via the marker message id (a real OneBot id is never negative).
     */
    guardedConnectionCall(action, params, chatId) {
        const inject = this.deps.config.inject;
        if (inject === undefined || !inject.intercepting || !isWriteAction(action)) {
            return this.deps.connection.call(action, params);
        }
        const alsRound = currentInjectRound();
        if (alsRound !== undefined)
            return inject.intercept(alsRound, action, params);
        if (chatId !== undefined) {
            const round = inject.activeRoundFor(chatId);
            if (round !== undefined && this.injectRoundByChat.get(chatId) === round.traceId) {
                return inject.intercept(round, action, params);
            }
        }
        if (params.message_id === INTERCEPTED_MESSAGE_ID) {
            // Recall of an intercepted send (interim path has no chatId): count it
            // on the marker rule even without a resolvable round.
            return inject.intercept(undefined, action, params);
        }
        return this.deps.connection.call(action, params);
    }
    // ------------------------------------------------------------ health (W1/T5)
    /** The health deps the /healthcheck command renders from (resolved live). */
    healthDeps() {
        const conn = this.deps.connection;
        const transport = conn.config ?? {};
        const recorder = this.deps.config.recorder;
        const inject = this.deps.config.inject;
        return {
            mediaDir: this.deps.config.mediaDir,
            connection: { connected: this.deps.connection.connected, selfId: this.deps.connection.selfId },
            transport: { mode: String(transport.mode ?? '未知'), host: String(transport.host ?? ''), port: Number(transport.port ?? 0) },
            retryState: {
                reverseRetryAttempts: conn.reverseRetryAttempts,
                reconnectAttempts: conn.reconnectAttempts,
                selfHealing: conn.selfHealing,
            },
            dedup: {
                entries: this.inbound.dedupWindowEntries,
                // The W2-② window key rides as an optional intersection member.
                windowSeconds: this.deps.config.dedupWindowSeconds ?? 300,
            },
            writeGate: this.outbound.writeGateStats(),
            ...(recorder !== undefined
                ? { recorder: { enabled: true, redact: recorder.redact, written: recorder.getStats().written } }
                : {}),
            ...(inject !== undefined
                ? {
                    inject: {
                        enabled: true, dryRun: inject.intercepting,
                        consumed: inject.getStats().consumed, intercepted: inject.getStats().intercepted,
                        skippedHistory: inject.getStats().skippedHistory,
                    },
                }
                : {}),
            configSnapshot: this.deps.configSnapshot?.() ?? {},
            // T4 (P3): the recent fault references for the report section.
            failureRefs: () => this.failureRefs.recent(),
            log: (level, message) => this.deps.log(level, message),
        };
    }
    /** /healthcheck: render the health summary. */
    async buildHealthReport() {
        return healthReport(this.healthDeps());
    }
    /** /healthcheck export: pack the redacted diagnostics archive. T4 (P3): the
     * file name carries the trigger reference — the explicit command argument,
     * or the most recent recorded fault reference when omitted. */
    async exportDiagnosticsPackage(triggerRef) {
        const deps = this.healthDeps();
        return exportDiagnostics({ ...deps, triggerRef: triggerRef ?? this.failureRefs.recent(1)[0]?.ref });
    }
    // ------------------------------------------------------------ session events
    onSessionEvent(session, event) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined) {
            // pipeline-hooks.md #20: non-QQ sessions (web/host) ride this same bus;
            // keep the early exit visible at debug without emitting any trace.
            this.deps.log('debug', 'session 事件早退：无 chat 映射（session=' + session.id + ' type=' + String(event.type) + '）');
            return;
        }
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.sessionId !== session.id)
            return;
        const trace = this.traceForChat(chatId);
        if (event.type === 'turn/start') {
            trace?.emit('agent', { ok: true, reason: '模型回合开始' });
            // B8: a new turn begins — prune the previous turn's recalled-id
            // residue (see InterimTracker.onTurnStart for the safety analysis).
            this.interim.onTurnStart(chat);
            // 陪伴插件：上一轮的「按住」到这儿作废，新回合重新算。
            chat.bubbleHold = '';
            // Freeze the running turn's initiator role from the dispatch FIFO
            // (M1-A2): turns the plugin did not dispatch (host/web input) find an
            // empty queue and fail closed as member.
            chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member';
            chat.lastActivityAt = Date.now();
            chat.busy = true;
            // T3 (P2): arm the deferred silent-wait window for this turn（每次模型
            // 输出重置；turn/end 解除；deferredTimeoutMs<=0 时为 no-op）。
            this.deferred.onTurnStart(chatId, session.id);
            return;
        }
        if (event.type === 'assistant/message') {
            // T3 (P2): a deferred-registered (timed-out) turn is muted — its text
            // messages are captured for the final补发 only（不插播 interim、不转
            // 审批/提问卡：超时后只补最终文字与终态通知）。
            if (this.deferred.onAssistantMessage(chatId, session.id, event.data.message))
                return;
            // 陪伴插件：会话说「做了但不想发」/「不想做」→ 整轮按住，不进 interim。
            if (this.bubbleHoldsTurn(chatId, chat, event.data.message))
                return;
            this.interim.onAssistantMessage(chatId, chat, event.data.message);
            return;
        }
        if (event.type === 'turn/end') {
            const reason = event.data.reason;
            // T4 (P3): a message-turn fault mints ONE MF- reference before any
            // consumer runs — the trace event (data.ref), the structured log line,
            // the ⚠️ notice tail and the deferred terminal text all carry the same
            // number. Normal (completed/cancelled) turns mint nothing.
            const errorRef = reason.kind === 'error'
                ? this.mintFailureRef('msg', 'agent', '模型回合出错: ' + reason.error.message, { chatId })
                : undefined;
            // T3 (P2): complete a deferred entry（补发异步进行）；true = the turn was
            // under deferred tracking — the terminal-state notice rides the补发
            // path, so the normal error notice below is suppressed（同一故障不双发）.
            const deferredTracked = this.deferred.onTurnEnd(chatId, session.id, reason, errorRef);
            this.interim.onTurnEnd(chatId, chat);
            if (reason.kind === 'error') {
                // T4: the ok:false agent event is emitted by mintFailureRef (with
                // data.ref) — no second event for the same decision point.
            }
            else {
                trace?.emit('agent', { ok: true, reason: '模型回合结束（' + reason.kind + '）' });
            }
            if (reason.kind === 'error') {
                const message = reason.error.message;
                // 基线语义保持：碰撞自愈原本挂在 sendErrorNotice 分支内；deferred
                // 回合的终态走补发通道，也必须自愈，故闸为 sendErrorNotice || deferredTracked。
                if ((this.deps.config.sendErrorNotice || deferredTracked)
                    && /persisted log on disk that does not match this live session|id collision/i.test(message)) {
                    void this.healSessionCollision(chatId);
                }
                if (!deferredTracked && this.deps.config.sendErrorNotice) {
                    // 哥哥 2026-10-26 的规矩：报错不往群里贴详细内容（错误原文/参考号
                    // 都不发），只说一句「出错了」；排查照旧走 qq-trace.jsonl。
                    this.sendToChat(chatId, '⚠️ 出错了', { queuable: true }).catch((error) => {
                        // pipeline-hooks.md #21: the send failure used to be swallowed.
                        this.deps.log('debug', '错误通知发送失败: ' + describeError(error));
                        trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed });
                    });
                }
            }
            this.stopTyping(chat);
            chat.lastActivityAt = Date.now();
            chat.busy = false;
            // T2 (P1): the turn that armed the queue notice is over — a later
            // running turn notifies again.
            this.queueNoticeChats.delete(chatId);
            this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind);
            // Durable: flush the session so a later restart can resume it.
            void this.deps.sessions.flush(chat.agent.session).catch((error) => {
                this.deps.log('warn', 'session flush failed: ' + String(error));
                trace?.emit('notice', { ok: false, reason: '会话落盘失败: ' + String(error) });
            });
            void this.saveMappingDebounced();
        }
    }
    /** W1: the trace scope for one chat's session events, resolved through the
     * chat-level association table; undefined when tracing is off or the chat
     * has no recorded dispatch (host-initiated turns stay untraced). */
    traceForChat(chatId) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const traceId = this.traceByChat.get(chatId);
        return traceId !== undefined ? sink.scope(traceId, chatId) : undefined;
    }
    // ------------------------------------------------------ failure references (W3/T4)
    /**
     * T4 (P3): the single fault-reference entry point. Mints one QQ-CONN-/MF-
     * number, records it in the bounded registry, emits the ok:false trace
     * event carrying `data.ref` (traceId = the chat's mapped id, or a fresh id
     * for chat-less connection faults), and writes the structured error log
     * line — every surface of the fault shares this one number. Called only on
     * fault events: normal traffic mints nothing (zero overhead).
     */
    mintFailureRef(kind, stage, detail, opts = {}) {
        const ref = this.failureRefs.mint(kind);
        const traceId = opts.chatId !== undefined ? this.traceByChat.get(opts.chatId) : undefined;
        this.failureRefs.record({ ref, kind, ts: Date.now(), stage, detail, traceId });
        const sink = this.deps.config.trace;
        if (sink !== undefined && sink.enabled) {
            sink.emit({
                traceId: traceId ?? newTraceId(sink.now()),
                chatId: opts.chatId,
                stage,
                ok: false,
                reason: detail,
                data: { ref, refKind: kind },
            });
        }
        this.deps.log('error', '故障参考号 ' + ref + ' [' + stage + ']: ' + detail);
        return ref;
    }
    /** T4: connection-fault reference entry (wired from index.ts via
     * `connection.onFailure`); the returned reference is appended to the
     * transport's own log line. */
    registerConnectionFailure(stage, detail) {
        return this.mintFailureRef('conn', 'connection', detail);
    }
    /** T4: message-fault reference entry for command-plane failures (e.g. the
     * /retry dispatch throw); the caller appends the returned reference to the
     * user-visible ⚠️ notice. */
    registerMessageFailure(chatId, stage, detail) {
        return this.mintFailureRef('msg', stage, detail, { chatId });
    }
    async onSessionFlush(session) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined)
            return;
        // M1-E2: arbitrary session flushes debounce like turn/end — stop() still
        // forces the final saveMapping directly.
        this.saveMappingDebounced();
    }
    // ------------------------------------------------------------ registry facades
    /** Same-name delegations to the chat registry (D1-PR3): the command table's
     * ctx, the interim/turn event links and the outbound pipeline keep calling
     * the bridge exactly as before the split. */
    /** Get (or create) the agent for a chat. */
    ensureChat(chatId, nickname) {
        return this.registry.ensureChat(chatId, nickname);
    }
    effectiveCwd(chatId) {
        return this.registry.effectiveCwd(chatId);
    }
    resolvePresetId(chatId) {
        return this.registry.resolvePresetId(chatId);
    }
    saveMappingDebounced() {
        this.registry.saveMappingDebounced();
    }
    healSessionCollision(chatId) {
        return this.registry.healSessionCollision(chatId);
    }
    /**
     * /new: the registry disposes the agent and retires its session id so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    async resetChat(chatId) {
        await this.registry.resetChat(chatId);
        this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error) => {
            this.deps.log('warn', 'reset notice send failed: ' + String(error));
        });
    }
    /**
     * Compose the QQ channel's scoped world for one agent: the QQ platform
     * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
     * own scope) instead of the plugin context, so Web/local sessions never see
     * the channel instructions or the media tools — they cannot (and should
     * not) push messages to QQ.
     */
    installChannelScope(agentCtx) {
        agentCtx.systemPrompt.section({
            name: 'channel:dsh-onebot',
            order: 90,
            text: buildPlatformPrompt(this.deps.config.restrictedMemberPrefix),
        });
        if (this.mediaGate === undefined) {
            this.mediaGate = new MediaGate({
                ownerId: this.deps.config.ownerQQ,
                voiceCooldownMs: this.deps.config.voiceCooldownMs,
                voiceMaxSeconds: this.deps.config.voiceMaxSeconds,
                imageCooldownMs: this.deps.config.imageCooldownMs,
                imageFreshMs: this.deps.config.imageFreshWindowMs,
                ffprobePath: this.deps.config.ffprobePath,
                log: this.deps.log,
            });
        }
        registerTools(agentCtx, this, this.deps.connection, {
            maxImageBytes: this.deps.config.maxImageBytes,
            maxVoiceBytes: this.deps.config.maxVoiceBytes,
            maxFileBytes: this.deps.config.maxFileBytes,
            gate: this.mediaGate,
        });
    }
    // ------------------------------------------------------------ typing
    /** Start the NapCat typing indicator (private chats only). */
    startTyping(chat) {
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        this.stopTyping(chat);
        const pulse = () => {
            if (this.stopping)
                return;
            void this.guardedConnectionCall('set_input_status', {
                user_id: Number(ref.target),
                event_type: 1,
            }, chat.chatId).catch(() => undefined);
        };
        pulse();
        chat.typingTimer = setInterval(pulse, 5_000).unref();
    }
    /** Stop the typing indicator. */
    stopTyping(chat) {
        if (chat.typingTimer !== undefined) {
            clearInterval(chat.typingTimer);
            chat.typingTimer = undefined;
        }
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        void this.guardedConnectionCall('set_input_status', {
            user_id: Number(ref.target),
            event_type: 0,
        }, chat.chatId).catch(() => undefined);
    }
}
export { OneBotNotConnectedError, OneBotActionError } from './connection.js';
