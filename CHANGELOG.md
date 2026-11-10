# 更新日志

版本号从 `0.9.6-companion.1` 起改成 `0.2.0`：之前那串是个人自用版，正式对外发的是这条线。

## 0.2.0 — 2026-11-10

第一个以「泡泡 / dsh-PaoPao」名义发的版本。

**改名与发布准备**

- npm 包名 `dsh-onebot-qq` → `dsh-onebot-paopao`（GitHub 仓库叫 `dsh-PaoPao`，npm 只允许小写）；设置页里那一栏改叫「泡泡」。
- 许可证 BSD-3-Clause → MIT；新增 `THIRD-PARTY-NOTICES.md`，把上游 dsh-onebot（BSD-3）与参考过的 dsh-bili-scroll（MIT）两份许可全文放齐，并声明本仓库独立发布、不代表上游。
- `package.json` 补 `author` / `forkOf` / 新的中英描述；`bin` 加 `dsh-paopao-doctor`（旧的 `dsh-onebot-doctor` 保留作兼容）。
- README 中英两份都补「致谢」一节，安装命令、patch 条目名、源码目录名同步改成新名字。
- 新增发布守卫 `scripts/guard-publish.mjs`：`npm publish` 前扫一遍个人痕迹（QQ 号、本机路径、旧网关地址、token、`.bak-*`），并把工具数量与实际注册的核对一遍，对不上就拒发。

**陪伴层（泡泡）**

- 权重机制：每个会话一条权重，按小时自己涨；低于阈值一定不开口，过阈值按概率掷骰；一轮结束后按她自己给的分数结算（0 分被气到、5 分标准、10 分非常满意），他主动起的对话格外加一点分。权重下限、上涨速度、概率上限、限流窗口、免打扰时段都能调，两套预设「日常 / 主动」。
- 九个主动事件（说句话、刷视频、找张图、上网看看、甩表情包、发语音、翻旧账、提醒、唱歌），份数和加分可自己改；插件只递话头，**不代写一个字**。
- 定时话头：`[LATER 25]` / `[AT 23:30]`，每个会话每天限条数、最长 12 小时封顶。
- 积分流水：每一拍、每次加减分都记一笔，按小时折叠，「做过的事 → 积分」里能看净变化、图例和明细。
- B站：按兴趣关键词挑视频、口味账（她打完分后自动调整关键词权重）、黑名单、拉黑 UP 不推；私信 / @我 / 回复我的 有新动静时递话头给会话，回复走 `bili_send_message`。
- 「看视频」工具 `qq_video_look`：quick 只看字幕、normal 五格、deep 十格；先按镜头切分再按画面变化量取帧，没字幕走 faster-whisper 转写。
- 视频分享改成封面 + 标题 + UP + 链接（新版本 QQ 的卡片怎么都点不进 B站，索性不发了）。

**QQ 通道**

- NapCat 快捷控制：设置页能看状态、出二维码、启动 / 重启；启动走隐藏窗口的 VBS，不再黑框闪一下，也不弹「Windows Script Host」错误框。
- 两个保活开关，默认都关：「打开 DSH 就自动拉起 NapCat」（等于免扫码登录 QQ）、「NapCat 掉了自动拉回来」。关着的时候开机不会自动登录，要用就点「启动 NapCat」。
- 二维码加了新鲜度判断：超过 150 秒没更新就直说「这张过期了」，不再拿旧图糊弄。
- 「检查环境」按钮 / `npx dsh-paopao-doctor`：一条命令查 node、ws、canvas、ffmpeg、yt-dlp、python、ASR、B站 凭证、视觉网关、NapCat，缺什么给什么修复命令。
- 设置页的 `convIdleMinutes`（对话间隔，默认 5 分钟）、`inboundBonus`（他先开口的加分）改成可调；配置写回改成按全部全局键整写，不再有「存一次盘把没提到的键抹回默认」的老毛病。

## 0.9.6-companion.1 — 2026-11-04 至 2026-11-10（个人自用）

把刷 B站（`dsh-bili-scroll`）和 QQ 通道（`dsh-onebot`）合成一个插件，只自己用。期间修的一批坑，记在这里免得以后重踩：

- **Windows 跨盘 `renameSync` 报 `EXDEV`** —— 必须 cp + rm。
- **`spawn('cmd.exe', ['/c', '"x.bat" -q …'])` 没给 `windowsVerbatimArguments: true`** —— Node 会重写引号，cmd 收到坏参数直接 exit 1，NapCat 根本没起来。
- **无窗口 `wscript` 跑脚本报错会弹模态框** —— 脚本里必须 `On Error Resume Next`，失败只写日志。
- **`readConfigFromObject()` 用白名单手写**，漏掉的键每次存盘都会被抹回默认 —— 改成按全局键全量写回。
- **`tick.mjs` 只传 profile 没传 globals** —— 关键词、视频参数都是全局键，导致「喜好模式」其实一直走热门兜底。
- **`retired-sessions.json` 里混进正在用的会话** —— 钉自己会被拦、重启会丢会话；已加 `pinnedChats` 豁免。
- **插件收摊时 NapCat 正在 `set_input_status`** —— `WebSocket is not open` 直接 unhandledRejection；改成先 `socket.close(1000, 'dsh-restart')` 再退。
- B站 的 `code=-509 请求过于频繁` —— 请求之间要 `sleep(350)`。
- 识图模型「先想后说」，`max_tokens` 给少了正文会被推理吃光返回空 —— 预算给足、空了翻倍重试。