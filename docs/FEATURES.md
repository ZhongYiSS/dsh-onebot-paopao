---
title: 泡泡 · 功能与关系全景（0.5.46）
markmap:
  initialExpandLevel: 2
  colorFreezeLevel: 2
---

# 泡泡 · 一张图看清「谁把什么交给了谁」

## 先记住三条铁律（所有功能都由它们推出来）
- **说话的是会话本体**，插件只做四件事：**递话头 / 把关门 / 发出去 / 记账**
- **凡是「设定」都进配置或人格**，代码里不写死任何本机内容和具体数值
- **数据只走一条主链**：`触发 → 闸门 → 事件 → 话头 → 注入会话 → 会话回复 → 发出 → 结算 → 改权重` → 回到触发

## 主链（8 步，每步只交棒给下一步）
### 1 触发：四种入口写进同一个 ticker
- **定时**：`app.restart()` 按「所有开着的绑定里最短的 `tickMinutes`」排节拍 → 每拍 `ticker.tickAll()`
- **来料**：`bili-watch` 抓到 @/回复/私信 → `pushInbox(home, chatId, items)` 写 `bubble/inbox.json` → `ticker.tick(chatId, {fresh:true})`
- **追聊**：会话在回复里写 `[LATER 25]` → `bridge.noteBubbleMore()` → `followup.request(chatId, sec)` → 到点 `ticker.tick(chatId, {followup:true})`
- **手动**：面板「抽一发」/`POST /api/bubble/run` → `tick(chatId,{force:true})`
- 关系：**四种入口只是给 `tickOne` 不同的旁路标记**（`force` / `fresh` / `followup`），闸门里每个跳过早退都标着「谁可以跳过」

### 2 闸门：顺序不能换（`lib/companion/tick.mjs` 的 `tickOne`）
- `⓪.0 b.enabled === false → binding-off`：**整条停**，不涨权重也不记账
- `⓪.0b isQqOff() → qq-off`：QQ 总开关关了就跳过，**不消耗今天的额度**
- `①.5 未到点 → notyet`：`!force && !fresh && !followup && t - lastTickAt < gap - 5000`
- `② inQuiet() → quiet`：免打扰**排在涨权重之前**，否则一夜能攒满
- `③ riseByTick(w, risePerTick, wFloor)`：这里才开始涨
- `④ 跨天重置 todayCount`
- `④.5 idleCheck(minutes) → chatting`：他刚说过话就别插嘴（`force`/`followup` 跳过）
- `⑤ pruneWindow + canTrigger → limit`：滑动窗口「N 小时最多 M 条」（`force`/`followup` 跳过 → **追聊不占限流**）
- `⑥ peekInbox`：有来料就优先来料（`followup` 轮强制当空）
- `⑥.1 canSpeak(w, threshold, wFloor) → below`：**阈值是硬门槛**，不是概率
- `⑦ triggerChance(...) 对 rnd()`：`p = triggerPmax × w/100`
- `⑧ drawEvent(mergePool(profile.pool), rnd) → noevent`
- `⑨ addBonus(w, ev.bonus, wFloor)`：抽中就加分（抽卡那轮不加分）
- `⑩ prepare(ev, {...})`：**只有 `video` 有真准备器**，其余九个只递词
- `⑪ buildHint(...)` → `⑫ deliver(...)` → `⑭ deliveredOk` 才记账

### 3 事件：十槽池子决定「这轮干什么」
- 默认十槽（`lib/companion/events.mjs` 的 `EVENT_POOL`，`sing` 默认关，开着的九槽合计 **100 份**）：说句话 24(+3) / 刷视频 18(+5) / 甩表情包 10(+4) / 找张图 10(+4) / 发语音 8(+5) / 上网看看 8(+4) / 讲个笑话 8(+4) / 翻旧账 6(+4) / 提醒哥哥 8(+8) / 唱首歌 5(+6，默认 `enabled:false`)
- 每槽四个字段：`label`（话头里那句动词）/ `weight`（份数）/ `bonus`（抽中加多少权重）/ `hint`（可选补充，≤80 字）/ `enabled`
- 关系：**`weight` 写 0 会回退默认份数**，禁用必须 `enabled:false`（`mergePool` 的语义）
- 关系：`prepare` 只喂 `{{candidates}}`，**不写「怎么发」**——做法归会话

### 4 话头：把事件翻译成「一句人话」
- 模板 `cue.template` + **11 个占位符**：`{{mode}}` 配置名 · `{{period}}` 时段 · `{{count}}` 今天第几次 · `{{ago}}` 上次多久前 · `{{who}}` 发给谁 · `{{w}}` 权重 · `{{line}}` 事件词（`{{label}}` 是它的老写法）· `{{hint}}` 事件补充 · `{{candidates}}` 候选 · `{{note}}` 插件临时加的一句
- 两条固定说明由代码追加、**用户改不掉**：`FIXED_FOOTER`（「不想发就写 [HOLD]」）、`TICK_FOOTER`（「本轮不用打分」只给抽卡轮）
- 关系：话头**不是系统提示词**，它是被注入的「一条用户消息」→ 所以必须像人说话，且要能带候选
- 关系：`{{line}}` 取自事件池的 `label`，所以**改事件词就等于改话头**

### 5 注入：让会话真跑一轮
- `deliver` → `bridge.dispatchFollowup(chatId, text, role, nickname, origin)` → `chat.pendingTurnRoles.push(role)` → `followup(createUserMessage(...))`
- 关系：**这一轮的权限身份由 `role` 决定**（管理员轮能改文件、成员轮只能聊）；外部注入的轮默认 `?? 'member'`
- 关系：`origin` 决定记账口径（`bubble` 抽卡 / `inbox` 来料 / `followup` 追聊），也决定**要不要打分**（抽卡轮不打分）

### 6 会话：本体真的写了一条回复
- 回复里可以带三个标记：`[HOLD]`（插件吞掉不发）、`[SCORE n]`（0~12 自评）、`[LATER n]`（到点再开口）
- **`[AT 23:30]` 真排程**（11-09 砍过、2026-11-19 哥哥选「甲」做回来：到那个钟点叫醒一轮；只认钟点不认日期，那个点已经过了就不排，上限 24 小时；同时写 `[LATER]` 时 AT 优先）
- 标记只在**独立成行或结尾**才认（`lib/markers.js`，正则只有一份）
- 关系：`[HOLD]` **照扣权重**（说了不出声也算说过了）；`[SCORE n]` 决定退回多少；`[LATER]` 要过「3 分钟闸门」——**刚有对话**的 3 分钟内才能排（他说话的时刻，或插件自己派发的那一轮，取较新的）；`[AT]` 同一个闸门，网关在 `lib/bridge.js:509`（`!hasLater(s) && !hasAt(s)` 才 return）
- **⚠ 缺口（2026-11-19 核对发现）**：这三个标记的写法**没有写在任何一处给会话看的文字里** —— `lib/prompt.js` 的平台说明没有、默认话头模板（`lib/companion/cue.mjs` 的 `DEFAULT_CUE`）没有、`FIXED_FOOTER` 只讲 `[HOLD]`。现在能用，是因为她在历史会话里见过自己的旧回复（账本里 `settle` 449 笔、score 常年 80 = 8 分）。**换一个新会话或新用户，`[SCORE]`/`[LATER]`/`[AT]` 会一个都不出现**（定时话头彻底不动、权重只剩涨与扣、`REFUND_PCT` 十三档形同虚设）。要补的话得加一行固定机制说明（哥哥 11-11 定「固定说明只留 [HOLD]」），要不要加等他一句话。

### 7 发出：分段、连发、媒体
- 纯文本 → 超 `textImageThreshold`(150 字) 转卡片图；超 `cardChunkChars`(500) 切块；多段按 `maxMessageParts`(3)
- 连发：`burstWindowMs`(10 秒) 内超 `burstThreshold`(3) 条 → 等 `burstWaitMs`(5 秒) 合并
- 媒体五种：`qq_send_image` / `qq_send_video`（封面+标题+链接）/ `qq_send_file` / `qq_send_voice` / `qq_send_forward`
- 关系：**媒体全过围栏**（`fencedMediaFile` 三关：不存在→给同目录候选；命中禁区→拒；出圈→给允许的根）

### 8 结算：一轮结束改权重（决定下一次）
- `turn/end` 时 `spend(w, releaseBase, {floor})` 再 `settle(w, score, {...})`
- `REFUND_PCT` **十三档（对应 0~12 分）**：0 分 −100% / 3 分 −40% / 5 分 0 / 8 分 +60% / 10 分 +120% / 12 分 +200%
- 关系：`inboundBonus`（每套配置自带，日常 +1 / 主动 +3）只加在「他主动开口」那轮
- 关系：结算完 `weight → threshold` 这一圈就是「她愿意开几次口」的全部经济学

## 权重这套机器（零件与接线）
### 三个数据来源
- **套配置**（`profile`）：`threshold` `risePerTick` `tickMinutes` `triggerPmax` `releaseBase` `wFloor` `limitHours/limitCount` `idleMinutes` `quietStart/End` `inboundBonus` `pool`
- **全局键**（`GLOBAL_KEYS`）：`cue` `keywords` `video*` `taste` `bindings`… 每个会话按 `profileId` 指一套
- **运行时状态**（`bubble/state.json`）：`w` `lastTickAt` `lastTriggerAt` `todayCount` `window` `lastSettleAt`
### 谁改谁
- `tick` 涨 / `turn/end` 扣 / `settle` 退 / `bonus` 抽中加 / 面板「归零」写 `resetAt`
- 关系：**拍内增量合并**（`merge()` 只写 `TICK_OWN_KEYS`，`w` 用 `delta`），免得 tick 和 turn/end 互相盖

## 来料与追聊（两条被动线）
### 来料（B站 那边有动静）
- `bili-watch` 四路轮询：私信会话 / 会话消息 / `msgfeed/at` / `msgfeed/reply`（`sleep(350)` 防 −509）
- → 去重账本 `bubble/bili-seen.json`（第一次接上只记账不打扰）→ `pushInbox` → 优先投递
- 关系：来料那一轮 `origin:'inbox'`，**投递成功才 `dropInbox`**
### 追聊（她说了「待会儿」）
- `[LATER 25]` → `followup.request` → `bubble/followup-pending.json` → 到点强制 tick
- 关系：**不占限流、不看 idle**，但**要过免打扰**；有 `followupPerDay`(20) 与 `followupMaxHours`(12) 双上限

## B站 子系统（唯一有「内容生产」的子系统）
### 一条视频从哪来
- 来源三选：`keywords` 兴趣词（**全局一份，不按群分**）/ 热门兜底 / 指定 BV
- 关系：`pickKeywords` 按 `state.keywordCursor` 轮转 → 搜索 → `isBlocked` 过滤（标题/UP/标签/分区/拉黑 mid）→ 补 `view` 拿时长与播放量
- 关系：**口味账** `bubble/taste.json`（`[SCORE]` 10 分 +1、0 分 −1；**每次记分时整本账 ×0.98**，不是每轮×一次）→ 排序
### 一条视频怎么发
- 链接 → `previewMeta` 补标题/封面/UP → `qq_send_video`（或封面图 + 标题 + 链接）
- 关系：**卡片恒失败**（新版 QQ 拒 ark），所以永远是「图 + 文字」
### 一条视频怎么「看」
- `lookVideo` 三档：`quick` 只字幕 / `normal` 5 格 / `deep` 10 格
- 流程：`playurl`(dash) → 分片下载 → ffmpeg 场景检测 → 按变化量在镜头内分帧 → 拼宫格 → 视觉模型逐格描述 → 汇总
- 关系：采样是**按预算分**（`max(9, min(90, 格数×9))` 帧），不是硬性的「1 秒 1 帧」
- 关系：缓存键 = `视频id|深度|采样版本|格数|模型|提示词版本`；**一格没看成就写缓存**是历史 bug（11-19 修）；`videoCacheDays` 现在真生效（与条目里的 `ttlDays` 取小的那个）
### 依赖矩阵（缺什么会怎样）
- 登录：Node + `qrcode`（缺则整个陪伴模块加载失败）
- 拿链接：什么都不用装（`api.bilibili.com`）
- 看内容：ffmpeg/ffprobe + canvas/fontkit + 视觉模型三项
- 站外链接：才需要 yt-dlp

## 媒体与文件围栏（谁能发什么）
- 三关：`realpath` 成功？→ `forbiddenReason` 命中？→ 在不在允许的根里？
- **管理员回合不设目录围栏**（只受绝对禁区约束）；**成员回合** = 媒体目录 + `$DSH_HOME/media` + 工作区（可关）+ 自配目录
- 绝对禁区（谁都不行）：`sessions` `profiles` `onebot` `credentials*` `~/.ssh` `.env` `*.pem` `bubble/bili` 会话内容拷贝
- 关系：`groupMediaWorkspace`（默认开）决定成员能不能发工作区；`mediaFreeDirs`（`lines`）决定额外放行哪些目录
- 关系：**`qq_video_look` 走同一套闸**（0.5.39 起）：本地路径先过 `fencedMediaPath`，URL 只许 http(s)、私网/环回拒。以前它是唯一一个能绕开围栏读本机文件的工具。
- 关系：陪伴插件自己注入的那一轮，角色按目标会话定（群 = 成员、私聊 = 主人）—— 0.5.39 前这里恒为管理员

## QQ 通道（把消息接进来 / 发出去）
### 连
- 反连模式：插件开 `WebSocketServer({noServer})` → 客户端（SnowLuma / NapCat）连 `ws://127.0.0.1:8643/ws?access_token=…`
- 关系：`/api/bubble/setup` 报三盏灯（监听 / 令牌 / 连上）；`/api/bubble/client-config` 按当前端口+令牌**生成客户端片段**
### 谁在说话
- 身份判定 `classifyUserRole`：主人 / 私聊白名单 / 群里其他人
- 关系：**管理员轮完全权限，成员轮只聊天**；`[群成员] ` 前缀 + 「别替群成员跑命令」是提示词级兜底
- 关系：沙箱预设 `qq-group` **可选、默认关**（0.5.34 起），填了但解析不了才 fail-closed
### 能干什么（17 个工具，`lib/tools.js` 里数出来的）
- 发（6）：`qq_send_image` `qq_send_voice` `qq_send_video` `qq_send_file` `qq_send_forward` `qq_send_card`
- 读（2）：`qq_group_history`（群聊最近记录）`qq_video_look`（看视频）
- 主动（2）：`qq_proactive_start` `qq_proactive_stop`
- B站（6）：`bili_pick_video`（挑一条）`bili_send_message`（回私信）`bili_like` `bili_coin` `bili_fav` `bili_comment`
- 底层（1）：`qq_napcat_api`（白名单接口，限主人私聊）
- 关系：**`bili_*` 五个会改动的动作要过 `requireAdminCaller`**，群成员调不动

## 配置体系（最容易出错的地方）
### 三层来源（优先级从上到下）
- `settings.json`（面板存的，永久压过下面）→ `cordis.patch.yml`（profile 里的手写配置）→ schema 默认值
- 关系：**一个键要活，得在六处出现**：schema / config 字面量 / `getConfig` / `setConfig` 白名单 / 面板字段 / `settings-remote` 的键表
### 142 个键怎么分组（只列常动的）
- 连接：`mode` `port` `accessToken` `reconnectMaxAttempts`
- 身份：`ownerQQ` `adminUsers` `dmPolicy` `allowFrom` `dmRestricted` `restrictedPreset`
- 群聊：`groupPolicy` `groupAllowFrom` `groupPreset` `groupAbilities` `groupAbilitiesExtra` `restrictedMemberPrefix` `requireMention` `mentionHistoryCount` `mentionMaxImages`
- 节奏：`debounceMs` `debounceMaxParts` `debounceBusyMaxMs` `rateLimitPerMinute` `dedupWindowSeconds` `interimMessages` `interimRecallMs`
- 主动：`proactiveDurationMs` `proactiveMaxFollowUps` `proactiveImageThreshold` `openChatDefaultMs` `openChatGroups`
- 看图：`autoOcr` `visionModel/BaseUrl/ApiKeyEnv/Headers/MaxTokens/TimeoutMs` `maxImagesPerTurn` `recentImageLookback`
- 看视频：`videoVision*` 六个 + `videoGrids` `videoFrames` `videoDeepGrids` `videoAsr` `videoCacheDays`
- 安全：`allowPrivateHosts` `allowEnvOverrides` `actionRatePerMinute` `sensitivePatterns`
### 两套预设的实盘参数（2026-11-19 从运行实例读出来的真值）
- 日常 `cmw285o3r`：`threshold 30` `risePerTick 2` `tickMinutes 5` `triggerPmax 0.3` `releaseBase 40` `wFloor -50` `limitHours 1 × limitMax 20` `idleMinutes 0` `quiet 00:00-09:00` `inboundBonus 1`，事件池开着 6 槽
- 主动 `cmw29317c`：`threshold 30` `risePerTick 3` `tickMinutes 5` `triggerPmax 0.5` `releaseBase 30` `wFloor -30` `limitHours 1 × limitMax 30` `idleMinutes 0` `quiet 02:00-09:00` `inboundBonus 3`，事件池开着 8 槽
- 关系：**四套绑定里只有 `private:1094335744` 开着**，三个群都 `enabled:false`（关掉的会话不涨不抽，`binding-off` 排最前）
- 关系：字段名容易记错，代码里是 `limitMax`（不是 limitCount）、`quiet: {enabled,from,to}`（不是一个字符串）

## 数据文件（谁写、谁读）
- `bubble/config.json`：面板写、tick 读（两套配置 + 绑定 + 话头 + 事件池）；解析失败会另存 `.broken-<时间戳>`
- `bubble/state.json`：tick/settle 写、面板读
- `bubble/ledger.jsonl` 每笔权重账 · `bubble/ticks.jsonl` 每拍明细 · `bubble/history.jsonl` 开口历史（超 4MB 滚，只读尾部 512KB）· `bubble/scores.json` 分数缓存
- `bubble/inbox.json` 来料队列 · `bubble/followup-pending.json` 待触发的定时话头 · `bubble/followup.jsonl` 定时话头流水
- `bubble/bili-seen.json` B站 去重 · `bubble/bili-sent.json` B站 已发 · `bubble/bili-pick.json` 挑视频游标 · `bubble/taste.json` 口味账
- `bubble/videos.json` 发过的视频 + 黑名单 · `bubble/video-titles.json` bvid→标题小抄（0.5.44）· `bubble/video-cache.json` 看视频证据缓存 · `bubble/video-work/` 下载下来的视频（默认留 15 天）
- `bubble/client-errors.log` 面板崩溃日志 · `bubble/bili/bili_credential.json` B站 凭证
- `onebot/chatrolls.json` 聊天强制事件 · `onebot/settings.json` 面板覆盖（**压过 yml**）· `onebot/qq-off.json` QQ 总开关 · `onebot/napcat-auto.json` 保活设置 · `onebot/tools.json` 外部程序路径 · `onebot/vision-cache.json` 识图缓存 · `onebot/access-token.json` 自动生成的令牌
- 关系：**插件从不删会话文件**，只写自己这几个

## 生效方式：哪些要刷新、哪些要重启（`lib/*.js` 是静态 import）
- **点刷新就够**：`lib/client.js`（界面那一半，面板整页）
- **必须重启 DSH**：`lib/index.js`、`lib/bridge.js`、`lib/tools.js`、`lib/prompt.js`、`lib/registry.js`、`lib/connection.js`、`lib/companion/**`、`cordis.patch.yml`（挂载时读）、`package.json` 的 `version`（`VERSION` 在模块加载时取）
- 关系：所以「改了参数没反应」先问一句——改的是面板（刷新），还是代码/yml（重启）

## 面板上还没有入口的键（能用、但只能在配置文件里改）
- `mediaDrawDirs`（画图产物目录，`lib/index.js` schema 里有、`getConfig`/`setConfig` 也收，`lib/companion/ext-settings.mjs` 里没有字段）
- `videoSendDepth` / `videoDeepOnSend` / `videoSubtitle`（0.5.40 新增：发前深看的档位、要不要深看、要不要抓字幕；在 `GLOBAL_KEYS` 里能生效，但面板没字段）
- `biliWeight`（B站 来料那轮动不动力气账——只有说明文字提到，没有勾选框）
- `followupEnabled` / `followupPerDay` / `followupMaxHours` / `followupMinSec`（定时话头的四个真旋钮，见 `lib/companion/followup.mjs:69`）

## 改动高危清单（动之前先看这里；每条都是踩过的）
- **加一个配置键**：要同时落在六处 —— schema（`lib/index.js`）/ config 字面量 / `getConfig` / `setConfig` 白名单 / 面板字段 / `lib/settings-remote.js` 的键表；policy 类还要进 `POLICY_KEYS`（`lib/index.js:518`），否则存了不生效。漏任何一处都是「面板显示改了、运行时不认」或「存了重启就丢」。
- **宿主 schema 不是 zod**：`@deepseek-ai/schemastery` 的数组没有 `.optional()`、数字没有 `.int()`；用了就 import 即崩，整套设置页消失（0.5.0 事故）。
- **闸门顺序**（`lib/companion/tick.mjs:183/190/197/200/218/227/230/241/247/252`）：`quiet` 必须在 `riseByTick` 之前（否则一夜攒满）；`limit` 在 `peekInbox` 之前；`binding-off` 永远第一。换顺序 = 静默改行为，测试不一定抓得住。
- **新增「每拍都写」的状态字段**：必须加进 `TICK_OWN_KEYS`（`lib/companion/tick.mjs:36`），否则 `merge()` 收尾时被本拍快照之外的旧值盖掉。
- **新增影响输出的开关**：要进看视频缓存键（`lib/video-look.js:804` 的 `id|depth|SAMPLE_VER|grids|m模型|p提示词版本`），否则老结论继续命中，改了参数看不到变化。
- **新增发文件的工具**：必须走 `fencedMediaPath`（`lib/tools.js:274`），别自己 `realpath` + 读文件 —— `qq_video_look` 当初就是唯一绕开围栏的口子。
- **新增注入/派发路径**：必须显式传角色（`lib/companion/deliver.mjs:37` 按 `group:` / `private:` 定；`bridge.dispatchFollowup(..., role)`），留默认会变成「群里也拿到管理员轮」。
- **新增机制标记**：正则在 `lib/markers.js` 一份，但**网关在三处**——`stripMarkers`（别漏到聊天框）、`noteBubbleMore`（`lib/bridge.js:509`，否则永远不排队）、给会话看的说明（现在这一条是缺的）。`[AT]` 这次就是只改了前两处的一半，网关没放行 → 功能等于不存在。
- **`settings.json` 永久压过 `cordis.patch.yml`**：在面板改过一次的键，回来改 yml 就不生效，得先在「QQ 通道 → 其他 → 清掉面板覆盖」（`POST /api/bubble/settings/clear`）再重启。
- **群预设的每个 insert 都要满足宿主要求的必填项**：`tool-todo` 缺 `allowParallelInProgress` 会让**整个预设挂载失败、静默回退全局工具层**（群聊沙箱从头到尾没生效过，就是这么来的）。改完看启动日志有没有 `agent preset mount failed`。
- **面板是轮询重画**：新增受控输入必须进 `DRAFT` 草稿表 + `sameOr()`，否则打字打到一半被 8 秒一次的刷新吃掉。
- **事件池 `weight` 写 0 会回退成默认份数**：禁用必须 `enabled:false`（`mergePool` 的语义）。
- **新增话头占位符**：`lib/companion/cue.mjs` 的 `PLACEHOLDERS` + `lib/companion/tick.mjs` 的 `buildHint` 传参 + 预览样例，三处都要动，漏一处渲染成空。
- **`/config` 只在「节拍签名」变化时才 `restart()`**（`lib/companion/app.mjs` 的 `schedSig`）：改 `tickMinutes`/绑定会立刻重排，改阈值之类要等下一拍（tick 每拍现读配置）。

## 接口 ↔ 界面（哪个按钮打哪个接口；`lib/companion/app.mjs` 一共 23 个 GET 分支 / 20 个写分支）
- `GET`（23 条）：`/` 与 `/state`（同一个分支，整页）· `/channel` · `/probe` · `/chats` · `/sessions` · `/ext` · `/rolls` · `/bili/login/poll` · `/bili/who` · `/watch` · `/ledger` · `/videos` · `/doctor` · `/setup` · `/setup/token` · `/napcat` · `/napcat/qr` · `/napcat/auto` · `/qq/off` · `/settings` · `/client-config` · `/cue` · `/prompt`
- 写（`POST`，20 条）：`/config`（配置/绑定/事件池）· `/run`（抽一发）· `/reset` · `/card`（发测试卡片）· `/unretire`（解退休）· `/session`（钉/解钉）· `/ext` · `/ext/reveal`（打开目录）· `/rolls` · `/bili/login/start` · `/client-log`（面板崩溃回报）· `/watch/run` · `/videos/block` · `/videos/unblock` · `/qq/off` · `/settings/clear`（清掉面板覆盖）· `/quick`（主人QQ/工作区/表情包目录）· `/napcat/auto` · `/cue/preview` · `/cue`
- 按钮 → 接口：抽一发 `/run`、归零 `/reset`、钉会话 `/session`、解退休 `/unretire`、看二维码 `/napcat/qr`、启动/重启 `/napcat/start|restart`、关掉 QQ `/qq/off`、检查环境 `/doctor`、生成客户端配置 `/client-config`、看固定提示词 `/prompt`、保存 QQ 设置 `/ext`、保存话头 `/cue`、清掉面板覆盖 `/settings/clear`
- 关系：**只有 `POST /config` 会重排节拍**，而且只在「影响定时器排布的那几项」（节拍签名 `schedSig`）变了时才 `restart()`；`/ext`、`/cue`、`/rolls` 这些是就地生效，不重排。
- 两个令牌接口（`/setup/token`、`/client-config`）要求请求头 `x-bubble-panel: 1`，面板自己带；地址栏或外部脚本直接打会 403。

## 已知取舍（不是 bug，别再报）
- 只有 `video` 有准备器 —— 因为只有它能「真去拿东西」，其余的交给会话自己发挥
- `[HOLD]` 照扣权重 —— 她决定不说话，也是花了这次机会
- `[AT 23:30]` 只认钟点、不认日期；那个点过了就不排（不擅自挪到明天）
- `dryRun: true` 时准备器照样真搜真下载真识图 —— 它只影响「发不发出去」，不影响准备阶段（贪便宜会看不到真结果）
- 「这条视频发过了」靠**正文里出现的 BV 号**记（30 天）：随口提一句 BV 也会被记上，`b23.tv` 短链反而记不上
- 群聊不做硬隔离 —— 人格 + 提示词兜底，硬隔离留给可选预设
- 识图与看视频分开配 —— 一个是 3 千 token 快问，一个是 8 千 token 细看
- 卡片分享不发 —— 新版 QQ 拒 ark，改「图 + 文字」
- NapCat 整套留着当后路 —— 主力走 SnowLuma，NapCat 只在需要扫码登录时用

## 验证手段（改完怎么证明）
- `npm test`（245 条）· `npm run guard`（发布守卫）· `node --check`（语法）
- 实跑：`POST /api/bubble/run` 抽一发看真发没发；`GET /api/bubble/state` 看权重与三盏灯
- 日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\host-*.log`