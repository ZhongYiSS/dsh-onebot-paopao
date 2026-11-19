---
title: 泡泡 · 功能与关系全景（0.5.38）
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
- 默认十槽（份数合计 100）：说句话 30 / 刷视频 20 / 找张图 10 / 上网看看 8 / 甩表情包 8 / 发语音 7 / 翻旧账 6 / 提醒哥哥 6 / 唱首歌 5
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
- 回复里可以带三个标记：`[HOLD]`（插件吞掉不发）、`[SCORE n]`（0~12 自评）、`[LATER n]`/`[AT 23:30]`（到点再开口）
- 标记只在**独立成行或结尾**才认（`lib/markers.js`，正则只有一份）
- 关系：`[HOLD]` **照扣权重**（说了不出声也算说过了）；`[SCORE n]` 决定退回多少；`[LATER]` 要过「3 分钟闸门」（刚开口 3 分钟内才能排，防抖）

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
- 来源三选：`keywords` 兴趣词（每个群/会话单独配）/ 热门兜底 / 指定 BV
- 关系：`pickKeywords` 按 `state.keywordCursor` 轮转 → 搜索 → `isBlocked` 过滤（标题/UP/标签/分区/拉黑 mid）→ 补 `view` 拿时长与播放量
- 关系：**口味账** `bubble/taste.json`（`[SCORE]` 10 分 +1、0 分 −1、每轮 ×0.98 衰减）→ 排序
### 一条视频怎么发
- 链接 → `previewMeta` 补标题/封面/UP → `qq_send_video`（或封面图 + 标题 + 链接）
- 关系：**卡片恒失败**（新版 QQ 拒 ark），所以永远是「图 + 文字」
### 一条视频怎么「看」
- `lookVideo` 三档：`quick` 只字幕 / `normal` 5 格 / `deep` 10 格
- 流程：`playurl`(dash) → 分片下载 → ffmpeg 场景检测 → 按变化量采样 → 拼宫格 → 视觉模型逐格描述 → 汇总
- 关系：缓存键含 `深度|采样版本|格数|模型|提示词版本`，**一格没看成就写缓存**是历史 bug（已修）
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
- `bubble/config.json`：面板写、tick 读（两套配置 + 绑定 + 话头 + 事件池）
- `bubble/state.json`：tick/settle 写、面板读
- `bubble/ledger.jsonl`：每笔权重账（涨/扣/退/奖/归零），滚到 8MB 只留末 4 万行
- `bubble/inbox.json` 来料队列 · `bubble/followup-pending.json` 定时话头 · `bubble/bili-seen.json` 去重 · `bubble/taste.json` 口味 · `bubble/videos.json` 发过的视频 · `onebot/chatrolls.json` 聊天强制事件 · `onebot/settings.json` 面板覆盖
- 关系：**插件从不删会话文件**，只写自己这几个

## 接口 ↔ 界面（哪个按钮打哪个接口）
- 读 `GET`：`/state`（整页）· `/ext`（QQ 设置）· `/cue`（话头）· `/rolls` · `/ledger` · `/videos` · `/sessions` · `/setup` · `/napcat` · `/client-config` · `/prompt`（固定提示词）· `/doctor`
- 写 `POST`：`/config`（配置/绑定/事件池）· `/ext`（QQ 设置）· `/cue` · `/rolls` · `/quick`（主人QQ/工作区/表情包目录）· `/run`（抽一发）· `/reset` · `/retry` · `/session`（钉/解钉）· `/qq/off` · `/napcat/start|restart`
- 关系：**每个写接口后面都跟一次 `restart()`**（重排节拍），所以「改完要等一拍才生效」是正常的

## 已知取舍（不是 bug，别再报）
- 只有 `video` 有准备器 —— 因为只有它能「真去拿东西」，其余的交给会话自己发挥
- `[HOLD]` 照扣权重 —— 她决定不说话，也是花了这次机会
- 群聊不做硬隔离 —— 人格 + 提示词兜底，硬隔离留给可选预设
- 识图与看视频分开配 —— 一个是 3 千 token 快问，一个是 8 千 token 细看
- 卡片分享不发 —— 新版 QQ 拒 ark，改「图 + 文字」
- NapCat 整套留着当后路 —— 主力走 SnowLuma，NapCat 只在需要扫码登录时用

## 验证手段（改完怎么证明）
- `npm test`（196 条）· `npm run guard`（发布守卫）· `node --check`（语法）
- 实跑：`POST /api/bubble/run` 抽一发看真发没发；`GET /api/bubble/state` 看权重与三盏灯
- 日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\host-*.log`