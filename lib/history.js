/**
 * 群历史 → 给模型看的短文本：每行「昵称(QQ)：内容」，空消息跳过。
 * 单独成模块，方便不启动连接就能测。
 * @module dsh-onebot/history
 */
import { parseMessage, cqUnescape } from './cq.js';
/**
 * 把 get_group_msg_history 的返回压成若干行。
 * @param messages - 原始消息数组（未知形状按对象处理）。
 * @param limit - 最多保留几条。
 * @param focus - 可选：以某人的发言为主（userId 对上的占 ≥ focus.ratio）。
 * @returns 多行文本；没有可用消息时返回空串。
 */
export function formatGroupHistory(messages, limit, focus) {
    const entries = [];
    for (const item of messages) {
        const msg = item;
        const sender = (msg.sender ?? {});
        const segments = Array.isArray(msg.message) ? msg.message : undefined;
        const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
        const parsed = parseMessage(segments, raw);
        const text = cqUnescape(parsed.text).replace(/\s+/g, ' ').trim();
        if (text === '')
            continue;
        const card = typeof sender.card === 'string' && sender.card !== '' ? sender.card : '';
        const nick = card !== '' ? card
            : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                : String(sender.user_id ?? msg.user_id ?? '');
        const uid = String(sender.user_id ?? msg.user_id ?? '');
        entries.push({
            text: nick + (uid !== '' ? '(' + uid + ')' : '') + '：' + text.slice(0, 80),
            userId: uid,
        });
    }
    let picked = entries;
    const focusId = focus?.userId !== undefined ? String(focus.userId) : '';
    if (focusId !== '') {
        const ratio = Math.min(Math.max(focus.ratio ?? 0.8, 0), 1);
        const focusEntries = entries.filter((entry) => entry.userId === focusId);
        // 对方一句话没说过时，退回完整历史，别让模型两眼一抹黑。
        if (focusEntries.length > 0) {
            // 别人最多占 1-ratio：既不超过窗口配额，也保证对象的占比不低于 ratio。
            const quota = Math.round(limit * (1 - ratio));
            const byRatio = Math.floor((focusEntries.length * (1 - ratio)) / ratio);
            const othersAllowance = Math.max(0, Math.min(quota, byRatio));
            const others = entries.filter((entry) => entry.userId !== focusId).slice(-othersAllowance);
            const keep = new Set([...focusEntries, ...others]);
            picked = entries.filter((entry) => keep.has(entry));
        }
    }
    // limit=0 表示「不要历史」：slice(-0) 等于 slice(0) 会返回全部，得先拦掉。
    if (!(limit > 0))
        return '';
    return picked.slice(-limit).map((entry) => entry.text).join('\n');
}
/**
 * 从群历史里往回找「最近一条带图的消息」，只取一张——被 @ 但本条没带图时用。
 * 有上限：只认 maxAgeMs 内的消息，找到就停，绝不无限往回翻。
 * @param messages - get_group_msg_history 的 messages 数组。
 * @param options - maxAgeMs / now（便于测试）。
 * @returns 图片 ref（最多 1 个），没有则空数组。
 */
export function recentImagesFromHistory(messages, options) {
    const maxAgeMs = options?.maxAgeMs ?? 300_000;
    const now = options?.now ?? Date.now();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i] ?? {};
        const time = Number(msg.time ?? 0) * 1000;
        if (time > 0 && now - time > maxAgeMs)
            continue;
        const segments = Array.isArray(msg.message) ? msg.message : undefined;
        const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
        const images = parseMessage(segments, raw).media.filter(ref => ref.kind === 'image' && String(ref.subType ?? '') !== '1');
        if (images.length > 0)
            return images.slice(0, 1);
    }
    return [];
}
