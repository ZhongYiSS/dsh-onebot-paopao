/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
// R1 部署加固：peer 依赖解析失败/关键模块缺失时必须显眼报错并 fail-loud，
// 不能静默不挂载。静态 import 会在本模块任何代码运行之前就以晦涩的
// ERR_MODULE_NOT_FOUND 失败（宿主侧表现为插件被静默跳过），因此运行时
// 值依赖改为入口顶部受控动态加载：失败时先输出含「peer/依赖」的显式
// 错误，再把原错误抛出。
let z;
let OneBotConnection;
let ChatBridge;
let MediaStore;
let IMAGE_MAX_BYTES;
let VOICE_MAX_BYTES;
let MEDIA_MAX_BYTES;
let Transcriber;
import { buildLaunchCommand, buildVbsScript, detectBotQQ, parseTasklist, qrInfo, qrPath, resolveNapcatDir } from './napcat.js';
let TraceSink;
let InboundRecorder;
let InjectChannel;
let redactSnapshot;
let describeError;
try {
    ;
    ({ default: z } = await import('@deepseek-ai/schemastery'));
    ({ OneBotConnection } = await import('./connection.js'));
    ({ ChatBridge } = await import('./bridge.js'));
    ({ MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } = await import('./media.js'));
    ({ Transcriber } = await import('./stt.js'));
    ({ TraceSink } = await import('./trace.js'));
    ({ InboundRecorder } = await import('./record.js'));
    ({ InjectChannel } = await import('./inject.js'));
    ({ redactSnapshot } = await import('./health.js'));
    ({ describeError } = await import('./errors.js'));
}
catch (error) {
    console.error('[dsh-onebot] 挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集（scripts/link-host.sh 产物），只复制 lib/ 不够。原始错误：' + (error instanceof Error ? error.message : String(error)));
    throw error;
}
export const name = 'dsh-onebot';
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry', 'commands', 'llm', 'webServer'];

import { mountCompanion } from './companion/app.mjs';
import { cardSegments } from './card.js';
const ENV = (name) => process.env[name] ?? '';
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir() {
    // os.homedir() reads $HOME first and falls back to the passwd entry — the
    // systemd service runs without HOME, so `?? '/tmp'` used to resolve to
    // /tmp/.dsh and preset enumeration hit ENOENT (web log line 14429).
    const home = ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
    return join(home, 'media', 'onebot');
}
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome() {
    return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
}
/** D4a: schema defaults for the renamed fields (referenced by the deprecated-name fallback). */
const INBOUND_IMAGE_MAX_PX = 2048;
const OUTBOUND_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const Config = z.object({
    mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse')
        .description('连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务'),
    host: z.string().default('127.0.0.1')
        .description('reverse 模式监听地址；跨机部署（NapCat 从其他机器拨入）需显式改为 0.0.0.0'),
    port: z.number().default(8643)
        .description('reverse 模式监听端口'),
    url: z.string().default('ws://127.0.0.1:3001')
        .description('forward 模式的 NapCat ws 地址'),
    accessToken: z.string().role('secret').default('')
        .description('OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer）'),
    napcatDir: z.string().default('').description('NapCat 的安装目录（含 launcher.bat）；填了设置页才有「启动 / 重启 / 看二维码」'),
    napcatQuickLogin: z.boolean().default(true).description('启动时带 -q <botQQ> 试快速登录（免扫码）；失败可在 NapCat 里扫码'),
    napcatAutoStart: z.boolean().default(false)
        .description('打开 DSH 就自动拉起 NapCat（等于免扫码登录 QQ）。关着就一个字不碰，要用时在设置页点「启动 NapCat」'),
    napcatAutoRestart: z.boolean().default(false)
        .description('NapCat 掉了自动拉回来，不用手点重启（扫码后不用再点一次就是靠它）'),
    reconnectMaxAttempts: z.number().default(100)
        .description('forward 模式重连上限：连续失败达到该次数后放弃重连并打印恢复指引；0 = 无限重试（退避间隔封顶 60s）'),
    botQQ: z.string().default('')
        .description('机器人自身 QQ 号；留空则从 meta 事件自动学习'),
    ownerQQ: z.string().default('')
        .description('主人的 QQ 号（留空 = 没有主人特权，也不提示 @ 主人）：群里有人 @ 主人时也会接话；语音/画图冷却对主人豁免'),
    memeDir: z.string().default('')
        .description('表情包目录（留空 = 不提示表情包）：提示词会列出里面的文件名，模型用 qq_send_image 按文件名发'),
    promptExtra: z.string().default('')
        .description('追加到 QQ 平台说明后面的人设/风格补充（留空 = 不加）；想改角色设定就写这里，别改代码'),
    mediaFreeDirs: z.array(z.string()).default([])
        .description('额外的「免费目录」（发图不计画图冷却、也加进发图白名单）：表情包、唱好的歌之类，绝对路径'),
    mediaDrawDirs: z.array(z.string()).default([])
        .description('额外的「画师出图目录」（从这里出来的图一定计冷却），绝对路径'),
    voiceCooldownMs: z.number().default(600_000)
        .description('非主人的语音冷却（毫秒，默认 600000 = 10 分钟一条）；0 = 不限'),
    voiceMaxSeconds: z.number().default(30)
        .description('非主人单条语音的时长上限（秒，默认 30）；0 = 不限'),
    imageCooldownMs: z.number().default(3_600_000)
        .description('非主人「叫画师现画一张图」的冷却（毫秒，默认 3600000 = 1 小时一张）；表情包/梗图/旧图不计时；0 = 不限'),
    imageFreshWindowMs: z.number().default(600_000)
        .description('非画师目录里、修改时间在这之内的图片算「刚画的」、要计冷却（毫秒，默认 600000 = 10 分钟）'),
    requireMention: z.boolean().default(true)
        .description('群聊是否仅在 @机器人（或被 @ 的主人、或回复其消息）时响应'),
    groupKeywords: z.array(z.string()).default([])
        .description('群聊关键词触发：消息里只要出现任意一个词，即使没 @ 机器人也主动回；空数组 = 关闭'),
    groupKeywordCooldownMs: z.number().default(120_000)
        .description('群聊关键词触发的冷却时间（毫秒，默认 120000 = 同一个群最多两分钟主动回一次）'),
    memeChance: z.number().min(0).max(1).default(0.33)
        .description('每轮发表情包的概率（11-04 加，默认 0.33）：插件每轮掷一次骰，结果写进本轮提示，模型只照标记执行'),
    voiceChance: z.number().min(0).max(1).default(0.1)
        .description('每轮发语音的概率（11-04 加，默认 0.1）：掷到之后还要本地服务在线才发'),
    voiceGateHost: z.string().default('127.0.0.1')
        .description('语音掷骰时探测的本地服务地址（默认 127.0.0.1）'),
    voiceGatePort: z.number().default(9880)
        .description('语音掷骰时探测的本地服务端口（默认 9880 = 嗓子）；连不上这轮就不发语音'),
    debounceMs: z.number().default(2000)
        .description('11-04：消息过完所有闸门后先等这么久（毫秒，默认 2000）再进会话；期间每来一条合规消息就重新计时，安静满这个时长才把期间的全部消息合并成一轮（0 = 关闭，即刻进会话）'),
    debounceMaxMs: z.number().default(20_000)
        .description('防抖合并的硬上限（毫秒，默认 20000）：一直有消息进来也不会无限往后拖，到点就一起发'),
    debounceMaxParts: z.number().default(30)
        .description('一个防抖窗最多合并多少条消息（默认 30，超出丢最早的）'),
    debounceBusyWait: z.boolean().default(true)
        .description('11-04 排队 B（默认开）：这一轮还在跑时不插话，把合并窗攒到它空闲再整把派发；关掉就回到「忙时按 steer/queue 策略即刻处理」'),
    debounceBusyMaxMs: z.number().default(120_000)
        .description('排队 B 最多为一轮让路多久（毫秒，默认 120000 = 2 分钟）：超时就不管它忙不忙，整把交出去'),
    probableKeywords: z.array(z.object({ word: z.string(), ratio: z.number().min(0).max(1) })).default([])
        .description('概率关键词触发（10-31 加）：消息里出现这个词后本地掷骰，小于 ratio 才接话（如「大肥鱼」配 0.5 = 一半概率回）；与 groupKeywords 共用每群冷却'),
    openChatMaxMs: z.number().default(1_200_000)
        .description('「随意聊聊」窗口的时长上限（毫秒，默认 1200000 = 20 分钟）'),
    openChatDefaultMs: z.number().default(600_000)
        .description('「随意聊聊」窗口的缺省时长（毫秒，默认 600000 = 10 分钟）：管理员发「随意聊聊」不带时间就用它'),
    steerNoticeEnabled: z.boolean().default(false)
        .description('自动插话（steer）提交成功后是否发「✅ 已提交」提示；默认关（跟排队提示一个规矩），手动 /steer 不受影响'),
    proactiveDurationMs: z.number().default(600_000)
        .description('主动模式默认时长（毫秒，默认 600000 = 10 分钟）；<=0 关闭主动模式'),
    proactiveFollowUpMs: z.number().default(45_000)
        .description('主动模式里对方多久不回就再追一句（毫秒，默认 45000 = 45 秒）'),
    proactiveMaxFollowUps: z.number().default(2)
        .description('主动模式最多追几次（默认 2 次，追完就收尾）'),
    proactiveImageThreshold: z.number().default(200)
        .description('主动模式下的图片卡片阈值（字符数，默认 200）：正文超过它才转图片，否则拆成多条纯文本'),
    proactiveChunkChars: z.number().default(30)
        .description('主动模式下每条纯文本的目标字数（默认 30）：按句子切，句子不切断'),
    cardChunkChars: z.number().default(500)
        .description('文字图片卡片每张最多多少字（默认 500）：超过就切成多张卡片'),
    groupMemoryDir: z.string().default('')
        .description('群聊长期记忆目录（每个群一个 <群号>.md；留空 = 不做群记忆）'),
    privateMemoryDir: z.string().default('')
        .description('私聊长期记忆目录（每个对象一个 <QQ>.md；留空 = 不做私聊记忆）'),
    burstWindowMs: z.number().default(10_000)
        .description('连发窗口（毫秒，默认 10000）：主动模式下目标用户在这个时间窗内的消息计入连发判断'),
    burstThreshold: z.number().default(3)
        .description('连发条数阈值（默认 3）：窗口内超过这个条数就开始压住、合并回复'),
    burstWaitMs: z.number().default(5_000)
        .description('压住后等多久再一起回（毫秒，默认 5000）；等待期间他再发会自动顺延；0 = 关闭连发缓冲'),
    maxMessageParts: z.number().default(3)
        .description('长文本最多拆成几条发（默认 3）；超出的并进最后一条；0 = 不限制'),
    mentionHistoryCount: z.number().default(10)
        .description('群里被 @ 时自动补多少条最近群聊上下文（默认 10；0 = 不补）'),
    historyFocusRatio: z.number().default(0.8)
        .description('主动模式追问时，历史上下文里目标对象发言的最低占比（默认 0.8 = 80%）'),
    autoOcr: z.boolean().default(true)
        .description('收到图片自动 OCR（NapCat 的 ocr_image），把图里的字附在 [图片:路径] 后面（默认开）'),
    visionModel: z.string().default('')
        .description('视觉模型名（OpenAI 兼容接口，如 gpt-4o-mini / qwen-vl-max）；留空则只用 OCR'),
    visionBaseUrl: z.string().default('')
        .description('视觉模型的 baseURL；留空 = 不启用云端识图'),
    visionApiKeyEnv: z.string().default('')
        .description('视觉模型 key 所在的环境变量名（或 DSH 凭证名）；留空 = 不启用云端识图'),
    visionMinOcrChars: z.number().default(6)
        .description('OCR 认出多少字就算够用、不再叫视觉模型（默认 6 字）'),
    visionFallbackModel: z.string().default('')
        .description('备用视觉模型名（主模型没开/失败时才用，如云端 gpt-6-luna）；留空 = 不兜底'),
    visionFallbackBaseUrl: z.string().default('')
        .description('备用视觉模型的 baseURL；留空 = 不配备用'),
    visionFallbackApiKeyEnv: z.string().default('')
        .description('备用视觉模型 key 的环境变量名；留空 = 不配备用'),
    visionTimeoutMs: z.number().default(40_000)
        .description('视觉模型超时（毫秒，默认 40000）；超时就只用 OCR 结果'),
    videoVisionModel: z.string().default('')
        .description('看视频用的视觉模型（留空 = 看视频不可用，必须自己填；填了就一直用它，别在代码里默认换）'),
    videoVisionBaseUrl: z.string().default('')
        .description('看视频的视觉模型网关（留空 = 跟识图共用 visionBaseUrl）'),
    videoVisionApiKeyEnv: z.string().default('')
        .description('看视频的视觉模型 key 所在凭证名（留空 = 跟识图共用）'),
    videoVisionFallbackModel: z.string().default('')
        .description('看视频的备选视觉模型（主模型空正文时才用；留空 = 不兜底）'),
    videoVisionFallbackBaseUrl: z.string().default('')
        .description('备选视觉模型网关；留空 = 跟主模型同一个'),
    videoVisionFallbackApiKeyEnv: z.string().default('')
        .description('备选视觉模型凭证名；留空 = 跟主模型同一个'),
    videoVisionMaxTokens: z.number().default(8_000)
        .description('看视频时单张图给多少 token（先想再说的模型要给足，默认 8000）'),
    videoVisionTimeoutMs: z.number().default(180_000)
        .description('看视频时单张图的超时（毫秒，默认 180000）'),
    videoGrids: z.number().default(5)
        .description('平时看视频拼几张九宫格（默认 3）'),
    videoFrames: z.number().default(2)
        .description('平时看视频额外抠几张单帧（默认 2）'),
    videoDeepGrids: z.number().default(10)
        .description('「仔细看看」时拼几张九宫格（默认 6，最多 10）'),
    videoDeepFrames: z.number().default(4)
        .description('「仔细看看」时额外抠几张单帧（默认 4）'),
    videoCacheDays: z.number().default(7)
        .description('看视频证据缓存几天（默认 7）；0 = 不缓存'),
    videoWorkDays: z.number().default(15)
        .description('视频工作目录（视频文件/抽帧）留几天，过了自动清（默认 15）'),
    videoAsr: z.boolean().default(true)
        .description('没有字幕轨的视频，用本机 whisper 转声音（默认开；最长只转前 videoAsrMaxSec 秒）'),
    videoAsrMaxSec: z.number().default(300)
        .description('声音转写最多转多少秒（默认 300；一秒钟音频约 0.3 秒 CPU）'),
    maxImagesPerTurn: z.number().default(3)
        .description('一轮最多识别几张图（主动模式/私聊，默认 3）；超过就不认，直接说脑子不够用'),
    mentionMaxImages: z.number().default(1)
        .description('被 @ 时最多识别几张图（默认 1 = 只看最后一张）'),
    recentImageLookback: z.number().default(3)
        .description('被 @ 但本条没带图时，往回看几条消息找图（默认 3，最多 10）'),
    recentImageMaxAgeMs: z.number().default(300_000)
        .description('回看找图的时间上限（毫秒，默认 5 分钟），超过就不认'),
    unknownCommand: z.union([z.const('intercept'), z.const('passthrough')]).default('intercept')
        .description('未知斜杠命令处理：intercept（默认）=拦截并提示相近命令或 /help；passthrough=透传给模型（旧行为）'),
    newMessagePolicy: z.union([z.const('queue'), z.const('steer')]).default('queue')
        .description('任务运行中的新消息处理策略（P1）：queue（默认）=排队——新消息在当前任务结束后按序处理为后续回合，等待期间至多提示一次；steer=插话——运行中收到的新普通纯文字消息作为补充指令加入当前任务（模型在下一步读取）并回复提交提示；图片/文件/语音/带引用消息与 [受限用户:仅问答] 消息两种模式下都按排队处理，/steer 命令两种模式下均可用'),
    autoSteerPolicy: z.union([z.const('admin'), z.const('all')]).default('admin')
        .description('steer 模式下自动插话的发送者资格（T9-B 用户裁决 2026-10-12）：admin（默认）=仅管理员可自动插话；all=所有非受限发送者均可。不具备资格的消息按排队处理；/steer 命令始终仅管理员、不受本项影响；queue 模式行为不变'),
    deferredTimeoutMs: z.number().default(600_000)
        .description('等待模型回复超时阈值（毫秒，T3/P2 超时补发）：回合超过该时长没有任何模型输出时提示超时并登记补发跟踪，任务完成后向原聊天自动补发最终文字（走既有出站管线）；发送明确失败最多尝试 3 次（退避），结果不确定时保留记录停止自动重试；/stop 终止该聊天的补发跟踪；0=关闭超时补发'),
    dmPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('私聊策略：open=仅管理员；allowlist=仅 allowFrom；disabled=拒绝所有私聊'),
    groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('群聊策略：open=所有群；allowlist=仅 groupAllowFrom；disabled=拒绝所有群'),
    allowFrom: z.array(z.string()).default([])
        .description('dmPolicy=allowlist 时允许私聊的 QQ 号'),
    groupAllowFrom: z.array(z.string()).default([])
        .description('groupPolicy=allowlist 时允许的群号'),
    adminUsers: z.array(z.string()).default([])
        .description('管理员 QQ 号（也可用环境变量 ONEBOT_ALLOWED_USERS 逗号分隔指定）'),
    allowAllUsers: z.boolean().default(false)
        .description('放行所有用户（仅开发用；也可用 ONEBOT_ALLOW_ALL_USERS=true）'),
    ignoreSelf: z.boolean().default(true)
        .description('忽略机器人自己发出的消息（防自循环）'),
    interimMessages: z.boolean().default(true)
        .description('是否把模型每步（含工具调用之间的中间回复）的文本立即发出；false 则只发最终回复。true 时：中间消息实时可见、每条在 interimRecallMs 后自动单独撤回、回合结束先发一张整轮 t2i 小结卡再发最终回复'),
    interimRecallMs: z.number().default(90_000)
        .description('中间消息各自发送完成后多久自动单独撤回（毫秒；QQ 撤回时限约 2 分钟，建议 ≤110000）'),
    interimRecall: z.boolean().default(true)
        .description('中间消息撤回开关：true（默认）=每条中间消息在 interimRecallMs 后自动撤回，回合结束先发整轮 t2i 小结卡再立即撤回原消息；false=只发不撤——中间消息照常实时发出但保留在聊天里：不排自动撤回定时器、回合结束不发小结卡也不撤回原消息，只发最终回复'),
    sendErrorNotice: z.boolean().default(true)
        .description('一轮运行出错时向用户发送 ⚠️ 错误提示'),
    rateLimitPerMinute: z.number().default(30)
        .description('每 chat 每分钟允许的普通消息条数上限（60 秒滑动窗口）；命令消息不计入也不受限；超限时每窗口最多提示一次；0=禁用频控'),
    restrictedMemberPrefix: z.boolean().default(true)
        .description('群聊非管理员消息注入 [受限用户:仅问答] 前缀（软限制）'),
    sensitivePatterns: z.array(z.string()).default([])
        .description('出站敏感内容审计正则（默认内置 rm -rf/关机/删库/密钥 等模式；留空用默认）'),
    mediaDir: z.string().default('')
        .description('入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot'),
    tempTtlHours: z.number().default(6)
        .description('入站临时媒体文件保留时长（小时），到期自动清理'),
    outboundImageMaxBytes: z.number().default(OUTBOUND_IMAGE_MAX_BYTES)
        .description('出站图片大小上限（字节）'),
    maxImageBytes: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 outboundImageMaxBytes）：出站图片大小上限（字节）；本版兼容读取，新配置请用新名'),
    inboundImageMaxPx: z.number().default(INBOUND_IMAGE_MAX_PX)
        .description('入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用'),
    imageMaxSize: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 inboundImageMaxPx）：入站图片长边上限（像素）；本版兼容读取，新配置请用新名'),
    maxVoiceBytes: z.number().default(VOICE_MAX_BYTES)
        .description('出站语音大小上限（字节）'),
    maxFileBytes: z.number().default(MEDIA_MAX_BYTES)
        .description('出站视频/文件大小上限（字节）'),
    sttEnabled: z.boolean().default(true)
        .description('入站语音是否转写（需要 ffmpeg 和 whisper CLI；失败时降级为 [语音] 占位）'),
    sttEngine: z.union([z.const('auto'), z.const('openai'), z.const('whisper-cpp'), z.const('custom')]).default('auto')
        .description('STT 引擎：auto 自动探测 whisper-cli / whisper / mlx_whisper'),
    sttCommand: z.string().default('')
        .description('custom 引擎的程序名/路径'),
    sttArgs: z.array(z.string()).default([])
        .description('custom 引擎参数模板，{file} 与 {out} 会被替换'),
    sttModel: z.string().default('small')
        .description('whisper 模型（openai: small/base/medium...；whisper.cpp: 模型名或 .bin 绝对路径）'),
    sttTimeoutMs: z.number().default(60_000)
        .description('单次转写超时（毫秒，默认 60000）；超时后占位即终态，不追加转写'),
    textImageThreshold: z.number().default(150)
        .description('回复正文超过该长度（字符数）时渲染为文字图卡片发送；<=0 禁用卡片路径'),
    cardFooter: z.string().default('dsh')
        .description('文字图卡片页脚品牌文字（"Powered by <brand>"）'),
    fontFiles: z.array(z.string()).default([])
        .description('t2i 渲染器注册的字体文件路径（Linux/自定义字体；macOS 自动用系统字体）'),
    fontFamilies: z.array(z.string()).default([])
        .description('t2i 渲染器优先使用的字体家族名（覆盖平台默认）'),
    agentPreset: z.string().default('')
        .description('QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设'),
    workspacePath: z.string().default('')
        .description('QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空时使用宿主进程工作目录并在启动时告警提醒（宿主未提供可编程查询的默认工作区），单聊 /workspace 覆盖优先且已持久化到会话映射文件，重启/恢复失败均不丢失'),
    inboundFileMaxBytes: z.number().default(INBOUND_FILE_MAX_BYTES)
        .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
    maxInboundFileBytes: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 inboundFileMaxBytes）：QQ 入站文件最大字节数；本版兼容读取，新配置请用新名'),
    allowPrivateHosts: z.boolean().default(false)
        .description('下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查'),
    chatIdleEvictDays: z.number().default(7)
        .description('会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用'),
    dedupWindowSeconds: z.number().default(300)
        .description('入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；0 = 禁用去重'),
    actionRatePerMinute: z.number().default(20)
        .description('主动写操作每分钟全桥合计上限（W2-③）：约束 qq_send_image/voice/video/file/segments 与 qq_send_forward 等工具发起的主动发送（回合内的被动回复/interim/通知不受此闸，由 rateLimitPerMinute 与离线队列上限约束）；超限拒发并记 warn 与审计；0 = 禁用分钟限额'),
    actionRatePerDay: z.number().default(500)
        .description('主动写操作每日（本地自然日）全桥合计上限（W2-③）：口径同 actionRatePerMinute；超限拒发并记 warn 与审计，次日自动恢复；0 = 禁用日限额'),
    actionAuditEnabled: z.boolean().default(true)
        .description('主动写审计（W2-③）：每次主动写（成功/失败）与拒发事件追加写一行 JSON 到 mediaDir/qq-actions.log（含 ts/chatId/action/ok/reason）；写失败仅 warn 不影响发送'),
    traceEnabled: z.boolean().default(false)
        .description('链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 mediaDir/qq-trace.jsonl（4MiB 改名轮转，保留 qq-trace.1/2.jsonl；同一原因 5 分钟限频）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与 0.6.0 完全一致'),
    traceLevel: z.union([z.const('debug'), z.const('warn')]).default('debug')
        .description('追踪事件级别（W1）：debug=记录全部决策事件；warn=仅记录 ok:false（被拒/失败/丢弃）事件'),
    recordInbound: z.boolean().default(false)
        .description('入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 mediaDir/qq-inbox.jsonl（2MiB 改名轮转，保留 qq-inbox.1/2.jsonl；注入的帧不会被二次录制）；纯旁路：写失败仅 warn 限频，绝不影响回复管线；默认关闭——零文件零开销'),
    inboxRedact: z.boolean().default(false)
        .description('录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+****（数字型 id 字段一并处理），便于把录制文件发给别人离线回放；默认关闭'),
    injectEnabled: z.boolean().default(false)
        .description('事件注入通道（W1，仅调试用——信任边界：注入是调试通道，默认全关，勿在生产开启）：开启后按 injectIntervalMs 轮询 mediaDir/qq-inject.jsonl，把新行喂进真实入站管线（trace 事件标 stage=inject）；启动时已存在的历史行跳过并记一条说明；默认关闭'),
    injectDryRun: z.boolean().default(true)
        .description('注入干跑（W1）：true（默认，强烈建议保持）=注入回合触发的全部出站写操作（发消息/撤回等，含异步模型回合的最终回复——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；false=注入内容会真实发送，仅限隔离环境实验'),
    injectIntervalMs: z.number().default(2000)
        .description('注入队列轮询间隔（毫秒，W1；最小 500）'),
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info')
        .description('控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。debug=全部输出（含「session 事件早退」等调试行）；info=常规信息（启动、连接建立、meta 事件等，默认）；warn=仅警告与错误；error=仅错误'),
});
/** D4a: the deprecated config names kept for one release, mapped onto their
 * renamed fields. */
const DEPRECATED_CONFIG_ALIASES = [
    ['imageMaxSize', 'inboundImageMaxPx', INBOUND_IMAGE_MAX_PX],
    ['maxImageBytes', 'outboundImageMaxBytes', OUTBOUND_IMAGE_MAX_BYTES],
    ['maxInboundFileBytes', 'inboundFileMaxBytes', INBOUND_FILE_MAX_BYTES],
];
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export function resolveDeprecatedConfig(config) {
    const resolved = { ...config };
    for (const [oldName, newName, defaultValue] of DEPRECATED_CONFIG_ALIASES) {
        const legacy = resolved[oldName];
        if (legacy === undefined)
            continue;
        console.warn('[dsh-onebot] config "' + oldName + '" is deprecated; rename it to "' + newName + '"');
        delete resolved[oldName];
        if (resolved[newName] === defaultValue)
            resolved[newName] = legacy;
    }
    return resolved;
}
/** Resolve env-var fallbacks into the effective access policy. */
function resolvePolicy(config) {
    const envAdmins = ENV('ONEBOT_ALLOWED_USERS')
        .split(',')
        .map(v => v.trim())
        .filter(v => v !== '');
    const adminUsers = [...new Set([...config.adminUsers, ...envAdmins])];
    return {
        dmPolicy: config.dmPolicy,
        groupPolicy: config.groupPolicy,
        allowFrom: config.allowFrom,
        groupAllowFrom: config.groupAllowFrom,
        adminUsers,
        allowAllUsers: config.allowAllUsers || ENV('ONEBOT_ALLOW_ALL_USERS').toLowerCase() === 'true',
        requireMention: config.requireMention,
    };
}
/** Severity rank for the logLevel gate (debug < info < warn < error). */
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export function logMetaEvent(selfId, event, minLevel = 'info') {
    const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : '';
    if (metaType === 'heartbeat')
        return;
    if (LOG_LEVEL_RANK.info < LOG_LEVEL_RANK[minLevel])
        return;
    console.log('[dsh-onebot] meta event; bot QQ: ' + selfId + '; ' + metaType);
}
/** Mount the plugin. */
export function apply(ctx, config) {
    // D4a: honor the deprecated config names before any consumer reads them.
    config = resolveDeprecatedConfig(config);
    const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir();
    const policy = resolvePolicy(config);
    /** Console log line callback (level, message) — shared by the bridge deps,
     * the connection log port and the host-ready boot gate below (M2-C5b). */
    const log = (level, message) => {
        if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[config.logLevel])
            return;
        const prefix = '[dsh-onebot] ';
        if (level === 'error')
            console.error(prefix + message);
        else if (level === 'warn')
            console.warn(prefix + message);
        else
            console.log(prefix + message);
    };
    // T3 方案 B: the host exposes no queryable default workspace —
    // WorkspaceRegistry has no default getter and the session controller's
    // defaultCwd is assembly-internal — so the unconfigured fallback stays the
    // host process cwd. Say so once at mount so a /root surprise is explainable.
    if (config.workspacePath === '') {
        log('warn', '未配置 workspacePath：QQ 会话默认目录将使用宿主进程工作目录 ' + process.cwd() + '，建议在配置中设置 workspacePath，避免会话工作区落在宿主启动目录');
    }
    const connection = new OneBotConnection({
        mode: config.mode,
        host: config.host,
        port: config.port,
        url: config.url,
        accessToken: config.accessToken,
        reconnectMaxAttempts: config.reconnectMaxAttempts,
        callTimeoutMs: 30_000,
        log,
    });
    const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts });
    // W1: the trace sink exists only when explicitly enabled — default off
    // means no sink, no traceIds, no jsonl, zero behavior difference.
    const traceSink = config.traceEnabled
        ? new TraceSink({ dir: mediaDir, level: config.traceLevel, log: (level, message) => log(level, message) })
        : undefined;
    // W1/T5: the inbound recorder exists only when recordInbound is on (pure
    // bypass: its own writer, failures only warn); the inject channel only
    // when injectEnabled is on (DEBUG-ONLY) — both absent by default.
    const recorder = config.recordInbound
        ? new InboundRecorder({ dir: mediaDir, redact: config.inboxRedact, log: (level, message) => log(level, message) })
        : undefined;
    const injectChannel = config.injectEnabled
        ? new InjectChannel({
            dir: mediaDir,
            dryRun: config.injectDryRun,
            intervalMs: config.injectIntervalMs,
            handleEvent: async (event) => bridge.handleInbound(event, { injected: true }),
            trace: traceSink,
            log: (level, message) => log(level, message),
        })
        : undefined;
    const transcriber = new Transcriber({
        enabled: config.sttEnabled,
        engine: config.sttEngine,
        command: config.sttCommand,
        args: config.sttArgs,
        model: config.sttModel,
        timeoutMs: config.sttTimeoutMs,
    });
    connection.onMessage = (event) => {
        void bridge.handleInbound(event);
    };
    connection.onMeta = (event) => {
        logMetaEvent(connection.selfId, event, config.logLevel);
    };
    // W2-②③ gate keys: BridgeConfig (bridge.ts) keeps its declared shape; the
    // pipelines read them off the runtime object via optional intersection
    // members (see InboundContext/OutboundContext.config), so the spread here
    // is the wiring — no bridge.ts change.
    const gateConfig = {
        dedupWindowSeconds: config.dedupWindowSeconds,
        actionRatePerMinute: config.actionRatePerMinute,
        actionRatePerDay: config.actionRatePerDay,
        actionAuditEnabled: config.actionAuditEnabled,
    };
    const bridge = new ChatBridge({
        ctx,
        // M2-C5b: the bridge sees only explicit ports — the session-event feed
        // (this context's own `on`) and the two injectables below; the 'loader'
        // service lookup lives here, not in the bridge.
        hostReady: async () => {
            try {
                const loader = ctx.get('loader');
                await loader?.await();
            }
            catch (error) {
                log('debug', 'loader.await failed: ' + describeError(error));
            }
        },
        // Live llm lookup per call — same semantics as the pre-port live getter.
        llmCatalog: {
            listProviders: () => ctx.llm.listProviders(),
            listModels: provider => ctx.llm.listModels(provider),
        },
        connection,
        dshHome: dshHome(),
        media,
        transcriber,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentPresets: ctx.agentPresets,
        commands: ctx.commands,
        sessionPersistence: ctx.sessionPersistence,
        workspaceRegistry: ctx.workspaceRegistry,
        agentDefaultModel: ctx.agentDefaultModel,
        defaultModel: () => {
            try {
                return ctx.agentDefaultModel.currentSelection();
            }
            catch {
                return undefined;
            }
        },
        config: {
            botQQ: config.botQQ,
            ownerQQ: config.ownerQQ,
            memeDir: config.memeDir,
            promptExtra: config.promptExtra,
            mediaFreeDirs: config.mediaFreeDirs,
            mediaDrawDirs: config.mediaDrawDirs,
            voiceCooldownMs: config.voiceCooldownMs,
            voiceMaxSeconds: config.voiceMaxSeconds,
            imageCooldownMs: config.imageCooldownMs,
            imageFreshWindowMs: config.imageFreshWindowMs,
            ignoreSelf: config.ignoreSelf,
            requireMention: config.requireMention,
            groupKeywords: config.groupKeywords,
            groupKeywordCooldownMs: config.groupKeywordCooldownMs,
            memeChance: config.memeChance,
            voiceChance: config.voiceChance,
            voiceGateHost: config.voiceGateHost,
            voiceGatePort: config.voiceGatePort,
            debounceMs: config.debounceMs,
            debounceMaxMs: config.debounceMaxMs,
            debounceMaxParts: config.debounceMaxParts,
            debounceBusyWait: config.debounceBusyWait,
            debounceBusyMaxMs: config.debounceBusyMaxMs,
            probableKeywords: config.probableKeywords,
            openChatMaxMs: config.openChatMaxMs,
            openChatDefaultMs: config.openChatDefaultMs,
            steerNoticeEnabled: config.steerNoticeEnabled,
            proactiveDurationMs: config.proactiveDurationMs,
            proactiveFollowUpMs: config.proactiveFollowUpMs,
            proactiveMaxFollowUps: config.proactiveMaxFollowUps,
            proactiveImageThreshold: config.proactiveImageThreshold,
            proactiveChunkChars: config.proactiveChunkChars,
            cardChunkChars: config.cardChunkChars,
            groupMemoryDir: config.groupMemoryDir,
            privateMemoryDir: config.privateMemoryDir,
            maxMessageParts: config.maxMessageParts,
            mentionHistoryCount: config.mentionHistoryCount,
            historyFocusRatio: config.historyFocusRatio,
            autoOcr: config.autoOcr,
            visionModel: config.visionModel,
            visionBaseUrl: config.visionBaseUrl,
            visionApiKeyEnv: config.visionApiKeyEnv,
            visionMinOcrChars: config.visionMinOcrChars,
            visionFallbackModel: config.visionFallbackModel,
            visionFallbackBaseUrl: config.visionFallbackBaseUrl,
            visionFallbackApiKeyEnv: config.visionFallbackApiKeyEnv,
            visionTimeoutMs: config.visionTimeoutMs,
            maxImagesPerTurn: config.maxImagesPerTurn,
            mentionMaxImages: config.mentionMaxImages,
            recentImageLookback: config.recentImageLookback,
            recentImageMaxAgeMs: config.recentImageMaxAgeMs,
            burstWindowMs: config.burstWindowMs,
            burstThreshold: config.burstThreshold,
            burstWaitMs: config.burstWaitMs,
            unknownCommand: config.unknownCommand,
            newMessagePolicy: config.newMessagePolicy,
            autoSteerPolicy: config.autoSteerPolicy,
            deferredTimeoutMs: config.deferredTimeoutMs,
            interimMessages: config.interimMessages,
            interimRecallMs: config.interimRecallMs,
            interimRecall: config.interimRecall,
            sendErrorNotice: config.sendErrorNotice,
            rateLimitPerMinute: config.rateLimitPerMinute,
            restrictedMemberPrefix: config.restrictedMemberPrefix,
            sensitivePatterns: config.sensitivePatterns,
            mediaDir,
            maxImageBytes: config.outboundImageMaxBytes,
            maxVoiceBytes: config.maxVoiceBytes,
            maxFileBytes: config.maxFileBytes,
            textImageThreshold: config.textImageThreshold,
            cardFooter: config.cardFooter,
            fontFiles: config.fontFiles,
            fontFamilies: config.fontFamilies,
            agentPreset: config.agentPreset,
            workspacePath: config.workspacePath,
            maxInboundFileBytes: config.inboundFileMaxBytes,
            chatIdleEvictDays: config.chatIdleEvictDays,
            ...gateConfig,
            trace: traceSink,
            recorder,
            inject: injectChannel,
        },
        policy,
        // W1/T5 health: the config snapshot is redacted at the source — secrets
        // (token/password/apikey…) never leave this closure in the clear.
        configSnapshot: () => redactSnapshot(config),
        log,
    });
    // W3/T4 (P3): connection faults mint QQ-CONN-… references through the
    // bridge (registry + trace + structured log); the transport appends the
    // returned reference to its own log line, so host logs and qq-trace.jsonl
    // share the same number for one fault.
    connection.onFailure = (stage, detail) => bridge.registerConnectionFailure(stage, detail);
    // Lifecycle: start the bridge and transport; unwind everything on unload.
    ctx.effect(() => {
        bridge.start();
        connection.start();
        injectChannel?.start();
        // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
        return async () => {
            await injectChannel?.stop();
            await bridge.stop();
            await connection.stop();
        };
    }, 'dsh-onebot.lifecycle');
    // —— 陪伴插件（dsh-bubble）的入口：只把「投递」和「会话列表」露出来 ——
    // QQ 原有行为一行不动。三个位置都放一份：本 context、根 context、宿主进程全局，
    // 谁能拿到算谁（Cordis 的服务作用域按父子链走，兄弟节点看不见）。
    try {
        // NapCat 快捷启动（2026-11-10）：查进程、起进程。只做「启动 / 重启」，不做「停止」。
    const NAPCAT_PROC = 'NapCatWinBootMain.exe';
    const napcatPid = () => new Promise((resolve) => {
        try {
            execFile('tasklist', ['/FI', 'IMAGENAME eq ' + NAPCAT_PROC, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                resolve(err ? 0 : parseTasklist(stdout));
            });
        }
        catch {
            resolve(0);
        }
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const spawnNapcat = () => {
        const v = resolveNapcatDir(config.napcatDir, { home: homedir() });
        if (!v.ok)
            return { ok: false, error: v.error };
        // 机器号：配置里填了就用填的；没填就从 config 目录的文件名里认（onebot11_<号>.json）
        const uin = String(config.botQQ || '') || detectBotQQ(v.dir);
        const quickLogin = config.napcatQuickLogin !== false;
        if (buildLaunchCommand(v.dir, { uin, quickLogin }) === null)
            return { ok: false, error: '拼不出启动命令：' + v.dir };
        try {
            // 走 VBScript 起：窗口样式 0 = 隐藏，launcher.bat 和它拉起的 NapCatWinBootMain
            // 都继承这个隐藏控制台，不会闪黑框（11-10 哥哥要求隐藏命令行窗口）。
            // 直接 spawn(cmd.exe) 还有一个坑：Node 会重写 /c 后面的引号 → cmd exit 1、NapCat 根本没起。
            const dataDir = join(homedir(), '.dsh', 'onebot');
            mkdirSync(dataDir, { recursive: true });
            const vbsPath = join(dataDir, 'napcat-launch.vbs');
            const logPath = join(dataDir, 'napcat-launch.log');
            writeFileSync(vbsPath, buildVbsScript(v.dir, { uin, quickLogin, logPath }), 'utf8');
            const child = spawn('wscript.exe', ['//nologo', vbsPath], {
                cwd: v.dir,
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            return { ok: true };
        }
        catch (e) {
            return { ok: false, error: '起不来：' + describeError(e) };
        }
    };

    // —— NapCat 保活（11-10 哥哥要的「要不要自动登 QQ」开关）——
    // 这两件事原来是外部计划任务 \FishNapCatWatchdog 干的（登录时 + 每 5 分钟），副作用是
    // 开机就等于登录 QQ，而且扫码后要等它下一次检查最多 5 分钟。现在交给插件按开关来。
    // autoStart：挂载时拉一次；autoRestart：进程没了 / 进程在但一直连不上，自己拉回来。
    // 开关存 ~/.dsh/onebot/napcat-auto.json（设置页改了立刻生效、重启也还认）；没存过就用 yml 里的值。
    const autoFile = () => join(dshHome(), 'onebot', 'napcat-auto.json');
    const readAuto = () => {
        try {
            const raw = JSON.parse(readFileSync(autoFile(), 'utf8'));
            const out = {};
            if (typeof raw.autoStart === 'boolean')
                out.autoStart = raw.autoStart;
            if (typeof raw.autoRestart === 'boolean')
                out.autoRestart = raw.autoRestart;
            return out;
        }
        catch {
            return {};
        }
    };
    const autoFlags = () => {
        const o = readAuto();
        return {
            autoStart: typeof o.autoStart === 'boolean' ? o.autoStart : config.napcatAutoStart === true,
            autoRestart: typeof o.autoRestart === 'boolean' ? o.autoRestart : config.napcatAutoRestart === true,
        };
    };
    const setAuto = (patch) => {
        const cur = { ...autoFlags() };
        if (typeof patch?.autoStart === 'boolean')
            cur.autoStart = patch.autoStart;
        if (typeof patch?.autoRestart === 'boolean')
            cur.autoRestart = patch.autoRestart;
        try {
            mkdirSync(join(dshHome(), 'onebot'), { recursive: true });
            writeFileSync(autoFile(), JSON.stringify(cur));
            return { ok: true, ...cur };
        }
        catch (e) {
            return { ok: false, error: describeError(e), ...cur };
        }
    };
    const napcatAuto = {
        lastTry: 0,
        sickSince: 0,
        everSeen: false,
        async check(reason) {
            const flags = autoFlags();
            if (!flags.autoStart && !flags.autoRestart)
                return { ok: true, skipped: '两个开关都关着' };
            if (String(config.napcatDir || '') === '')
                return { ok: false, skipped: '没配 napcatDir' };
            const now = Date.now();
            if (now - this.lastTry < 20000)
                return { ok: true, skipped: '刚试过，等等' };
            const pid = await napcatPid();
            if (pid > 0)
                this.everSeen = true;
            const online = !!(connection && connection.connected);
            if (pid > 0 && online) {
                this.sickSince = 0;
                return { ok: true, skipped: '好好活着' };
            }
            if (reason === 'tick') {
                // 「掉了拉回来」只对「本来在跑」的成立：开机后 autoStart 关着、它从没起来过，
                // 就不能替哥哥把它拉起来（那又变成打开 DSH 就登录 QQ 了）。
                if (pid === 0 && !this.everSeen && !flags.autoStart)
                    return { ok: true, skipped: '这次开机没起过，不动它' };
                // 进程在但连不上：给它 3 分钟自愈（NapCat 自己在重连），过了才动手
                if (pid > 0) {
                    if (this.sickSince === 0) {
                        this.sickSince = now;
                        return { ok: true, skipped: '进程在，先观察' };
                    }
                    if (now - this.sickSince < 180000)
                        return { ok: true, skipped: '还在观察' };
                }
                else {
                    this.sickSince = 0;
                }
                if (!flags.autoRestart)
                    return { ok: true, skipped: 'autoRestart 关着' };
            }
            else if (pid > 0) {
                // 开机那一刻 NapCat 已经在了（可能正在登录）：别叠着再起一个
                return { ok: true, skipped: '进程已在' };
            }
            this.lastTry = now;
            this.sickSince = 0;
            this.everSeen = true;
            const r = spawnNapcat();
            log(r.ok ? 'info' : 'warn', '[napcat] ' + reason + '：' + (r.ok ? '已发起启动' : '起不来 - ' + r.error));
            return r;
        },
    };

    const onebotApi = {
            dispatch: (chatId, text, role, nickname) => bridge.dispatchFollowup(chatId, text, role, nickname, 'bubble'),
            /** 这个会话最后一次有动静是什么时候（陪伴插件用它判断「他是不是正在聊」）。 */
            lastActivityAt: (chatId) => {
                try {
                    const c = bridge.chats.get(chatId);
                    return Number(c?.lastActivityAt) || 0;
                } catch { return 0; }
            },
            /** 陪伴插件要读的那几个设置（白名单，别的一概不给）。 */
            getConfig: () => ({
                memeChance: bridge.deps.config.memeChance,
                voiceChance: bridge.deps.config.voiceChance,
                requireMention: bridge.deps.config.requireMention,
                groupKeywords: bridge.deps.config.groupKeywords ?? [],
                groupKeywordCooldownMs: bridge.deps.config.groupKeywordCooldownMs,
                debounceMs: bridge.deps.config.debounceMs,
                debounceBusyWait: bridge.deps.config.debounceBusyWait,
                proactiveMaxFollowUps: bridge.deps.config.proactiveMaxFollowUps,
                proactiveFollowUpMs: bridge.deps.config.proactiveFollowUpMs,
                openChatDefaultMs: bridge.deps.config.openChatDefaultMs,
                ownerQQ: bridge.deps.config.ownerQQ,
                memeDir: bridge.deps.config.memeDir,
                promptExtra: bridge.deps.config.promptExtra,
                visionModel: bridge.deps.config.visionModel,
                visionBaseUrl: bridge.deps.config.visionBaseUrl,
                visionApiKeyEnv: bridge.deps.config.visionApiKeyEnv,
                visionMaxTokens: bridge.deps.config.visionMaxTokens,
                videoVisionModel: bridge.deps.config.videoVisionModel,
                videoVisionBaseUrl: bridge.deps.config.videoVisionBaseUrl,
                videoVisionApiKeyEnv: bridge.deps.config.videoVisionApiKeyEnv,
                videoVisionFallbackModel: bridge.deps.config.videoVisionFallbackModel,
                videoVisionFallbackBaseUrl: bridge.deps.config.videoVisionFallbackBaseUrl,
                videoVisionFallbackApiKeyEnv: bridge.deps.config.videoVisionFallbackApiKeyEnv,
                videoVisionMaxTokens: bridge.deps.config.videoVisionMaxTokens,
                videoVisionTimeoutMs: bridge.deps.config.videoVisionTimeoutMs,
                videoGrids: bridge.deps.config.videoGrids,
                videoFrames: bridge.deps.config.videoFrames,
                videoDeepGrids: bridge.deps.config.videoDeepGrids,
                videoDeepFrames: bridge.deps.config.videoDeepFrames,
                videoCacheDays: bridge.deps.config.videoCacheDays,
                videoWorkDays: bridge.deps.config.videoWorkDays,
                videoAsr: bridge.deps.config.videoAsr,
                videoAsrMaxSec: bridge.deps.config.videoAsrMaxSec,
                // NapCat 目录（2026-11-10）：检查环境要用它判断「装了没、起没起」
                napcatDir: bridge.deps.config.napcatDir,
                napcatQuickLogin: bridge.deps.config.napcatQuickLogin,
            }),
            /** 就地改（热生效，不落盘；重启回 yml 里的值）。只认白名单里的键。 */
            setConfig: (patch) => {
                if (!patch || typeof patch !== 'object') return false;
                for (const k of ['memeChance', 'voiceChance', 'requireMention', 'groupKeywords',
                    'groupKeywordCooldownMs', 'debounceMs', 'debounceBusyWait', 'proactiveMaxFollowUps',
                    'proactiveFollowUpMs', 'openChatDefaultMs', 'ownerQQ', 'memeDir', 'promptExtra',
                    'mediaFreeDirs', 'mediaDrawDirs',
                    'visionModel', 'visionBaseUrl', 'visionApiKeyEnv', 'visionMaxTokens', 'visionTimeoutMs',
                    'videoVisionModel', 'videoVisionBaseUrl', 'videoVisionApiKeyEnv',
                    'videoVisionFallbackModel', 'videoVisionFallbackBaseUrl', 'videoVisionFallbackApiKeyEnv',
                    'videoVisionMaxTokens', 'videoVisionTimeoutMs',
                    'videoGrids', 'videoFrames', 'videoDeepGrids', 'videoDeepFrames', 'videoCacheDays',
                    'videoWorkDays', 'videoAsr', 'videoAsrMaxSec']) {
                    if (k in patch) bridge.deps.config[k] = patch[k];
                }
                return true;
            },
            /** QQ 通道状态：给陪伴插件看「现在能不能发」。 */
            status: () => {
                try {
                    const conn = bridge.deps?.connection || { };
                    return {
                        connected: !!(bridge.connected ?? conn.connected),
                        selfId: conn.selfId ? String(conn.selfId) : '',
                    };
                } catch { return { connected: null, selfId: '' }; }
            },
            /** 陪伴插件挂「兴趣分」钩子：会话每轮自己写的 [SCORE n] 从这儿递过去。 */
            setScoreHook: (fn) => {
                try {
                    bridge.bubbleScoreHook = (typeof fn === 'function' ? fn : null);
                    return true;
                } catch { return false; }
            },
            /** 陪伴插件挂「每一轮结束」钩子：报这一轮是谁起的（bubble/user/host），插件据此扣一格。 */
            setConvIdleMs: (ms) => {
                if (bridge && typeof bridge.setConvIdleMs === 'function') bridge.setConvIdleMs(ms)
            },
            setTurnHook: (fn) => {
                try {
                    bridge.bubbleTurnHook = (typeof fn === 'function' ? fn : null);
                    return true;
                } catch { return false; }
            },
            /** 陪伴插件挂「追聊」钩子：会话写的 [MORE] 从这儿递过去（秒数，0 = 用默认区间）。 */
            setMoreHook: (fn) => {
                try {
                    bridge.bubbleMoreHook = (typeof fn === 'function' ? fn : null);
                    return true;
                } catch { return false; }
            },
            /** 陪伴插件挂「发出去记账」钩子：每一条真发出去的正文递过来（认 B站 链接，记发过的视频）。 */
            setSentHook: (fn) => {
                try {
                    bridge.bubbleSentHook = (typeof fn === 'function' ? fn : null);
                    return true;
                } catch { return false; }
            },
            /** 这个会话最后一条「他发的」消息是什么时候（追聊到点要判断他有没有接上话）。 */
            lastInboundAt: (chatId) => {
                try {
                    const c = bridge.chats.get(chatId);
                    return Number(c?.lastInboundAt) || 0;
                } catch { return 0; }
            },
            /** 给某个会话发一张链接卡片（news 型）；卡片对象由调用方构造。 */
            sendCard: (chatId, card) => bridge.sendSegments(chatId, cardSegments(card)),
            /**
             * 直接调一个 OneBot 扩展接口（NapCat 的 `get_mini_app_ark` 这类没有
             * 标准封装的要用它）。只给陪伴插件内部用，参数原样透传。
             */
            callAction: (action, params) => bridge.deps.connection.call(action, params),
            /** 发一组原始消息段（签名后的卡片就得这么发，不能走 sendCard 的 builder）。 */
            sendSegments: (chatId, segments) => bridge.sendSegments(chatId, segments),
            listChats: () => {
                const out = [];
                try {
                    for (const id of bridge.chats.keys()) {
                        let label = String(id);
                        try {
                            const c = bridge.chats.get(id);
                            const n = c?.title || c?.nickname || c?.name || c?.displayName;
                            if (n) label = String(n);
                        } catch { /* 拿不到名字就用 id */ }
                        out.push({ chatId: String(id), kind: String(id).startsWith('group:') ? 'group' : 'private', label });
                    }
                } catch { /* 没会话就空列表 */ }
                return out;
            },
            // 「第一次用」引导卡（2026-11-10）：NapCat 有没有在听、token 配没配、QQ 登没登。
            // 只读，不改任何东西；token 单独一个接口，免得每次拉状态都把密钥带出来。
            setupInfo: () => {
                // 注意：bridge.deps.config 是白名单（不含 mode/port/accessToken），
                // 这里必须读本插件的真实配置与那一条 connection 实例。
                const cfg = config || {};
                const conn = connection;
                const addr = conn && typeof conn.address === 'function' ? conn.address() : undefined;
                const mode = String(cfg.mode || 'reverse');
                const host = String(cfg.host || '127.0.0.1');
                const port = Number(cfg.port) || 8643;
                const token = String(cfg.accessToken || '');
                const wsHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
                return {
                    mode,
                    host,
                    port,
                    url: mode === 'reverse' ? 'ws://' + wsHost + ':' + port + '/ws' : String(cfg.url || ''),
                    listening: addr !== undefined,
                    boundPort: addr && addr.port,
                    connected: !!(conn && conn.connected),
                    selfId: String((conn && conn.selfId) || ''),
                    tokenSet: token !== '',
                    tokenTail: token === '' ? '' : token.slice(-4),
                };
            },
            /** 把 accessToken 明文交给本机界面（复制按钮用）。只走本机 loopback。 */
            plainToken: () => String((config || {}).accessToken || ''),
            // ── NapCat 快捷启动 / 二维码（2026-11-10）──
            napcatStatus: async () => {
                const v = resolveNapcatDir(config.napcatDir, { home: homedir() });
                const out = {
                    dirSet: v.ok,
                    dir: v.ok ? v.dir : String(config.napcatDir || ''),
                    error: v.ok ? '' : v.error,
                    running: false,
                    pid: 0,
                    connected: !!(connection && connection.connected),
                    quickLogin: config.napcatQuickLogin !== false,
                    ...autoFlags(),
                    botQQ: String(config.botQQ || '') || (v.ok ? detectBotQQ(v.dir) : ''),
                    qr: { exists: false, at: 0, ageSec: -1, stale: false },
                };
                if (v.ok) {
                    out.pid = await napcatPid();
                    out.running = out.pid > 0;
                    out.qr = qrInfo(v.dir);
                }
                return out;
            },
            napcatQr: () => {
                const v = resolveNapcatDir(config.napcatDir, { home: homedir() });
                if (!v.ok)
                    return { ok: false, error: v.error };
                const info = qrInfo(v.dir);
                if (!info.exists)
                    return { ok: false, error: '还没有二维码：NapCat 起来后才会生成（已经登录了就不会有）', at: 0 };
                if (info.stale) {
                    const online = !!(connection && connection.connected);
                    return {
                        ok: false, stale: true, connected: online, at: info.at, ageSec: info.ageSec,
                        error: online
                            ? 'QQ 已经登录了，不用扫码（这张图是 ' + Math.round(info.ageSec / 60) + ' 分钟前的旧图）'
                            : '这张二维码已经 ' + Math.round(info.ageSec / 60) + ' 分钟没更新了，扫不动。多半是 NapCat 这会儿没在等你扫码（进程没起来，或者刚落登录态）',
                    };
                }
                try {
                    const buf = readFileSync(qrPath(v.dir));
                    return { ok: true, at: info.at, bytes: info.bytes, dataUrl: 'data:image/png;base64,' + buf.toString('base64') };
                }
                catch (e) {
                    return { ok: false, error: '读不到二维码文件：' + describeError(e), at: 0 };
                }
            },
            napcatStart: async () => {
                const pid = await napcatPid();
                if (pid > 0)
                    return { ok: false, error: 'NapCat 已经在跑了（PID ' + pid + '）', pid };
                const r = spawnNapcat();
                if (!r.ok)
                    return r;
                await sleep(1200);
                const after = await napcatPid();
                return { ok: true, pid: after, started: after > 0 };
            },
            napcatRestart: async () => {
                const v = resolveNapcatDir(config.napcatDir, { home: homedir() });
                if (!v.ok)
                    return { ok: false, error: v.error };
                // 和 watchdog 一样：先杀引导进程和 QQ（Hook 是开机注进去的，不杀 QQ 等于没重启）。
                await new Promise((resolve) => {
                    try {
                        execFile('taskkill', ['/F', '/IM', NAPCAT_PROC, '/IM', 'QQ.exe'], { windowsHide: true, timeout: 8000 }, () => resolve());
                    }
                    catch {
                        resolve();
                    }
                });
                await sleep(2500);
                const r = spawnNapcat();
                if (!r.ok)
                    return r;
                // NapCat 起来要几秒（注入 QQ + 初始化），1.5 秒太短会误报没起来
                let after = 0;
                for (let i = 0; i < 40; i++) {
                    await sleep(750);
                    after = await napcatPid();
                    if (after > 0) break;
                }
                if (after <= 0)
                    return { ok: false, error: '命令发出去了，但 30 秒内没看到 NapCat 进程（看 NapCat.Shell\logs\watchdog.log）', started: false };
                return { ok: true, pid: after, started: true };
            },
            // 会话自选（本鱼补丁 2026-11-08）：设置页直接填 session id，立刻换过去。
            // NapCat 保活的两个开关：读/写都走 ~/.dsh/onebot/napcat-auto.json（重启也认）。
            napcatAutoStatus: () => ({ ok: true, ...autoFlags(), dirSet: resolveNapcatDir(config.napcatDir, { home: homedir() }).ok }),
            setNapcatAuto: (patch) => setAuto(patch),
            napcatCheck: () => napcatAuto.check('manual'),
            sessionTable: () => bridge.registry.sessionTable(),
            currentSessionId: (chatId) => bridge.registry.currentSessionId(String(chatId)),
            pinSession: (chatId, sessionId) => bridge.registry.pinSession(String(chatId), String(sessionId ?? '')),
            unpinSession: (chatId) => bridge.registry.unpinSession(String(chatId)),
            retryPendingPins: () => bridge.registry.retryPendingPins(),
        };
        // 先挂全局（同一宿主进程里最稳），再试根 context，最后试本 context。
        // 每一步各自 try：前一步挂了不许连累后一步。
        try {
            globalThis.__DSH_ONEBOT__ = onebotApi;
        } catch (e) {
            log('warn', 'onebot 挂不到全局：' + (e?.message ?? e));
        }
        try {
            if (ctx.root && typeof ctx.root.set === 'function') ctx.root.set('onebot', onebotApi);
        } catch (e) {
            log('warn', 'onebot 挂不到根 context：' + (e?.message ?? e));
        }
        try {
            if (typeof ctx.set === 'function') ctx.set('onebot', onebotApi);
        } catch (e) {
            log('warn', 'onebot 挂不到本 context：' + (e?.message ?? e));
        }
        log('info', '已暴露 onebot 服务（陪伴插件可用）');
        // —— 泡泡（陪伴）：它自己读配置、掐表、挑事件，只借这里的「投递」和「会话列表」。 ——
        // 挂不上也不许连累 QQ 通道。
        try {
            mountCompanion(ctx, () => onebotApi);
        } catch (e) {
            log('warn', '陪伴模块没挂上：' + (e?.message ?? e));
        }
        // 钉了但当时被 GUI 占着的会话：每分钟补接一次（pins 文件就是待办清单）。
        try {
            const t = setInterval(() => {
                Promise.resolve(bridge.registry.retryPendingPins()).catch(() => { });
            }, 60000);
            if (typeof t.unref === 'function')
                t.unref();
            ctx.effect(() => () => clearInterval(t));
        }
        catch (e) {
            log('warn', '待接会话的定时器没挂上：' + (e?.message ?? e));
        }
        // NapCat 保活：两个开关都关着时 check() 立刻返回，什么都不做。
        try {
            const t = setInterval(() => { napcatAuto.check('tick').catch(() => { }); }, 30000);
            if (typeof t.unref === 'function') t.unref();
            ctx.effect(() => () => clearInterval(t));
            if (autoFlags().autoStart)
                napcatAuto.check('start').catch(() => { });
        } catch (e) {
            log('warn', 'NapCat 保活没挂上：' + (e?.message ?? e));
        }
    } catch (e) {
        log('warn', 'onebot 服务没露出来：' + (e?.message ?? e));
    }
    console.log('[dsh-onebot] mounted (mode=' + config.mode + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')');
}
