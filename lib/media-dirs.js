/**
 * 媒体目录策略：哪些文件能作为消息发出去。
 *
 * 2026-11-14（哥哥 m23555 / m23569）：换判定维度。
 * 原来的模型是「按目录放行」——产物落在哪全靠运气撞进固定目录，自定义事件的产物
 * 一律发不出去。现在改成先看「谁在要」：
 *   - 管理员回合：除了下面那份「绝对不能发」清单，整台机器都能发；
 *   - 非管理员回合：只能发插件的产物目录 + 会话工作区（可关）+ 用户自己加的文件夹。
 * 目录全部推导（`$DSH_HOME`、系统临时目录），代码里不留任何机器路径，别人装上自动对上。
 * @module dsh-onebot/media-dirs
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 画师作品的落地目录（默认空，用配置 `mediaDrawDirs` 补）。 */
export const DRAW_DIRS = [];

/** 插件自己的媒体相对目录（相对 `mediaDir` 的上级；只作兼容保留）。 */
export const FREE_DIRS = [
    'media/onebot/stickers',
    'media/onebot/images',
    'media/onebot/inbound',
];

/** `$DSH_HOME`：跟宿主同一个取法（环境变量优先）。 */
export function dshHomeDir() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}

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

/**
 * 插件和宿主自己会写文件的目录——不用谁配，装好就对上。
 * 生图、搜图、剪帧、下载的素材基本都落在这些地方。
 * @param mediaDir - 插件媒体目录（配置来的，默认 `<dsh-home>/media/onebot`）。
 * @returns 绝对路径数组。
 */
export function productRoots(mediaDir) {
    const home = dshHomeDir();
    const out = [];
    if (typeof mediaDir === 'string' && mediaDir.trim() !== '')
        out.push(mediaDir.trim());
    out.push(
        join(home, 'media'),
        join(home, 'storages'),
        join(home, 'cache'),
        join(home, 'bubble'),
        tmpdir(),
    );
    return out;
}

/** 名字一看就是钥匙的文件（跟目录无关）。 */
const SECRET_NAME = [
    /^\.env(\..*)?$/i,
    /^\.?credentials.*\.(json|ya?ml)$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /\.(pem|p12|pfx|kdbx|key)$/i,
    /^\.npmrc$/i,
    /^\.git-credentials$/i,
];

/** 统一成小写、正斜杠，好比较（Windows 路径两样都认）。 */
function norm(p) {
    return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** `child` 是否在 `root` 里（含 root 自己）。 */
function under(root, child) {
    const r = norm(root);
    const c = norm(child);
    if (r === '' || c === '')
        return false;
    return c === r || c.startsWith(r + '/');
}

/**
 * 命中「绝对不能发」时返回一句给模型看的话，没命中返回 null。
 * 这份清单对管理员也一样生效：白名单里写了也没用。
 * @param realPath - 已经 realpath 过的绝对路径。
 * @returns 拒绝原因，或 null。
 */
export function forbiddenReason(realPath) {
    const raw = String(realPath ?? '');
    if (raw === '')
        return null;
    const home = homedir();
    const dsh = dshHomeDir();
    // 宿主自己的钥匙区
    for (const sub of ['sessions', 'profiles', 'onebot']) {
        if (under(join(dsh, sub), raw))
            return '这个文件属于「绝对不能发」的那类（宿主的会话记录 / 配置 / 令牌），换个文件吧：' + raw;
    }
    // `$DSH_HOME` 根上散着的文件（多半是凭据），产物子目录不受影响
    if (under(dsh, raw) &&
        !under(join(dsh, 'media'), raw) &&
        !under(join(dsh, 'storages'), raw) &&
        !under(join(dsh, 'cache'), raw) &&
        !under(join(dsh, 'bubble'), raw)) {
        const rest = norm(raw).slice(norm(dsh).length).replace(/^\/+/, '');
        if (!rest.includes('/'))
            return '这个文件在宿主根目录里（多半是密钥或令牌），不能发：' + raw;
    }
    // 用户主目录里的钥匙与凭据
    for (const sub of ['.ssh', '.aws', '.gnupg', '.config/gcloud']) {
        if (under(join(home, sub), raw))
            return '这个文件在密钥 / 凭据目录里，不能发：' + raw;
    }
    // AppData 只拦真正存凭据的那几间——系统临时目录就在 AppData\Local\Temp 底下，
    // 一刀切会把「刚生成的图」一起拦掉（2026-11-14 测出来的）。
    for (const sub of [
        'AppData/Roaming/Microsoft/Credentials',
        'AppData/Local/Microsoft/Credentials',
        'AppData/Roaming/Microsoft/Protect',
        'AppData/Local/Microsoft/Protect',
        'AppData/Roaming/Microsoft/Vault',
        'AppData/Local/Microsoft/Vault',
    ]) {
        if (under(join(home, sub), raw))
            return '这个文件在 Windows 的凭据库目录里，不能发：' + raw;
    }
    const name = String(raw).split(/[\\/]/).pop() ?? '';
    for (const re of SECRET_NAME) {
        if (re.test(name))
            return '这种文件名一般是密钥或凭据，不能发：' + raw;
    }
    return null;
}

/**
 * 这回合能发哪些目录。
 * @param options - `{mediaDir, isTurnAdmin, workspace, extraDirs, groupMediaWorkspace}`。
 * @returns `null` 表示「不设目录围栏」（管理员回合，只看 forbiddenReason）；
 *          否则是允许的根列表。
 */
export function sendRootsFor(options) {
    const { mediaDir, isTurnAdmin, workspace, extraDirs, groupMediaWorkspace } = options ?? {};
    if (isTurnAdmin)
        return null;
    const out = productRoots(mediaDir);
    if (groupMediaWorkspace !== false && typeof workspace === 'string' && workspace.trim() !== '')
        out.push(workspace.trim());
    for (const extra of extraDirs ?? []) {
        const p = String(extra ?? '').trim();
        if (p !== '')
            out.push(p);
    }
    return out;
}