/**
 * 媒体冷却闸：别人找你要语音/图片时排队，免得被榨干。
 *
 * 规则（默认值，都可在设置页改）：
 * - 语音：非主人每人 10 分钟一条，且单条 ≤30 秒；
 * - 图片：**只有叫画师现画的图**才计时（非主人 1 小时一张）；
 *   表情包、梗图、已有旧图、别人发来的图 → 随便发，不计时；
 * - 主人（ownerQQ）不受任何限制；ownerQQ 留空 = 没有主人特权；
 * - 判断不了请求人（主动模式、定时任务）时按主人放行。
 *
 * 目录白名单默认只含插件自己的 media\onebot 那几条；本机的表情包目录、
 * 画师出图目录用配置 `mediaFreeDirs` / `mediaDrawDirs` 补，代码里不留机器路径。
 *
 * 冷却按「请求人 QQ」记，跨会话共用：同一个人在小号和群里一起算。
 * @module dsh-onebot/media-gate
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

export const DEFAULT_VOICE_COOLDOWN_MS = 600_000;
export const DEFAULT_IMAGE_COOLDOWN_MS = 3_600_000;
export const DEFAULT_VOICE_MAX_SECONDS = 30;
/** 新图窗口：非免费目录里、mtime 在这之内的文件算「刚画的」，要计冷却。 */
export const DEFAULT_IMAGE_FRESH_MS = 600_000;
/** 画师作品的落地目录：这里出来的图一定计冷却（默认空，用配置 `mediaDrawDirs` 补）。 */
export const DRAW_DIRS = [];
/** 免费目录：表情包、梗图、别人发来的图——发多少次都不计时。 */
export const FREE_DIRS = [
    'media\\onebot\\stickers',
    'media\\onebot\\images',
    'media\\onebot\\inbound',
];

/**
 * 从配置里取用户自己加的目录（`mediaFreeDirs` / `mediaDrawDirs`）。
 * @param config - 插件配置。
 * @returns 绝对路径数组（空串和空项都丢掉）。
 */
export function mediaExtraDirs(config) {
    const out = [];
    for (const key of ['mediaFreeDirs', 'mediaDrawDirs']) {
        const list = config?.[key];
        if (!Array.isArray(list))
            continue;
        for (const item of list) {
            const p = String(item ?? '').trim();
            if (p !== '')
                out.push(p);
        }
    }
    return out;
}

/** 把剩余毫秒说成人话：8 分钟 / 45 秒。 */
export function formatWait(ms) {
    const total = Math.max(1, Math.ceil(ms / 1000));
    if (total >= 60) {
        const minutes = Math.ceil(total / 60);
        return minutes + ' 分钟';
    }
    return total + ' 秒';
}

function inDirs(path, dirs) {
    const lower = path.toLowerCase();
    return dirs.some((dir) => lower.startsWith(String(dir).toLowerCase()));
}

/**
 * 读 WAV 头算时长（秒）。不是 WAV 或读不出返回 null。
 * @param path - 音频路径。
 */
async function wavSeconds(path) {
    let buf;
    try {
        buf = await readFile(path);
    }
    catch {
        return null;
    }
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
        return null;
    const byteRate = buf.readUInt32LE(28);
    if (!Number.isFinite(byteRate) || byteRate <= 0)
        return null;
    // 找 data chunk，剩下的字节数就是音频数据。
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        if (id === 'data')
            return Math.round((size / byteRate) * 100) / 100;
        offset += 8 + size + (size % 2);
    }
    return null;
}

/** 用 ffprobe 量时长；没有 ffprobe 就返回 null（不拦截）。 */
function ffprobeSeconds(path, ffprobePath) {
    return new Promise((resolve) => {
        execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 5000 }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const value = Number.parseFloat(String(stdout).trim());
            resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null);
        });
    });
}

/**
 * 语音/图片冷却闸。
 */
export class MediaGate {
    constructor(deps) {
        this.deps = deps ?? {};
        this.voiceAt = new Map();
        this.imageAt = new Map();
        this.log = typeof this.deps.log === 'function' ? this.deps.log : () => undefined;
    }

    voiceCooldownMs() {
        return this.deps.voiceCooldownMs ?? DEFAULT_VOICE_COOLDOWN_MS;
    }

    imageCooldownMs() {
        return this.deps.imageCooldownMs ?? DEFAULT_IMAGE_COOLDOWN_MS;
    }

    voiceMaxSeconds() {
        return this.deps.voiceMaxSeconds ?? DEFAULT_VOICE_MAX_SECONDS;
    }

    imageFreshMs() {
        return this.deps.imageFreshMs ?? DEFAULT_IMAGE_FRESH_MS;
    }

    /** 免费目录 = 内置 + 配置 `mediaFreeDirs`。 */
    freeDirs() {
        return [...FREE_DIRS, ...mediaExtraDirs({ mediaFreeDirs: this.deps.freeDirs })];
    }

    /** 画师目录 = 内置 + 配置 `mediaDrawDirs`。 */
    drawDirs() {
        return [...DRAW_DIRS, ...mediaExtraDirs({ mediaDrawDirs: this.deps.drawDirs })];
    }

    /** 请求人算不算主人（空 = 判断不了，按主人算）。 */
    isOwner(requesterId) {
        const owner = String(this.deps.ownerId ?? '');
        const who = String(requesterId ?? '');
        return who === '' || (owner !== '' && who === owner);
    }

    /** 量音频时长（秒），量不出去 null。 */
    async seconds(path) {
        const wav = await wavSeconds(path);
        if (wav !== null)
            return wav;
        const probe = this.deps.ffprobePath;
        if (typeof probe === 'string' && probe !== '')
            return ffprobeSeconds(path, probe);
        return null;
    }

    /**
     * 这张图要不要计冷却（只有画师现画的才算）。
     * - 网络图 / 表情包 / 梗图 / 别人发来的图 → 不计；
     * - 画师输出目录 → 计；
     * - 其它：mtime 在「新图窗口」内的算刚画出来 → 计；旧图 → 不计。
     * @param path - 图片来源（本地路径或 URL）。
     */
    async shouldBillImage(path) {
        const p = String(path ?? '');
        if (p === '')
            return false;
        if (/^https?:/i.test(p))
            return false;
        if (inDirs(p, this.freeDirs()))
            return false;
        if (inDirs(p, this.drawDirs()))
            return true;
        try {
            const info = await stat(p);
            return Date.now() - info.mtimeMs < this.imageFreshMs();
        }
        catch {
            return false;
        }
    }

    /**
     * 记一条语音；不放行就抛错（错误消息直接给模型看）。
     * @param requesterId - 请求人 QQ。
     * @param seconds - 时长（秒），null = 没量出来（跳过时长检查）。
     */
    takeVoice(requesterId, seconds) {
        if (this.isOwner(requesterId))
            return { ok: true, bypass: true };
        const maxSeconds = this.voiceMaxSeconds();
        if (maxSeconds > 0 && typeof seconds === 'number' && seconds > maxSeconds) {
            throw new Error('语音太长：' + seconds + ' 秒，超过 ' + maxSeconds + ' 秒上限（别人的语音限 ' + maxSeconds + ' 秒，主人不受限）');
        }
        const cooldown = this.voiceCooldownMs();
        const now = Date.now();
        const last = this.voiceAt.get(String(requesterId)) ?? 0;
        const remain = cooldown - (now - last);
        if (cooldown > 0 && remain > 0) {
            throw new Error('语音冷却中：' + requesterId + ' 还要等 ' + formatWait(remain) + '（别人 ' + formatWait(cooldown) + '一条，主人不受限）');
        }
        this.voiceAt.set(String(requesterId), now);
        this.log('info', '语音放行: ' + requesterId + (typeof seconds === 'number' ? ' ' + seconds + 's' : ''));
        return { ok: true };
    }

    /**
     * 记一张图；只有「画师现画的」才走冷却，表情包/旧图直接放行。
     * @param requesterId - 请求人 QQ。
     * @param path - 图片来源（用来判断要不要计时）。
     */
    async takeImage(requesterId, path) {
        if (this.isOwner(requesterId))
            return { ok: true, bypass: true };
        if (!(await this.shouldBillImage(path)))
            return { ok: true, free: true };
        const cooldown = this.imageCooldownMs();
        const now = Date.now();
        const last = this.imageAt.get(String(requesterId)) ?? 0;
        const remain = cooldown - (now - last);
        if (cooldown > 0 && remain > 0) {
            throw new Error('画图冷却中：' + requesterId + ' 还要等 ' + formatWait(remain) + '（别人 ' + formatWait(cooldown) + ' 才能再点一张画；表情包和旧图不受限，主人不受限）');
        }
        this.imageAt.set(String(requesterId), now);
        this.log('info', '画图放行: ' + requesterId + ' ' + String(path ?? ''));
        return { ok: true };
    }
}
