---
title: 泡泡 · 功能全景（0.5.38）
markmap:
  initialExpandLevel: 2
  colorFreezeLevel: 2
---

# 泡泡 dsh-onebot-paopao

## 一句话
- 一个插件干两件事：把 QQ 接进来、让会话自己开口
- **说话的是会话本体**，插件只负责「递话头 + 发出去 + 记账」
- 人格、记忆、工具都还是宿主那套；插件不代写一个字

## 开口节奏（权重）
### 权重 w
- 范围 `[-100, 100]`，每套配置有地板 `wFloor`（日常 -50 / 主动 -20）
- 每拍 `w += risePerTick`（日常 +2 /5 分钟，主动 +3 /3 分钟）
- 硬门槛：`w < threshold` 时概率恒为 0（日常 30 / 主动 0）
- 过门槛后 `p = triggerPmax × w/100`（日常 0.1 / 主动 0.5）
### 扣分与补分
- **一轮结束就扣**，发没发都扣：`w -= releaseBase`（日常 40 / 主动 30）
- `[HOLD]` 也照扣；抽卡轮、追聊轮、来料（`biliWeight:false`）有特例
- 分数 0~12 由她自己给（`[SCORE n]`），换成补分百分比
- 补分表 13 档：0 分 -100%｜5 分 0%｜10 分 +120%｜11 分 +150%｜12 分 +200%
- `inboundBonus`（他主动起的对话加分）：日常 +1 / 主动 +3，允许负
### 开口限制
- 免打扰时段：日常 00:00–09:00｜主动 02:00–09:00
- 限流：滑动窗口「N 小时最多 M 条」（日常 1h·20，主动 1h·30）
- `idleMinutes`：他刚说完话的若干分钟内不主动
- 每会话绑定一套配置（`bindings`：chatId / profileId / label / enabled）

## 话头模板（cue）
- 模板里 11 个占位符：`{{mode}} {{period}} {{count}} {{ago}} {{who}} {{w}} {{line}} {{label}} {{hint}} {{candidates}} {{note}}`
- 固定尾注写死在代码里、改不掉：「不想发就写 [HOLD]」「本轮不用打分」
- 面板可编辑 + 四份预览（有候选 / 没候选 / 追聊 / 来料）
- 每事件一句台词表已删（跟事件页重复）

## 事件池（十槽）
- 聊天 24+3｜发个视频 18+5｜发表情包 10+4｜找张图 10+4｜发个语音 8+5
- 上网看看 8+4｜讲个笑话 8+4｜翻个旧账 6+4｜提醒我 8+8｜唱首歌 5+6（默认关）
- 抽中才注入「这轮可以干这个」，只有份数加权抽签
- **只有「发个视频」有真准备器**，其余八槽只递词，怎么做交给她
- 槽的三个存活条件：`enabled !== false`、`weight > 0`、`label` 非空
- 想禁用必须 `enabled:false`（weight 写 0 会回退默认份数）

## 标记协议
- `[HOLD]`：整轮一个字都不发（分照收、账照扣）
- `[SCORE 0-12]`：她给自己这轮打分，插件剥掉
- `[LATER n]`：n 分钟后再叫一轮，单位认 `m`/`s`/`分钟`/`秒`
- `[SKIP]`：已删除，只剩发送前顺手剥掉
- 正则只有一份（`lib/markers.js`），别处不许再写

## 来料与追聊
### 来料（B站 / 群里的动静）
- B站 私信、`@我`、回复我的 → 落收件箱 → 触发一轮
- 第一次接上只记账不打扰；陌生人私信默认不递
### 追聊
- `[LATER n]` → 排队 → 到点 `tick(followup)` 再叫醒一轮
- 每会话每天上限（默认 20 条）、最长 12 小时；只受免打扰管、不受限流管
- busy / quiet 时重排，最多 12 次

## B站 能力
- 登录：扫码（面板出二维码）、`whoami`、凭证落 `bubble/bili`
- 挑视频：兴趣关键词 × 分区 × 时长/播放门槛 × 拉黑 UP + 口味账（`taste.json`）
- 发视频：封面图 + 标题 + UP + 链接（卡片走不通，QQ 报版本过低）
- 看视频：先字幕、无字幕走 ASR、抽帧宫格交给视觉模型（quick/normal/deep）
- 私信与评论：`bili_send_message`、`bili_like/coin/fav/comment`

## 媒体能力
- 图：`qq_send_image`（本地路径 / URL）、表情包目录掷骰、识图灌进上下文
- 语音：`qq_send_voice`（路径或 URL）
- 文件 / 合并转发 / 卡片：`qq_send_file`、`qq_send_forward`、`qq_send_card`
- 发文件的围栏：管理员不设围栏；非管理员只能发媒体目录 / 产物区 / 临时目录 / 工作区
- 硬拒清单：`sessions`、`profiles`、`onebot`、`~/.ssh`、`.env`、`*.pem`、`credentials*`

## QQ 通道
### 连接
- 反向 WS：客户端连到 `ws://127.0.0.1:8643/ws`（token 即 accessToken，留空自动生成）
- 只认「连上了没」，不锁死 NapCat：SnowLuma 也能接
- NapCat 后端可选：启动/重启/看二维码/保活三开关（收在折叠里）
### 身份与权限
- 三级：管理员（`adminUsers` ∪ `ownerQQ`）／私聊白名单／群里其他人
- 私聊 `open`：只认管理员（原版行为）；白名单要放人得加进 `adminUsers`
- 群聊 `open`：任何群都能用（0.5.34 起默认）；`allowlist` 才查 `groupAllowFrom`
- 沙箱预设 `preset-qq-group`：**可选**，默认不挂；填了但解析不了就拒绝开会话（fail-closed）
- 群成员消息带 `[群成员]` 前缀 + `groupAbilities` 八项清单（默认全开）
### 工具（17 个）
- 发：`qq_send_video / image / voice / file / forward / card`
- 查：`qq_group_history`、`qq_video_look`
- 主动：`qq_proactive_start / stop`
- B站：`bili_pick_video / like / coin / fav / comment / send_message`
- 运维：`qq_napcat_api`（白名单方法、只在主人私聊）
- 写操作类全部要求管理员身份

## 配置体系
- 三层来源，优先级从低到高：插件默认 → `cordis.patch.yml` → `settings.json`（面板保存的）
- 新增一个键要同时改六处：schema、config 字面量、`getConfig`、`setConfig` 白名单、面板字段、文档
- 两套预设：日常 / 主动（阈值、节奏、限流、免打扰都不同）
- 全局键（关键词、视频筛选、cue、追聊参数）在 `GLOBAL_KEYS`，漏登记就会被保存抹回默认
- 宿主 `@deepseek-ai/schemastery` 没有 `.optional()` / `.int()` / `safeParse`

## 界面
- 三个顶层页签：**泡泡** / **B站与视频** / **QQ 通道**
- 泡泡子页签：总览 / 设置 / 话头 / 说明
- 总览：三盏灯（连接 / 登录 / QQ 在线）、QQ 连接卡、必做清单（可就地改）、会话卡
- 会话卡：权重条、上次开口、窗口 N/M、归零、抽一发、名字可点改
- 会话头「做过的事」tab：聊天 / 积分 / 视频 三视图
- 界面规矩：读不到就说原因 +「再读一次」，不许整块消失；输入中不重画

## 运行期数据
- `~/.dsh/bubble/`：config / state / buckets / history / ledger / inbox / taste / scores / videos / followup
- `~/.dsh/onebot/`：settings.json、chat-sessions、pins、retired、napcat 开关、access-token
- `~/.dsh/bubble/bili/`：B站 凭证、seen 账本、缓存

## HTTP 接口（`/api/bubble/*`）
- 读：`/state /channel /probe /chats /sessions /ext /rolls /watch /ledger /videos /doctor /setup /napcat /qq/off /cue /prompt /client-config`
- 写：`/config /run /reset /card /session /unretire /ext /rolls /watch/run /videos/block /cue /cue/preview /quick /client-log /napcat/* /qq/off /bili/login/start`
- 约定：`{ok:true}` / `{ok:false,error}`；读失败也要回原因；写配置必须落盘

## 刻意的取舍
- 群聊不做硬隔离，靠人格 + 提示词兜底（群会话里 bash 仍在）
- `[HOLD]` 出现即按住整轮（没做「独立标记」判定）
- `vision*` 与 `videoVision*` 分开配（预算/超时不同，留空则跟随）
- 卡片彻底放弃（QQ 报「发送者版本过低」）
- NapCat 整套留着当后路，SnowLuma 是现在的主路

## 怎么验证
- `npm test`（196 项）+ `node scripts/guard-publish.mjs`（124 文件 / 17 工具）
- 起宿主看：`/api/bubble/setup`、`/ext`、`/prompt`
- 改 `lib/*.js` 是静态 import，要重启宿主才生效