/**
 * 媒体目录白名单。
 *
 * 插件自己只认 `media\onebot` 下那几条相对目录；本机的表情包目录、画师出图目录
 * 用配置 `mediaFreeDirs` / `mediaDrawDirs` 补，代码里不留机器路径。
 *
 * 这些目录只影响「哪些文件能直接发出去」，不做任何频率/次数限制。
 * @module dsh-onebot/media-dirs
 */

/** 画师作品的落地目录（默认空，用配置 `mediaDrawDirs` 补）。 */
export const DRAW_DIRS = [];

/** 表情包、梗图、别人发来的图。 */
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