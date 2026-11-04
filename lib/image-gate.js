/**
 * 一轮消息里「识图额度」的小状态机：决定哪张图该识别、哪张直接跳过、
 * 什么时候图太多该让模型说「脑子不够用」。
 *
 * 规则：
 * - 只有本鱼要发言的那条消息才建额度（allow=false 时一律不识别）；
 * - @ 场景只认「最后一张」，前面几张标成「先不看了」；
 * - 主动模式/私聊最多认 budget 张，超出就置 overflow，让模型直接认输。
 * @module dsh-onebot/image-gate
 */
/**
 * 建一轮的识图额度。
 * @param options - allow / budget / skipLeading。
 * @returns 可变的额度状态（交给 imageAction 消费）。
 */
export function imageTurn(options) {
    return {
        allow: options.allow === true,
        budget: Math.max(0, Math.floor(options.budget ?? 3)),
        skipLeading: Math.max(0, Math.floor(options.skipLeading ?? 0)),
        used: 0,
        overflow: false,
    };
}
/**
 * 消费一张图的额度。
 * @param turn - imageTurn 建的状态（可为 undefined）。
 * @returns ignore（不识别）/ skip（这张先不看）/ overflow（图太多）/ recognize（去识别）。
 */
export function imageAction(turn) {
    if (turn === undefined || turn.allow !== true)
        return 'ignore';
    if (turn.skipLeading > 0) {
        turn.skipLeading -= 1;
        return 'skip';
    }
    if (turn.used >= turn.budget) {
        turn.overflow = true;
        return 'overflow';
    }
    turn.used += 1;
    return 'recognize';
}
