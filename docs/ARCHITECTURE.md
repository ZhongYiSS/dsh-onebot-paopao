# 泡泡（dsh-onebot-paopao）架构与审计指南

> 面向：接手这个仓库的会话、外部审计、未来的自己。
> 目标：**看完这一份，能独立答出「某个功能在哪、怎么实现的、改哪里、哪里最容易坏」**。
> 版本基线：`0.5.24`（`git log` 最新 `7f71d58`）；`npm test` 145 条；`node scripts/guard-publish.mjs` 过。
> 本文只写「现在是怎么做的」。为什么改、哪次改的，看 `CHANGELOG.md` 和 `D:\AI\蓝色大肥鱼\记忆\变更记录.md`。

---

## 0. 一句话

一个 DSH 插件：**它是 QQ 通道 + 一个「到点提醒某个会话该说话了」的节拍器**。
真正说话的是会话本体（模型 + 人格 + 记忆），插件**一个字都不代写**，只负责「什么时候、给什么话头、发到哪」。

---

## 1. 不可动摇的四条（违反即 bug）

| # | 约束 | 后果 / 判据 |
|---|---|---|
| 1 | **插件不代写正文**。所有要发出去的文字都由会话跑一轮模型产生，插件只递「话头」 | 任何 `lib/` 里拼出来当消息发的中文正文（「今天想你了」这类）都是 bug；模板只允许递词与机制说明 |
| 2 | **人设/记忆/人格属于会话，不属于插件** | `promptExtra` 留空 = 用 `lib/persona-default.js` 那段风格；填了 = 整段替换。插件不许再把「规则」写进代码（分段、句长、冷却曾经这么干过，已全部搬进设置或人格） |
| 3 | **一切「设定」进设置或人格，不硬编码** | 数字必须能在面板改；改不了的东西必须写进文档说明为什么（如 `port`、`preset id`） |
| 4 | **普适化：代码里不许有只在本机成立的东西** | 不许出现本机路径、本机 QQ 号、本机目录里的文件名、只对某个人成立的措辞。`scripts/guard-publish.mjs` 会扫一部分，扫不到的靠审 |

---

## 2. 模块地图

### 2.1 QQ 通道（`lib/*.js`）

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/index.js` | ~1470 | 插件入口：schema（配置面）、`apply()`、`onebotApi`（对外契约）、NapCat 生命周期、`settings.json` 落盘 |
| `lib/bridge.js` | ~1340 | 会话桥：QQ 消息进 → 建/取会话 → 调度；出站前的 `[HOLD]/[SCORE]/[LATER]` 处理；回合事件 |
| `lib/inbound.js` | ~1250 | 入站流水线：解析 OneBot11 → 去重 → 限流 → 权限 → 防抖合并 → 媒体/识图/转写 → 拼成一条用户消息 → `session/event` |
| `lib/outbound.js` | ~570 | 出站流水线：分句/分条/卡片切分、动作限流、发送队列、审计日志 |
| `lib/connection.js` | ~740 | 到 NapCat 的 WS 连接：反连模式（`noServer` + `upgrade` 验路径/Origin/token）、API 调用与超时 |
| `lib/registry.js` | ~1550 | 会话注册表：chatId ↔ sessionId 映射、pin/退休名单、按身份选 agent preset |
| `lib/media.js` | ~470 | 媒体落盘、类型判定、`resolveContainedPath`（围栏判定原语）、`fileToBase64` |
| `lib/media-dirs.js` | ~183 | **发文件围栏**：允许根推导、硬拒清单、`sendRootsFor()` |
| `lib/tools.js` | ~790 | 17 个 QQ/哔哩哔哩工具的实现与出站围栏 |
| `lib/commands.js` | ~1200 | 斜杠命令（`/new` `/reset` `/steer` …）、`unwrapUserMessageText` |
| `lib/cq.js` | ~350 | CQ 码、@ 检测、引用/转发解析、share 摘要 |
| `lib/chat.js` | ~157 | chatId 解析、`roleOf`、`dmAllowed`、`groupAllowed`、`[群成员]` 前缀常量 |
| `lib/napcat.js` | ~171 | NapCat 纯函数：目录推断、启动命令、VBS 脚本、二维码信息、进程表解析 |
| `lib/proc.js` | 116 | 进程枚举/查杀（`listProcs/findNapcat/killTree/waitGone`），不碰 `QQ.exe` |
| `lib/vision.js` | ~161 | 识图客户端（OpenAI 兼容）+ `parseHeaderJson` |
| `lib/video-look.js` | ~960 | 看视频：下载 → 场景切分 → 抽帧 → 宫格 → 逐格问模型 → 汇总 |
| `lib/settings-remote.js` | ~460 | 设置页 Remote：字段白名单、schema、补丁校验 |
| `lib/doctor.mjs` | — | 环境体检（`bin/doctor.mjs` + `GET /api/bubble/doctor`） |

### 2.2 陪伴（`lib/companion/*.mjs`，23 个 + `adapters/`）

| 文件 | 职责 |
|---|---|
| `app.mjs`（~1520） | 思路中枢：`mountCompanion()`、配置读写、四个钩子、ticker 装配、**全部 HTTP 路由** |
| `tick.mjs`（388） | 抽卡：`createTicker()` / `tickOne()`，一拍一次判定 |
| `weight.mjs` | 权重数学：`clamp/riseByTick/canSpeak/triggerChance/refundPct/settle/spend/release` |
| `events.mjs` | 事件池：十槽默认份数、`drawEvent`、`mergePool`、`seedPool` |
| `cue.mjs` | 话头模板：占位符、固定尾注、`renderCue`、`previewSamples` |
| `prompt.mjs` | 把「话头 + 候选 + 机制说明」拼成注入文本（`buildHint`） |
| `deliver.mjs` | 投递：dry-run / 走 `onebotApi.dispatch` / 掉线拒发 |
| `bridge-link.mjs` | 找 QQ 插件：`ctx.get` → `ctx.root.get` → `globalThis.__DSH_ONEBOT__` |
| `state.mjs` | 落盘原语：`readJson/writeJson`（原子）、buckets、history、scores |
| `limit.mjs` | 滑动窗口限流 + 距离下次可发多久 |
| `period.mjs` | 时段划分与免打扰（`24:00` 合法） |
| `inbox.mjs` | 来料收件箱（B站 动静先落这里，等下一拍照话头注入） |
| `followup.mjs` | 定时话头（`[LATER n]` / `[AT hh:mm]` 的定时器与配额） |
| `chatroll.mjs` | 「聊天强制事件」：每轮独立掷，抽到就注入「这轮必须…」 |
| `taste.mjs` | 口味帐：哪个 UP/关键词给过高分 |
| `ledger.mjs` | 积分流水（`ledger.jsonl`，8MB/60 天滚动，小时折叠） |
| `bili-watch.mjs` | B站 消息监听：私信/`@我`/回复我的 → `pushInbox` |
| `bili-login.mjs` / `bili-paths.mjs` / `bili-act.mjs` | B站 登录二维码、凭证路径、点赞投币等动作 |
| `ext-settings.mjs` | 设置页字段表（`BILI_FIELDS` / `QQ_FIELDS`）与读写归一化 |
| `video-log.mjs` | 发过的视频账（`videos.json`，防重复发） |
| `adapters/bili.mjs` | 唯一有「准备器」的事件：挑视频（关键词/热门/详情补全/口味/去重/降级） |

---

## 3. 运行时链路（时序）

### 3.1 主动开口：一拍一次

节拍来源：`app.mjs` 的 `ticker`，间隔取**所有开启绑定里最短的 `tickMinutes`**，但每拍的 `tickOne` 只处理「自己这一套配置到点」的会话（`gap - 5000ms` 容差）。

`tick.mjs` 的 `tickOne(b, buckets, t, force, dryRun, fresh, biliWeight, followup, globals)` 顺序**固定**，改顺序会改语义：

```
⓪.0  绑定关（enabled === false）           → skip('disabled')
⓪.0b QQ 总开关关（qq-off.json）            → skip('qq-off')，不记账
①.5  没到点                                → skip('not-due')
②    免打扰（quiet）                       → skip('quiet')，**不涨权、不记账**
③    riseByTick(w, profile.risePerTick, floor)
④    跨天：todayCount 归零
④.5  idleCheck（他多少分钟没动静）          → skip('idle')
⑤    pruneWindow + 限流（N 小时 M 条）      → skip('limit')
⑥    来料优先（peekInbox）/ 追聊（followup） → 有就不用抽卡
⑦    阈值：canSpeak(w, threshold)           → skip('below')
⑦'   掷骰：triggerChance(w, threshold, pmax) → skip('dice')
⑧    drawEvent(mergePool(pool))              → 抽一个事件
⑨    addBonus(w, ev.bonus)
⑩    prepare(adapter)                        → 只有 video 有真准备器
⑪    buildHint({cue, event, candidates…})    → 话头文本
⑫    deliver({chatId, text, origin:'bubble'})
⑭    记账：ticks.jsonl / history.jsonl / ledger.jsonl
```

**关键实现细节**

- `merge()`：这一拍写回 buckets 时**只写本拍产生的增量**（`w` 用 `w - wStart` 加回去、buckets 重新读盘合并），因为同一时间段 `turn/end` 可能刚刚扣过分 —— 直接整份覆盖会把扣分盖掉（曾经的真 bug）。
- 涨权**只在 ③ 发生**：免打扰、绑定关、QQ 关都不涨。
- 抽卡那轮 `origin === 'bubble'`，**结算时不吃分**（见 3.2）。

### 3.2 回合结束结算（`turn/end`）

`app.mjs` 的 `setTurnHook((chatId, meta) => …)`，**当场算**，不等下一拍：

```
origin = meta.origin   // 'bubble' | 'inbox' | 'followup' | 'user' | 'host'
if (origin === 'inbox' && cfg.biliWeight === false) return   // 来料不动账
if (origin === 'followup') return                            // 追聊不扣不结
binding 关 / 无 profile / releaseBase 非法 → return
① w = spend(w, base, {floor})      记 ledger kind:'spend'
② sc = readScore(chatId)；fresh = sc.at > bucket.lastSettleAt && ≤24h
   scoreCounts = origin !== 'bubble' && origin !== 'followup'
   if (fresh && scoreCounts) w = settle(w, score, {base, floor, inbound, inboundBonus})
   记 ledger kind:'settle'，并 bumpTaste()
③ bucket.lastSettleAt = sc.at; lastSpendAt = now; lastSpendOrigin = origin; w
```

**`inbound` 的定义**：`chat.activeTurnOrigin === 'user'`（`turn/start` 时冻在 chat 上，`bridge.js` 的 `noteBubbleScore` 读它）。只有「他找上来的那一轮」才吃 `inboundBonus`。

### 3.3 来料与追聊

- **来料**（B站 私信/@/回复）：`bili-watch.mjs` → `pushInbox(home, chatId, items)` → `inbox.json` → 下一拍照话头里带「B站 有动静」，`origin: 'inbox'`。
- **追聊**（会话自己写 `[LATER 25]` / `[AT 23:30]`）：`followup.mjs` 起 `setTimeout`（`unref`），到点 `ticker.tick(chatId, {followup:true})`；受 `followupPerDay` / `followupMaxHours` 约束，**只受免打扰管、不受限流管**；`restore()` 会把过点的挪到 5 秒后。

### 3.4 消息进出 QQ

入站（`lib/inbound.js` `processInbound`）：解析事件 → `duplicated()` 去重（300 秒窗口）→ `rateLimited()` → 权限（`roleOf`）→ 命令识别 → 防抖合并（`debounceMs`，同 chat 排队）→ 媒体落盘/识图/OCR/转写 → `buildBody()` → 加 `[群成员]` 前缀（非管理员且开关开）→ 包 `<user_message>` 边界 → 交给会话。

出站（`lib/bridge.js` `sendToChat`）：`noteBubbleScore`（收 `[SCORE]`）→ `chat.bubbleHold` 判 `[HOLD]`（整轮不发，返回 `[]`）→ 剥 `[HOLD]/[SKIP]/[LATER n]/[SCORE n]` → `noteBubbleSent`（记账）→ `outbound.sendToChat`（分句/分条/卡片）。

---

## 4. 权重模型（数学定义）

```
w ∈ [-100, 100]，每套配置有自己的地板 wFloor（默认 -20，可到 -100）
每拍      w += risePerTick                       （不越过 W_MAX = 100）
硬门槛    w < threshold  → 概率恒 0
概率      p = triggerPmax × w / 100              （只有过门槛后才可能 >0）
扣分      w -= releaseBase                       （在「一轮结束」时，见下）
补分      w += refundPct / 100 × releaseBase     （同上）
```

**扣分不是「开口那一刻扣」，而是「一轮结束就扣」**（哥哥 11-10 定）：
`spend(w, releaseBase, {floor})`，发没发都扣，`[HOLD]` 也照扣；抽卡轮、追聊轮、来料（`biliWeight:false`）按 §3.2 的特例走。

**补分**：`refundPct(score, {inbound, inboundBonus})`

```js
REFUND_PCT = [-100, -80, -60, -40, -20, 0, 20, 50, 60, 80, 120, 150, 200]  // 13 档
SCORE_MAX = 12
s = clamp(round(score/10 + (inbound ? inboundBonus : 0)), 0, 12)
补分 = REFUND_PCT[s] / 100 × releaseBase
```

即：5 分 = 0%（不补不追）；10 分 = +120%（补回 1.2 倍那一格）；11/12 分 = +150% / +200%；0 分 = -100%（那一格全追回）。
`inboundBonus` 在**每套配置**里（日常 +1、主动 +3），允许负数。

**两套预设**（`app.mjs:66-74`，`defaultConfig()` 产出）

| 键 | 日常 | 主动 |
|---|---|---|
| `threshold` | 30 | 0 |
| `risePerTick` / `tickMinutes` | 2 / 5 | 3 / 3 |
| `triggerPmax` | 0.1 | 0.5 |
| `releaseBase` / `wFloor` | 40 / -50 | 30 / -20 |
| `limitHours/limitMax` | 1 / 20 | 1 / 30 |
| `idleMinutes` | 3 | 1 |
| `inboundBonus` | 1 | 3 |
| `quiet` | 00:00–09:00 | 02:00–09:00 |

**每个会话绑定一套配置**（`bindings: [{chatId, profileId, label, enabled}]`），面板上可改可改名。

---

## 5. 标记协议（会话写在正文里，插件在发送前处理）

| 标记 | 谁读 | 语义 | 代码位置 |
|---|---|---|---|
| `[HOLD]` | `bridge.bubbleHoldsTurn` + `sendToChat` | 这一轮**一个字都不发**（但分照收、账照扣） | `lib/bridge.js:545` |
| `[SCORE n]` | `bridge.noteBubbleScore` | 她给这一轮打 0~12 分，插件剥掉不发 | `lib/bridge.js:513` |
| `[LATER n]` / `[AT hh:mm]` | `bridge.noteBubbleMore` → `followup.request` | 过 n 分钟 / 到点再叫醒一轮 | `lib/bridge.js:494` |
| `[SKIP]` | —— | **已删除**，只剩发送前顺手剥掉（老回复残留） | `lib/bridge.js:466` |

闸门（防止自己半夜给自己排卡）：
- `[LATER]` 只认「他 3 分钟内说过话」的那一轮，同轮 60 秒去重；
- 抽卡轮（`origin === 'bubble'`）不算分；
- `[HOLD]` 只认文本块里独立出现的标记。

---

## 6. 话头（cue）—— 用户可编辑的模板

`lib/companion/cue.mjs`

- `DEFAULT_CUE = { template, candidatesTitle, empty }`，模板里可用占位符：
  `{{line}}`（这一轮的词 = 事件的 label）、`{{hint}}`（事件下自己填的补充）、`{{period}}`、`{{weight}}`、`{{count}}`、`{{quiet}}`、`{{candidates}}` 等（见 `PLACEHOLDERS`）。
- **固定尾注**由代码追加，用户改不掉：
  - `FIXED_FOOTER`：`不想发就写 [HOLD]，插件会替你吞掉。`
  - `TICK_FOOTER`：`本轮不用打分。`（只在抽卡轮）
- `stripFixed()` 负责把老配置里手写进去的固定句洗掉，避免重复。
- `previewSamples()` 给面板提供四份预览（有候选/没候选/追聊/来料）。
- 渲染入口：`prompt.mjs` 的 `buildHint()` → `renderCue()`。

> 设计史：先做过「模板语言 + 12 句台词表」，被哥哥否掉（太复杂、且与事件页重复），最后就是「模板 + 占位符 + 两条固定说明」。

---

## 7. 事件池

`lib/companion/events.mjs`

十槽默认份数（合计 100，`seedPool()` 填默认词；**label 默认全空 = 交用户填**）：

| id | label 默认 | weight | bonus | adapter |
|---|---|---|---|---|
| `chat` | 说句话 | 24 | 3 | chat |
| `video` | 去b站找个视频 | 18 | 5 | bili |
| `meme` | 甩个表情 | 10 | 4 | — |
| `image` | 找张图 | 10 | 4 | — |
| `voice` | 发条语音 | 8 | 5 | — |
| `web` | 上网看看 | 8 | 4 | — |
| `joke` | 讲个笑话 | 8 | 4 | — |
| `memory` | 翻旧账 | 6 | 4 | — |
| `remind` | 提醒哥哥 | 8 | 8 | — |
| `sing` | 唱首歌 | 5 | 6 | —（默认 `enabled:false`） |

规则：
- `drawEvent(pool)` 按份数加权抽；`isLive(e)` 要求 `enabled !== false` 且 `label` 非空。
- **`mergePool` 里 weight 写 0 会回退成默认份数**（想禁用必须 `enabled:false`）——这是坑，别改。
- 只有 `video` 有真「准备器」（`adapters/bili.mjs`），其余八槽**只递词**，怎么做由会话自己决定（这正是「普适化」的落点）。
- `hint` 上限 80 字（`HINT_MAX`），只作补充说明，不写做法。

---

## 8. 会话桥（`onebotApi`，`lib/index.js`）

陪伴侧通过 `resolveOnebot(ctx)` 找到它（三级兜底），只调用下面这些方法：

```
dispatch(chatId, text, role, nickname, origin)   让该会话真跑一轮并把回复发到 QQ
lastActivityAt(chatId) / lastInboundAt(chatId)   空闲判定
getConfig() / setConfig(patch)                   运行时配置（含 applied 回执）
status()                                         { connected, selfId }
setScoreHook / setTurnHook / setMoreHook / setSentHook
sendCard / sendSegments / callAction             NapCat API 直调
listChats / sessionTable / currentSessionId
pinSession / unpinSession / retryPendingPins / retiredSessions / unretireSession
setupInfo / plainToken / napcatStatus / napcatQr / napcatStart / napcatRestart
napcatAutoStatus / setNapcatAuto / qqOff / qqOffStatus / setQqOff / napcatCheck
```

四个钩子的语义（**改这里就会改变权重语义**，谨慎）：

| 钩子 | 触发点 | 参数 |
|---|---|---|
| `setScoreHook` | 读到 `[SCORE n]` | `(chatId, score10, {inbound, origin})`，score 已 ×10 |
| `setTurnHook` | `turn/end` | `(chatId, {origin})` |
| `setMoreHook` | 读到 `[LATER]` 且闸门通过 | `(chatId, text)` |
| `setSentHook` | 真正发出去之后 | `(chatId, text)` |

`dispatch` 的 `origin` 一路带到 QQ 侧（`bubble` / `inbox` / `followup` / `user`），**别在半路折成 `bubble`**（曾经的真 bug）。

---

## 9. QQ 通道实现

### 9.1 连接 NapCat

- 只支持**反连**模式：插件起一个 WS 服务（默认 `port: 8643`），NapCat 连进来。
- `lib/connection.js` 用 `noServer` + `upgrade`，先验**路径 / Origin / token** 再交握（401/403/404）。空 token 会自动生成并落盘（`lib/token.js` → `$DSH_HOME/onebot/access-token.json`）。
- **`address()` 在反连模式必须走 `this.reverseHttp?.address()`**（`WebSocketServer` 自己没有 `address()`，直接调会抛 `The server is operating in "noServer" mode` —— 曾导致 `/setup` 整块消失）。
- `status().connected` 是「连接是否可用」的唯一判据；`catch` 里必须返回 `connected:false`，不能返回 `null`（投递侧判的是 `=== false`）。

### 9.2 权限（三级身份 → 三个预设）

```
adminUsers（含 ownerQQ 合并）  → 完全权限（agentPreset，默认 standard/当前会话预设）
私聊 + 非管理员 + dmRestricted → restrictedPreset（留空沿用 groupPreset）
群聊                          → groupPreset（默认 qq-group，无 shell/terminal/写文件）
```

- `lib/chat.js` `roleOf(chatId, userId, policy)` 是唯一判据；`dmAllowed` / `groupAllowed` 在**每次投递前**都要复检（不是建会话时判一次）。
- **fail-closed**：预设解析不出来就 `throw blocked`（`blocked.presetBlocked = true`），**绝不静默退回完全权限**。`groupPreset` 留空也算解析失败。
- `[群成员]` 前缀（`lib/chat.js` 的 `RESTRICTED_PREFIX`）加在群成员消息上，提示词里据此区分「他说的话」与「主人下的命令」。老别名 `[受限用户:仅问答]` 只作兼容剥离。
- `POLICY_KEYS` 命中时，`setConfig` 会就地 `Object.assign(bridge.deps.policy, resolvePolicy(cfg))` —— 策略是 `apply()` 时算一次的常量，不重算就是「存上了不生效」。

### 9.3 发文件围栏（`lib/media-dirs.js` + `lib/tools.js`）

先看**谁在要**，再看**文件在哪**：

| 身份 | 允许的根 |
|---|---|
| 管理员那一轮 | **不设目录围栏**（返回 `null`），只有硬拒清单 |
| 群成员 / 私聊白名单 | 插件媒体目录、`$DSH_HOME/media`、系统临时目录、会话工作区（`groupMediaWorkspace`，默认开）、`mediaFreeDirs` |

**硬拒清单**（谁都拒，白名单写了也拒）：
`$DSH_HOME/sessions`、`profiles`、`onebot`、`$DSH_HOME` 根下文件、`credentials.yaml` 一类、
`storages/session_projcache`（会话原文）、`storages/dsh-context`、`cache/attachments`（请求附件）、`bubble/bili`（B站 凭证）、
`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gcloud`、`AppData/*/Microsoft/{Credentials,Protect,Vault}`、
名字像 `.env` / `credentials*` / `id_rsa*` / `*.pem|p12|pfx|kdbx|key` / `.npmrc` / `.git-credentials`。

三关（`fencedMediaFile`）：`realpath` 失败 → **先判围栏再列目录**（防用报错探测目录）；硬拒 → 抛出；`roots !== null` 时 `resolveContainedPath` 为空 → 抛「不在能发的范围里」。
「没 chat 的 session 一律算成员」（`bridge.mediaSendRoots`），不许因为拿不到 chat 就放行。

### 9.4 NapCat 生命周期

- `napcatAutoStart` / `napcatAutoRestart` 存 `$DSH_HOME/onebot/napcat-auto.json`（文件优先于 yml）。
- 启动走 `wscript.exe` + 生成的 `.vbs`（隐藏窗口）。**VBS 必须写成 UTF-16LE + BOM**（`Buffer.from('\ufeff'+script,'utf16le')`）；写 UTF-8 BOM 会让 `wscript` 挂死（实测 exit 124、脚本都不生成）。
- 二维码：`<napcatDir>/cache/qrcode.png`，`QR_STALE_SEC = 150` 秒内才算新。
- 总开关：`$DSH_HOME/onebot/qq-off.json`，关着就不连、也不自动拉起。
- 进程判据用 `lib/proc.js`（名字 ∪ 路径），**不许全机 `taskkill QQ.exe`**。

### 9.5 工具（17 个）

`bili_coin` `bili_comment` `bili_fav` `bili_like` `bili_pick_video` `bili_send_message`
`qq_group_history` `qq_napcat_api` `qq_proactive_start` `qq_proactive_stop`
`qq_send_card` `qq_send_file` `qq_send_forward` `qq_send_image` `qq_send_video` `qq_send_voice` `qq_video_look`

- 写操作类（`bili_like/coin/fav/comment/send_message`、`qq_napcat_api`、`qq_proactive_*`）**必须 `requireAdminCaller` / `isAdminChat`**：群成员不能借机器人去动主人的号。
- `resolveChat` 必须校验「谁在发」——群成员不许指定 `chat_id: private:<主人>` 往主人私聊塞东西。
- `qq_napcat_api` 有方法白名单，且**只在主人私聊可用**。

---

## 10. 配置体系（最容易出错的地方）

### 10.1 三处来源，优先级从低到高

1. **schema 默认值**（`lib/index.js` 的 `Config`）
2. **profile 的 `cordis.patch.yml`**（`C:\Users\...\.dsh\profiles\<name>\cordis.patch.yml`，改完要重启）
3. **设置页 → `$DSH_HOME/onebot/settings.json`**（`writeSettings`，**永久压过 yml**，目前没有「恢复 yml 值」入口）

陪伴自己另有一套：`$DSH_HOME/bubble/config.json`（`readConfig/writeConfig`，原子写）。

### 10.2 新增一个配置键，必须同时改六处（少一处就是 bug）

1. `lib/index.js` 的 **schema**（`z.xxx().default(...).description(...)`）
2. `lib/index.js` 的 **`config: { ... }`** 字面量（`ChatBridge` 构造参数，12 空格缩进那块）
3. `lib/index.js` 的 **`getConfig()`** 返回（陪伴面板读它）
4. `lib/index.js` 的 **`setConfig()` 白名单**
5. `lib/companion/ext-settings.mjs` 的 **`QQ_FIELDS`**（面板字段）
6. `lib/settings-remote.js` 的 **`ALL_KEYS` / `BOOLEAN_KEYS` / `STRING_KEYS` / `SCHEMA_DEFAULTS`**，以及 `lib/client.js` 的 `configSchema` / `patchSchema` / `DEFAULTS`

> 5 与 6 缺一个的后果：面板字段被当成「幽灵键」→ 宿主 `validatePatch` 整单拒收 → **这次保存一个键都没写进去**（真发生过，`dmRestricted`）。

### 10.3 `@deepseek-ai/schemastery` 的坑

数组 schema **没有** `.optional()` / `.describe()` / `.int()`；用了就是插件 import 时崩、设置页整块消失。
一律 `.default([])` / `.description()`。

### 10.4 陪 伴配置的全局键

`GLOBAL_KEYS`（`app.mjs`）是「整份配置上的键」（关键词、视频筛选、cue、followup 参数…）。
`readConfigFromObject()` 按 `GLOBAL_KEYS` 全量写回 —— **新加全局键忘了登记，保存一次就被抹回默认**（踩过 11-08、11-10 两回）。

---

## 11. 运行期数据文件

`$DSH_HOME/bubble/`

| 文件 | 内容 | 滚动 |
|---|---|---|
| `config.json` | 陪伴配置（`enabled/dryRun/profiles/bindings/globals`） | 原子写 |
| `state.json` | 每会话 bucket：`w / todayCount / lastSentAt / lastSpendAt / lastSpendOrigin / lastSettleAt / window / lastPicks / keywordCursor` | 原子写 |
| `scores.json` | 最近一次 `[SCORE]`（`{score, inbound, at, origin}`） | 原子写 |
| `history.jsonl` | 每拍/每次开口记录 | 追加 |
| `ledger.jsonl` | 积分流水（`spend/settle/rise/bonus/tick/reset`） | 8MB 滚到末 40000 行、留 60 天 |
| `ticks.jsonl` | 逐拍明细（调试用） | 512KB 滚 |
| `inbox.json` | 来料收件箱（按 chatId 分桶） | 原子写 |
| `followup-pending.json` / `followup.jsonl` | 定时话头队列 / 日志 | 原子写 / 追加 |
| `taste.json` | 口味帐（UP mid / 关键词分数，`DECAY 0.98`） | 原子写 |
| `videos.json` | 发过的/拉黑的视频（`blocked`） | 原子写 |
| `bili-seen.json` | B站 消息去重账本 | 原子写 |
| `video-cache.json` | 看视频结论缓存（键含 `模型 + PROMPT_VER + 采样版本`） | 原子写 |
| `bili/bili_credential.json` | B站 凭证（sessdata 等） | —— |

`$DSH_HOME/onebot/`：`settings.json`、`access-token.json`、`napcat-auto.json`、`qq-off.json`、`chatrolls.json`、`vision-cache.json`、`tools.json`（外部程序路径）。
`$DSH_HOME/media/onebot/`：会话映射 `chat-sessions.json`、pins、退休名单。

---

## 12. HTTP 接口（`/api/bubble/*`，`lib/companion/app.mjs`）

读：`/state` `/channel` `/probe` `/chats` `/sessions` `/ext` `/rolls` `/watch` `/ledger` `/videos` `/doctor` `/setup` `/setup/token` `/napcat` `/napcat/qr` `/napcat/auto` `/qq/off` `/cue` `/prompt` `/bili/login/poll` `/bili/who`
写：`/config` `/run` `/reset` `/card` `/session` `/unretire` `/ext` `/ext/reveal` `/rolls` `/watch/run` `/videos/block` `/videos/unblock` `/cue` `/cue/preview` `/client-log` `/napcat/start` `/napcat/restart` `/napcat/auto` `/qq/off` `/bili/login/start`

约定：
- 统一 `{ ok: true, ... }` / `{ ok: false, error }`；
- 读接口**失败也要把原因回传**（`error` 字段），界面据此显示「读不到，因为…」而不是整块消失；
- 写配置要落到磁盘（`writeConfig` / `writeSettings`），不能只改内存。

---

## 13. 界面结构（`lib/client.js`，4300 行，内嵌进设置页）

三个顶层页签（`CombinedPanel`）：

1. **泡泡** — 子页签 `总览 / 设置 / 话头 / 说明`
   - 总览：三盏灯（连接 / 登录 / QQ 在线）、`NapCat / QQ 登录` 独立卡（启动/重启/看二维码/关掉 QQ + 三个保活开关 + 二维码图）、`SetupChecklist`、会话卡（名字可点改、权重条、上次开口、窗口 N/M、归零、抽一发）
   - 设置：`AccessWarn` 一句人话 + 权重参数（跟当前配置走）+ 事件池 + 聊天强制事件
   - 话头：模板框 + 占位符圆片 + 四份预览 + 保存/恢复默认
2. **B站与视频** — B站 登录/账号、挑视频参数、发过的视频、看视频参数
3. **QQ 通道** — 总开关、七组设置（识图/人设/互动/群聊/主动/看视频/其他，含权限组）、检查环境

会话头还有一个 tab：**做过的事**（聊天 / 积分 / 视频 三视图）。

界面规矩：
- **不许「数据没来就整块不渲染」**——要么用别处数据兜底，要么显示「读不到，因为 X，点这里重读」；
- 轮询刷新时用 `sameOr()` 复用旧对象、`isTyping()` 跳过正在输入的框，否则用户打一半就被清空；
- `[data-bb-*]` 属性选择器样式都很宽，新组件别复用同名属性。

---

## 14. 已知薄弱点 / 刻意取舍（审计从这里下手）

**已知未修（留给下一轮）**

1. `lib/inbound.js:431` 关键词冷却在「命令 / 限流 / 空内容」判定**之前**消费 —— 被丢弃的消息也吃冷却。
2. 图额度按「条」不按「轮」：连发 N 条各带 1 图，等于 N 张；`recentImageNote` 还能再白看 1 张。
3. `setConfig` 不做 schema 校验：字符串 / `NaN` 直接进内存（不崩，但会静默失效）。
4. `queueNoticeEnabled` 是死键（schema / 面板 / 代码三面皆无）。
5. `mergePool` 的 `label` 语义与注释相反（注释说「空 = 用默认」，实际空就是空）。
6. `/state` 的 `cfg` 仍带 4 个已废弃的 `followup*` 键。
7. `POST /config` 每次都 `restart()` 重排 ticker（频率不高，但有抖动）。
8. `/setup/token` 回明文令牌；`sameOriginOk` 在**没有 Origin 头**时直接放行。
9. `settings.json` 永久压过 yml，且面板没有「恢复 yml 值 / 删掉这个键」的入口。
10. `readBody` 收到坏 JSON 静默当 `{}`：`POST /cue` 会把话头重置成默认并落盘；`/ext` 空 body 回 `ok:true`。
11. `POST /config` 对 `body.profiles` 零校验：`{"profiles": []}` 照收 → 下次读配置回默认分支、绑定全指向第一个 profile。
12. `videoVision*` 与 `vision*` 两套视觉配置是**有意分开**的（单图 3000 token / 40 秒；宫格 8000 token / 180 秒），但字段多，容易配漏。
13. `lib/client.js:1316` 的 `loadExt` catch 是空的（B站 页「看视频」组可能显示「读不到这组设置：undefined」）。
14. `ChatRollsCard` 乐观更新，失败不回滚。

**刻意取舍（不是 bug，别改）**

- 事件池只有 `video` 有准备器：其余八槽「只递词」，因为做法由会话决定（普适化要求）。
- `[HOLD]` 也照扣权重：哥哥认可（这一轮确实占了她的注意力）。
- 追聊不扣不结：追聊是她排队等着的补充，纯亏会让她不敢排。
- 抽卡轮不吃分：防止抽卡轮随手给分刷权重。
- 群聊/私聊非管理员进受限预设，但**没做硬隔离**（工具仍在表里）：靠人格 + 提示词兜底，预设只做默认收口。

---

## 15. 怎么验证

```bash
cd D:/AI/聊天/dsh-onebot
npm test                        # 145 条
node scripts/guard-publish.mjs  # 发布前检查（本机痕迹、工具清单、依赖声明）
node bin/doctor.mjs             # 环境体检（node/ws/canvas/fontkit/ffmpeg/bili/vision/napcat）
```

运行期（宿主开着）：

```bash
curl -s http://127.0.0.1:<GUI端口>/api/bubble/state   | head -c 400
curl -s http://127.0.0.1:<GUI端口>/api/bubble/doctor
curl -s http://127.0.0.1:<GUI端口>/api/bubble/setup
curl -s http://127.0.0.1:<GUI端口>/api/bubble/ext
```

真发一条（会真的发到 QQ）：`POST /api/bubble/run`（body `{"chatId":"private:<qq>","force":true}`）。
干跑：配置里 `dryRun: true` 时 `/run` 只写日志。

**静态 import 的模块要重启宿主才生效**：`lib/index.js`、`lib/bridge.js`、`lib/prompt.js`、`lib/tools.js`、`lib/companion/app.mjs`、`lib/registry.js`。
`lib/client.js` 是客户端产物，**改完点界面上的「刷新」**即可（不用重启）。

---

## 16. 审计清单（建议按这个顺序过）

**A. 陪伴核心**
- [ ] `tick.mjs` 的十步顺序有没有被改动？`merge()` 是否真的只写增量？
- [ ] `weight.mjs` 的 `floor` 有没有在每条路径上传下去？（少传 = 日档 -50 被抬成 -20）
- [ ] `turn/end` 的 `spend` 与 `settle` 是否都用同一个 `base`？`fresh` 判据（24h 且新于 `lastSettleAt`）有没有被绕过？
- [ ] `origin` 一路有没有被折成 `bubble`？（`deliver` → `dispatch` → `bridge` → `turn`）
- [ ] `inbox` / `followup` 的特例有没有漏（来料不动账、追聊不扣不结、抽卡不吃分）？

**B. 配置面**
- [ ] 新增键是否六处齐全（见 §10.2）？跑 `npm test` 里那条「面板字段 ⊆ setConfig 白名单」。
- [ ] `GLOBAL_KEYS` 是否包含所有「整份配置上的键」？
- [ ] 有没有键是「面板能改、服务端不认」或「服务端读、面板写不进」？

**C. 权限与围栏**
- [ ] 每个写操作工具是否都过了 `requireAdminCaller` / `isAdminChat`？
- [ ] `resolveChat` 是否校验「谁在发」？
- [ ] 预设解析失败是否 fail-closed？`groupPreset`/`restrictedPreset` 留空是否也算失败？
- [ ] 硬拒清单能不能被 `..`、符号链接、大小写、UNC 路径绕过？
- [ ] 报错信息会不会泄露目录内容？

**D. 界面**
- [ ] 有没有「数据为空就整块不渲染」的地方？
- [ ] 每个 `jget/jpost` 是否都有对应路由、失败是否显示原因？
- [ ] 轮询会不会清掉用户正在输入的内容？

**E. 普适化**
- [ ] 全库 grep 本机痕迹：盘符路径、QQ 号、`1094335744`、`蓝色大肥鱼`、具体表情包文件名、别人的账号名。
- [ ] 提示词里有没有「只有本机才有」的东西（记忆路径、点歌、嗓子、群里写文件）？

---

*最后更新：0.5.24（2026-11-14）。改代码时顺手改这份文档，别让它过期。*
