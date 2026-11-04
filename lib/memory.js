/**
 * 长期记忆的小工具：算路径、截正文。群聊和私聊共用同一套规则。
 * @module dsh-onebot/memory
 */
import { join } from 'node:path';
/**
 * 记忆文件路径（群聊 → groupMemoryDir/<群号>.md；私聊 → privateMemoryDir/<QQ>.md）。
 * @param kind - 'group' / 'private'。
 * @param target - 群号或对方 QQ。
 * @param dirs - 配置里的两个目录。
 * @returns 路径；没配目录或参数不全时返回 ''（= 不做记忆）。
 */
export function memoryPathFor(kind, target, dirs) {
    const dir = kind === 'group' ? dirs?.groupMemoryDir
        : kind === 'private' ? dirs?.privateMemoryDir
            : undefined;
    if (typeof dir !== 'string' || dir === '')
        return '';
    if (typeof target !== 'string' || target === '')
        return '';
    return join(dir, target + '.md');
}
/**
 * 取记忆正文（去掉首尾空白；超长只留尾部，最近的事更重要）。
 * @param text - 文件内容。
 * @param limit - 最多留多少字（默认 2000）。
 * @returns 正文；空内容返回 ''。
 */
export function memoryTail(text, limit = 2000) {
    const trimmed = text.trim();
    return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
}
