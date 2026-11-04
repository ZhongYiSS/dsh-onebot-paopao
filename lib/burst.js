/**
 * 连发缓冲：目标用户说话太快（默认 10 秒内超过 3 条）时，先压住不逐条回复，
 * 等他安静 5 秒后把所有消息合并成一轮，一次回完。
 * @module dsh-onebot/burst
 */
export class BurstBuffer {
    /** chatId → { texts, stamps, timer, role } */
    buffers = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    get windowMs() {
        return this.deps.config.burstWindowMs ?? 10_000;
    }
    get threshold() {
        return this.deps.config.burstThreshold ?? 3;
    }
    get waitMs() {
        return this.deps.config.burstWaitMs ?? 5_000;
    }
    /**
     * 收到目标用户一条消息。
     * @returns true = 已压进缓冲（不要立刻回复）；false = 照常立刻回复。
     */
    offer(chatId, text, role, nickname) {
        if (this.waitMs <= 0)
            return false;
        const now = this.deps.now();
        let state = this.buffers.get(chatId);
        if (state === undefined) {
            state = { texts: [], stamps: [], timer: undefined, role, nickname };
            this.buffers.set(chatId, state);
        }
        state.stamps.push(now);
        state.stamps = state.stamps.filter((stamp) => now - stamp <= this.windowMs);
        // 已经在缓冲：追加内容并把 5 秒窗口往后顺延。
        if (state.timer !== undefined) {
            state.texts.push(text);
            state.role = role;
            state.nickname = nickname;
            this.schedule(chatId, state);
            return true;
        }
        // 超过阈值（默认 10 秒内 >3 条）才开始缓冲。
        if (state.stamps.length > this.threshold) {
            state.texts.push(text);
            state.role = role;
            state.nickname = nickname;
            this.schedule(chatId, state);
            this.deps.log('info', '对方连发太快（' + state.stamps.length + ' 条 / ' + Math.round(this.windowMs / 1000) + ' 秒），先压住 5 秒再一起回: ' + chatId);
            return true;
        }
        return false;
    }
    schedule(chatId, state) {
        if (state.timer !== undefined)
            clearTimeout(state.timer);
        state.timer = setTimeout(() => this.flush(chatId), this.waitMs);
        state.timer.unref?.();
    }
    /** 到点：把缓冲的几条合并成一轮交给模型。 */
    flush(chatId) {
        const state = this.buffers.get(chatId);
        this.buffers.delete(chatId);
        if (state === undefined || state.texts.length === 0)
            return;
        const count = state.texts.length;
        const merged = '[对方在 ' + Math.round(this.waitMs / 1000) + ' 秒内连发了 ' + count
            + ' 条，合并成一轮：一次回完，不要逐条回，也不要复述他的原话]'
            + '\n' + state.texts.join('\n');
        this.deps.log('info', '合并连发消息 ' + count + ' 条后一起回复: ' + chatId);
        this.deps.dispatch(chatId, merged, state.role, state.nickname);
    }
    /** 丢掉某个聊天的缓冲（主动模式关闭时用）。 */
    clear(chatId) {
        const state = this.buffers.get(chatId);
        if (state === undefined)
            return false;
        if (state.timer !== undefined)
            clearTimeout(state.timer);
        this.buffers.delete(chatId);
        return true;
    }
    /** 停机：清空所有缓冲。 */
    stop() {
        for (const state of this.buffers.values()) {
            if (state.timer !== undefined)
                clearTimeout(state.timer);
        }
        this.buffers.clear();
    }
}
