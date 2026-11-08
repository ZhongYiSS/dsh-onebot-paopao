import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { sessionIdForChat } from './chat.js';
import { describeError } from './errors.js';
import { validatePinSessionId } from './pin-id.js';
/** The mapping file name inside the media dir. */
const MAPPING_FILE = 'chat-sessions.json';
/** 本鱼补丁（2026-10-29）：钉住「这个聊天接哪个会话」的独立文件。插件从不写它，
 * 所以 saveMapping() 的整表回写冲不掉；手改 chat-sessions.json 则会被内存旧表覆盖。 */
const PINS_FILE = 'chat-session-pins.json';
/** The retired-session-id file name inside the media dir (append-only). */
const RETIRED_FILE = 'retired-sessions.json';
/** The per-chat switchable-session file name inside the media dir. */
const SWITCHABLE_FILE = 'switchable-sessions.json';
/** Per-chat cap of the switchable list (hard-wired; no config surface). */
const SWITCHABLE_CAP = 20;
/** 本鱼补丁（2026-11-04）：resume / 退役 / 新开会话 的真实原因留档文件。
 * 这些 warn 本来只进控制台，重启一次就没了，查「为什么又开了一个会话」时抓瞎。 */
const SESSION_EVENTS_FILE = 'qq-session-events.log';
/** D4b: build one mapping entry — a bare session id when the chat carries no
 * persisted settings (byte-identical to the legacy format), else an object
 * with the optional mode/goal/workspace fields. An empty workspacePath counts
 * as unset (never persisted). */
function persistEntry(sessionId, interimOverride, goal, workspacePath) {
    const ws = workspacePath !== undefined && workspacePath !== '' ? workspacePath : undefined;
    if (interimOverride === undefined && goal === undefined && ws === undefined)
        return sessionId;
    const entry = { session: sessionId };
    if (interimOverride !== undefined)
        entry.interimOverride = interimOverride;
    if (goal !== undefined)
        entry.goal = goal;
    if (ws !== undefined)
        entry.workspacePath = ws;
    return entry;
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(inspection) {
    const events = inspection.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            return event.data.agentPreset;
        }
    }
    return inspection.meta.agentPreset;
}
/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export class ChatRegistry {
    deps;
    /** Live chats by chat id. */
    chats = new Map();
    /** Reverse index: session id → chat id (routes session events to chats). */
    bySession = new Map();
    /** Per-chat settings (workspace/preset/mode/goal/ocr), lazy-created. */
    chatSettings = new Map();
    /** Session ids whose persisted logs are unusable (collision heals, failed
     * resumes, create collisions); creates must avoid them. Deliberately kept
     * apart from retiredSessionIds: /session's soft-retired (switchable) ids
     * land in retiredSessionIds only, so they stay switch-back targets. */
    brokenSessions = new Set();
    /** Session ids retired across restarts (durable copy in retired-sessions.json):
     * both the broken ones and the soft-retired /session switchables. */
    retiredSessionIds = new Set();
    /** Per-chat switchable retired sessions (/session history), newest first. */
    switchableByChat = new Map();
    mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
    mappingLoaded = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
    }
    /** The (lazy-created) settings entry for one chat. */
    getSettings(chatId) {
        let settings = this.chatSettings.get(chatId);
        if (settings === undefined) {
            settings = {};
            this.chatSettings.set(chatId, settings);
        }
        return settings;
    }
    // ------------------------------------------------------------ chat lifecycle
    /** C2: default-model wiring shared by the create and resume assembly paths
     * — agent options for the registry call plus the mutable per-agent
     * selection ref (undefined when the deployment has no default model). */
    modelWiring() {
        const selection = this.deps.defaultModel?.();
        const agentOptions = {};
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
        }
        const selectionRef = selection !== undefined
            ? { current: selection, assembled: undefined }
            : undefined;
        return { agentOptions, selectionRef };
    }
    /** C2: the AgentSetup closure shared by the create and resume assembly
     * paths. The only difference between the callers is the preset: a resumed
     * session rejoins the preset it recorded itself; a fresh create reuses the
     * config/default resolution already recorded in its header meta. */
    buildSetup(selectionRef, recordedPreset) {
        return async (agentCtx) => {
            this.deps.installChannelScope(agentCtx);
            await this.joinPreset(agentCtx, recordedPreset);
            if (selectionRef !== undefined) {
                installModelSelection(agentCtx, selectionRef);
            }
        };
    }
    /** C2: the ChatAgent literal shared by the create and resume assembly
     * paths — every field starts at its neutral initial value. `nickname` is
     * the one deliberate divergence between the callers (create seeds it from
     * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
     * the M2-C2 characterization tests in bridge.spec.ts. */
    createChatAgent(chatId, handle, selectionRef, nickname) {
        return {
            chatId,
            sessionId: handle.agent.session.id,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            lastActivityAt: Date.now(),
            loopPending: null,
            loopBuffer: [],
            recallTimers: new Map(),
            recalledInterimIds: new Set(),
            lastHandledMessageId: undefined,
            busy: false,
            dispatchTimes: [],
            rateLimitNoticeAt: undefined,
            typingTimer: undefined,
            lastNickname: nickname,
            pendingTurnRoles: [],
            activeTurnRole: 'member',
            lastFollowup: undefined,
            selectionRef,
        };
    }
    /** B8a: in-flight creates keyed by chat id — concurrent first messages for
     * one chat join a single create instead of racing (pre-B8a, two dispatches
     * could both pass the empty-map check and agents.create ran twice with the
     * same derived session id; the second chats.set won and the first agent
     * leaked). */
    pendingCreates = new Map();
    /** B8c: chats evicted for idleness, kept resumable (chat id → last session
     * id plus the D4b persisted-settings snapshot, since chatSettings is cleared
     * on eviction). NOT retired: saveMapping keeps writing them, so the mapping
     * file never drops an evicted chat and a later message resumes its session. */
    evictedChats = new Map();
    /** Get (or create) the agent for a chat. */
    async ensureChat(chatId, nickname) {
        const existing = this.chats.get(chatId);
        if (existing !== undefined)
            return existing;
        const pending = this.pendingCreates.get(chatId);
        if (pending !== undefined)
            return pending;
        const creation = this.createChat(chatId, nickname);
        this.pendingCreates.set(chatId, creation);
        void creation.finally(() => {
            this.pendingCreates.delete(chatId);
        }).catch(() => undefined);
        return creation;
    }
    async createChat(chatId, nickname) {
        await this.mappingLoaded;
        // B8c: a chat evicted for idleness resumes its recorded session instead
        // of forking a fresh one — the mapping entry was kept for exactly this.
        const evicted = this.evictedChats.get(chatId);
        if (evicted !== undefined) {
            if (this.isSessionIdBlocked(evicted.session)) {
                // T3: the snapshot records a retired session (resetChat keeps the
                // mapping entry as a settings carrier after /new or a /workspace
                // switch). Resuming it would resurrect retired history — skip the
                // resume, keep the settings, and fall through to a fresh create.
                this.restoreEvictedSettings(chatId, evicted);
                this.evictedChats.delete(chatId);
            }
            else {
                try {
                    const resumed = await this.resumeWithRetry(chatId, evicted.session);
                    // D4b/T3: the evicted chat's persisted mode/goal/workspace come back with it.
                    this.restoreEvictedSettings(chatId, evicted);
                    this.evictedChats.delete(chatId);
                    return resumed;
                }
                catch (error) {
                    this.retireSession(evicted.session);
                    void this.noteSessionEvent('resume-retired', chatId, evicted.session, error);
                    // T3-R2: mirror the blocked-snapshot fast path above — the failed
                    // resume retires the session but must not lose the snapshot's
                    // settings: restore them onto chatSettings so the fresh create
                    // below keys them in (and, if that create also fails, saveMapping's
                    // settings-only fallback keeps writing them under the derived bare id).
                    this.restoreEvictedSettings(chatId, evicted);
                    this.evictedChats.delete(chatId);
                    this.deps.log('warn', 'resume of evicted session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error));
                }
            }
        }
        let sessionId = makeSessionId(sessionIdForChat(chatId));
        if (this.isSessionIdBlocked(sessionId)) {
            sessionId = this.freshSessionId(chatId);
        }
        else if (await this.hasPersistedLog(sessionId)) {
            // The bare id still owns a stale on-disk log (e.g. the retired record
            // was lost in an earlier crash): reusing it would collide, so retire it
            // NOW and move to a suffixed id instead of failing the chat later.
            this.retireSession(sessionId);
            sessionId = this.freshSessionId(chatId);
        }
        // 本鱼补丁（2026-11-04）：新开会话也留个记录，配合 qq-session-events.log
        // 就能看出「这个聊天为什么又从一个新会话开始了」。
        void this.noteSessionEvent('create-fresh', chatId, sessionId, 'no live chat and no resumable session');
        const { agentOptions, selectionRef } = this.modelWiring();
        const cwd = this.effectiveCwd(chatId);
        const presetId = await this.resolvePresetId(chatId);
        const meta = { cwd };
        if (presetId !== undefined)
            meta.agentPreset = presetId;
        const setup = this.buildSetup(selectionRef);
        let handle;
        try {
            handle = await this.deps.agents.create({
                sessionId,
                meta,
                agentOptions,
                setup,
            });
        }
        catch (error) {
            // A stale or foreign persisted log under the same id blocks creation
            // (id collision). Recover with a fresh suffixed session id instead of
            // failing the chat.
            this.retireSession(sessionId);
            const fallbackId = this.freshSessionId(chatId);
            this.deps.log('warn', 'agent create failed (' + describeError(error) + '); retrying with ' + fallbackId);
            handle = await this.deps.agents.create({
                sessionId: fallbackId,
                meta,
                agentOptions,
                setup,
            });
            this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId);
        }
        // The real session id is authoritative (the fallback path above creates a
        // different id than the one initially attempted); record it everywhere so
        // session events route to this chat and the mapping persists the truth.
        const actualSessionId = handle.agent.session.id;
        await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd);
        const chat = this.createChatAgent(chatId, handle, selectionRef, nickname);
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            // B8b: create succeeded but the first idle wait failed — dispose the
            // orphan agent instead of leaking it.
            try {
                await handle.dispose();
            }
            catch {
                // the whenIdle failure is the cause; a dispose failure must not mask it
            }
            throw error;
        }
        this.chats.set(chatId, chat);
        this.bySession.set(actualSessionId, chatId);
        this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')');
        void this.saveMapping();
        return chat;
    }
    /** T3: apply the persisted-settings snapshot (mode/goal/workspace override)
     * of an evicted or reset chat onto its settings entry — shared by the
     * evicted-resume path and its retired-session fast path. */
    restoreEvictedSettings(chatId, evicted) {
        const settings = this.getSettings(chatId);
        if (evicted.interimOverride !== undefined)
            settings.interimOverride = evicted.interimOverride;
        if (evicted.goal !== undefined)
            settings.goal = evicted.goal;
        if (evicted.workspacePath !== undefined && evicted.workspacePath !== '')
            settings.workspacePath = evicted.workspacePath;
    }
    /** Resume persisted chats from the mapping file (best-effort). */
    async loadMapping() {
        try {
            const content = await readFile(this.mappingPath(), 'utf8');
            // D4b/T3: additive format — a legacy entry is a bare session-id string; a
            // new entry is { session, interimOverride?, goal?, workspacePath? }.
            const mapping = JSON.parse(content);
            // 本鱼补丁（2026-10-29）：pins 文件里的「聊天 → 会话」优先于映射表。
            // 只在启动加载时盖一次；插件从不写这个文件，被回写的是映射表本身。
            // 2026-11-08：钉住的会话即使是「退休」状态也照样接回来——显式钉它 =
            // 明确要它，否则重启一次就丢（他私聊就撞上过）。
            const pinnedChats = new Set();
            try {
                const pins = JSON.parse(await readFile(this.pinsPath(), 'utf8'));
                for (const [pinChat, pinSession] of Object.entries(pins)) {
                    if (typeof pinSession !== 'string' || pinSession === '')
                        continue;
                    pinnedChats.add(pinChat);
                    if (this.retiredSessionIds.has(pinSession) || this.brokenSessions.has(pinSession)) {
                        this.unretireSession(pinSession);
                        this.deps.log('info', 'pinned session un-retired: ' + pinChat + ' -> ' + pinSession);
                    }
                    const prev = mapping[pinChat];
                    mapping[pinChat] = typeof prev === 'object' && prev !== null
                        ? { ...prev, session: pinSession }
                        : pinSession;
                    this.deps.log('info', 'chat-session pin applied: ' + pinChat + ' -> ' + pinSession);
                }
            }
            catch {
                // 没有 pins 文件：照常用映射表。
            }
            this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)');
            for (const [chatId, entry] of Object.entries(mapping)) {
                const sessionId = typeof entry === 'string' ? entry : entry?.session;
                if (typeof sessionId !== 'string' || sessionId === '')
                    continue;
                // Restore the persisted mode/goal/workspace override BEFORE the resume
                // attempt (old files carry neither — the settings then fall back to
                // their current defaults). T3: restoring the override first closes the
                // hole where a failed resume (retire → fresh session) lost the
                // per-chat /workspace choice.
                if (typeof entry === 'object' && entry !== null) {
                    const settings = this.getSettings(chatId);
                    if (typeof entry.interimOverride === 'boolean')
                        settings.interimOverride = entry.interimOverride;
                    if (typeof entry.goal === 'string' && entry.goal !== '')
                        settings.goal = entry.goal;
                    if (typeof entry.workspacePath === 'string' && entry.workspacePath !== '')
                        settings.workspacePath = entry.workspacePath;
                }
                // T3: a durably retired session id (recorded by resetChat's settings
                // snapshot) must never be resumed — the entry only carries the
                // settings for the chat's NEXT session. T3-R1 (review closure): keep
                // the object entry in evictedChats so any mid-flight saveMapping
                // (stop(), another chat's createChat) still writes it — a
                // settings-only chat sits in neither chats nor evictedChats, and one
                // dropped save would erase workspacePath/goal/mode from the file
                // before the next restart.
                if (this.retiredSessionIds.has(sessionId)) {
                    this.deps.log('debug', 'skipping resume of retired session ' + sessionId + ' for ' + chatId + ' (settings only)');
                    if (typeof entry === 'object' && entry !== null)
                        this.evictedChats.set(chatId, entry);
                    continue;
                }
                this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId);
                if (this.deps.isStopping())
                    return;
                try {
                    await this.resumeWithRetry(chatId, sessionId);
                }
                catch (error) {
                    // 哥哥 11-08：钉住的是正在 GUI 里开着的那条时，宿主会报
                    // 「already owned by an active write handle」。这不是坏会话，
                    // 绝不能退休（退休后关掉 GUI 也接不回来，他连钉两次都栽在这）。
                    if (this.isInUseElsewhere(error)) {
                        if (typeof entry === 'object' && entry !== null)
                            this.evictedChats.set(chatId, entry);
                        void this.noteSessionEvent('resume-in-use', chatId, sessionId, error);
                        this.deps.log('warn', 'session ' + sessionId + ' 还在别处开着（多半是 GUI），这次先不接 ' + chatId);
                        continue;
                    }
                    this.retireSession(sessionId);
                    void this.noteSessionEvent('resume-retired', chatId, sessionId, error);
                    // T3-R2: mirror the retired-skip branch above — keep the object
                    // entry in evictedChats as a settings carrier so any later
                    // saveMapping keeps writing it (otherwise one dropped save erases
                    // workspacePath/goal/mode from the file before the next restart).
                    if (typeof entry === 'object' && entry !== null)
                        this.evictedChats.set(chatId, entry);
                    this.deps.log('warn', 'resume failed for ' + chatId + ': ' + describeError(error));
                }
            }
        }
        catch {
            // No mapping file yet — fresh start.
        }
    }
    /** Resume one persisted chat from its recorded session id (shared by
     * loadMapping and the B8c evicted-chat resume). */
    async resumeChat(chatId, sessionId) {
        const { agentOptions, selectionRef } = this.modelWiring();
        const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId));
        const handle = await this.deps.agents.resume({
            resumeSessionId: makeSessionId(sessionId),
            agentOptions,
            setup: this.buildSetup(selectionRef, recordedPreset),
        });
        await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd);
        // /workspace persistence across restarts: the per-chat override map is
        // in-memory only, but a session's cwd is frozen in its header. When the
        // resumed session's directory differs from what this chat would default
        // to now, restore it as the override so /workspace and future /new
        // sessions keep using it.
        const headerCwd = handle.agent.session.header?.cwd;
        if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
            this.getSettings(chatId).workspacePath = headerCwd;
            this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd);
        }
        const chat = this.createChatAgent(chatId, handle, selectionRef, '');
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            // B8b: same orphan rule as the create path — dispose before rethrowing.
            try {
                await handle.dispose();
            }
            catch {
                // the whenIdle failure is the cause
            }
            throw error;
        }
        this.chats.set(chatId, chat);
        this.bySession.set(handle.agent.session.id, chatId);
        return chat;
    }
    pinsPath() {
        return this.mappingPath().replace(/chat-sessions\.json$/, PINS_FILE);
    }
    mappingPath() {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + MAPPING_FILE
            : this.deps.config.mediaDir + '/' + MAPPING_FILE;
    }
    /** 本鱼补丁（2026-11-04）：mediaDir 下的文件路径（统一处理末尾分隔符）。 */
    mediaPath(name) {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + name
            : this.deps.config.mediaDir + '/' + name;
    }
    /** 本鱼补丁（2026-11-04）：把「session 事件」按行落到 qq-session-events.log。
     * 记不下来也不影响主流程，所以整段吞掉异常。 */
    async noteSessionEvent(kind, chatId, sessionId, detail) {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            const line = JSON.stringify({
                time: new Date().toISOString(),
                kind,
                chatId,
                sessionId,
                detail: typeof detail === 'string' ? detail : detail === undefined ? undefined : describeError(detail),
            });
            await appendFile(this.mediaPath(SESSION_EVENTS_FILE), line + '\n', 'utf8');
        }
        catch {
            // 日志失败不阻断会话流程
        }
    }
    /** 本鱼补丁（2026-11-04）：resume 带重试。
     * 重启那一刻常是「旧进程还没死透 / 渲染进程刚崩」的状态，一次 resume 失败就
     * retireSession() 会让这个聊天每重启换一个新会话。先让 1.5s、3s 重试两次，
     * 三次都失败才认账；每次失败都写进 qq-session-events.log 留证据。 */
    async resumeWithRetry(chatId, sessionId, attempts = 3) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (this.deps.isStopping())
                break;
            try {
                return await this.resumeChat(chatId, sessionId);
            }
            catch (error) {
                lastError = error;
                await this.noteSessionEvent(attempt === attempts ? 'resume-failed' : 'resume-retry', chatId, sessionId, 'attempt ' + attempt + ': ' + describeError(error));
                if (attempt < attempts)
                    await new Promise(resolve => setTimeout(resolve, attempt * 1500));
            }
        }
        throw lastError ?? new Error('resume aborted');
    }
    /** T3 (hole C): make a just-set /workspace override durable even when the
     * chat is not live (before its first message, or after a failed resume).
     * saveMapping covers chats/evictedChats plus (T3-R2) a settings-only
     * fallback, so the settings survive either way — the snapshot still pins
     * the chat's real mapping session id over the derived bare id. Snapshots
     * the chat into evictedChats under its mapping session id — or the derived bare id
     * when the chat never went live (the resume then fails harmlessly and a
     * fresh session is created with the settings intact). No-op for a live
     * chat: the normal save path covers it. */
    noteWorkspaceOverride(chatId) {
        if (this.chats.has(chatId))
            return;
        const settings = this.chatSettings.get(chatId);
        if (settings === undefined)
            return;
        const workspacePath = settings.workspacePath;
        if (workspacePath === undefined || workspacePath === '')
            return;
        const known = this.evictedChats.get(chatId);
        this.evictedChats.set(chatId, {
            session: known?.session ?? makeSessionId(sessionIdForChat(chatId)),
            interimOverride: settings.interimOverride ?? known?.interimOverride,
            goal: settings.goal ?? known?.goal,
            workspacePath,
        });
    }
    async saveMapping() {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            const mapping = {};
            for (const [chatId, evicted] of this.evictedChats) {
                // T3: prefer the live settings entry over the snapshot — later
                // /mode, /goal or /workspace changes on a not-yet-resumed chat must
                // reach the file (union semantics: a field kept in only one of the
                // two places still survives).
                const live = this.chatSettings.get(chatId);
                mapping[chatId] = persistEntry(evicted.session, live?.interimOverride ?? evicted.interimOverride, live?.goal ?? evicted.goal, live?.workspacePath ?? evicted.workspacePath);
            }
            for (const chat of this.chats.values()) {
                const settings = this.chatSettings.get(chat.chatId);
                mapping[chat.chatId] = persistEntry(chat.sessionId, settings?.interimOverride, settings?.goal, settings?.workspacePath);
            }
            // T3-R2: a chat that sits in neither evictedChats nor chats but owns
            // persisted settings must not be dropped from the file by a save —
            // write it under the noteWorkspaceOverride-derived bare session id,
            // and only when it carries at least one persistable field (no empty
            // placeholder entries).
            for (const [chatId, settings] of this.chatSettings) {
                if (mapping[chatId] !== undefined)
                    continue;
                if (settings.interimOverride === undefined && settings.goal === undefined && (settings.workspacePath === undefined || settings.workspacePath === ''))
                    continue;
                mapping[chatId] = persistEntry(makeSessionId(sessionIdForChat(chatId)), settings.interimOverride, settings.goal, settings.workspacePath);
            }
            await writeFile(this.mappingPath(), JSON.stringify(mapping, null, 2), 'utf8');
        }
        catch (error) {
            this.deps.log('warn', 'mapping save failed: ' + describeError(error));
        }
    }
    saveMappingDebounced() {
        if (this.mappingSaveTimer !== undefined)
            clearTimeout(this.mappingSaveTimer);
        this.mappingSaveTimer = setTimeout(() => {
            this.mappingSaveTimer = undefined;
            void this.saveMapping();
        }, 2_000).unref();
    }
    /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
     * (0 disables; default 7). Called before each inbound message: the session
     * is flushed, the agent disposed, and the chat removed from
     * chats/bySession/settings — NOT retired, the mapping keeps the pair so a
     * later message (or a restart) resumes the same session. */
    async sweepIdleChats() {
        const days = this.deps.config.chatIdleEvictDays ?? 7;
        if (days <= 0 || this.deps.isStopping())
            return;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        for (const [chatId, chat] of [...this.chats]) {
            if (chat.lastActivityAt > cutoff)
                continue;
            await this.evictChat(chatId, chat);
        }
    }
    async evictChat(chatId, chat) {
        // Only evict a session that is durably persisted; a failed flush keeps
        // the chat alive and the sweep retries on the next message.
        try {
            await this.deps.sessions.flush(chat.agent.session);
        }
        catch (error) {
            this.deps.log('warn', 'idle-evict flush failed for ' + chatId + ' (keeping the chat): ' + String(error));
            return;
        }
        this.deps.onChatRemoved(chat);
        this.clearInterimTimers(chat);
        this.chats.delete(chatId);
        this.bySession.delete(chat.sessionId);
        // D4b/T3: snapshot the persisted settings before the eviction clears them,
        // so saveMapping keeps writing the chat's mode/goal/workspace override
        // while it is idle.
        const evictedSettings = this.chatSettings.get(chatId);
        this.evictedChats.set(chatId, {
            session: chat.sessionId,
            interimOverride: evictedSettings?.interimOverride,
            goal: evictedSettings?.goal,
            workspacePath: evictedSettings?.workspacePath,
        });
        this.chatSettings.delete(chatId);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'idle-evict dispose failed: ' + String(error));
        }
        this.deps.log('info', 'evicted idle chat ' + chatId + ' (session ' + chat.sessionId + ' kept resumable)');
    }
    // ------------------------------------------------------------ retired ids
    /** Whether a session id must never be created again (this run or on disk). */
    /** 「会话正被另一个写句柄占着」——典型是 GUI 里开着同一条。
     *  这种不能退休（退休=永久黑名单，关掉那边也接不回来），只是暂时用不了。 */
    isInUseElsewhere(error) {
        return /already owned by an active write handle/i.test(describeError(error));
    }
    isSessionIdBlocked(id) {
        return this.brokenSessions.has(id) || this.retiredSessionIds.has(id);
    }
    /** A suffixed session id for a chat that avoids every blocked id. */
    freshSessionId(chatId) {
        let id;
        do {
            id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36));
        } while (this.isSessionIdBlocked(id));
        return id;
    }
    /** Permanently retire a session id: in-memory plus durable on-disk record,
     * so a restart never reuses an id whose log collides with a fresh session. */
    retireSession(id) {
        this.brokenSessions.add(id);
        this.retiredSessionIds.add(id);
        void this.saveRetired();
    }
    /** Whether the persistence layer already owns a durable log for this id —
     * true means reusing the id would collide (stale on-disk log or live entry).
     * A read failure counts as no log so the caller falls back to the normal
     * path rather than blocking an id on a transient error. */
    async hasPersistedLog(id) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined)
            return false;
        try {
            // 0.1.6 `stat` (the retired `inspect` no longer exists): a snapshot means
            // the id owns a durable log; missing or a read failure counts as no log.
            return (await persistence.stat(id)) !== undefined;
        }
        catch {
            return false;
        }
    }
    retiredPath() {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + RETIRED_FILE
            : this.deps.config.mediaDir + '/' + RETIRED_FILE;
    }
    async loadRetired() {
        let content;
        try {
            content = await readFile(this.retiredPath(), 'utf8');
        }
        catch (error) {
            // Only a missing file means "fresh start". ANY other read failure must
            // not be treated as an empty retired set — a later saveRetired() would
            // then OVERWRITE the on-disk record with nothing, silently dropping
            // every retired id (exactly the 2026-08-17 regression: the bare id
            // lost its retire record and /new collided on the stale log).
            if (error?.code !== 'ENOENT') {
                this.deps.log('warn', 'retired-sessions read failed; keeping the current set: ' + describeError(error));
            }
            return;
        }
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                this.retiredSessionIds = new Set(parsed.filter((id) => typeof id === 'string'));
                // Not backfilled into brokenSessions: the durable file cannot tell a
                // broken id from a soft-retired (/session switchable) one, and the
                // blocked union below already keeps every file id out of the create
                // paths. A genuinely broken id that is somehow targeted after a
                // restart fails inside switchSession's resume and falls back safely.
                this.deps.log('debug', 'retired-sessions file has ' + this.retiredSessionIds.size + ' id(s)');
            }
            else {
                this.deps.log('warn', 'retired-sessions file is not a JSON array; ignoring');
            }
        }
        catch (error) {
            // Corrupt JSON: keep the current in-memory set (never replace it with
            // an empty array) and warn so a future save does not obliterate history.
            this.deps.log('warn', 'retired-sessions file is unparsable; keeping the current set: ' + describeError(error));
        }
    }
    async saveRetired() {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            // Atomic write: a temp file + rename never leaves a half-written file
            // that a concurrent/future loadRetired could parse into a broken empty set.
            // A UNIQUE tmp suffix per call: two concurrent saves sharing one fixed
            // `.tmp` name interleave so the later rename finds its tmp already
            // consumed by the earlier one (ENOENT, web log line 14251).
            const tmpPath = this.retiredPath() + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            await writeFile(tmpPath, JSON.stringify(Array.from(this.retiredSessionIds), null, 2), 'utf8');
            await rename(tmpPath, this.retiredPath());
        }
        catch (error) {
            this.deps.log('warn', 'retired-sessions save failed: ' + describeError(error));
        }
    }
    // ---------------------------------------------------- switchable history
    switchablePath() {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + SWITCHABLE_FILE
            : this.deps.config.mediaDir + '/' + SWITCHABLE_FILE;
    }
    /** Load the per-chat switchable lists from disk (same discipline as
     * loadRetired: only a missing file means "fresh start"; a read failure or
     * corrupt JSON keeps the current in-memory lists so a later save never
     * obliterates them). */
    async loadSwitchable() {
        let content;
        try {
            content = await readFile(this.switchablePath(), 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.deps.log('warn', 'switchable-sessions read failed; keeping the current lists: ' + describeError(error));
            }
            return;
        }
        try {
            const parsed = JSON.parse(content);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const loaded = new Map();
                for (const [chatId, list] of Object.entries(parsed)) {
                    if (!Array.isArray(list))
                        continue;
                    const entries = list.filter((entry) => entry !== null && typeof entry === 'object' &&
                        typeof entry.id === 'string' && typeof entry.retiredAt === 'number');
                    if (entries.length > 0)
                        loaded.set(chatId, entries.slice(0, SWITCHABLE_CAP));
                }
                this.switchableByChat = loaded;
                this.deps.log('debug', 'switchable-sessions file has ' + loaded.size + ' chat(s)');
            }
            else {
                this.deps.log('warn', 'switchable-sessions file is not a JSON object; ignoring');
            }
        }
        catch (error) {
            // Corrupt JSON: keep the current in-memory lists (never replace them
            // with an empty map) and warn so a future save does not drop history.
            this.deps.log('warn', 'switchable-sessions file is unparsable; keeping the current lists: ' + describeError(error));
        }
    }
    /** Atomic write of the switchable lists (temp + rename, like saveRetired). */
    async saveSwitchable() {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            const payload = {};
            for (const [chatId, list] of this.switchableByChat)
                payload[chatId] = list;
            // Unique tmp suffix per call — same concurrent-rename race as saveRetired.
            const tmpPath = this.switchablePath() + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
            await rename(tmpPath, this.switchablePath());
        }
        catch (error) {
            this.deps.log('warn', 'switchable-sessions save failed: ' + describeError(error));
        }
    }
    /** The chat's switchable retired sessions (a copy; newest first). */
    switchableSessions(chatId) {
        return [...(this.switchableByChat.get(chatId) ?? [])];
    }
    /** Record a just-soft-retired session as switchable for its chat: dedupe by
     * id (a later re-retire refreshes retiredAt and moves it to the front),
     * newest first, capped per chat. */
    recordSwitchable(chatId, sessionId) {
        const rest = (this.switchableByChat.get(chatId) ?? []).filter(entry => entry.id !== sessionId);
        this.switchableByChat.set(chatId, [{ id: sessionId, retiredAt: Date.now() }, ...rest].slice(0, SWITCHABLE_CAP));
        void this.saveSwitchable();
    }
    removeSwitchable(chatId, sessionId) {
        const list = this.switchableByChat.get(chatId);
        if (list === undefined)
            return;
        const next = list.filter(entry => entry.id !== sessionId);
        if (next.length === 0)
            this.switchableByChat.delete(chatId);
        else
            this.switchableByChat.set(chatId, next);
        void this.saveSwitchable();
    }
    /** /session switch success: the target session is live again — lift the
     * retired mark (in-memory plus the durable file) so the NORMAL resume paths
     * (restart loadMapping, idle-evict re-activation) keep finding it. The
     * create paths stay protected without the mark: hasPersistedLog catches the
     * target's own log and the create-collision fallback covers the rest. */
    unRetireSession(id) {
        this.brokenSessions.delete(id);
        this.retiredSessionIds.delete(id);
        void this.saveRetired();
    }
    /**
     * /session <序号>: switch a chat back to one of its switchable (soft-retired)
     * sessions. Validation is per-chat (chat A's history is invisible to chat
     * B) and refuses broken ids. With a live chat the current session is
     * soft-retired into the list first (the retire half of resetChat — the
     * settings carrier included — so a failed resume still rebuilds cleanly);
     * with no live chat the switch is carried through evictedChats like
     * noteWorkspaceOverride. On success the target is un-retired and leaves the
     * list (it is the current session); on resume failure the target is
     * hard-retired, dropped from the list, and the chat falls back to a fresh
     * session on its next message — it never gets stuck.
     */
    async switchSession(chatId, targetSessionId) {
        const target = targetSessionId.trim();
        if (!(this.switchableByChat.get(chatId) ?? []).some(entry => entry.id === target)) {
            this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is not in the chat switchable list');
            return { ok: false, reason: 'not-switchable', message: '目标会话不在该 chat 的可切回列表中' };
        }
        if (this.brokenSessions.has(target)) {
            this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is broken');
            return { ok: false, reason: 'broken', message: '目标会话已损坏' };
        }
        const chat = this.chats.get(chatId);
        if (chat !== undefined && chat.busy) {
            return { ok: false, reason: 'busy', message: '当前会话正在生成' };
        }
        if (chat !== undefined) {
            // The retire half of resetChat: keep the settings carrier, then retire
            // the live session as SOFT-retired (switchable, not broken) and record
            // it so the user can switch back later.
            this.snapshotRetainedSettings(chatId, chat.sessionId);
            this.deps.onChatRemoved(chat);
            this.clearInterimTimers(chat);
            this.retiredSessionIds.add(chat.sessionId);
            void this.saveRetired();
            this.recordSwitchable(chatId, chat.sessionId);
            this.chats.delete(chatId);
            this.bySession.delete(chat.sessionId);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'session switch dispose failed: ' + describeError(error));
            }
        }
        else {
            // Chat not live (before its first message / after a failed resume):
            // carry the switch through the evictedChats carrier exactly like
            // noteWorkspaceOverride — saveMapping only writes chats/evictedChats,
            // and the next message's createChat resumes the (un-retired) target
            // from the carrier. On resume failure below the carrier points at the
            // hard-retired target, which the evicted branch skips into a fresh
            // create with the settings intact.
            const settings = this.chatSettings.get(chatId);
            const known = this.evictedChats.get(chatId);
            this.evictedChats.set(chatId, {
                session: target,
                interimOverride: settings?.interimOverride ?? known?.interimOverride,
                goal: settings?.goal ?? known?.goal,
                workspacePath: settings?.workspacePath ?? known?.workspacePath,
            });
        }
        try {
            await this.resumeChat(chatId, target);
        }
        catch (error) {
            // The target's log is unusable: hard-retire it, drop it from the list
            // and let the chat rebuild on a fresh session (never stuck).
            this.retireSession(target);
            this.removeSwitchable(chatId, target);
            void this.saveMapping();
            this.deps.log('warn', 'session switch resume failed for ' + chatId + ' -> ' + target + '; falling back to a fresh session: ' + describeError(error));
            return { ok: false, reason: 'resume-failed', message: describeError(error) };
        }
        this.unRetireSession(target);
        this.removeSwitchable(chatId, target);
        // The live (or just-resumed) chat owns the mapping entry now; drop any
        // stale carrier so it cannot shadow the fresh entry.
        this.evictedChats.delete(chatId);
        void this.saveMapping();
        this.deps.log('info', 'session switch for ' + chatId + ' -> ' + target);
        return { ok: true, sessionId: target };
    }
    /** T3-R1 (review closure): carry the chat's persisted settings across a
     * reset or a collision heal — snapshot them into evictedChats under the
     * (about-to-be-retired) session id, so the trailing saveMapping keeps the
     * entry instead of dropping the chat's workspace/goal/mode on a restart.
     * Only persisted fields trigger the snapshot (a plain /new or heal keeps
     * the exact pre-T3 on-disk behavior: entry dropped); the recorded session
     * id is retired by the caller, so the carrier is never resumed. Shared by
     * resetChat and healSessionCollision — logic frozen to the original
     * resetChat inline snapshot. */
    snapshotRetainedSettings(chatId, sessionId) {
        const settings = this.chatSettings.get(chatId);
        if (settings?.interimOverride !== undefined || settings?.goal !== undefined || (settings?.workspacePath !== undefined && settings?.workspacePath !== '')) {
            this.evictedChats.set(chatId, {
                session: sessionId,
                interimOverride: settings.interimOverride,
                goal: settings.goal,
                workspacePath: settings.workspacePath,
            });
        }
    }
    /**
     * Recover from a session-log collision: the live session cannot append to
     * the mismatched on-disk log, so dispose the agent and rebuild the chat on
     * a fresh session id. The user is asked to resend.
     */
    async healSessionCollision(chatId) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return;
        // T3-R1 (review closure): same settings carrier as resetChat — without
        // the snapshot the trailing saveMapping drops the chat entirely (it sits
        // in neither chats nor evictedChats), losing workspacePath/goal/mode on a
        // restart before the next message. Only persisted fields trigger it.
        this.snapshotRetainedSettings(chatId, chat.sessionId);
        this.retireSession(chat.sessionId);
        // The bare derived id shares the chat's stale log; retire it too so the
        // next ensureChat can never pick it again in this run OR after a restart.
        this.retireSession(sessionIdForChat(chatId));
        this.chats.delete(chatId);
        this.bySession.delete(chat.sessionId);
        this.deps.onChatRemoved(chat);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'collision heal dispose failed: ' + String(error));
        }
        this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message');
        void this.saveMapping();
    }
    // ------------------------------------------------------------ workspace & preset
    /**
     * Effective workspace directory for a chat's sessions: the per-chat
     * /workspace override when set, else the configured workspacePath, falling
     * back to the host process cwd.
     */
    effectiveCwd(chatId) {
        if (chatId !== undefined) {
            const override = this.getSettings(chatId).workspacePath;
            if (override !== undefined && override !== '')
                return override;
        }
        const configured = this.deps.config.workspacePath;
        return configured !== undefined && configured !== '' ? configured : process.cwd();
    }
    /**
     * The preset id a NEW session records and joins: the configured id when set,
     * else the deployment default — the same resolution the Web surface applies,
     * so cross-channel sessions carry the same header fact. A roster that cannot
     * resolve the effective id leaves the header bare and the session uncomposed,
     * exactly like a failed mount.
     */
    async resolvePresetId(chatId) {
        // A /preset override wins for this chat (survives /new, so the re-created
        // session registers the chosen preset in its header).
        const override = chatId !== undefined ? this.getSettings(chatId).presetOverride : undefined;
        if (override !== undefined && override !== '')
            return override;
        const presets = this.deps.agentPresets;
        if (presets === undefined)
            return undefined;
        const configured = this.deps.config.agentPreset;
        const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId;
        try {
            const preset = await presets.resolve(wanted);
            return preset.id;
        }
        catch (error) {
            this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + describeError(error));
            return undefined;
        }
    }
    /**
     * The preset id a persisted session recorded for itself (newest logged
     * selection wins, else the creation header), or undefined when it recorded
     * none or the record cannot be read — a legacy session resumes under the
     * config/default, preserving its original behavior.
     */
    async recordedPresetFor(sessionId) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined)
            return undefined;
        // 0.1.6 has no `inspect`: read the same record through open('read') — the
        // immutable header carries the creation preset, the full event log the
        // newest `agent-preset/selected`. The handle MUST close even on failure
        // (AsyncDisposable — a leaked read handle pins backend resources).
        let handle;
        try {
            handle = await persistence.open(sessionId, 'read');
            return resolveRecordedPreset({
                meta: { agentPreset: handle.header.agentPreset },
                events: (await handle.read()).events,
            });
        }
        catch (error) {
            this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + describeError(error));
            return undefined;
        }
        finally {
            if (handle !== undefined) {
                try {
                    await handle.close();
                }
                catch {
                    // Best-effort teardown: the read outcome above already decided.
                }
            }
        }
    }
    /**
     * Join the QQ agent to the configured agent preset (the deployment default
     * when unset) so its tools/prompt sections/skill catalog resolve against the
     * preset composition instead of the empty global layer. `preferred` — the
     * preset the session itself recorded — overrides the config (its history was
     * produced under that composition; replaying it differently would break the
     * recorded tool calls); a conflicting config only logs. Best-effort: a
     * broken preset falls back to the previous behavior rather than failing the
     * chat.
     */
    async joinPreset(agentCtx, preferred) {
        if (this.deps.agentPresets === undefined)
            return;
        const configured = this.deps.config.agentPreset;
        if (preferred !== undefined && configured !== undefined && configured !== '' && configured !== preferred) {
            this.deps.log('warn', 'session records preset ' + preferred + ' but plugin config names ' + configured + '; resuming under the recorded preset');
        }
        const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined);
        try {
            const preset = await this.deps.agentPresets.mount(agentCtx, selected);
            this.deps.log('debug', 'agent joined preset ' + preset.id);
        }
        catch (error) {
            this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + describeError(error));
        }
    }
    /**
     * Attach a chat session to the workspace owning its header cwd, so QQ
     * sessions group under a workspace in the GUI instead of "Ungrouped".
     * Best-effort: failure only logs.
     *
     * A workspace is auto-created only when the session cwd matches the
     * configured workspacePath (new sessions). A resumed session carrying a
     * foreign cwd (e.g. created under an earlier host cwd) is attached only when
     * a workspace already owns that path — never auto-created, so legacy
     * sessions cannot spawn accidental workspaces.
     */
    async attachToWorkspace(sessionId, headerCwd) {
        const registry = this.deps.workspaceRegistry;
        if (registry === undefined)
            return;
        try {
            if (headerCwd === undefined || headerCwd === '') {
                this.deps.log('warn', 'workspace attach skipped: session header carries no cwd');
                return;
            }
            const workspace = await registry.resolveByPath(headerCwd);
            if (workspace === undefined) {
                if (headerCwd !== this.effectiveCwd()) {
                    this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath');
                    return;
                }
                const created = await registry.create(headerCwd);
                this.deps.log('info', 'created workspace for ' + headerCwd);
                await created.attachSession(sessionId);
                this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd);
                return;
            }
            await workspace.attachSession(sessionId);
            this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd);
        }
        catch (error) {
            this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + describeError(error));
        }
    }
    /**
     * /new: dispose the current chat agent and retire its session id, so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The chat's settings (workspace/preset/mode/
     * goal/ocr) all survive — they key the NEXT session of this chat.
     */
    async resetChat(chatId) {
        const chat = this.chats.get(chatId);
        if (chat !== undefined) {
            // T3 (hole C): keep the mapping entry alive across the reset — without a
            // snapshot the trailing saveMapping drops the chat entirely (it sits in
            // neither chats nor evictedChats), losing the /workspace override (and
            // mode/goal) on any restart before the next message. The retired session
            // id is never resumed: createChat skips blocked snapshots and loadMapping
            // skips durably retired ids. Only persisted fields trigger the snapshot —
            // a plain /new keeps the exact pre-T3 on-disk behavior (entry dropped).
            // T3-R1 (review): the identical snapshot now also covers collision heals.
            this.snapshotRetainedSettings(chatId, chat.sessionId);
            this.deps.onChatRemoved(chat);
            this.clearInterimTimers(chat);
            // SOFT retire (not brokenSessions): the old session's history is
            // intact, and /session must keep it switchable — the durable retired
            // record still keeps the id out of every create path (blocked union).
            this.retiredSessionIds.add(chat.sessionId);
            void this.saveRetired();
            this.recordSwitchable(chatId, chat.sessionId);
            // The bare derived id is forever unsafe for this chat once its history
            // has moved to a suffixed id: its on-disk log (if any) would collide
            // with any future bare-id session. Retire it up front so a /new after a
            // restart — when only the retired file protects us — stays safe.
            // Skipped when it IS the current session (a first-generation /new): the
            // soft retire above already covers it, and a hard retire would mark the
            // chat's own first session broken and un-switchable for /session.
            const bareId = sessionIdForChat(chatId);
            if (bareId !== chat.sessionId)
                this.retireSession(bareId);
            this.chats.delete(chatId);
            this.bySession.delete(chat.sessionId);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'reset dispose failed: ' + describeError(error));
            }
            this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + chat.sessionId + ' retired)');
        }
        void this.saveMapping();
    }
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    async sessionIdFromMapping(chatId) {
        const file = joinMappingPath(this.deps.config.mediaDir);
        try {
            const text = await readFile(file, 'utf8');
            const map = JSON.parse(text);
            const entry = map[chatId];
            const id = typeof entry === 'string' ? entry : entry?.session;
            return typeof id === 'string' && id !== '' ? id : undefined;
        }
        catch {
            return undefined;
        }
    }
    // ------------------------------------------- 会话自选（本鱼补丁 2026-11-08）
    /** 读 pins 文件（「聊天 → 会话」的真相）。坏文件一律当空，不当成错误。 */
    async readPins() {
        try {
            const text = await readFile(this.pinsPath(), 'utf8');
            const parsed = JSON.parse(text);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
    /** 原子写 pins（临时文件 + rename）。Windows 上杀软偶尔占着，隔 120ms 再试一次。 */
    async writePins(pins) {
        await mkdir(this.deps.config.mediaDir, { recursive: true });
        const path = this.pinsPath();
        const tmp = path + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await writeFile(tmp, JSON.stringify(pins, null, 2), 'utf8');
        try {
            await rename(tmp, path);
        }
        catch (error) {
            await new Promise(resolve => setTimeout(resolve, 120));
            try {
                await rename(tmp, path);
            }
            catch (again) {
                void error;
                throw again;
            }
        }
    }
    /** 这个聊天现在接的是哪个会话（活着的 → 快照的 → 映射表的）。 */
    async currentSessionId(chatId) {
        const chat = this.chats.get(chatId);
        if (chat !== undefined)
            return chat.sessionId;
        const evicted = this.evictedChats.get(chatId);
        if (evicted !== undefined && typeof evicted.session === 'string' && evicted.session !== '')
            return evicted.session;
        return await this.sessionIdFromMapping(chatId);
    }
    /** 同一个会话不许被两个聊天占着（两边会各写各的历史）。 */
    ownerOfSession(sessionId) {
        for (const [chatId, chat] of this.chats)
            if (chat.sessionId === sessionId)
                return chatId;
        for (const [chatId, entry] of this.evictedChats)
            if (entry?.session === sessionId)
                return chatId;
        return undefined;
    }
    /** 卸掉一个聊天当前的 agent：不退会话、不删历史，只把「活着的这一份」收掉。 */
    async detachForPin(chat) {
        this.deps.onChatRemoved(chat);
        this.clearInterimTimers(chat);
        this.chats.delete(chat.chatId);
        this.bySession.delete(chat.sessionId);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'pin dispose failed: ' + describeError(error));
        }
    }
    /** 把 pins 恢复成切换前的样子（回滚用）。 */
    async restorePinEntry(chatId, prev) {
        try {
            const pins = await this.readPins();
            if (prev === undefined)
                delete pins[chatId];
            else
                pins[chatId] = prev;
            await this.writePins(pins);
        }
        catch (error) {
            this.deps.log('warn', 'pin rollback failed: ' + describeError(error));
        }
    }
    /** 这个会话在盘上有没有（手填的 id 先验一道，别让 resume 拿个错字开出一张空会话）。 */
    async sessionExists(sessionId) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined) return true;  // 没有读口就交给 resume 判
        let handle;
        try {
            handle = await persistence.open(makeSessionId(sessionId), 'read');
            return true;
        }
        catch {
            return false;
        }
        finally {
            if (handle !== undefined) {
                try {
                    await handle.close();
                }
                catch {
                    // 关不掉不影响判断
                }
            }
        }
    }
    /** 把会话从「退掉 / 坏了」的名单里放回来（显式钉它 = 明确要它）。 */
    unretireSession(id) {
        const had = this.brokenSessions.has(id) || this.retiredSessionIds.has(id);
        this.brokenSessions.delete(id);
        this.retiredSessionIds.delete(id);
        if (had) void this.saveRetired();
        return had;
    }
    /** 换会话（立刻生效）：写 pins → 卸旧 agent → resume 目标；失败就退回原来的。 */
    async pinSession(chatId, rawSessionId) {
        const bad = validatePinSessionId(rawSessionId);
        if (bad !== undefined)
            return { ok: false, reason: 'bad-id', message: bad };
        const target = String(rawSessionId).trim();
        const chat = this.chats.get(chatId);
        if (chat !== undefined && chat.busy)
            return { ok: false, reason: 'busy', message: '这个聊天正在生成回复，先 /stop 再换' };
        if (this.pendingCreates.has(chatId))
            return { ok: false, reason: 'busy', message: '这个聊天正在开新会话，等一秒再换' };
        // 内存里的退休名单可能是旧的（文件被手工清过、或另一个宿主改过）——钉之前重读一次盘
        await this.loadRetired();
        const oldSession = await this.currentSessionId(chatId);
        // 钉的就是现在这条 → 不用卸也不用挂，只把 pins 写上、顺手解掉退休记录
        const alreadyMine = target === oldSession || (chat !== undefined && chat.sessionId === target);
        if (!alreadyMine) {
            if (this.isSessionIdBlocked(target))
                return { ok: false, reason: 'blocked', message: '这个会话被 /new 退掉过或已损坏，接不回来' };
            const owner = this.ownerOfSession(target);
            if (owner !== undefined && owner !== chatId)
                return { ok: false, reason: 'taken', message: '这个会话正被 ' + owner + ' 用着；一个会话只能给一个聊天' };
            if (!(await this.sessionExists(target)))
                return { ok: false, reason: 'not-found', message: '盘上找不到这个会话 id；整串照抄（session- 开头），别漏字符' };
        }
        const before = await this.readPins();
        const prevPin = typeof before[chatId] === 'string' ? before[chatId] : undefined;
        try {
            await this.writePins({ ...before, [chatId]: target });
        }
        catch (error) {
            return { ok: false, reason: 'write-failed', message: '写 pins 失败：' + describeError(error) };
        }
        if (alreadyMine) {
            this.unretireSession(target);
            await this.saveMapping();
            void this.noteSessionEvent('pin-same', chatId, target, '');
            return { ok: true, chatId, sessionId: target, previous: oldSession, unchanged: true };
        }
        const settings = this.getSettings(chatId);
        const carrier = {
            session: target,
            interimOverride: settings.interimOverride,
            goal: settings.goal,
            workspacePath: settings.workspacePath,
        };
        // 先摆好「下一条消息接目标会话」的底：resume 万一失败，它还能兜住
        this.evictedChats.set(chatId, carrier);
        if (chat !== undefined)
            await this.detachForPin(chat);
        try {
            const resumed = await this.resumeWithRetry(chatId, target);
            this.evictedChats.delete(chatId);
            await this.saveMapping();
            void this.noteSessionEvent('pin-switched', chatId, target, oldSession === undefined ? 'from none' : 'from ' + oldSession);
            return { ok: true, chatId, sessionId: resumed.sessionId, previous: oldSession };
        }
        catch (error) {
            this.evictedChats.delete(chatId);
            await this.restorePinEntry(chatId, prevPin);
            void this.noteSessionEvent('pin-failed', chatId, target, error);
            if (this.isInUseElsewhere(error)) {
                return {
                    ok: false,
                    reason: 'in-use',
                    message: '这条会话正开着（GUI 那边在用）。一个会话同时只能有一处写：先把那边关掉再来钉，或者钉另一条。',
                };
            }
            // 把旧会话接回来；接不回来就留成快照，下一条消息自己恢复
            if (typeof oldSession === 'string' && oldSession !== '' && !this.isSessionIdBlocked(oldSession)) {
                this.evictedChats.set(chatId, { ...carrier, session: oldSession });
                try {
                    await this.resumeWithRetry(chatId, oldSession, 1);
                    this.evictedChats.delete(chatId);
                }
                catch {
                    // 留着快照，下一条消息再试
                }
            }
            await this.saveMapping();
            return { ok: false, reason: 'resume-failed', message: '接不上这个会话：' + describeError(error) + '（已退回原来的）' };
        }
    }
    /** 改回自动：只删 pins 里这一条，当前对话不动。 */
    async unpinSession(chatId) {
        const pins = await this.readPins();
        if (!(chatId in pins))
            return { ok: true, removed: false, chatId };
        delete pins[chatId];
        try {
            await this.writePins(pins);
        }
        catch (error) {
            return { ok: false, reason: 'write-failed', message: '写 pins 失败：' + describeError(error) };
        }
        void this.noteSessionEvent('pin-cleared', chatId, '');
        return { ok: true, removed: true, chatId };
    }
    /** 给界面：每个聊天的当前会话 + 钉的会话（一次全给）。 */
    async sessionTable() {
        const pins = await this.readPins();
        const table = {};
        const put = (chatId, patch) => {
            table[chatId] = { ...(table[chatId] ?? {}), ...patch };
        };
        for (const [chatId, pinned] of Object.entries(pins))
            if (typeof pinned === 'string' && pinned !== '')
                put(chatId, { pinned });
        for (const chat of this.chats.values())
            put(chat.chatId, { sessionId: chat.sessionId });
        for (const [chatId, entry] of this.evictedChats)
            if (typeof entry?.session === 'string' && entry.session !== '' && table[chatId]?.sessionId === undefined)
                put(chatId, { sessionId: entry.session });
        for (const chatId of Object.keys(table)) {
            if (table[chatId].sessionId === undefined)
                table[chatId].sessionId = null;
            if (table[chatId].pinned === undefined)
                table[chatId].pinned = null;
        }
        return table;
    }
    /** Clear every pending interim auto-recall timer for a chat (dispose path). */
    clearInterimTimers(chat) {
        for (const timer of chat.recallTimers.values())
            clearTimeout(timer);
        chat.recallTimers.clear();
    }
    /** Stop everything registry-owned: cancel the debounce timer, save the
     * mapping, dispose every agent, clear both indexes. */
    async stop() {
        if (this.mappingSaveTimer !== undefined) {
            clearTimeout(this.mappingSaveTimer);
            this.mappingSaveTimer = undefined;
        }
        await this.saveMapping();
        for (const chat of this.chats.values()) {
            this.deps.onChatRemoved(chat);
            this.clearInterimTimers(chat);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'agent dispose failed: ' + String(error));
            }
        }
        this.chats.clear();
        this.bySession.clear();
    }
}
/** Join the mapping file name onto the media dir (no trailing-separator loss). */
function joinMappingPath(mediaDir) {
    return mediaDir.endsWith('/') || mediaDir.endsWith('\\')
        ? mediaDir + MAPPING_FILE
        : mediaDir + '/' + MAPPING_FILE;
}
