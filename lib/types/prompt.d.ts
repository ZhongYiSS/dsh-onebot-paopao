/**
 * System-prompt section for the OneBot channel: platform constraints the
 * model must follow while chatting via QQ. The dsh equivalent of the Hermes
 * platform_hint.
 * @module dsh-onebot/prompt
 */
/**
 * 可选的个人化内容（都由配置注入，代码里不留本机字面量）。
 */
export interface PlatformPromptOptions {
    /** 主人 QQ；空串 = 不提示 @ 主人。 */
    ownerQQ?: string;
    /** 表情包目录；空串 = 不提示表情包目录。 */
    memeDir?: string;
    /** 额外的人设 / 风格补充；空串 = 不加。 */
    promptExtra?: string;
}
/**
 * Build the platform-guidance section text.
 * @param restrictedMembers - whether restricted-member mode is active.
 * @param opts - 个人化内容（promptExtra / memeDir / ownerQQ），默认全空。
 * @returns the section text.
 */
export declare function buildPlatformPrompt(restrictedMembers: boolean, opts?: PlatformPromptOptions): string;
