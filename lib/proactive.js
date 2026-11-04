/**
 * 主动模式（粘人肥鱼）：由 qq_proactive_start 开启，持续 N 分钟（默认 10）。
 * 期间目标用户若 45 秒不回应，就由模型再追一句；最多追 N 次（默认 2 次），
 * 追完或到点后收尾，并把要点写进群记忆文件。
 * @module dsh-onebot/proactive
 */
/** 轮询间隔：5 秒一次，判断是否该追问/收尾。 */
const TICK_MS = 5_000;
export class ProactiveManager {
    /** chatId → 会话状态。 */
    sessions = new Map();
    timer;
    constructor(deps) {
        this.deps = deps;
    }
    /** 主动模式是否启用（时长 > 0）。 */
    get enabled() {
        return (this.deps.config.proactiveDurationMs ?? 0) > 0;
    }
    /**
     * 给某个聊天开启主动模式。
     * @param chatId - 会话 id。
     * @param targetId - 目标用户 QQ。
     * @param targetName - 目标昵称（仅用于提示词）。
     * @param minutes - 自定义时长（分钟）；省略用配置默认值。
     * @returns 会话状态。
     */
    arm(chatId, targetId, targetName, minutes) {
        const now = this.deps.now();
        const durationMs = minutes !== undefined && minutes > 0
            ? minutes * 60_000
            : (this.deps.config.proactiveDurationMs ?? 600_000);
        const state = {
            chatId,
            targetId: targetId === undefined || targetId === null ? '' : String(targetId),
            targetName: targetName ?? '',
            startedAt: now,
            expiresAt: now + durationMs,
            durationMs,
            followUps: 0,
            maxFollowUps: this.deps.config.proactiveMaxFollowUps ?? 2,
            lastBotAt: now,
            lastTargetAt: 0,
        };
        this.sessions.set(chatId, state);
        this.deps.log('info', '主动模式开启 ' + chatId + ' → ' + state.targetName + '(' + state.targetId + ')，'
            + Math.round(durationMs / 60_000) + ' 分钟，最多追 ' + state.maxFollowUps + ' 次');
        return state;
    }
    /** 关闭主动模式（不触发收尾回合）。 */
    disarm(chatId, reason = '手动关闭') {
        const state = this.sessions.get(chatId);
        if (state === undefined)
            return false;
        this.sessions.delete(chatId);
        this.deps.log('info', '主动模式关闭 ' + chatId + '（' + reason + '）');
        this.deps.onClose?.(chatId);
        return true;
    }
    /** 当前聊天是否处于主动模式。 */
    isActive(chatId) {
        return this.sessions.has(chatId);
    }
    /** 当前聊天的主动模式状态（只读）。 */
    stateOf(chatId) {
        return this.sessions.get(chatId);
    }
    /** 目标用户说话了：追聊次数刷新（可以再连续追 maxFollowUps 次），静默计时重来。 */
    noteTarget(chatId, userId) {
        const state = this.sessions.get(chatId);
        if (state === undefined)
            return;
        if (state.targetId !== '' && String(userId) !== state.targetId)
            return;
        state.lastTargetAt = this.deps.now();
        state.followUps = 0;
    }
    /** 本鱼发出一条消息：追问计时从现在起算。 */
    noteBot(chatId) {
        const state = this.sessions.get(chatId);
        if (state !== undefined)
            state.lastBotAt = this.deps.now();
    }
    /** 定时检查：该追问就追问，到点就收尾。 */
    async tick() {
        if (this.deps.isStopping?.() === true)
            return;
        const now = this.deps.now();
        const silenceMs = this.deps.config.proactiveFollowUpMs ?? 30_000;
        for (const [chatId, state] of [...this.sessions]) {
            if (now >= state.expiresAt) {
                this.finish(chatId, state, '时间到了');
                continue;
            }
            // 图片识别/其他长耗时处理期间不插话：等它忙完再说。
            if (this.deps.isBusy?.(chatId) === true)
                continue;
            // 必须安静满一个窗口才动：本鱼刚说完、对方刚说完都不追。
            const silentSinceBot = now - state.lastBotAt >= silenceMs;
            const silentSinceTarget = state.lastTargetAt === 0 || now - state.lastTargetAt >= silenceMs;
            if (!silentSinceBot || !silentSinceTarget)
                continue;
            // 追满之后还要再等一个窗口，给对方回应的时间，再收尾。
            if (state.followUps >= state.maxFollowUps) {
                this.finish(chatId, state, '追问次数用完了');
                continue;
            }
            state.followUps += 1;
            state.lastBotAt = now;
            const who = state.targetName !== '' ? state.targetName + '(' + state.targetId + ')' : state.targetId;
            // 追问前先看看群里最近说了什么：以对象为主（默认 80% 来自对象本人）。
            let history = '';
            try {
                history = (await this.deps.recentHistory?.(chatId, state.targetId)) ?? '';
            }
            catch {
                history = '';
            }
            const context = history !== ''
                ? '[最近群聊：以「' + who + '」的发言为主]\n' + history + '\n[/最近群聊]\n'
                : '';
            const text = context
                + '[主动模式·追问 ' + state.followUps + '/' + state.maxFollowUps + '] '
                + '你正在主动黏着「' + who + '」聊天，对方已经 ' + Math.round(silenceMs / 1000) + ' 秒没回你了。'
                + (history !== '' ? '上面是群里最近的发言，接着他之前的话头说，别复述原话。' : '')
                + '用引用回复再追一次：**最多两句话**、每条 30 字以内；可以撒娇、可以说自己无聊 / 在想他、'
                + '也可以只发一张表情包（配一句很短的话）；别轻易放弃，但也别重复上一句，'
                + '不要提这是任务、系统或主动模式。';
            this.deps.log('info', '主动模式追问 ' + chatId + ' #' + state.followUps);
            this.deps.dispatch(chatId, text, 'admin', '系统');
        }
    }
    /** 收尾：删掉状态并让模型写一条温柔结尾 + 落群记忆。 */
    finish(chatId, state, reason) {
        this.sessions.delete(chatId);
        this.deps.onClose?.(chatId);
        const memory = this.deps.memoryPath?.(chatId) ?? '';
        const who = state.targetName !== '' ? state.targetName : state.targetId;
        const text = '[主动模式·收尾] ' + reason + '（这次黏的是「' + who + '」）。'
            + '先用一句话温柔收尾，不要提任务；'
            + '再把这段聊天里值得记的东西（对方喜好、约定、梗）追加写进群记忆文件：'
            + (memory !== '' ? memory : '（未配置群记忆目录，跳过写文件）');
        this.deps.log('info', '主动模式收尾 ' + chatId + '（' + reason + '）');
        this.deps.dispatch(chatId, text, 'admin', '系统');
    }
    start() {
        if (this.timer !== undefined)
            return;
        this.timer = setInterval(() => {
            void this.tick().catch((error) => this.deps.log('warn', '主动模式 tick 失败: ' + String(error)));
        }, TICK_MS);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.sessions.clear();
    }
}
