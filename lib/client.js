/**
 * dsh-onebot — client bundle（QQ Bot 设置面板，T4 · T1 定案 B 路径）
 *
 * 结构模板：dsh-expert-orchestrator/lib/client.js（CJS 包裹 + slots/remote 挂载模式），
 * 业务与契约全部对齐本仓库 docs/settings-page-design.md（T1 定案）与宿主侧
 * lib/settings-remote.js（T3 实现）。契约唯一来源：T1 §3 / §3.1 / §4 / §5。
 *
 * 宿主装载契约（对照 0.1.7-alpha.2 dsh-client-modules 校验与 expert-orchestrator 先例）：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 仅 react（平台冻结模块表）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
 *     {name, key, locale}, render))`（keyed，key = 组合包 npm 包名）。
 *   - 数据通道：Typert Remote（`ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE)` 后
 *     `ctx.get('remote.onebotSettings')`）；所有读写经 Remote 调 host 侧，host 经
 *     configEditor.edit 写 profile patch 中 dsh-onebot 条目的 config 覆盖行
 *     （T1 §3：设置页/手改 patch/宿主原生设置页三方同源）。
 *
 * descriptor 同步说明（重要）：宿主侧 lib/settings-remote.js（T3）导出的是
 * SETTINGS_GROUPS / SCHEMA_DEFAULTS / SECRET_KEYS / 服务实现，**未导出客户端
 * Typert descriptor 数组**（descriptor 是浏览器侧 client bundle 的挂载清单，
 * host 侧服务经原型发现注册，两侧各持一份）。因此本文件内联定义
 * ONEBOT_SETTINGS_DESCRIPTORS，并以下述不变量与宿主侧逐字对齐（由
 * tests/client-settings.spec.ts 对 src/settings-remote.js 的导出常量断言）：
 *   - namespace/service = `onebotSettings`（T1 §4）；
 *   - 方法集 = getSettings() / updateSettings(patch, expectedRevision) /
 *     listWorkspaces()（W7：只读查询宿主 workspace 注册表，{available, workspaces:
 *     [{id,path,sessionCount}]}；registry 缺席降级 available:false 不抛错），
 *     全 positional（宿主网关 methodParameterNames 拒绝解构/默认值/rest）；
 *   - 快照结构 = T1 §3 OnebotSettingsSnapshot（revision/entryActive/config(29 键)/
 *     secrets/groups/effect='restart'），accessToken 恒 ''（脱敏，T1 §3）；
 *   - 四组 29 键分组与 schema 默认值 = T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy
 *     = src/settings-remote.ts 常量。
 * 任一侧变更 descriptor/分组/键集/默认值时，必须同步本文件并在 DEVLOG 记录。
 *
 * 生效语义（T1 §5）：19 键统一「保存即热生效」——插件 fiber 秒级原地重启，
 * QQ 桥（NapCat ws-reverse/forward）自动重连；在途回合中断、频控窗口与中间
 * 消息缓冲清零；会话映射/历史不受影响。保存冲突（onebot-settings/conflict）
 * 时提示并重拉快照（revision 语义 = T1 §3.1，任何来源的已提交变更都 +1）。
 */

window.__ModuleLoader__.load({
	id: "dsh-onebot-paopao",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-onebot client: react 不可用");
		}
		//#endregion

		//#region 陪伴模块（原 dsh-bubble，合进同一个插件一起跑）
		var BubbleUI = (function (require) {
    const React = require('react')
    const h = React.createElement
    // 「列表型」配置在输入框里编辑时会临时是字符串（逗号隔开），显示时一律
    // 转成文本再画；以前直接 .join 会把整页渲染炸掉（settings.section 崩过一次）。
    const asText = (v) => Array.isArray(v) ? v.join('，') : (v == null ? '' : String(v))
    /* 页签和「正在打的草稿」存在模块里，不跟组件一起死。
       哥哥 11-11：设置页每隔几秒会被整页重画一次，正在写的长文本一重挂就没了。
       组件重挂时先从这儿把字捡回来；真正存盘成功才清。 */
    const UI = { tab: 'companion', sub: 'overview' }
    const DRAFT = Object.create(null)
    const dget = (k, fallback) => (k in DRAFT ? DRAFT[k] : fallback)
    const dset = (k, v) => { DRAFT[k] = v }
    const ddrop = (k) => { delete DRAFT[k] }
/** 数据一样就别换对象：轮询每 8 秒拉一次，没变还 setState 会把整页重画一遍
 *  （哥哥 11-11「在设置页输入时页面会刷新」——重画会把光标和没写完的字赶走） */
const sameOr = (prev, next) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
    /** 光标是不是在输入框里——在写东西就别刷新，别把字和光标一起赶走 */
    const isTyping = () => {
      try {
        const el = document.activeElement
        if (!el) return false
        if (el.isContentEditable) return true
        const tag = String(el.tagName || '').toUpperCase()
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      } catch (e) { return false }
    }
    // 「刚刚 / 12 分钟前」——卡片上显示上次开口用的
    const agoText = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return '刚刚'
      const s = Math.round(n / 1000)
      if (s < 60) return s + ' 秒'
      const m = Math.round(s / 60)
      if (m < 60) return m + ' 分钟'
      const hh = Math.round(m / 60)
      if (hh < 24) return hh + ' 小时'
      return Math.round(hh / 24) + ' 天'
    }
    // 这一拍为什么没开口——服务端 skipped 的原话翻成人话
    const SKIP_TEXT = {
      chatting: '他正在聊，先不插嘴',
      limit: '这个时间窗已经说够了',
      below: '权重还没到阈值',
      roll: '掷骰没中',
      quiet: '安静时段',
      notyet: '还没到这一拍',
      'binding-off': '这个会话关了',
      nochat: '会话 id 是空的',
      noevent: '事件池是空的',
    }
    const { useState, useEffect, useCallback } = React

    // 内置事件（删了服务端也会补回来）；不在这里面的就是自己加的，能删
    const BUILTIN_EVENTS = ['chat', 'video', 'image', 'web', 'meme', 'voice', 'memory', 'remind', 'sing']

    const API = '/api/bubble'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 403 ? '（被拦了：只接受本机同源）' : res.status === 404 ? '（插件没挂上）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-bb-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 10px;max-width:680px;}
[data-bb-napqr]{width:236px;height:236px;padding:8px;border-radius:12px;background:#fff;}
[data-bb-napqr] img{display:block;width:220px;height:220px;image-rendering:pixelated;}
[data-bb-doc]{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.03);}
[data-bb-docline]{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.5;}
[data-bb-docline][data-level=warn]{color:#e8c05a;}
[data-bb-docline][data-level=bad]{color:#ef7a7a;}
[data-bb-docmark]{flex:none;width:18px;text-align:center;}
[data-bb-docneed]{flex:none;font-size:11px;line-height:17px;padding:0 5px;border-radius:5px;background:rgba(255,255,255,.06);color:var(--dsw-alias-label-secondary,#8b93a1);}
[data-bb-docneed][data-must]{background:rgba(239,122,122,.16);color:#ef9a9a;}
[data-bb-docfix]{flex:none;max-width:46%;color:var(--dsw-alias-label-secondary,#8b93a1);font-size:12px;}
[data-bb-sec]{display:flex;flex-direction:column;gap:8px;}
[data-bb-lamps]{display:flex;flex-direction:column;gap:6px;}
[data-bb-lamp]{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary,#8b93a1);}
[data-bb-lamp] b{color:#e7ecf3;font-weight:600;}
[data-bb-lamp] [data-bb-dot]{width:8px;height:8px;border-radius:50%;background:#ef4444;flex:0 0 auto;}
[data-bb-lamp][data-on] [data-bb-dot]{background:#22c55e;}
[data-bb-steps]{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:13px;
  color:var(--dsw-alias-label-secondary,#8b93a1);line-height:1.6;}
[data-bb-steps] code{font-size:12px;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.16);}
[data-bb-tabs]{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid rgba(127,127,127,.22);padding-bottom:2px;}
[data-bb-tab]{font-size:12px;padding:5px 12px;border-radius:8px 8px 0 0;border:0;background:transparent;
  color:var(--dsw-alias-label-secondary,#8b93a1);cursor:pointer;font-family:inherit;transition:background .15s;}
[data-bb-tab]:hover{background:rgba(127,127,127,.12);}
[data-bb-tab][data-on]{background:rgba(59,130,246,.16);color:#60a5fa;font-weight:600;}
[data-bb-tabpanel]{display:flex;flex-direction:column;gap:14px;padding-top:4px;}
/* 陪伴里的子页签（横排小胶囊；别复用 data-bb-tab，那个被「做过的事」整页样式占了） */
[data-bb-subtabs]{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 4px;}
[data-bb-subtab]{font-size:12px;padding:5px 14px;border-radius:999px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));background:transparent;color:inherit;}
[data-bb-subtab]:hover{background:rgba(127,127,127,.10);}
[data-bb-subtab][data-on]{background:#3b82f6;border-color:transparent;color:#fff;font-weight:600;}
[data-bb-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bb-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bb-grow]{flex:1;min-width:0;}
[data-bb-label]{font-size:13px;}
[data-bb-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bb-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bb-sw][data-on]{background:#3b82f6;}
[data-bb-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bb-sw][data-on] i{left:19px;}
[data-bb-sw][disabled]{opacity:.45;cursor:default;}
[data-bb-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-bb-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-bb-input]:focus{outline:none;border-color:#3b82f6;}
[data-bb-num]{width:92px;text-align:center;}
[data-bb-textarea]{min-height:96px;resize:vertical;line-height:1.55;font-size:12.5px;}
[data-bb-row]{display:flex;gap:8px;align-items:center;}
[data-bb-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-bb-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-bb-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-bb-btn][disabled]{opacity:.5;cursor:default;}
[data-bb-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));}
[data-bb-msg][data-err]{background:rgba(220,38,38,.14);color:#f87171;}
[data-bb-msg][data-ok]{background:rgba(34,197,94,.14);color:#4ade80;}
[data-bb-toast]{position:fixed;top:12vh;left:50%;transform:translateX(-50%);z-index:80;
  font-size:13px;line-height:18px;padding:10px 18px;border-radius:10px;word-break:break-all;
  max-width:min(560px,86vw);box-shadow:0 10px 30px rgba(0,0,0,.45);animation:bb-toast-in .16s ease-out;}
[data-bb-toast][data-ok]{background:rgba(22,163,74,.95);color:#f0fff4;}
[data-bb-toast][data-err]{background:rgba(220,38,38,.95);color:#fff;}
@keyframes bb-toast-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
[data-bb-ret]{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:8px;
  background:rgba(255,255,255,.04);font-size:12px;line-height:17px;}
[data-bb-ret] [data-bb-grow]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bb-power]{border:1px solid #3a3d45;border-radius:10px;padding:12px 14px;margin-bottom:12px;}
[data-bb-power][data-bb-power="off"]{border-color:#8a4b4b;background:rgba(138,75,75,.10);}
[data-bb-powerbtn]{margin-top:8px;font-size:15px;padding:7px 16px;border-radius:8px;cursor:pointer;}
[data-bb-powerbtn="off"]{background:#c0392b;color:#fff;border:0;}
[data-bb-powerbtn="on"]{background:#2f8f4e;color:#fff;border:0;}
[data-bb-powerbtn][disabled]{opacity:.6;cursor:default;}
/* 扫码登录：码要白底，透明底手机扫不出来 */
[data-bb-qr]{width:236px;height:236px;padding:8px;border-radius:12px;background:#fff;}
[data-bb-qr] svg{display:block;width:220px;height:220px;}
[data-bb-badge]{font-size:11px;padding:2px 7px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,#c9cdd4);}
/* 话头：占位符小圆片 + 预览框 */
[data-bb-chip]{font-size:11px;padding:3px 8px;border-radius:999px;cursor:help;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9cdd4);}
[data-bb-pre]{margin:0;padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.65;
  white-space:pre-wrap;word-break:break-word;font-family:inherit;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));
  border:1px dashed var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));}
/* 话头页：说明/提示比别处大一号（哥哥 11-11「提示可以稍微大字一点点」） */
[data-bb-page] [data-bb-note]{font-size:12.5px;line-height:19px;}
[data-bb-page] [data-bb-h]{font-size:12px;}
[data-bb-page] [data-bb-label]{font-size:13.5px;}
[data-bb-page] [data-bb-pre]{font-size:13.5px;line-height:1.7;}
[data-bb-page] [data-bb-chip]{font-size:12px;}
/* 固定的机制说明：只读展示，压在每条话头最后 */
[data-bb-fixed]{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-radius:10px;
  font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#c9cdd4);
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));
  border-left:3px solid var(--dsw-alias-brand,#3b82f6);}
/* 顶上的告警条：一个管理员都没有 / allowAllUsers 开着 */
[data-bb-warn]{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;
  font-size:13px;line-height:1.55;
  border-left:3px solid var(--dsw-alias-danger,#e5484d);
  background:var(--dsw-alias-bg-layer-4,rgba(229,72,77,.10));}
[data-bb-warn="warn"]{border-left-color:var(--dsw-alias-warning,#f5a524);
  background:var(--dsw-alias-bg-layer-4,rgba(245,165,36,.10));}
/* 每个会话一张卡：名字 + 权重条 + 模式 + 手感 */
[data-bb-card]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.06));}
[data-bb-name]{font-size:13px;font-weight:600;}
[data-bb-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
/* 加会话：拉到的列表摊开给人点，不用在长下拉里找 */
[data-bb-pick]{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;
  border:1px dashed var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.04));}
[data-bb-hero]{display:flex;align-items:baseline;gap:10px;padding:12px 14px;border-radius:12px;
  background:linear-gradient(135deg,rgba(59,130,246,.16),rgba(59,130,246,.04));
  border:1px solid rgba(59,130,246,.22);}
[data-bb-w]{font-size:30px;font-weight:700;line-height:1;color:#60a5fa;font-variant-numeric:tabular-nums;}
[data-bb-ev]{display:flex;align-items:center;gap:8px;}
[data-bb-evbox]{display:flex;flex-direction:column;gap:4px;}
[data-bb-x]{flex:none;width:20px;height:20px;padding:0;line-height:1;border-radius:6px;font-size:14px;
  background:transparent;border:1px solid transparent;color:var(--dsw-alias-text-tertiary,#94a3b8);cursor:pointer;}
[data-bb-x]:hover{color:#f87171;border-color:rgba(248,113,113,.4);}
[data-bb-hint]{font-size:11px;padding:5px 8px;}
[data-bb-ev-label]{font-size:13px;width:88px;flex:none;}
[data-bb-label]{font-size:12px;padding:4px 8px;}
[data-bb-bar]{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));overflow:hidden;}
[data-bb-bar] i{display:block;height:100%;background:#3b82f6;border-radius:3px;}
[data-bb-pct]{font-size:11px;width:46px;text-align:right;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  font-variant-numeric:tabular-nums;}
[data-bb-list]{display:flex;flex-direction:column;gap:6px;}
[data-bb-item]{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px;
  padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.08));}
[data-bb-item][data-nosend]{opacity:.62;}
[data-bb-was]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-variant-numeric:tabular-nums;}
[data-bb-chip]{font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;border:1px solid transparent;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;font-family:inherit;}
[data-bb-chip][data-on]{background:#3b82f6;color:#fff;}
/* ── 会话头那个「做过的事」tab（注意：别和页签按钮共用 data-bb-tab，那个是横排小按钮） ── */
[data-bb-done]{display:flex;flex-direction:column;gap:12px;padding:14px 16px 20px;max-width:760px;}
[data-bb-tabtop]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;
  color:var(--dsw-alias-label-secondary,#c9cdd4);}
[data-bb-tabtop] b{font-size:17px;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums;}
[data-bb-tablist]{display:flex;flex-direction:column;gap:8px;}
[data-bb-tabitem]{display:flex;flex-direction:column;gap:5px;padding:11px 13px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.08));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06));}
[data-bb-tabitem][data-nosend]{opacity:.62;}
[data-bb-tabi-h]{display:flex;align-items:center;gap:9px;font-size:14.5px;line-height:22px;}
[data-bb-tabi-t]{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
[data-bb-tabi-x]{display:flex;flex-direction:column;gap:3px;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-secondary,#c9cdd4);}
[data-bb-tabi-x] a{color:#60a5fa;text-decoration:none;word-break:break-all;}
[data-bb-tabi-x] a:hover{text-decoration:underline;}
[data-bb-tabi-time]{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bb-help] { margin: 6px 0 10px }
[data-bb-help-btn] { background: none; border: 1px dashed var(--border, #444); color: var(--fg-muted, #999); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer }
[data-bb-help-body] { margin-top: 8px; padding: 10px 12px; border: 1px solid var(--border, #333); border-radius: 10px; font-size: 12px; line-height: 1.7 }
[data-bb-help-t] { margin: 6px 0 4px; font-weight: 600; opacity: .85 }
[data-bb-help-li] { opacity: .92 }
[data-bb-help-li] b { font-weight: 600 }
[data-bb-legend]{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;line-height:1.7;opacity:.75;margin:2px 0 8px;}
[data-bb-hourlabel]{font-size:14px;font-weight:600;min-width:106px;font-variant-numeric:tabular-nums;}
[data-bb-hoursum]{font-size:12.5px;opacity:.82;font-variant-numeric:tabular-nums;}
[data-bb-delta]{font-size:14px;font-weight:600;min-width:64px;text-align:right;color:#5ecf85;font-variant-numeric:tabular-nums;}
[data-bb-delta=down]{color:#ef7a6d;}
[data-bb-score]{display:flex;flex-direction:column;gap:8px;}
[data-bb-hours]{display:flex;flex-direction:column;gap:6px;}
[data-bb-hour]{border:1px solid var(--border,#3a3a3a);border-radius:8px;overflow:hidden;}
[data-bb-hourhead]{display:flex;align-items:center;gap:10px;padding:6px 10px;cursor:pointer;font-size:12px;}
[data-bb-hourhead]:hover{background:var(--hover,rgba(255,255,255,.05));}
[data-bb-hourrows]{border-top:1px solid var(--border,#3a3a3a);padding:6px 10px;display:flex;flex-direction:column;gap:4px;}
[data-bb-hourrow]{display:flex;align-items:center;gap:10px;font-size:12px;}
[data-bb-chips]{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px;}
[data-bb-chip]{border:1px solid var(--dsw-alias-border-secondary,#3a3f47);background:transparent;
  color:var(--dsw-alias-label-secondary,#c9cdd4);border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer;}
[data-bb-chip][data-on]{background:var(--dsw-alias-brand,#3b82f6);border-color:transparent;color:#fff;}
/* 「做过的事」整块字号再放大三成（哥哥 11-10 说还小）——只在这里覆盖，不影响设置页 */
[data-bb-done]{font-size:15px;}
[data-bb-done] [data-bb-tabtop]{font-size:17px;}
[data-bb-done] [data-bb-tabtop] b{font-size:22px;}
[data-bb-done] [data-bb-btn]{font-size:15px;padding:8px 14px;border-radius:9px;}
[data-bb-done] [data-bb-chip]{font-size:14px;padding:5px 12px;}
[data-bb-done] [data-bb-tabitem]{padding:13px 15px;gap:7px;border-radius:12px;}
[data-bb-done] [data-bb-tabi-h]{font-size:19px;line-height:27px;gap:11px;}
[data-bb-done] [data-bb-tabi-t]{font-size:17px;line-height:25px;}
[data-bb-done] [data-bb-tabi-x]{font-size:17px;line-height:25px;}
[data-bb-done] [data-bb-badge]{font-size:14px;padding:3px 9px;}
[data-bb-done] [data-bb-was]{font-size:14px;}
[data-bb-done] [data-bb-mono]{font-size:15px;}
[data-bb-done] [data-bb-note]{font-size:14px;line-height:21px;}
[data-bb-done] [data-bb-legend]{font-size:16px;line-height:1.8;gap:6px 18px;}
[data-bb-done] [data-bb-hourlabel]{font-size:18px;min-width:136px;}
[data-bb-done] [data-bb-hoursum]{font-size:16px;}
[data-bb-done] [data-bb-delta]{font-size:18px;min-width:82px;}
[data-bb-done] [data-bb-hourhead]{font-size:15.5px;padding:8px 12px;gap:12px;}
[data-bb-done] [data-bb-hourrows]{padding:8px 12px;gap:6px;}
[data-bb-done] [data-bb-hourrow]{font-size:15.5px;gap:12px;}
[data-bb-tabi-who]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);border:1px solid var(--dsw-alias-border-secondary,#3a3f47);
  border-radius:4px;padding:0 5px;white-space:nowrap;}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bb-sw': '', 'data-on': on ? '' : undefined, disabled: !!disabled,
        onClick: () => !disabled && onChange(!on),
        title: on ? '开' : '关',
      }, h('i'))
    }

    /** 浮在中间偏上的结果提示：设置改在页面下半截时，提示不该跑到页头去。 */
    function Toast({ msg }) {
      const [gone, setGone] = useState(false)
      useEffect(() => {
        setGone(false)
        if (!msg) return undefined
        const t = setTimeout(() => setGone(true), 2400)
        return () => clearTimeout(t)
      }, [msg])
      if (!msg || gone) return null
      const ok = msg.kind === 'ok'
      return h('div', { 'data-bb-toast': '', ...(ok ? { 'data-ok': '' } : { 'data-err': '' }) }, msg.text)
    }

    /** 被退休（拉黑）的会话：列出来 + 一键放出来。
     *  退休名单不该只剩一个看不见的 id——「原来那个会话不见了」就是它干的。 */
    function RetiredSessions() {
      const [list, setList] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const load = useCallback(async () => {
        try {
          const d = await jget('/sessions')
          setList(Array.isArray(d.retired) ? d.retired : [])
        } catch { setList([]) }
      }, [])
      useEffect(() => { load() }, [load])
      const release = async (id) => {
        setBusy(true)
        try {
          const d = await jpost('/unretire', { sessionId: id })
          setMsg(d.ok === false
            ? { kind: 'err', text: '没放开：' + (d.error || '不知道为啥') }
            : { kind: 'ok', text: '放出来了，下次接它就会用回原来这条' })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '没放开：' + e.message })
        } finally { setBusy(false) }
      }
      ensureCss()
      return h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '被退休的会话'),
        h('div', { 'data-bb-note': '' },
          '这些 id 被插件拉黑过（老代码一撞名就拉黑）。拉黑之后这个聊天不会再用它、会另开一条新的——看上去就是「原来的会话不见了」。盘上还有日志的，放出来就能接回去。'),
        list === null
          ? h('div', { 'data-bb-note': '' }, '正在读…')
          : list.length === 0
            ? h('div', { 'data-bb-note': '' }, '名单是空的，没有会话被拉黑。')
            : h('div', { 'data-bb-list': '' }, ...list.map((r) => h('div', { 'data-bb-ret': '', key: r.id },
                h('span', { 'data-bb-mono': '', 'data-bb-grow': '', title: r.id }, r.id),
                h('span', { 'data-bb-note': '', style: { flex: 'none' } }, r.hasLog ? '盘上有日志' : '盘上没日志'),
                h('button', { 'data-bb-btn': '', disabled: busy, onClick: () => release(r.id) }, '放出来'),
              ))),
        h(Toast, { msg }),
      )
    }

    /** QQ 机器人总开关（哥哥 11-11）：「自动连接太猛，根本关不掉」——一键断连 + 停掉 NapCat。
     *  关掉是两段式：第一次点变「确定关掉？（再点一下）」，4 秒内再点才真关，免得手滑。 */
    function QqPower() {
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [arm, setArm] = useState(false)
      const [msg, setMsg] = useState(null)
      const load = useCallback(async () => {
        try { setSt(await jget('/qq/off')) } catch { setSt({ ok: false, error: '读不到开关' }) }
      }, [])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (!arm) return
        const t = setTimeout(() => setArm(false), 4000)
        return () => clearTimeout(t)
      }, [arm])
      const flip = async (want) => {
        if (want === true && !arm) { setArm(true); return }
        setArm(false)
        setBusy(true)
        try {
          const d = await jpost('/qq/off', { off: want })
          setSt(d)
          setMsg(d.ok === false
            ? { kind: 'err', text: '没改成：' + (d.error || '不知道为啥') }
            : { kind: 'ok', text: want ? '关掉了：连接断了、NapCat 也停了，重启电脑也不会自己开' : '开回来了：能收消息了' })
        } catch (e) {
          setMsg({ kind: 'err', text: '没改成：' + e.message })
        } finally { setBusy(false) }
      }
      ensureCss()
      const off = !!(st && st.off)
      return h('div', { 'data-bb-sec': '', 'data-bb-power': off ? 'off' : 'on' },
        h('div', { 'data-bb-h': '' }, 'QQ 机器人'),
        h('div', { 'data-bb-note': '' },
          st === null
            ? '正在读…'
            : off
              ? '关着——不收、不回、不自动连。NapCat 停掉以后 QQ 也没登录；要再开，按下面那个绿色的。'
              : ('开着' + (st.connected ? '，通道在线' : '，通道还没连上') + (st.napcat ? '，NapCat 在跑。' : '，NapCat 没在跑。')
                + '关掉会把连接断开、把整棵 QQ 进程停掉，并且记住不再自己开。')),
        h('button', {
          'data-bb-btn': '',
          'data-bb-powerbtn': off ? 'on' : 'off',
          disabled: busy,
          onClick: () => flip(!off),
        }, busy ? '…' : (off ? '开启 QQ 机器人' : (arm ? '确定关掉？（再点一下）' : '关掉 QQ 机器人'))),
        h(Toast, { msg }),
      )
    }

    /** 总览页用的精简版：只有一个按钮，跟「看二维码」排在一行（哥哥 11-11）。 */
    function QqPowerBtn() {
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [arm, setArm] = useState(false)
      const load = useCallback(async () => {
        try { setSt(await jget('/qq/off')) } catch { setSt(null) }
      }, [])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (!arm) return
        const t = setTimeout(() => setArm(false), 4000)
        return () => clearTimeout(t)
      }, [arm])
      const off = !!(st && st.off)
      const broken = !!(st && st.ok === false)   // 老实例还没重启：接口在，但里面会抛错
      const click = async () => {
        if (!off && !arm) { setArm(true); return }
        setArm(false)
        setBusy(true)
        try { setSt(await jpost('/qq/off', { off: !off })) } catch { /* 老实例没有这个接口时就这样 */ } finally { setBusy(false) }
      }
      return h('button', {
        'data-bb-btn': '',
        'data-bb-powerbtn': off ? 'on' : 'off',
        disabled: busy || broken,
        title: broken ? '重启宿主后这个按钮才真的能关' : '',
        onClick: click,
      }, broken ? '关掉 QQ（重启后可用）' : (busy ? '…' : (off ? '开启 QQ 机器人' : (arm ? '确定关掉？（再点）' : '关掉 QQ 机器人'))))
    }

    function Field({ label, note, children }) {
      return h('div', { 'data-bb-field': '' },
        h('div', { 'data-bb-row': '' },
          h('span', { 'data-bb-label': '', 'data-bb-grow': '' }, label),
          children,
        ),
        note ? h('div', { 'data-bb-note': '' }, note) : null,
      )
    }

    // 数字框：只在「失焦」和「回车」时提交（哥哥 11-08：以前每敲一下都存一次，一卡一卡的）
    function Num({ value, onChange, step = 1, min, max }) {
      const commit = (raw) => {
        const s = String(raw ?? '').trim()
        if (s === '') return
        const n = Number(s)
        if (!Number.isFinite(n)) return
        const lo = Number.isFinite(min) ? min : null
        const hi = Number.isFinite(max) ? max : null
        let v = n
        if (lo !== null && v < lo) v = lo
        if (hi !== null && v > hi) v = hi
        if (v === Number(value)) return
        onChange(v)
      }
      return h('input', {
        key: 'num-' + (value ?? ''),  // 外面值变了就重挂一次，别让旧字卡在框里
        'data-bb-input': '', 'data-bb-num': '', type: 'number', defaultValue: value ?? '',
        step, min, max,
        onBlur: (e) => commit(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { commit(e.target.value); e.target.blur() } },
      })
    }

    function ExtField({ f, onSave, busy }) {
      const v = f.value
      const [tip, setTip] = useState('')
      const dk = 'ext:' + f.key   // 草稿：面板被重画时把没存完的字捡回来
      if (f.type === 'switch') {
        return h(Field, { label: f.label, note: f.note },
          h(Switch, { on: v === true, disabled: busy, onChange: (x) => onSave({ [f.key]: x }) }))
      }
      if (f.type === 'select') {
        return h(Field, { label: f.label, note: f.note },
          h('select', {
            'data-bb-input': '', value: v, disabled: busy,
            onChange: (e) => onSave({ [f.key]: e.target.value }),
          }, ...(f.options || []).map((o) => h('option', { value: o, key: o }, o))))
      }
      if (f.type === 'num') {
        // scale：存的是毫秒、给人看的是秒（哥哥 11-11「毫秒全部改成秒」）。
        // 显示时除、保存时乘，配置键不变——升级不影响老数据。
        const sc = Number(f.scale) > 0 ? Number(f.scale) : 1
        const shown = sc === 1 ? v : Math.round((Number(v) / sc) * 1000) / 1000
        return h(Field, { label: f.label, note: f.note },
          h('input', {
            'data-bb-input': '', 'data-bb-num': '', type: 'number',
            defaultValue: shown, step: f.step ?? 1, min: f.min, max: f.max,
            disabled: busy,
            onBlur: (e) => {
              // 空着别写：以前失焦一次就把整套配置写成最小值了
              if (e.target.value.trim() === '') return
              const raw = Number(e.target.value)
              onSave({ [f.key]: sc === 1 ? raw : Math.round(raw * sc) })
            },
          }))
      }
      if (f.type === 'textarea') {
        return h(Field, { label: f.label, note: f.note },
          h('textarea', {
            'data-bb-input': '', 'data-bb-textarea': '', rows: 6,
            defaultValue: dget(dk, v ?? ''), disabled: busy,
            onChange: (e) => dset(dk, e.target.value),
            onBlur: (e) => {
              const text = e.target.value.trim()
              if (text === '') return
              ddrop(dk)
              onSave({ [f.key]: e.target.value })
            },
          }))
      }
      const shown = f.type === 'tags' ? asText(v) : (v ?? '')
      const input = h('input', {
        'data-bb-input': '', defaultValue: dget(dk, shown), disabled: busy,
        onChange: (e) => dset(dk, e.target.value),
        onBlur: (e) => {
          if (e.target.value.trim() === '') return
          ddrop(dk)
          onSave({
            [f.key]: f.type === 'tags'
              ? e.target.value.split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean)
              : e.target.value,
          })
        },
      })
      if (f.reveal !== true) return h(Field, { label: f.label, note: f.note }, input)
      return h(Field, { label: f.label, note: f.note },
        h('div', { 'data-bb-row': '' },
          input,
          h('button', {
            'data-bb-btn': '', disabled: busy,
            onClick: async () => {
              setTip('')
              try {
                const r = await jpost('/ext/reveal', { key: f.key })
                if (r && r.ok === false) setTip('打开不了：' + (r.error || '未知原因'))
              } catch (e) {
                setTip('打开不了：' + String(e?.message ?? e))
              }
            },
          }, '打开目录')),
        tip !== '' ? h('div', { 'data-bb-note': '' }, tip) : null)
    }

    function ExtSection({ title, note, data, which, onSave, busy, only }) {
      if (!data) return null
      if (data.available === false) {
        return h('div', { 'data-bb-sec': '' },
          h('div', { 'data-bb-h': '' }, title),
          h('div', { 'data-bb-note': '' }, data.hint || '还没接上'))
      }
      const groups = []
      for (const f of (data.fields || []).filter((x) => !only || only.includes(x.group))) {
        let g = groups.find((x) => x.name === f.group)
        if (!g) { g = { name: f.group, items: [] }; groups.push(g) }
        g.items.push(f)
      }
      return h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, title),
        note ? h('div', { 'data-bb-note': '' }, note) : null,
        ...groups.map((g) => h('div', { 'data-bb-sub': '', key: g.name },
          h('div', { 'data-bb-note': '' }, g.name),
          ...g.items.map((f) => h(ExtField, {
            key: f.key, f, busy,
            onSave: (patch) => onSave(which, patch),
          })),
        )),
      )
    }

    /* 样式只挂一次到 head —— 以前 <style> 写在设置页里，
       没打开设置页时「做过的事」就只剩裸文字、边框全不见 */
    function ensureCss() {
      if (typeof document === 'undefined') return
      try {
        if (document.querySelector('style[data-bubble-ui]')) return
        const tag = document.createElement('style')
        tag.setAttribute('data-bubble-ui', '')
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (e) { /* 没有 head 就算了，不影响数据 */ }
    }

    /* ────────────── 会话头那个 tab：做过的事 ────────────── */
    function DoneTab() {
      const PAGE = 30
      const [limit, setLimit] = useState(PAGE)
      const [d, setD] = useState(null)
      const [chats, setChats] = useState([])
      const [who, setWho] = useState('')
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [view, setView] = useState('chat')      // chat / score
      const [whoTouched, setWhoTouched] = useState(false) // 手动切过就不再自动挑
      const [led, setLed] = useState(null)          // 积分流水
      const [openHour, setOpenHour] = useState('')  // 展开哪个小时
      const [vid, setVid] = useState(null)          // 视频账（发过的 / 抽到的 / 不再推）
      const [blkBusy, setBlkBusy] = useState('')
      const loadVideos = () => {
        setBusy(true)
        jget('/videos')
          .then((r) => { setVid(r); setErr('') })
          .catch((e) => setErr(String(e?.message ?? e)))
          .finally(() => setBusy(false))
      }
      const blockOne = (bvid, on) => {
        setBlkBusy(bvid)
        jpost(on ? '/videos/unblock' : '/videos/block', { bvid })
          .then(() => loadVideos())
          .catch((e) => setErr(String(e?.message ?? e)))
          .finally(() => setBlkBusy(''))
      }
      const loadLedger = () => {
        setBusy(true)
        jget('/ledger?hours=48' + (who ? '&chatId=' + encodeURIComponent(who) : ''))
          .then((r) => { setLed(r); setErr('') })
          .catch((e) => setErr(String(e?.message ?? e)))
          .finally(() => setBusy(false))
      }
      useEffect(() => { if (view === 'score') loadLedger() }, [view, who])
      useEffect(() => { if (view === 'video') loadVideos() }, [view])
      const load = () => {
        setBusy(true)
        jget('/state?limit=' + limit)
          .then((r) => { setD(r); setErr('') })
          .catch((e) => setErr(String(e?.message ?? e)))
          .finally(() => setBusy(false))
      }
      useEffect(() => { load() }, [limit])
      useEffect(() => {
        jget('/chats')
          .then((r) => setChats(r && Array.isArray(r.chats) ? r.chats : []))
          .catch(() => {})
      }, [])
      const cfg = (d && d.cfg) || {}
      const st = (d && d.state) || {}
      const rows = (d && d.history) || []
      const two = (n) => String(n).padStart(2, '0')
      const when = (ts) => { const x = new Date(ts); return `${two(x.getHours())}:${two(x.getMinutes())}` }
      const sendText = (x) => (x.kind === 'bili-act' ? '做了' : x.mode === 'qq' ? '发了' : x.mode === 'dry' ? '干跑' : (x.error ? '没发出去' : '没发'))
      // 是谁：优先后台给的群名/昵称，拿不到就退编号；前缀区分群和私聊
      const kindOf = (id) => (String(id) === 'bili' ? 'B站' : String(id).startsWith('group:') ? '群' : '私聊')
      const nameOf = (id) => {
        const key = String(id || '')
        if (key === 'bili') return '我的账号'
        const c = chats.find((x) => String(x.chatId) === key)
        const lab = c && c.label && String(c.label) !== key ? String(c.label) : ''
        return lab || (key.split(':')[1] || key)
      }
      const whos = Array.from(new Set([
        ...rows.map((x) => x.chatId),
        ...chats.map((c) => c.chatId),
      ].filter(Boolean)))
      // 默认别把几个号混在一起：先挑私聊，没有就挑第一个（用户自己点过就不再自动挑）
      useEffect(() => {
        if (whoTouched || who || !whos.length) return
        const first = whos.find((x) => String(x).startsWith('private:')) || whos[0]
        setWho(first)
      }, [d, chats, who, whoTouched])
      const mine = who ? rows.filter((x) => x.chatId === who) : rows
      // ── 积分视图：按小时折叠，点开看每一笔（哥哥 11-10 要的全量记录）──
      const KIND = { tick: '这一拍', rise: '涨', spend: '扣', settle: '补', bonus: '奖' }
      const num = (n) => (Number(n) > 0 ? '+' : '') + (Math.round(Number(n) * 10) / 10)
      const hourRange = (key) => `${key.slice(11)}:00–${key.slice(11)}:59`
      const scoreView = h('div', { 'data-bb-score': '' },
        h('div', { 'data-bb-note': '' }, '最近 48 小时。上面一行是一个小时，点开看这个小时里的每一笔。'),
        h('div', { 'data-bb-legend': '' },
          h('span', null, '拍 = 每 5 分钟那一跳（没到点也记）'),
          h('span', null, '涨 = 这一拍往上加多少'),
          h('span', null, '扣 = 一轮聊完扣一格（发没发都扣）'),
          h('span', null, '补 = 她给自己打完分，按表补回来或追扣'),
          h('span', null, '奖 = 抽中事件加的分'),
        ),
        !led ? h('div', { 'data-bb-note': '' }, '读取中…')
          : !(led.hours || []).length ? h('div', { 'data-bb-note': '' }, '还没有积分记录，等一拍就有了。')
            : h('div', { 'data-bb-hours': '' }, (led.hours || []).map((hb) => h('div', { key: hb.key, 'data-bb-hour': '' },
                h('div', {
                  'data-bb-hourhead': '',
                  onClick: () => setOpenHour(openHour === hb.key ? '' : hb.key),
                },
                  h('span', { 'data-bb-hourlabel': '' }, hourRange(hb.key)),
                  h('span', { 'data-bb-grow': '', 'data-bb-mono': '' },
                    `${Math.round(hb.start)} → ${Math.round(hb.end)}（净 ${num(hb.delta)}）`),
                  h('span', { 'data-bb-hoursum': '' },
                    `拍了 ${hb.ticks} 次 · 涨 ${num(hb.rise)} · 扣 ${num(hb.spend)} · 补 ${num(hb.settle)} · 奖 ${num(hb.bonus)}`),
                ),
                openHour === hb.key ? h('div', { 'data-bb-hourrows': '' }, (hb.rows || []).map((r, i) => h('div', {
                  key: (r.at || 0) + '-' + i,
                  'data-bb-hourrow': '',
                },
                  h('span', { 'data-bb-tabi-time': '' }, when(r.at)),
                  h('span', { 'data-bb-badge': '' }, KIND[r.kind] || r.kind),
                  h('span', { 'data-bb-mono': '', 'data-bb-delta': Number(r.delta) < 0 ? 'down' : undefined }, num(r.delta)),
                  h('span', { 'data-bb-mono': '', 'data-bb-was': '' },
                    r.w0 != null && r.w1 != null ? `${Math.round(r.w0)} → ${Math.round(r.w1)}` : ''),
                  h('span', { 'data-bb-grow': '' },
                    r.kind === 'settle' && r.score != null
                      ? `她打了 ${Math.round(r.score / 10)} 分${r.inbound ? '（你起的话头）' : '（她起的话头）'}`
                      : (r.note || '')),
                ))) : null,
              ))),
      )
      ensureCss()
      // ── 视频视图：发出去过的（30 天不再自动抽到）、抽到过的（只记录）、永不推的黑名单 ──
      const vrow = (x, tag, canBlock) => h('div', { key: tag + x.bvid, 'data-bb-vrow': '' },
        h('span', { 'data-bb-tabi-time': '' }, when(x.at)),
        h('span', { 'data-bb-badge': '' }, tag),
        h('span', { 'data-bb-grow': '' },
          h('span', { 'data-bb-vtitle': '' }, x.title || x.bvid),
          h('span', { 'data-bb-mono': '', 'data-bb-vsub': '' }, ' ' + x.bvid + (x.chatId ? ' · ' + nameOf(x.chatId) : '')),
        ),
        canBlock
          ? h('button', { 'data-bb-btn': '', disabled: blkBusy === x.bvid, onClick: () => blockOne(x.bvid, tag === '不再推') }, tag === '不再推' ? '恢复' : '不再推')
          : null,
      )
      const videoView = h('div', { 'data-bb-videos': '' },
        h('div', { 'data-bb-note': '' }, '「发出去过」的 30 天内不会被自动抽到（跨群和私聊共用一本账）；抽到但没发的不占名额，下一轮还能再抽到。'),
        !vid ? h('div', { 'data-bb-note': '' }, '读取中…')
          : h('div', null,
            h('div', { 'data-bb-vhead': '' }, '发出去过的 ' + (vid.sent || []).length + ' 条'),
            (vid.sent || []).length
              ? (vid.sent || []).map((x) => vrow(x, '发过', true))
              : h('div', { 'data-bb-note': '' }, '还没发过视频。'),
            h('div', { 'data-bb-vhead': '' }, '抽到过的 ' + (vid.picked || []).length + ' 条（只记录，不占名额）'),
            (vid.picked || []).length
              ? (vid.picked || []).filter((x) => !(vid.sent || []).some((s) => s.bvid === x.bvid))
                .slice(0, 60).map((x) => vrow(x, x.delivered ? '发了' : '抽到', true))
              : h('div', { 'data-bb-note': '' }, '还没抽到过。'),
            (vid.blocked || []).length
              ? h('div', null,
                  h('div', { 'data-bb-vhead': '' }, '不再推 ' + (vid.blocked || []).length + ' 条'),
                  (vid.blocked || []).map((bvid) => vrow({ bvid, at: Date.now(), title: '' }, '不再推', true)))
              : null,
          ),
      )
      return h('div', { 'data-bb-done': '' },
        h('div', { 'data-bb-tabtop': '' },
          h('b', null, Math.round(st.w || 0)),
          h('span', null, '权重'),
          h('span', null, `· 今天 ${st.todayCount || 0} 次`),
          h('span', null, `· 每 ${cfg.tickMinutes || 5} 分钟抽一次`),
          h('span', null, cfg.dryRun ? '· 干跑中' : '· 真发'),
          h('span', { 'data-bb-grow': '' }),
          h('button', { 'data-bb-btn': '', 'data-on': view === 'chat' ? '' : undefined, onClick: () => setView('chat') }, '聊天'),
          h('button', { 'data-bb-btn': '', 'data-on': view === 'score' ? '' : undefined, onClick: () => setView('score') }, '积分'),
          h('button', { 'data-bb-btn': '', 'data-on': view === 'video' ? '' : undefined, onClick: () => setView('video') }, '视频'),
          h('button', { 'data-bb-btn': '', disabled: busy, onClick: view === 'score' ? loadLedger : view === 'video' ? loadVideos : load }, busy ? '读取中…' : '刷新'),
        ),
        err ? h('div', { 'data-bb-msg': '', 'data-err': '' }, '读不到记录：' + err) : null,
        // 各号之间分开：默认只看一个会话（最先绑的私聊），要混着看再点「全部」
        whos.length ? h('div', { 'data-bb-chips': '' },
          h('button', {
            'data-bb-chip': '', 'data-on': who === '' ? '' : undefined,
            onClick: () => { setWhoTouched(true); setWho('') },
          }, `全部 ${rows.length}`),
          whos.map((id) => {
            const n = rows.filter((x) => x.chatId === id).length
            return h('button', {
              key: id, 'data-bb-chip': '', 'data-on': who === id ? '' : undefined,
              onClick: () => { setWhoTouched(true); setWho(who === id ? '' : id) },
            }, `${kindOf(id)} ${nameOf(id)} ${n}`)
          }),
        ) : null,
        view === 'score' ? scoreView
          : view === 'video' ? videoView
            : h('div', { 'data-bb-chatview': '' },
        !rows.length
          ? h('div', { 'data-bb-note': '' }, d ? '还没有记录。点设置页里的「立刻抽一次」试试。' : '读取中…')
          : h('div', { 'data-bb-tablist': '' }, mine.map((x, i) => h('div', {
              key: (x.at || 0) + '-' + i,
              'data-bb-tabitem': '',
              'data-nosend': x.mode === 'qq' ? undefined : '',
            },
              h('div', { 'data-bb-tabi-h': '' },
                h('span', { 'data-bb-tabi-time': '' }, when(x.at)),
                h('span', { 'data-bb-tabi-who': '' }, `${kindOf(x.chatId)} ${nameOf(x.chatId)}`),
                h('span', { 'data-bb-grow': '' }, x.label || x.event),
                x.kind === 'bili-act' ? null : h('span', { 'data-bb-was': '' }, `${Math.round(x.w0)}→${Math.round(x.w1)}→${Math.round(x.w2)}`),
                h('span', { 'data-bb-badge': '' }, sendText(x)),
              ),
              (x.targets && x.targets.length) ? h('div', { 'data-bb-tabi-x': '' },
                x.targets.map((g, j) => {
                  const href = g.url || (g.bvid ? 'https://www.bilibili.com/video/' + g.bvid : '')
                  const name = g.title || g.bvid || g.url || ''
                  return h('div', { key: j },
                    href ? h('a', { href, target: '_blank', rel: 'noreferrer' }, name) : name,
                    g.note ? h('span', { 'data-bb-note': '' }, ' · ' + g.note) : null,
                  )
                }),
              ) : null,
            ))),
        mine.length && mine.length >= limit ? h('div', { 'data-bb-row': '' },
          h('button', { 'data-bb-btn': '', disabled: busy, onClick: () => setLimit(limit + PAGE) }, '再看 30 条'),
        ) : null,
        ),
      )
    }

    /* ────────────── B站扫码登录：泡泡自己的凭证 ────────────── */
    // 以前扫码靠刷B站插件的工具；刷B站 卸了之后泡泡得自己会登录，
    // 所以这里直接走 passport 的二维码接口，成了写 bubble\bili\bili_credential.json。
    function BiliLogin() {
      const [qr, setQr] = useState(null)        // { key, svg }
      const [who, setWho] = useState(null)      // { ok, uname, mid, message }
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      const loadWho = useCallback(async () => {
        try { setWho(await jget('/bili/who')) } catch { setWho({ ok: false, message: '读不到凭证' }) }
      }, [])
      useEffect(() => { loadWho() }, [loadWho])

      // 有码才轮询，扫完之后自己收摊
      useEffect(() => {
        if (!qr || !qr.key) return
        let stop = false
        const t = setInterval(async () => {
          let r = null
          try { r = await jget('/bili/login/poll?key=' + encodeURIComponent(qr.key)) } catch { return }
          if (stop || !r) return
          if (r.state === 'scanned') { setMsg('扫到了，手机上点一下确认'); return }
          if (r.state === 'done') {
            stop = true; clearInterval(t); setQr(null)
            setMsg(r.message || '登录成功'); loadWho()
          } else if (r.state === 'expired' || r.state === 'error') {
            stop = true; clearInterval(t); setQr(null)
            setMsg(r.message || '没成，再来一次')
          }
        }, 2000)
        return () => { stop = true; clearInterval(t) }
      }, [qr, loadWho])

      const start = async () => {
        setBusy(true); setMsg('')
        try {
          const d = await jpost('/bili/login/start', {})
          if (d && d.ok && d.svg) setQr({ key: d.key, svg: d.svg })
          else setMsg((d && d.message) || '没拿到二维码')
        } catch (e) { setMsg('没拿到二维码：' + (e && e.message ? e.message : e)) }
        setBusy(false)
      }

      return h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, 'B站扫码登录'),
        h('div', { 'data-bb-row': '' },
          h('span', { 'data-bb-note': '' },
            who ? (who.ok ? `当前：${who.uname || '没认出是谁'}${who.mid ? `（${who.mid}）` : ''}` : (who.message || '没登录')) : '读取中…'),
          h('span', { 'data-bb-grow': '' }),
          h('button', { 'data-bb-btn': '', disabled: busy, onClick: start },
            busy ? '要码中…' : (qr ? '换一张' : '扫码登录')),
        ),
        qr ? h('div', { 'data-bb-qr': '', dangerouslySetInnerHTML: { __html: qr.svg } }) : null,
        qr ? h('div', { 'data-bb-note': '' }, '手机 B站 → 我的 → 扫一扫，码大约 3 分钟内有效。') : null,
        msg ? h('div', { 'data-bb-msg': msg.indexOf('成功') >= 0 ? { 'data-ok': '' } : { 'data-err': '' } }, msg) : null,
      )
    }

    // 顶上的告警：一个人都进不来 / allowAllUsers 敞着（安装记录里踩过这个坑）
    function AccessWarn({ access }) {
      if (!access || access.available !== true) return null
      const rows = []
      if (access.adminCount === 0 && !access.allowAllUsers) {
        rows.push(h('div', { key: 'a', 'data-bb-warn': '' },
          h('b', null, '现在谁私聊都不会回'),
          h('span', null, '主人 QQ 还没填，也没有别的管理员——所有私聊都会被静默丢掉。去「设置 → 其他 → 主人 QQ」填上，改完点刷新。'),
        ))
      }
      if (access.allowAllUsers) {
        rows.push(h('div', { key: 'b', 'data-bb-warn': 'warn' },
          h('b', null, 'allowAllUsers 开着'),
          h('span', null, '这个开关已经不管私聊了（私聊永远只认主人 QQ / 管理员）。群聊策略是 open 的时候，它等于所有群都放进来。'),
        ))
      }
      if (access.groupPolicy === 'open') {
        rows.push(h('div', { key: 'c', 'data-bb-warn': 'warn' },
          h('b', null, '群聊对「所有群」开放'),
          h('span', null, '任何人把机器人拉进一个群，群里的人就能让它干活——那群人也拥有这台电脑的完整权限。想收紧就把群聊策略改成 allowlist，再把群号填进白名单。'),
        ))
      } else if (access.groupPolicy === 'allowlist' && access.groupAllowCount === 0) {
        rows.push(h('div', { key: 'd', 'data-bb-warn': '' },
          h('b', null, '群聊现在一个都不回'),
          h('span', null, '群聊策略是 allowlist，但白名单是空的——任何群都不会触发。要开哪个群，把群号填进去。'),
        ))
      }
      if (!rows.length) return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, ...rows)
    }

    // 必做清单：一次做完就不用再想（哥哥 m18764）。全绿了自己收成一行。
    function SetupChecklist({ items, onSettings, onChannel }) {
      const [open, setOpen] = useState(false)
      if (!items || !items.length) return null
      const todo = items.filter((x) => !x.ok)
      const go = (where) => {
        if (typeof where === 'string' && where.indexOf('QQ 通道') === 0) onChannel && onChannel()
        else onSettings && onSettings()
      }
      if (!todo.length && !open) {
        return h('div', { 'data-bb-sec': '', style: { padding: '10px 14px' } },
          h('div', { 'data-bb-row': '' },
            h('span', { 'data-bb-ok': '', 'data-bb-grow': '' }, '✓ 必做的几项都齐了'),
            h('button', { 'data-bb-btn': '', onClick: () => setOpen(true) }, '展开看'),
          ),
        )
      }
      return h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, todo.length ? '还差 ' + todo.length + ' 项就能用了' : '必做清单（都齐了）'),
        ...items.map((it) => h('div', { key: it.key, 'data-bb-row': '', style: { alignItems: 'flex-start' } },
          h('span', { 'data-bb-dot': '', 'data-on': it.ok ? '' : undefined }),
          h('div', { 'data-bb-grow': '', style: { minWidth: 0 } },
            h('div', { style: { fontSize: 13.5 } }, it.label,
              h('span', { 'data-bb-note': '', style: { marginLeft: 8 } }, it.ok ? (it.value || '已填') : '没填')),
            h('div', { 'data-bb-note': '' }, it.hint + '　' + it.where),
          ),
          it.ok ? null : h('button', { 'data-bb-btn': '', onClick: () => go(it.where) }, '去填'),
        )),
        open ? h('div', { 'data-bb-row': '' }, h('button', { 'data-bb-btn': '', onClick: () => setOpen(false) }, '收起')) : null,
      )
    }

    // 加一个群的四步：每一步都按真实状态点亮，省得用户自己猜「我配到哪了」
    // 数据来源：access（策略 + 白名单条数）/ chats（见过的聊天）/ bindings（绑上的会话）
// 「怎么加一个群 / 一个人」：放在会话卡片下面，每一步按真实状态点亮
    // 数据来源：access（策略 / 管理员数 / 群白名单条数）、chats（见过的聊天）、bindings（绑上的会话）
    function AddGuide({ access, chats, bindings, onChannel }) {
      const [open, setOpen] = useState(false)
      const a = access || {}
      const list = Array.isArray(chats) ? chats : []
      const binds = Array.isArray(bindings) ? bindings : []
      const idOf = (c) => String((c && (c.chatId != null ? c.chatId : c.id)) || '')
      const pick = (pre) => list.filter((c) => idOf(c).indexOf(pre) === 0)
      const boundOf = (pre) => binds.filter((b) => b && typeof b.chatId === 'string' && b.chatId.indexOf(pre) === 0)
      const onCount = (arr) => arr.filter((b) => b.enabled !== false).length
      const groups = pick('group:')
      const privs = pick('private:')
      const groupBound = boundOf('group:')
      const privBound = boundOf('private:')
      const allow = Number(a.groupAllowCount) || 0
      const admins = Number(a.adminCount) || 0
      const policy = String(a.groupPolicy || '')
      const dm = String(a.dmPolicy || '')
      const groupAllowOk = policy === 'open' || allow > 0
      const dmOk = dm === 'disabled' ? false : (dm === 'allowlist' ? true : admins > 0)
      const dmNote = dm === 'disabled'
        ? '私聊现在是「禁用」：去 QQ 通道 → 权限，改成「开放」或「白名单」'
        : dm === 'allowlist'
          ? '白名单模式：把对方 QQ 加进「私聊白名单」'
          : admins > 0
            ? '「开放」只认管理员（现 ' + admins + ' 个）：把对方加进管理员，或改「主人 QQ」'
            : '「开放」只认管理员，现在一个都没有：填「主人 QQ」或管理员列表'
      const blockGroup = [
        { ok: true, text: '把机器人拉进群', note: '在 QQ 里操作，和拉人一样' },
        {
          ok: groupAllowOk,
          text: '把群号写进白名单',
          note: policy === 'open'
            ? '现在群聊策略是「开放」，哪个群都能进——想收紧就改成「白名单」'
            : allow
              ? '白名单里已经有 ' + allow + ' 个群'
              : '白名单是空的：群里说什么都会被整条丢掉，连会话都不建',
          tip: policy === 'open' ? '' : 'QQ 通道 → 权限 → 群聊白名单（每行一个群号）',
          go: policy !== 'open',
        },
        {
          ok: groups.length > 0,
          text: '在群里 @ 它说一句',
          note: groups.length ? '已经见过 ' + groups.length + ' 个群' : '它收到第一句话才会建会话',
        },
        {
          ok: onCount(groupBound) > 0,
          text: '回到这里绑定，再发一次 /new',
          note: onCount(groupBound)
            ? '有 ' + onCount(groupBound) + ' 个群开着'
            : groupBound.length
              ? '绑上了，但开关是关的'
              : '下面的卡片里挑一个，选配置、打开开关',
          tip: '/new 才换成群聊预设（只读文件、能上网，没有 shell）',
        },
      ]
      const blockDm = [
        { ok: true, text: '让对方加机器人好友，随便说一句', note: '在 QQ 里操作' },
        { ok: dmOk, text: '把这个人放行', note: dmNote, tip: 'QQ 通道 → 权限', go: !dmOk },
        {
          ok: onCount(privBound) > 0,
          text: '回到这里绑定，打开开关',
          note: onCount(privBound)
            ? '有 ' + onCount(privBound) + ' 个私聊开着'
            : privBound.length
              ? '绑上了，但开关是关的'
              : '私聊卡片里挑一个，选配置、打开开关',
        },
      ]
      const all = blockGroup.length + blockDm.length
      const done = blockGroup.concat(blockDm).filter((s) => s.ok).length
      if (done === all && !open) {
        return h('div', { 'data-bb-sec': '', style: { padding: '10px 14px' } },
          h('div', { 'data-bb-row': '' },
            h('span', { 'data-bb-ok': '', 'data-bb-grow': '' }, '✓ 群聊和私聊都通了'),
            h('button', { 'data-bb-btn': '', onClick: () => setOpen(true) }, '看流程'),
          ),
        )
      }
      const renderStep = (s, i) => h('div', { key: 's' + i, 'data-bb-row': '', style: { alignItems: 'flex-start' } },
        h('span', { 'data-bb-dot': '', 'data-on': s.ok ? '' : undefined }),
        h('div', { 'data-bb-grow': '', style: { minWidth: 0 } },
          h('div', { style: { fontSize: 13.5 } }, (i + 1) + '. ' + s.text),
          h('div', { 'data-bb-note': '' }, s.note),
          s.tip ? h('div', { 'data-bb-note': '' }, s.tip) : null,
        ),
        s.go && !s.ok && onChannel
          ? h('button', { 'data-bb-btn': '', onClick: () => onChannel() }, '去填')
          : null,
      )
      return h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '怎么加一个群 / 一个人'),
        h('div', { 'data-bb-note': '', style: { marginBottom: 6 } },
          '走完 ' + done + '/' + all + ' 步就能用。白名单那步不做，消息会被直接丢掉，连会话都不建。'),
        h('div', { 'data-bb-note': '', style: { marginTop: 8, marginBottom: 2 } }, '群聊'),
        ...blockGroup.map(renderStep),
        h('div', { 'data-bb-note': '', style: { marginTop: 10, marginBottom: 2 } }, '私聊'),
        ...blockDm.map(renderStep),
        open ? h('div', { 'data-bb-row': '' }, h('button', { 'data-bb-btn': '', onClick: () => setOpen(false) }, '收起')) : null,
      )
    }
    function Panel(props) {
      const goChannel = props && props.goChannel
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)     // {kind:'ok'|'err', text}
      const [showHistory, setShowHistory] = useState(false)
      const [histFilter, setHistFilter] = useState('')
      const [ext, setExt] = useState(null)
      const [chan, setChan] = useState(null)
      const [chats, setChats] = useState([])
      const [editing, setEditing] = useState('')
      const [newChat, setNewChat] = useState('')
      const [newChatProfile, setNewChatProfile] = useState('')
      const [newEvent, setNewEvent] = useState('')
      const [copiedName, setCopiedName] = useState('')
      const [renaming, setRenaming] = useState('')
      const [picking, setPicking] = useState(false)   // 「加个会话」展开着没有
      const [pickQ, setPickQ] = useState('')          // 会话列表里的搜索词
      const [sessions, setSessions] = useState({})    // chatId -> { sessionId, pinned }（会话自选）
      const [pinDraft, setPinDraft] = useState({})    // chatId -> 正在填的 session id
      const [sub, setSubRaw] = useState(UI.sub || 'overview')  // 陪伴页的子页签（存模块里，重挂不丢）
      const setSub = (v) => { UI.sub = v; setSubRaw(v) }
      const [setup, setSetup] = useState(null)       // 「第一次用」引导：连接状态
      const [tokMsg, setTokMsg] = useState('')
      const loadSetup = useCallback(async () => {
        try { const r = await jget('/setup'); setSetup((p) => sameOr(p, r && r.setup ? r.setup : null)) } catch { setSetup((p) => sameOr(p, null)) }
      }, [])
      const [nap, setNap] = useState(null)           // NapCat 状态（进程 / 二维码文件）
      const [qr, setQr] = useState(null)             // { dataUrl, at }
      const [napBusy, setNapBusy] = useState(false)
      const loadNap = useCallback(async () => {
        try { const r = await jget('/napcat'); setNap((p) => sameOr(p, r && r.napcat ? r.napcat : null)) } catch { setNap((p) => sameOr(p, null)) }
      }, [])
      const loadQr = useCallback(async () => {
        try {
          const r = await jget('/napcat/qr')
          setQr(r && r.ok ? r : { error: (r && r.error) || '拿不到二维码' })
        } catch (e) { setQr({ error: String(e?.message ?? e) }) }
      }, [])
      // 二维码开着的时候每 5 秒自己换一张（11-11）：NapCat 重启后出的是新码，
      // 以前得手点「刷新」，看着就像没反应。
      useEffect(() => {
        if (!qr || !qr.ok || qr.connected) return undefined
        const id = setInterval(loadQr, 5000)
        return () => clearInterval(id)
      }, [qr && qr.ok, qr && qr.connected, loadQr])
      const [doc, setDoc] = useState(null)           // 检查环境的结果
      const [docBusy, setDocBusy] = useState(false)
      const loadDoctor = async () => {
        setDocBusy(true)
        try {
          const r = await jget('/doctor')
          setDoc(r && r.ok ? r.doctor : { error: (r && r.error) || '检查没跑起来', items: [], bad: 0, warn: 0 })
        } catch (e) { setDoc({ error: String(e?.message ?? e), items: [], bad: 0, warn: 0 }) } finally { setDocBusy(false) }
      }
      const napAct = async (which) => {        setNapBusy(true)
        try {
          const r = await jpost('/napcat/' + which, {})
          if (r && r.ok === false) setTokMsg('没成：' + (r.error || '不知道为啥'))
          else setTokMsg(which === 'restart' ? '重启中，等十几秒再看灯' : '已经叫起来了，等它加载')
          setTimeout(() => setTokMsg(''), 6000)
          await loadSetup()
          await loadNap()
        } catch (e) { setTokMsg('没成：' + e.message) } finally { setNapBusy(false) }
      }
      const toggleQr = async () => {
        if (qr) { setQr(null); return }
        await loadQr()
      }
      // 两个保活开关（11-10）：存 ~/.dsh/onebot/napcat-auto.json，立刻生效、重启也认。
      const napAuto = async (key, val) => {
        setNapBusy(true)
        try {
          const r = await jpost('/napcat/auto', { [key]: val })
          if (r && r.ok === false) setTokMsg('没改成：' + (r.error || '不知道为啥'))
          else if (key === 'showWindow') setTokMsg(val ? '开了：下一回启动会带控制台窗口（重开 NapCat 才看得到）' : '关了：启动时不弹黑框，日志写 napcat-launch.log')
          else setTokMsg(val ? '开了：打开 DSH 就自动拉起来，掉了 30 秒内自己回来' : '关了：不碰 NapCat，要用时点「启动 NapCat」')
          setTimeout(() => setTokMsg(''), 6000)
          await loadNap()
        } catch (e) { setTokMsg('没成：' + e.message) } finally { setNapBusy(false) }
      }
      const copyToken = async () => {
        try {
          const r = await jget('/setup/token')
          if (!r || !r.token) { setTokMsg('还没配 token'); return }
          try {
            await navigator.clipboard.writeText(r.token)
            setTokMsg('复制好了，去 NapCat 填同一个')
          } catch {
            setTokMsg('复制不了，手动记：' + r.token)
          }
          setTimeout(() => setTokMsg(''), 6000)
        } catch (e) { setTokMsg('读不到：' + e.message) }
      }
      const loadChan = useCallback(async () => {
        try { const d = await jget('/channel'); setChan((p) => sameOr(p, d)) } catch (e) { setChan({ ok: false, error: String(e?.message ?? e) }) }
      }, [])

      const loadExt = useCallback(async () => {
        try { const d = await jget('/ext'); setExt((p) => sameOr(p, d)) } catch { /* 别家插件没装也正常 */ }
      }, [])

      const saveExt = async (which, patch) => {
        setBusy(true)
        try {
          const d = await jpost('/ext', { [which]: patch })
          if (d.ok === false) {
            setMsg({ kind: 'err', text: '没改成：' + (d[which]?.error || '不知道为啥') })
          } else {
            setMsg({ kind: 'ok', text: '已保存' })
            setTimeout(() => setMsg(null), 1500)
          }
          await loadExt()
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + e.message })
        } finally { setBusy(false) }
      }

      const load = useCallback(async () => {
        try { const d = await jget('/state?limit=60'); setSt((p) => sameOr(p, d)) } catch (e) {
          setMsg({ kind: 'err', text: '读不到状态：' + e.message })
        }
      }, [])

      // 打开面板就先拉一遍会话列表，卡片上才有名字/群名（失败了也不吵）
      const loadChats = useCallback(async () => {
        try {
          const d = await jget('/chats')
          if (d && d.ok !== false && Array.isArray(d.chats)) setChats(d.chats)
        } catch { /* QQ 没连上就先显示 chatId */ }
      }, [])

      // 会话自选：每个聊天现在接哪个会话、钉了哪个（失败了也不吵，卡片显示「读不到」）
      const loadSessions = useCallback(async () => {
        try {
          const d = await jget('/sessions')
          if (d && d.table && typeof d.table === 'object') setSessions(d.table)
        } catch { /* QQ 没连上就先不显示 */ }
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => { loadExt() }, [loadExt])
      useEffect(() => { loadChan() }, [loadChan])
      useEffect(() => { loadSetup() }, [loadSetup])
      useEffect(() => { loadNap() }, [loadNap])
      useEffect(() => { const t = setInterval(() => { if (!isTyping()) loadSetup() }, 10000); return () => clearInterval(t) }, [loadSetup])
      useEffect(() => { loadChats() }, [loadChats])
      useEffect(() => { loadSessions() }, [loadSessions])
      // 轮询：手在输入框里的时候先别拉——整页重画会把光标和没写完的字一起赶走
      // （哥哥 11-11「我在设置页输入时页面会刷新，长文本写不了」）
      useEffect(() => { if (!st) return; const t = setInterval(() => { if (!isTyping()) load() }, 8000); return () => clearInterval(t) }, [st, load])
      useEffect(() => { if (!st) return; const t = setInterval(() => { if (!isTyping()) loadChan() }, 15000); return () => clearInterval(t) }, [st, loadChan])

      const cfg = st?.cfg
      const profiles = (st && st.profiles) || []
      const bindings = (st && st.bindings) || []
      const prof = profiles.find((p) => p.id === editing) || profiles[0] || {}
      const pool = prof.pool || []
      const percent = (() => {
        const m = {}
        const tot = pool.filter((e) => e.enabled !== false)
          .reduce((s, e) => s + Math.max(0, Number(e.weight) || 0), 0)
        for (const e of pool) {
          m[e.id] = e.enabled === false ? 0 : (tot ? Math.round((Math.max(0, Number(e.weight) || 0) * 100) / tot) : 0)
        }
        return m
      })()

      // 所有保存都走这里：体可以是 {全局键} / {profileId, patch} / {profiles} / {bindings}
      const save = async (body) => {
        if (!body) return
        setBusy(true)
        try {
          await jpost('/config', body)
          await load()
          setMsg({ kind: 'ok', text: '已保存' })
          setTimeout(() => setMsg(null), 1800)
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + e.message })
        } finally { setBusy(false) }
      }

      const set = (k, v) => save({ [k]: v })                       // 全家共用
      const setP = (k, v) => save({ profileId: prof.id, patch: { [k]: v } })  // 当前这套配置
      // 他找上门多给几分：跟着这套配置走，老配置没这个键时按模式给默认（主动 3 / 日常 1）
      const profileBonus = (p) => (Number.isFinite(Number(p && p.inboundBonus)) ? Number(p.inboundBonus) : (p && p.mode === 'active' ? 3 : 1))
      const saveBindings = (list) => save({ bindings: list })

      // 把一个会话加进绑定（已经在列表里的先摘掉再放回去，配置不重复）
      const addChat = (id) => {
        const key = String(id || '').trim()
        if (!key) return
        const rest = bindings.filter((b) => b.chatId !== key)
        saveBindings([...rest, { chatId: key, profileId: newChatProfile || prof.id, enabled: true }])
        setNewChat('')
      }
      const saveProfiles = (list) => save({ profiles: list })

      const patchPool = (id, patch) => {
        const next = pool.map((e) => (e.id === id ? { ...e, ...patch } : e))
        save({ profileId: prof.id, patch: { pool: next } })
      }

      // 自定义事件：名字 + 份数就够了，具体怎么做由会话自己想（哥哥 m05588）。
      // 内置那 9 个不给删（删了 mergePool 也会补回来），自己加的能删。
      const addEvent = (name) => {
        const label = String(name || '').trim().slice(0, 12)
        if (!label) return
        const id = 'e' + Date.now().toString(36)
        save({ profileId: prof.id, patch: { pool: [...pool, { id, label, weight: 10, bonus: 3, enabled: true, hint: '' }] } })
      }
      const removeEvent = (id) => {
        save({ profileId: prof.id, patch: { pool: pool.filter((e) => e.id !== id) } })
      }

      const copyProfile = () => {
        const src = prof
        const id = 'c' + Date.now().toString(36)
        const name = (copiedName || src.name + ' 副本').slice(0, 20)
        saveProfiles([...profiles, { ...JSON.parse(JSON.stringify(src)), id, name }])
        setEditing(id)
        setCopiedName('')
      }

      const renameProfile = (name) => {
        const n = String(name || '').trim().slice(0, 20)
        if (!n || n === prof.name) return
        saveProfiles(profiles.map((p) => (p.id === prof.id ? { ...p, name: n } : p)))
      }

      const delProfile = () => {
        if (profiles.length <= 1) return
        const rest = profiles.filter((p) => p.id !== prof.id)
        // 被删那套配置下的会话，挪到剩下第一套
        const nextBindings = bindings.map((b) => (b.profileId === prof.id ? { ...b, profileId: rest[0].id } : b))
        setEditing(rest[0].id)
        save({ profiles: rest, bindings: nextBindings })
      }

      const runNow = async () => {
        setBusy(true)
        try {
          const d = await jpost('/run', {})
          const r = d.result || {}
          const why = r.ok ? `抽中了「${r.eventLabel}」，权重 ${Math.round(r.w0)} → ${Math.round(r.w2)}`
            : `这一轮没动（${r.skipped || '?'}）`
          setMsg({ kind: r.ok ? 'ok' : 'err', text: why })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '跑失败：' + e.message })
        } finally { setBusy(false) }
      }

      // 单个会话：立刻抽一发 / 权重归零
      const runOne = async (chatId) => {
        setBusy(true)
        try {
          const d = await jpost('/run', { chatId })
          const r = d.result || {}
          const why = r.ok
            ? `「${r.eventLabel}」发出去了（权重 ${Math.round(r.w0)} → ${Math.round(r.w2)}）`
            : `没动：${SKIP_TEXT[r.skipped] || r.skipped || '?'}`
          setMsg({ kind: r.ok ? 'ok' : 'err', text: why })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '跑失败：' + e.message })
        } finally { setBusy(false) }
      }

      const resetOne = async (chatId) => {
        setBusy(true)
        try {
          await jpost('/reset', { chatId })
          setMsg({ kind: 'ok', text: '这个会话的权重归零了' })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '归零失败：' + e.message })
        } finally { setBusy(false) }
      }

      // 换会话：填 id 立刻切；空 id = 改回自动（当前对话不动）
      const pinSessionOf = async (chatId, sessionId) => {
        setBusy(true)
        try {
          const d = await jpost('/session', { chatId, sessionId: String(sessionId || '').trim() })
          if (d && d.ok) {
            const pending = !!(d.result && d.result.pending)
            setMsg(pending
              ? { kind: 'ok', text: d.result.message || '钉上了，等那边空出来就自动接上' }
              : { kind: 'ok', text: d.result && d.result.removed === false ? '本来就是自动的' : (sessionId ? '换好了，这条起接着那个会话聊' : '改回自动了（当前对话不动）') })
            setPinDraft((m) => ({ ...m, [chatId]: '' }))
          } else {
            setMsg({ kind: 'err', text: '没换成：' + (d?.result?.message || d?.error || '不知道为啥') })
          }
          if (d && d.table) setSessions(d.table)
          else await loadSessions()
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '换失败：' + e.message })
        } finally { setBusy(false) }
      }

      const reset = async () => {
        setBusy(true)
        try {
          await jpost('/reset', {})
          setMsg({ kind: 'ok', text: '权重归零了' })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '归零失败：' + e.message })
        } finally { setBusy(false) }
      }

      const watchNow = async () => {
        setBusy(true)
        try {
          const d = await jpost('/watch/run', {})
          const r = d.result || {}
          const text = r.seeded ? `第一次接上，先把 ${r.seeded} 条旧账记下（没打扰你）`
            : r.n ? `看到 ${r.n} 条新的，话头递过去了（${r.mode === 'qq' ? '真发' : '干跑'}）`
              : r.skipped === 'off' ? '开关关着呢'
                : r.ok === false ? '没看成：' + (r.error || '?')
                  : '没有新的'
          setMsg({ kind: r.ok === false ? 'err' : 'ok', text })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '看失败：' + e.message })
        } finally { setBusy(false) }
      }

      const pullChats = async () => {
        setBusy(true)
        try {
          const d = await jget('/chats')
          if (d.chats?.length) {
            setChats(d.chats)
            setMsg({ kind: 'ok', text: '拉到 ' + d.chats.length + ' 个会话，从下面那个下拉里挑' })
          } else {
            setMsg({ kind: 'err', text: d.hint || '拉不到会话列表' })
          }
        } catch (e) {
          setMsg({ kind: 'err', text: '拉失败：' + e.message })
        } finally { setBusy(false) }
      }

      if (!st || !cfg) {
        return h('div', { 'data-bb-page': '' },
          h('div', { 'data-bb-note': '' }, '正在读状态…'),
          msg ? h('div', { 'data-bb-msg': '', 'data-err': '' }, msg.text) : null,
        )
      }

      const state = st.state || {}
      const states = st.states || {}
      const history = st.history || []
      const shown = history.filter((x) => {
        if (!histFilter) return true
        if (histFilter === 'sent') return x.delivered && x.mode === 'qq'
        if (histFilter === 'dry') return x.mode === 'dry'
        if (histFilter === 'fail') return !x.delivered
        return true
      })

      ensureCss()

      // 「第一次用」引导卡：三盏灯 + 三步 + 复制 token。装不上插件的人先看这张。
      const lamp = (ok, text, note) => h('div', { 'data-bb-lamp': '', 'data-on': ok ? '' : undefined },
        h('span', { 'data-bb-dot': '' }), h('b', null, text), note ? h('span', { 'data-bb-note': '' }, note) : null)
      const SEC_R_SETUP = !setup ? null : h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '第一次用（QQ 那边接不上先看这里）'),
        h('div', { 'data-bb-lamps': '' },
          lamp(setup.listening, setup.listening ? `本插件在听 ${setup.boundPort || setup.port}` : `没在听 ${setup.port}`,
            setup.mode === 'reverse' ? '等 NapCat 连过来' : '主动连过去'),
          lamp(setup.tokenSet, setup.tokenSet ? '两边 token 一致才行' : '还没设 accessToken',
            setup.tokenSet ? `…${setup.tokenTail}` : '空的会被拒绝'),
          lamp(setup.connected, setup.connected ? `QQ ${setup.selfId} 在线` : 'QQ 还没连上',
            setup.connected ? '能收发' : '多半是 NapCat 没起来或没登录'),
        ),
        h('ol', { 'data-bb-steps': '' },
          h('li', null, '装好 NTQQ 和 NapCat，起 NapCat 后用手机 QQ 扫码登录；'),
          h('li', null, setup.tokenSet
            ? 'NapCat 的 WebUI 里加一个「WebSocket 客户端」，地址 '
            : '先在上面的「插件配置」里设一个 accessToken（重启生效），然后在 NapCat 的 WebUI 里加「WebSocket 客户端」，地址 ',
          h('code', null, setup.url), setup.tokenSet ? '，token 填下面这个；' : '，token 填那个值；'),
          h('li', null, '这里的三盏灯都亮了，再回上面打开「启用」。'),
        ),
        nap && nap.dirSet
          ? h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-note': '' }, nap.running ? 'NapCat 在跑（PID ' + nap.pid + '）' : 'NapCat 没在跑'),
              h('button', { 'data-bb-btn': '', onClick: () => napAct('start'), disabled: napBusy || nap.running }, '启动 NapCat'),
              h('button', { 'data-bb-btn': '', onClick: () => napAct('restart'), disabled: napBusy }, '重启 NapCat'),
              h('button', { 'data-bb-btn': '', onClick: toggleQr, disabled: napBusy }, qr ? '收起二维码' : '看二维码'),
              qr ? h('button', { 'data-bb-btn': '', onClick: loadQr, disabled: napBusy }, '刷新') : null,
              h(QqPowerBtn, null),
            )
          : h('div', { 'data-bb-note': '' },
              nap && nap.error ? nap.error : '想在这里一键启动、扫码：在插件配置里填 napcatDir（含 launcher.bat 的那个目录）'),
        // 保活开关：不开就一个字不碰 NapCat，开了才自动登录 QQ
        nap && nap.dirSet
          ? h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-note': '', 'data-bb-grow': '' }, '打开 DSH 就自动拉起 NapCat', h('br'), '（等于免扫码登录 QQ，不要就关掉）'),
              h(Switch, { on: !!nap.autoStart, disabled: napBusy, onChange: (v) => napAuto('autoStart', v) }),
            )
          : null,
        nap && nap.dirSet
          ? h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-note': '', 'data-bb-grow': '' }, 'NapCat 掉了自动拉回来', h('br'), '（扫码后不用再点一次重启，就靠它）'),
              h(Switch, { on: !!nap.autoRestart, disabled: napBusy, onChange: (v) => napAuto('autoRestart', v) }),
            )
          : null,
        nap && nap.dirSet
          ? h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-note': '', 'data-bb-grow': '' }, '启动 NapCat 时留着它的控制台窗口', h('br'), '（排查用：登录二维码、掉线原因都打在里面；改完要重开一次 NapCat）'),
              h(Switch, { on: !!nap.showWindow, disabled: napBusy, onChange: (v) => napAuto('showWindow', v) }),
            )
          : null,
        qr
          ? (qr.dataUrl
              ? h('div', { 'data-bb-napqr': '' },
                  h('img', { src: qr.dataUrl, alt: 'NapCat 登录二维码' }),
                  h('div', { 'data-bb-note': '' },
                    qr.hint || ('手机 QQ 扫这张；它每分钟换一张（这张是 ' + (Math.max(0, Math.round((Date.now() - Number(qr.at || 0)) / 1000))) + ' 秒前的），扫不上点「刷新」。')))
              : h('div', { 'data-bb-note': '', 'data-err': '' }, qr.error || '拿不到二维码'))
          : null,
        h('div', { 'data-bb-row': '' },
          h('button', { 'data-bb-btn': '', onClick: copyToken, disabled: busy }, '复制 token'),
          h('span', { 'data-bb-note': '' }, tokMsg || (setup.tokenSet ? `和 NapCat 里填的那个必须一样（…${setup.tokenTail}）` : '还没设 token：reverse 模式下留空会拒绝启动')),
        ),
        h('div', { 'data-bb-row': '' },
          h('button', { 'data-bb-btn': '', onClick: loadDoctor, disabled: docBusy }, docBusy ? '检查中…' : '检查环境'),
          h('span', { 'data-bb-note': '' }, '装完东西点一下：标「必需」的四项（Node + 三个依赖）不过就是跑不起来；其余都是可选功能，黄了只少一块。'),
        ),
        doc === null
          ? null
          : (doc.error
              ? h('div', { 'data-bb-note': '', 'data-err': '' }, doc.error)
              : h('div', { 'data-bb-doc': '' },
                  ...(doc.items || []).map((it) => h('div', { 'data-bb-docline': '', 'data-level': it.level, key: it.id },
                    h('span', { 'data-bb-docmark': '' }, it.level === 'ok' ? '✅' : it.level === 'warn' ? '⚠️' : '❌'),
                    h('span', { 'data-bb-docneed': '', 'data-must': it.need === 'must' ? '' : undefined }, it.need === 'must' ? '必需' : '可选'),
                    h('span', { 'data-bb-grow': '' }, it.label + '：' + it.detail),
                    it.fix !== '' && it.fix !== undefined
                      ? h('span', { 'data-bb-docfix': '' }, it.fix)
                      : null,
                  )),
                  h('div', { 'data-bb-note': '' }, (doc.mustBad || 0) === 0
                    ? '必需的四项都齐了，能跑。' + ((doc.betterBad || 0) > 0 ? `另有 ${doc.betterBad} 项可选功能没配齐（不影响聊天）。` : '')
                    : `有 ${doc.mustBad} 项必需没过，上面跟了怎么补。`))),
      )

      const SEC_R_SWITCH = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '开关'),
        h(Field, { label: '启用' },
          h(Switch, { on: cfg.enabled !== false, onChange: (v) => set('enabled', v), disabled: busy })),
        h('div', { 'data-bb-sub': '' },
          h(Field, { label: '干跑（只记账，不真发）', note: '先跑通再打开' },
            h(Switch, { on: cfg.dryRun !== false, onChange: (v) => set('dryRun', v), disabled: busy })),
        ),
      )
      const SEC_R_CHATS = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-row': '' }, h('div', { 'data-bb-h': '', 'data-bb-grow': '' }, '谁在用'), h('span', { 'data-bb-note': '' }, '一个会话一张卡，权重各算各的')),
        !bindings.length
          ? h('div', { 'data-bb-note': '' }, '还没绑会话——下面加一个，不然它不知道往哪儿说。')
          : null,
        ...bindings.map((b, i) => {
          const bk = states[b.chatId] || {}
          const w = Number.isFinite(Number(bk.w)) ? Number(bk.w) : 0
          const bp = profiles.find((x) => x.id === b.profileId) || profiles[0] || {}
          const th = Number(bp.threshold ?? 30)
          const over = w >= th
          const pct = Math.max(0, Math.min(100, ((w + 20) / 120) * 100))
          const winN = Array.isArray(bk.window) ? bk.window.length : 0
          const lastTxt = bk.lastTriggerAt ? agoText(Date.now() - Number(bk.lastTriggerAt)) + '前' : '还没开口过'
          const hit = chats.find((x) => x.chatId === b.chatId)
          const nm = (hit && hit.label) || ''
          const isGroup = String(b.chatId).startsWith('group:')
          return h('div', { 'data-bb-card': '', key: b.chatId },
            h('div', { 'data-bb-row': '' },
              h('span', {
                'data-bb-name': '', 'data-bb-grow': '',
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, nm || b.chatId),
              h('span', { 'data-bb-badge': '' }, isGroup ? '群' : '私聊'),
              h(Switch, {
                on: b.enabled !== false, disabled: busy,
                onChange: (v) => saveBindings(bindings.map((x, j) => (j === i ? { ...x, enabled: v } : x))),
              }),
              h('button', {
                'data-bb-btn': '', disabled: busy,
                onClick: () => saveBindings(bindings.filter((_, j) => j !== i)),
              }, '删'),
            ),
            h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-label': '', style: { fontVariantNumeric: 'tabular-nums', width: 64, flex: 'none' } }, '权重 ' + Math.round(w)),
              h('div', { 'data-bb-bar': '' },
                h('i', { style: { width: pct + '%', background: over ? '#34d399' : undefined } })),
              h('span', { 'data-bb-note': '', style: { width: 96, textAlign: 'right', flex: 'none' } },
                over ? '过阈值 ' + th : '离阈值差 ' + Math.max(0, Math.round(th - w))),
            ),
            h('div', { 'data-bb-row': '' },
              h('select', {
                'data-bb-input': '', value: b.profileId, disabled: busy, style: { width: 'auto' },
                onChange: (e) => saveBindings(bindings.map((x, j) => (j === i ? { ...x, profileId: e.target.value } : x))),
              }, profiles.map((x) => h('option', { key: x.id, value: x.id }, x.name))),
              h('span', { 'data-bb-note': '', 'data-bb-grow': '' }, '上次开口 ' + lastTxt + ' · 窗口 ' + winN + '/' + (bp.limitMax ?? 2)),
              h('button', { 'data-bb-btn': '', disabled: busy, onClick: () => resetOne(b.chatId) }, '归零'),
              h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: busy, onClick: () => runOne(b.chatId) }, '抽一发'),
            ),
            (() => {
              const info = sessions[b.chatId] || {}
              const cur = typeof info.sessionId === 'string' && info.sessionId !== '' ? info.sessionId : ''
              return h('div', { 'data-bb-row': '' },
                h('span', { 'data-bb-label': '', style: { width: 64, flex: 'none' } }, '会话'),
                h('span', {
                  'data-bb-mono': '', 'data-bb-grow': '', title: cur || '按 QQ 号自动生成',
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, cur ? cur.replace(/^session-/, '').slice(0, 12) : '自动'),
                info.pinned ? h('span', { 'data-bb-badge': '' }, '钉住') : null,
              )
            })(),
            h('div', { 'data-bb-row': '' },
              h('input', {
                'data-bb-input': '', 'data-bb-grow': '', disabled: busy,
                placeholder: '填 session-… 或 onebot-… 后点「钉」',
                value: pinDraft[b.chatId] || '',
                onChange: (e) => setPinDraft((m) => ({ ...m, [b.chatId]: e.target.value })),
              }),
              h('button', {
                'data-bb-btn': '', disabled: busy || !String(pinDraft[b.chatId] || '').trim(),
                onClick: () => pinSessionOf(b.chatId, pinDraft[b.chatId]),
              }, '钉'),
              h('button', {
                'data-bb-btn': '', disabled: busy || !(sessions[b.chatId] || {}).pinned,
                onClick: () => pinSessionOf(b.chatId, ''),
              }, '自动'),
            ),
            nm ? h('div', { 'data-bb-mono': '' }, b.chatId) : null,
          )
        }),
        h('div', { 'data-bb-row': '' },
          h('button', {
            'data-bb-btn': '', disabled: busy,
            onClick: () => { const next = !picking; setPicking(next); if (next && !chats.length) pullChats() },
          }, picking ? '收起' : '＋ 加个会话'),
          h('button', { 'data-bb-btn': '', disabled: busy, onClick: pullChats }, '重新拉列表'),
          h('div', { 'data-bb-note': '', 'data-bb-grow': '' },
            chats.length ? '列表里有 ' + chats.length + ' 个会话' : '还没拉到列表，点「重新拉列表」'),
        ),
        picking ? h('div', { 'data-bb-pick': '' },
          h('input', {
            'data-bb-input': '', value: pickQ, placeholder: '按群名 / 号搜一下',
            onChange: (e) => setPickQ(e.target.value),
          }),
          ...(() => {
            if (!chats.length) return [h('div', { 'data-bb-note': '' }, '拿不到列表就先在下面手填。')]
            const q = String(pickQ || '').trim().toLowerCase()
            const free = chats.filter((c) => !bindings.some((b) => b.chatId === c.chatId))
            const hit = free.filter((c) => !q
              || String(c.label || '').toLowerCase().includes(q)
              || String(c.chatId).toLowerCase().includes(q))
            if (!hit.length) return [h('div', { 'data-bb-note': '' }, free.length ? '没有匹配的会话' : '列表里的都加过了')]
            const groups = hit.filter((c) => String(c.chatId).startsWith('group:'))
            const privs = hit.filter((c) => !String(c.chatId).startsWith('group:'))
            const line = (c) => h('div', { 'data-bb-item': '', key: c.chatId },
              h('span', {
                'data-bb-grow': '',
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, c.label || c.chatId),
              c.label ? h('span', { 'data-bb-mono': '' }, c.chatId) : null,
              h('button', {
                'data-bb-btn': '', 'data-primary': '', disabled: busy,
                onClick: () => addChat(c.chatId),
              }, '加'),
            )
            const out = []
            if (privs.length) out.push(h('div', { 'data-bb-note': '', key: 'ph' }, '私聊'))
            for (const c of privs) out.push(line(c))
            if (groups.length) out.push(h('div', { 'data-bb-note': '', key: 'gh' }, '群'))
            for (const c of groups) out.push(line(c))
            return out
          })(),
          h('div', { 'data-bb-row': '' },
            h('input', {
              'data-bb-input': '', 'data-bb-grow': '', value: newChat,
              placeholder: '手填 private:123456789 或 group:123456',
              onChange: (e) => setNewChat(e.target.value),
            }),
            h('select', {
              'data-bb-input': '', value: newChatProfile || prof.id, style: { width: 'auto' },
              onChange: (e) => setNewChatProfile(e.target.value),
            }, profiles.map((p) => h('option', { key: p.id, value: p.id }, p.name))),
            h('button', {
              'data-bb-btn': '', disabled: busy || !String(newChat).trim(),
              onClick: () => addChat(newChat),
            }, '＋ 加上'),
          ),
        ) : null,
        h('div', { 'data-bb-note': '' }, 'private: 是私聊，group: 是群。每个会话各算各的权重，互不抢额度。'),
      )
      const SEC_R_MODE = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-row': '' },
          h('div', { 'data-bb-h': '', 'data-bb-grow': '' }, '模式'),
          h('span', { 'data-bb-note': '' }, '一套参数一份；改哪一页，用它的会话立刻跟着变'),
        ),
        h('div', { 'data-bb-tabs': '' },
          ...profiles.map((p) => h('button', {
            key: p.id, 'data-bb-tab': '', 'data-on': p.id === prof.id ? '' : undefined,
            disabled: busy, onClick: () => setEditing(p.id),
          }, p.name)),
          h('button', {
            'data-bb-tab': '', disabled: busy, title: '照这套再建一份',
            onClick: () => {
              const id = 'c' + Date.now().toString(36)
              const copy = JSON.parse(JSON.stringify(prof))
              saveProfiles([...profiles, { ...copy, id, name: '新配置' }])
              setEditing(id)
            },
          }, '＋ 新模式'),
        ),
        h('div', { 'data-bb-row': '' },
          h('input', {
            'data-bb-input': '', 'data-bb-grow': '', defaultValue: dget('prof:' + prof.id + ':name', prof.name), key: prof.id + ':name',
            placeholder: '这页叫什么',
            onChange: (e) => dset('prof:' + prof.id + ':name', e.target.value),
            onBlur: (e) => { ddrop('prof:' + prof.id + ':name'); renameProfile(e.target.value) },
          }),
          h('button', { 'data-bb-btn': '', disabled: busy, onClick: copyProfile }, '复制当前'),
          h('button', { 'data-bb-btn': '', disabled: busy || profiles.length <= 1, onClick: delProfile }, '删掉这页'),
        ),
        h('div', { 'data-bb-note': '' }, '下面「权重 / 频率 / 事件池」改的都是当前这页。'),
      )
      const SEC_R_WEIGHT = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '权重'),
        h(Field, { label: '阈值（低于它不开口）' }, h(Num, { value: prof.threshold, onChange: (v) => setP('threshold', v), min: -20, max: 99 })),
        h(Field, { label: '每次涨多少', note: '每抽一拍涨这么多，跟隔了多久无关' }, h(Num, { value: prof.risePerTick, onChange: (v) => setP('risePerTick', v), min: 0, max: 50, step: 0.1 })),
        h(Field, { label: '多久抽一次（分钟）' }, h(Num, { value: prof.tickMinutes, onChange: (v) => setP('tickMinutes', v), min: 1, max: 240 })),
        h(Field, { label: '触发概率上限', note: '权重 100 时就是它；平时按 权重/100 打折，低于阈值不开口' }, h(Num, { value: prof.triggerPmax, onChange: (v) => setP('triggerPmax', v), min: 0.01, max: 1, step: 0.01 })),
        h(Field, { label: '每轮扣多少', note: '每结束一轮就扣一次，扣和补都按「轮」当场算完：不管这轮是她主动开口、还是你找她，扣这么多；她给自己打的心情分当场按表补回来：12 分 +200%、11 分 +150%、10 分 +120%、9 分 +80%、8 分 +60%、7 分 +50%、6 分 +20%、5 分 0%、4 分 −20%、3 分 −40%、2 分 −60%、1 分 −80%、0 分 −100%。' }, h(Num, { value: prof.releaseBase, onChange: (v) => setP('releaseBase', v), min: 0, max: 100 })),
        h(Field, { label: '他找上门多给几分', note: '你起的这一轮里，她给自己的评分先加上这么多分（0-12 分制里的分）。调高 = 你多找她几次，她就更容易主动开口；0 = 不加；填负数 = 她爱打高分时把分压回来。抽卡、追聊那一下不吃这份。跟着这套配置走，两套可以不一样。' },
          h('div', { 'data-bb-row': '' },
            h(Num, { value: profileBonus(prof), onChange: (v) => setP('inboundBonus', v), min: -10, max: 10 }),
            h('span', { 'data-bb-note': '' }, '分'),
          )),
        h(Field, { label: '权重下限', note: '扣到这儿就到底（−100 ~ 0）。想让她掉得深一点就往下放，找到舒服的数值再调阈值。' }, h(Num, { value: prof.wFloor, onChange: (v) => setP('wFloor', v), min: -100, max: 0 })),
      )
      const SEC_R_FREQ = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '频率'),
        h(Field, { label: '每几小时最多几条' },
          h('div', { 'data-bb-row': '' },
            h(Num, { value: prof.limitHours, onChange: (v) => setP('limitHours', v), min: 0.1, max: 72, step: 0.5 }),
            h('span', { 'data-bb-note': '' }, '小时最多'),
            h(Num, { value: prof.limitMax, onChange: (v) => setP('limitMax', v), min: 1, max: 100 }),
            h('span', { 'data-bb-note': '' }, '条'),
          )),
        h(Field, { label: '他刚说过话就先别插嘴', note: '分钟；0 = 不管' },
          h('div', { 'data-bb-row': '' },
            h(Num, { value: prof.idleMinutes ?? 20, onChange: (v) => setP('idleMinutes', v), min: 0, max: 1440 }),
            h('span', { 'data-bb-note': '' }, '分钟内他动过嘴，这一轮就跳过'),
          )),
        h(Field, { label: '免打扰' },
          h(Switch, {
            on: prof.quiet?.enabled !== false, disabled: busy,
            onChange: (v) => save({ profileId: prof.id, patch: { quiet: { ...prof.quiet, enabled: v } } }),
          })),
        h('div', { 'data-bb-sub': '' },
          h('div', { 'data-bb-row': '' },
            h('input', {
              'data-bb-input': '', 'data-bb-num': '', defaultValue: prof.quiet?.from || '00:00', key: prof.id + ':qf',
              onBlur: (e) => save({ profileId: prof.id, patch: { quiet: { ...prof.quiet, from: e.target.value } } }),
            }),
            h('span', { 'data-bb-note': '' }, '到'),
            h('input', {
              'data-bb-input': '', 'data-bb-num': '', defaultValue: prof.quiet?.to || '07:00', key: prof.id + ':qt',
              onBlur: (e) => save({ profileId: prof.id, patch: { quiet: { ...prof.quiet, to: e.target.value } } }),
            }),
          ),
        ),
        h(Field, { label: '定时话头', note: '他说话或回她的那一轮，她可以写 [LATER 25] 让自己 25 分钟后再来说；抽卡叫起来的那轮不给排' },
          h(Switch, {
            on: cfg.followupEnabled !== false, disabled: busy,
            onChange: (v) => set('followupEnabled', v),
          })),
        h('div', { 'data-bb-sub': '' },
          h('div', { 'data-bb-row': '' },
            h(Num, { value: cfg.followupPerDay ?? 3, onChange: (v) => set('followupPerDay', v), min: 1, max: 20 }),
            h('span', { 'data-bb-note': '' }, '条/天，最长'),
            h(Num, { value: cfg.followupMaxHours ?? 12, onChange: (v) => set('followupMaxHours', v), min: 1, max: 12 }),
            h('span', { 'data-bb-note': '' }, '小时'),
          ),
          h('div', { 'data-bb-row': '' },
            h(Num, { value: cfg.followupMinSec ?? 60, onChange: (v) => set('followupMinSec', v), min: 30, max: 3600, step: 30 }),
            h('span', { 'data-bb-note': '' }, '秒起——她写 [LATER 5] 也按这个抬起来'),
          ),
          h('span', { 'data-bb-note': '' }, '到点只是把她叫醒再说一轮（能看到最新对话），不会发固定内容；免打扰照样管，限流不管'),
        ),
      )
      const SEC_R_POOL = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-row': '' },
          h('div', { 'data-bb-h': '', 'data-bb-grow': '' }, '事件池'),
          h('span', { 'data-bb-note': '' }, '填了词、勾上才参与抽签；两个数字是「份数」和「抽中加多少分」（可填负数）；下面那行是给会话的补充'),
        ),
        ...pool.map((e) => h('div', { 'data-bb-evbox': '', key: e.id },
          h('div', { 'data-bb-ev': '' },
            h('button', {
              'data-bb-sw': '', 'data-on': e.enabled !== false ? '' : undefined,
              style: { width: 30, height: 18 }, disabled: busy,
              onClick: () => patchPool(e.id, { enabled: e.enabled === false }),
            }, h('i', { style: { width: 12, height: 12, top: 3, left: e.enabled === false ? 3 : 15 } })),
            h('input', {
              'data-bb-input': '', 'data-bb-label': '', type: 'text', maxLength: 20,
              defaultValue: dget(prof.id + ':' + e.id + ':label', e.label || ''), key: prof.id + ':' + e.id + ':label',
              placeholder: '填个词（留空就不抽它）',
              style: { width: 132 },
              onChange: (ev) => dset(prof.id + ':' + e.id + ':label', ev.target.value),
              onBlur: (ev) => {
                ddrop(prof.id + ':' + e.id + ':label')
                patchPool(e.id, { label: String(ev.target.value).trim().slice(0, 20) })
              },
            }),
            h('input', {
              'data-bb-input': '', 'data-bb-num': '', type: 'number', min: 0, max: 1000,
              defaultValue: e.weight, key: prof.id + ':' + e.id + ':w', style: { width: 64 },
              onChange: (ev) => {
                const v = Number(ev.target.value)
                ev.target.dataset.v = String(v)
              },
              onBlur: (ev) => patchPool(e.id, { weight: Math.max(0, Number(ev.target.value) || 0) }),
            }),
            h('input', {
              'data-bb-input': '', 'data-bb-num': '', type: 'number', min: -20, max: 20, step: 1,
              defaultValue: e.bonus, key: prof.id + ':' + e.id + ':b', style: { width: 58 },
              title: '抽中这条时权重加多少（负数就是扣）',
              onBlur: (ev) => patchPool(e.id, {
                bonus: Math.max(-20, Math.min(20, Math.round(Number(ev.target.value) || 0))),
              }),
            }),
            h('div', { 'data-bb-bar': '' }, h('i', { style: { width: `${Math.min(100, percent[e.id] || 0)}%` } })),
            h('span', { 'data-bb-pct': '' }, `${percent[e.id] ?? 0}%`),
            BUILTIN_EVENTS.includes(e.id) ? null : h('button', {
              'data-bb-x': '', title: '删掉这个自定义事件', disabled: busy,
              onClick: () => removeEvent(e.id),
            }, '×'),
          ),
          h('input', {
            'data-bb-input': '', 'data-bb-hint': '',
            defaultValue: dget(prof.id + ':' + e.id + ':hint', e.hint || ''), key: prof.id + ':' + e.id + ':hint',
            placeholder: e.label
              ? '想加点什么就写这儿；留空就只把「' + e.label + '」这个词递过去'
              : '先在上面填个词；这里可以再补一句说明',
            onChange: (ev) => dset(prof.id + ':' + e.id + ':hint', ev.target.value),
            onBlur: (ev) => {
              ddrop(prof.id + ':' + e.id + ':hint')
              patchPool(e.id, { hint: String(ev.target.value).trim().slice(0, 80) })
            },
          }),
        )),
        h('div', { 'data-bb-row': '', style: { marginTop: 8 } },
          h('input', {
            'data-bb-input': '', 'data-bb-grow': '', value: newEvent,
            placeholder: '自己加一个事件：比如「分享首歌」（只是把词递过去）',
            onChange: (ev) => setNewEvent(ev.target.value),
            onKeyDown: (ev) => {
              if (ev.key !== 'Enter' || busy) return
              addEvent(newEvent); setNewEvent('')
            },
          }),
          h('button', {
            'data-bb-btn': '', disabled: busy || !String(newEvent || '').trim(),
            onClick: () => { addEvent(newEvent); setNewEvent('') },
          }, '＋ 加上'),
        ),
      )
      const SEC_R_TEST = h('div', { 'data-bb-row': '' },
        h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: busy, onClick: runNow }, '立刻抽一次'),
        h('button', { 'data-bb-btn': '', disabled: busy, onClick: reset }, '权重归零'),
        h('button', { 'data-bb-btn': '', disabled: busy, onClick: load }, '刷新'),
      )
      const SEC_R_HISTORY = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-row': '' },
          h('div', { 'data-bb-h': '', 'data-bb-grow': '' }, '做过的事'),
          h('span', { 'data-bb-note': '' }, `${history.length} 条`),
          h('button', { 'data-bb-btn': '', onClick: () => setShowHistory((v) => !v) }, showHistory ? '收起' : '看它做了什么'),
        ),
        showHistory ? h('div', null,
          h('div', { 'data-bb-row': '', style: { marginBottom: 6 } },
            ...[['', '全部'], ['sent', '真发了'], ['dry', '干跑'], ['fail', '没发出去']].map(([v, label]) =>
              h('button', {
                'data-bb-chip': '', 'data-on': histFilter === v ? '' : undefined,
                onClick: () => setHistFilter(v),
              }, label),
            ),
          ),
          shown.length ? h('div', { 'data-bb-list': '' },
            ...shown.map((x, i) => h('div', {
              'data-bb-item': '', 'data-nosend': x.delivered ? undefined : '', key: i,
              title: x.error || '',
            },
              h('span', { 'data-bb-was': '' }, new Date(x.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
              h('span', { 'data-bb-grow': '' }, x.label || x.event),
              h('span', { 'data-bb-was': '' }, `${Math.round(x.w0)} → ${Math.round(x.w2)}`),
              h('span', { 'data-bb-badge': '' },
                x.mode === 'qq' ? '发了' : x.mode === 'dry' ? '干跑' : (x.error ? '没发出去' : '没发')),
            )),
          ) : h('div', { 'data-bb-note': '' }, '还没有记录。点上面「立刻抽一次」试试。'),
        ) : null,
      )
      const SEC_R_CHANNEL = h('div', { 'data-bb-note': '' },
        chan
          ? (chan.ok
              ? `QQ 通道：在线 · ${chan.selfId || '（没拿到号）'}`
              : (chan.hasService ? 'QQ 通道：掉线了，连回来之前先不往那边发' : 'QQ 通道：插件没接上'))
          : 'QQ 通道：读取中…',
        chan && chan.ok ? '' : null,
      )
      const SEC_R_VERSION = h('div', { 'data-bb-note': '' },
        `v${st.version} · 家目录 ${st.home}`,
      )

    // 设置页的「说明」页：症状表在最前，逐项解释在后（哥哥 11-10 要的）
    function HelpPage() {
      const symptom = [
        ['太吵，一天找你好几次', '每轮扣分调高、阈值调高、限流条数调小'],
        ['半天不吭声', '每拍涨多少调高、阈值调低、触发概率上限调高'],
        ['总在深夜冒出来', '免打扰的两个时间点'],
        ['发的东西不对味', '事件池里那几项的份数（后台一份文档没有，就在这页）'],
        ['刷视频老是热榜', '兴趣关键词是不是空的（空着就走热门兜底）'],
        ['抽卡太频繁', '限流「几小时最多几条」'],
        ['她老说「过会儿再说」', '定时话头的上限（条数调小、或者直接关掉）'],
        ['你找她聊、她还是那副冷样', '「他找上门多给几分」调高：你起的每一轮都给她的评分加分'],
      ]
      const rows = [
        ['每拍涨多少', '节拍每跑一拍涨这么多，涨过阈值才有机会开口。想让她更容易主动就调大。'],
        ['阈值（低于它不开口）', '分数门槛，低于它就是 0 概率。调高＝更少开口。'],
        ['触发概率上限', '满分时的开口概率，实际概率 = 它 × 分数 ÷ 100。'],
        ['每轮扣多少', '每结束一轮扣一次（不论谁起头、发没发出去），扣完立刻按她这一轮打的分补/追（12 分 +200%、11 分 +150%、10 分 +120% … 0 分 −100%），当场算完，不等下一拍。'],
        ['权重下限', '扣到这儿就停住（−100~0）。设太深，一次热闹之后要很久才爬回来。'],
        ['限流', '滑动窗口：几小时内最多发几条。和阈值是两道闸，两道都过才开口。'],
        ['免打扰', '这段时间只涨分不开口；绑定开关关掉，这一条整条停（连分都不涨）。'],
        ['定时话头', '她能给自己排一个「过会儿再说」，到点插件再叫醒她说一轮；这里只管上限，说什么时候说、隔多久，是她自己定的。'],
        ['事件池 · 份数', '每轮抽中各项的权重，合计自动归一。不想让它出现就用开关关掉（份数写 0 会回退默认）。'],
        ['事件池 · 加分', '抽中这一项额外加多少分。'],
      ]
      return h('div', { 'data-bb-help': '' },
        h('div', { 'data-bb-help-t': '' }, '看症状，找数字'),
        ...symptom.map(([k, v]) => h('div', { 'data-bb-help-li': '' }, h('b', null, k + '：'), v)),
        h('div', { 'data-bb-help-t': '' }, '逐项'),
        ...rows.map(([k, v]) => h('div', { 'data-bb-help-li': '' }, h('b', null, k + '：'), v)),
      )
    }

      /* ────────────── 话头：能自己写、能预览、存了下一拍就生效 ────────────── */
      function CuePage() {
        const [cue, setCue] = useState(null)
        const [def, setDef] = useState(null)
        const [ph, setPh] = useState([])
        const [previews, setPreviews] = useState([])
        const [fixed, setFixed] = useState([])
        const [pick, setPick] = useState('video')
        const [busy, setBusy] = useState(false)
        const [dirty, setDirty] = useState(false)
        const [msg, setMsg] = useState(null)

        const load = useCallback(async () => {
          try {
            const r = await jget('/cue')
            if (!r || r.ok === false) throw new Error((r && r.error) || '读不到')
            // 上一轮没存的草稿还在：面板被宿主重画过一次，把字捡回来接着写
            const draft = dget('cue:draft', null)
            if (draft && typeof draft.template === 'string') {
              setCue(draft); setDirty(true)
            } else {
              setCue(r.cue); setDirty(false)
            }
            setDef(r.defaults)
            setPh(r.placeholders || [])
            setFixed(r.fixed || [])
            setPreviews(r.previews || [])
          } catch (e) {
            setMsg({ kind: 'err', text: '读不到话头：' + e.message })
          }
        }, [])
        useEffect(() => { load() }, [load])

        const patch = (fn) => {
          setCue((c) => {
            if (!c) return c
            const n = JSON.parse(JSON.stringify(c))
            fn(n)
            dset('cue:draft', n)   // 草稿跟着模块走，重挂也能接着写
            return n
          })
          setDirty(true)
        }
        const doPreview = async () => {
          if (!cue) return
          setBusy(true)
          try {
            const r = await jpost('/cue/preview', { cue })
            if (!r || !r.previews) throw new Error((r && r.error) || '预览失败')
            setPreviews(r.previews)
            setMsg({ kind: 'ok', text: '预览用的就是真发的那套渲染' })
          } catch (e) {
            setMsg({ kind: 'err', text: '预览失败：' + e.message })
          } finally { setBusy(false) }
        }
        const save = async () => {
          if (!cue) return
          setBusy(true)
          try {
            const r = await jpost('/cue', { cue })
            if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败')
            setCue(r.cue)
            setPreviews(r.previews || [])
            ddrop('cue:draft')
            setDirty(false)
            setMsg({ kind: 'ok', text: '存好了，下一拍就用新的（不用重启）' })
          } catch (e) {
            setMsg({ kind: 'err', text: '保存失败：' + e.message })
          } finally { setBusy(false) }
        }

        if (!cue) {
          return h('div', { 'data-bb-page': '' }, h(Toast, { msg }),
            h('div', { 'data-bb-note': '' }, msg ? msg.text : '正在读话头…'))
        }
        const pv = previews.find((x) => x.id === pick) || previews[0] || { text: '' }

        return h('div', { 'data-bb-page': '' },
          h(Toast, { msg }),
          h('div', { 'data-bb-card': '' },
            h('div', { 'data-bb-name': '' }, '话头 = 插件对会话说的那一句'),
            h('div', { 'data-bb-note': '' }, '插件只说「什么时候、手边有什么」，正文一个字都不代写；她看见的就是下面这些字。'),
            h('div', { 'data-bb-note': '' }, '怎么写：一行一句。{{…}} 会被换成真东西；一行里只有占位符、又换不出内容，这一行整行消失。'),
            h('div', { 'data-bb-note': '' }, '什么时候生效：点「保存」→ 写进 config.json → 下一拍（最长 5 分钟）就用新的，不用重启、不用刷新。改完先点「预览」，预览走的是真发的那套渲染。'),
            h('div', { 'data-bb-note': '' }, '最后一行是机制说明（不想发怎么拦），固定跟着每条话头走，模板里不用写，写了也会被拿掉。别的想写什么写什么——「不用交代来路」那句只是模板里的普通一行，删了就没有。'),
          ),

          h('div', { 'data-bb-card': '' },
            h('div', { 'data-bb-h': '' }, '模板'),
            h('textarea', {
              'data-bb-input': '', 'data-bb-textarea': '', style: { minHeight: '200px' },
              value: cue.template,
              onChange: (e) => patch((n) => { n.template = e.target.value }),
            }),
            h('div', { 'data-bb-row': '', style: { flexWrap: 'wrap', gap: '6px' } },
              ...ph.map((p) => h('span', {
                'data-bb-chip': '', key: p.key,
                title: p.desc + (p.example ? '（例：' + p.example + '）' : ''),
              }, p.key)),
            ),
            h('div', { 'data-bb-note': '' }, ph.map((p) => p.key + ' ' + p.desc).join(' · ')),
            h('div', { 'data-bb-note': '' }, '插件固定压在最后的一行（改不了，也不用写进模板）：'),
            h('div', { 'data-bb-fixed': '' }, ...(fixed.length ? fixed : ['不想发就写 [HOLD]，插件会替你吞掉。']).map((line) => h('span', { key: line }, line))),
          ),

          h('div', { 'data-bb-card': '' },
            h('div', { 'data-bb-h': '' }, '候选与兜底'),
            h('div', { 'data-bb-note': '' }, '「这一轮干嘛」只看事件页那个事件填的词，这儿不再单独写台词（两处写会打架）。'),
            h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-label': '', style: { width: '76px', flex: 'none', fontSize: '12px' } }, '候选标题'),
              h('input', {
                'data-bb-input': '', 'data-bb-grow': '', value: cue.candidatesTitle || '',
                onChange: (e) => patch((n) => { n.candidatesTitle = e.target.value }),
              }),
            ),
            h('div', { 'data-bb-row': '' },
              h('span', { 'data-bb-label': '', style: { width: '76px', flex: 'none', fontSize: '12px' } }, '没备到料'),
              h('input', {
                'data-bb-input': '', 'data-bb-grow': '', value: cue.empty || '',
                placeholder: '留空就不提示',
                onChange: (e) => patch((n) => { n.empty = e.target.value }),
              }),
            ),
          ),

          h('div', { 'data-bb-card': '' },
            h('div', { 'data-bb-h': '' }, '预览'),
            h('div', { 'data-bb-row': '', style: { flexWrap: 'wrap', gap: '6px' } },
              ...previews.map((p) => h('button', {
                key: p.id, 'data-bb-btn': '', 'data-primary': pick === p.id ? '' : undefined,
                onClick: () => setPick(p.id),
              }, p.name)),
            ),
            h('pre', { 'data-bb-pre': '' }, pv.text || '（这一种现在什么都不会发）'),
          ),

          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', disabled: busy, onClick: doPreview }, '预览'),
            h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: busy || !dirty, onClick: save }, dirty ? '保存（有改动）' : '保存'),
            h('button', {
              'data-bb-btn': '', disabled: busy || !def,
              onClick: () => { if (def) { setCue(JSON.parse(JSON.stringify(def))); setDirty(true); setMsg(null) } },
            }, '恢复默认'),
            dirty ? h('span', { 'data-bb-note': '' }, '还没保存') : null,
          ),
        )
      }

      const SUB_TABS = [['overview', '总览'], ['settings', '设置'], ['cue', '话头'], ['help', '说明']]
      const subBar = h('div', { 'data-bb-subtabs': '' },
        ...SUB_TABS.map(([v, label]) => h('button', {
          key: v, 'data-bb-subtab': '', 'data-on': sub === v ? '' : undefined,
          onClick: () => setSub(v),
        }, label)),
      )

      const out = []
      out.push(h(Toast, { msg }))
      out.push(h(AccessWarn, { access: st && st.access }))
      out.push(subBar)
      if (sub === 'overview') {
        out.push(h(SetupChecklist, {
          items: st && st.setup,
          onSettings: () => { setSub('settings') },
          onChannel: () => { goChannel && goChannel() },
        }))
        if (SEC_R_SETUP) out.push(SEC_R_SETUP)
        out.push(SEC_R_SWITCH)
        out.push(SEC_R_CHATS)
        // 会话卡片下面接一段「怎么加群 / 加人」——白名单和 @ 这两步不看就是空白，用户自己猜不出来
        out.push(h(AddGuide, {
          access: st && st.access,
          chats: chats,
          bindings: bindings,
          onChannel: () => { goChannel && goChannel() },
        }))
        out.push(SEC_R_TEST)
        out.push(SEC_R_CHANNEL)
        out.push(SEC_R_VERSION)
      }
      if (sub === 'settings') {
        out.push(SEC_R_MODE)
        out.push(h('div', { 'data-bb-tabpanel': '' }, SEC_R_WEIGHT, SEC_R_FREQ))
        out.push(SEC_R_POOL)
        out.push(SEC_R_HISTORY)
      }
      if (sub === 'cue') out.push(h(CuePage))
      if (sub === 'help') out.push(h(HelpPage))
      return h('div', { 'data-bb-page': '' }, ...out)
    }

    /* ────────────── B站与视频：挑视频的规矩 + 看视频用哪个模型 ────────────── */
    function BiliPanel() {
      const [st, setSt] = useState(null)
      const [ext, setExt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const load = useCallback(async () => {
        try { setSt(await jget('/state?limit=1')) } catch (e) { setMsg({ kind: 'err', text: '读不到状态：' + e.message }) }
      }, [])
      const loadExt = useCallback(async () => { try { const d = await jget('/ext'); setExt((p) => sameOr(p, d)) } catch { /* 别家插件没装也正常 */ } }, [])
      useEffect(() => { load() }, [load])
      useEffect(() => { loadExt() }, [loadExt])
      const save = async (body) => {
        if (!body) return
        setBusy(true)
        try {
          await jpost('/config', body)
          await load()
          setMsg({ kind: 'ok', text: '已保存' })
          setTimeout(() => setMsg(null), 1800)
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + e.message })
        } finally { setBusy(false) }
      }
      const set = (k, v) => save({ [k]: v })
      const saveExt = async (which, patch) => {
        setBusy(true)
        try {
          const d = await jpost('/ext', { [which]: patch })
          if (d.ok === false) {
            setMsg({ kind: 'err', text: '没改成：' + (d[which]?.error || '不知道为啥') })
          } else {
            setMsg({ kind: 'ok', text: '已保存' })
            setTimeout(() => setMsg(null), 1500)
          }
          await loadExt()
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + e.message })
        } finally { setBusy(false) }
      }
      const watchNow = async () => {
        setBusy(true)
        try {
          const d = await jpost('/watch/run', {})
          const r = d.result || {}
          const text = r.seeded ? `第一次接上，先把 ${r.seeded} 条旧账记下（没打扰你）`
            : r.n ? `看到 ${r.n} 条新的，话头递过去了（${r.mode === 'qq' ? '真发' : '干跑'}）`
              : r.skipped === 'off' ? '开关关着呢'
                : r.ok === false ? '没看成：' + (r.error || '?')
                  : '没有新的'
          setMsg({ kind: r.ok === false ? 'err' : 'ok', text })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '看失败：' + e.message })
        } finally { setBusy(false) }
      }
      ensureCss()
      const cfg = (st && st.cfg) || {}
      if (!st) return h('div', { 'data-bb-page': '' }, h('div', { 'data-bb-note': '' }, '正在读状态…'))
      const SEC_R_VIDEO = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, '刷视频'),
        h(Field, { label: '兴趣关键词', note: '逗号隔开；留空就翻 B站 首页热门' },
          h('input', {
            'data-bb-input': '', defaultValue: dget('bili:keywords', asText(cfg.keywords)),
            placeholder: '比如：DeepSeek，手搓电路，猫',
            onChange: (e) => dset('bili:keywords', e.target.value),
            onBlur: (e) => {
              ddrop('bili:keywords')
              set('keywords', e.target.value.split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean))
            },
          })),
        h(Field, { label: '一次摆几条', note: '挑哪条最后还是看会话' },
          h(Num, { value: cfg.videoPerRound ?? 3, onChange: (v) => set('videoPerRound', v), min: 1, max: 5 })),
        h(Field, { label: '每轮用几个关键词', note: '词多了就轮着用，一轮取这么几个' },
          h(Num, { value: cfg.videoKeywordsPerRound ?? 3, onChange: (v) => set('videoKeywordsPerRound', v), min: 1, max: 10 })),
        h(Field, { label: '多久以内算新' },
          h('div', { 'data-bb-row': '' },
            h(Num, { value: cfg.videoFreshDays ?? 14, onChange: (v) => set('videoFreshDays', v), min: 1, max: 365 }),
            h('span', { 'data-bb-note': '' }, '天内'),
          )),
        h(Field, { label: '播放量低于这个不理', note: '关键词搜出来的会再查一次播放量' },
          h(Num, { value: cfg.videoMinPlay ?? 1000, onChange: (v) => set('videoMinPlay', v), min: 0, max: 1000000 })),
        h(Field, { label: '视频多长才要', note: '太短多半没法看，太长看不完' },
          h('div', { 'data-bb-row': '' },
            h(Num, { value: cfg.videoMinSec ?? 60, onChange: (v) => set('videoMinSec', v), min: 0, max: 7200, step: 30 }),
            h('span', { 'data-bb-note': '' }, '秒 ~'),
            h(Num, { value: cfg.videoMaxSec ?? 1800, onChange: (v) => set('videoMaxSec', v), min: 10, max: 7200, step: 60 }),
            h('span', { 'data-bb-note': '' }, '秒'),
          )),
        h(Field, { label: '按关键词搜的再查一次详情', note: '关掉省接口，但时长、播放量就筛不动了' },
          h(Switch, { on: cfg.videoDetail !== false, disabled: busy, onChange: (v) => set('videoDetail', v) })),
        h(Field, { label: '不感兴趣（标题/UP/标签里有就不推）', note: '逗号隔开' },
          h('input', {
            'data-bb-input': '', defaultValue: dget('bili:videoExclude', asText(cfg.videoExclude)), placeholder: '比如：广告，标题党，切片',
            onChange: (e) => dset('bili:videoExclude', e.target.value),
            onBlur: (e) => {
              ddrop('bili:videoExclude')
              set('videoExclude', e.target.value.split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean))
            },
          })),
        h(Field, { label: '拉黑的 UP 主', note: '名字或 mid 都行，逗号隔开' },
          h('input', {
            'data-bb-input': '', defaultValue: dget('bili:blockUps', asText([].concat(cfg.videoBlockUps || [], cfg.videoBlockUids || []))),
            placeholder: '比如：某个UP，12345678',
            onChange: (e) => dset('bili:blockUps', e.target.value),
            onBlur: (e) => {
              ddrop('bili:blockUps')
              const all = e.target.value.split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean)
              const uids = all.filter((x) => /^\d+$/.test(x))
              const ups = all.filter((x) => !/^\d+$/.test(x))
              set('videoBlockUids', uids)
              set('videoBlockUps', ups)
            },
          })),
      )
      const SEC_R_WATCH = h('div', { 'data-bb-sec': '' },
        h('div', { 'data-bb-h': '' }, 'B站 那边有动静'),
        h(Field, { label: '盯着私信 / 回复我的 / @我的', note: '有新的就把一句话头递给会话，不看权重' },
          h(Switch, { on: cfg.biliWatch !== false, onChange: (v) => set('biliWatch', v), disabled: busy })),
        h(Field, { label: '多久看一眼（分钟）', note: 'B站 接口有频率限制，别调太快' },
          h(Num, { value: cfg.biliWatchMinutes ?? 5, onChange: (v) => set('biliWatchMinutes', v), min: 1, max: 240 })),
        h(Field, { label: '自己人的 B站 号', note: '逗号隔开；只有这些号的私信会递进来' },
          h('input', {
            'data-bb-input': '', defaultValue: dget('bili:ownerUids', asText(cfg.biliOwnerUids)), placeholder: '比如：233078950',
            onChange: (e) => dset('bili:ownerUids', e.target.value),
            onBlur: (e) => {
              ddrop('bili:ownerUids')
              set('biliOwnerUids', e.target.value.split(/[，,、\s]+/).map((x) => Number(x)).filter((n) => n > 0))
            },
          })),
        h(Field, { label: '陌生人的私信也递', note: '默认不递，只记在账本里' },
          h(Switch, { on: cfg.biliDmStrangers === true, onChange: (v) => set('biliDmStrangers', v), disabled: busy })),
        h(Field, { label: '私信算打扰', note: '关掉就只记账，不来打断她' },
          h(Switch, { on: cfg.biliDm !== false, onChange: (v) => set('biliDm', v), disabled: busy })),
        h(Field, { label: '@ 我算打扰', note: '关掉就只记账' },
          h(Switch, { on: cfg.biliAt !== false, onChange: (v) => set('biliAt', v), disabled: busy })),
        h(Field, { label: '评论回复算打扰', note: '关掉就只记账' },
          h(Switch, { on: cfg.biliReply !== false, onChange: (v) => set('biliReply', v), disabled: busy })),
        h(Field, { label: '来料动权重', note: '关掉：这轮照回，但不 +分也不扣分（账本不被别人的消息带跑）' },
          h(Switch, { on: cfg.biliWeight !== false, onChange: (v) => set('biliWeight', v), disabled: busy })),
        h('div', { 'data-bb-note': '' },
          '规矩：自己人的私信 → 递进来；陌生人的私信 → 只记账不打扰；回复我的 / @我的 → 不管是谁都递（那是人家来找你）。'),
        h('div', { 'data-bb-note': '' },
          'B站 那边能不能回话还没打通（要写接口，往外发东西得你点头）；现在只做到「知道有人找你」。'),
        h('div', { 'data-bb-row': '' },
          h('button', { 'data-bb-btn': '', disabled: busy, onClick: watchNow }, '现在看一眼'),
          h('span', { 'data-bb-note': '', 'data-bb-grow': '' }, '第一次接上只记账、不打扰'),
        ),
      )
      return h('div', { 'data-bb-page': '' },
        h(Toast, { msg }),
        SEC_R_VIDEO,
        SEC_R_WATCH,
        h(BiliLogin, { key: 'bili-login' }),
        h(ExtSection, {
          title: '看视频用哪个模型',
          note: '就地改运行中的配置，立刻生效；重启会回到 yml 里的值。',
          data: ext?.qq, which: 'qq', onSave: saveExt, busy, only: ['看视频'],
        }),
        h('div', { 'data-bb-note': '' }, '识图（QQ 收到图片时认图）在「QQ 通道」那边。'),
      )
    }

    /* ────────────── QQ 通道页底：识图那组（认图、模型、凭证） ────────────── */
    function ExtQqSection() {
      const [ext, setExt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const loadExt = useCallback(async () => { try { const d = await jget('/ext'); setExt((p) => sameOr(p, d)) } catch { /* 拿不到就不显示 */ } }, [])
      useEffect(() => { loadExt() }, [loadExt])
      const saveExt = async (which, patch) => {
        setBusy(true)
        try {
          const d = await jpost('/ext', { [which]: patch })
          if (d.ok === false) {
            setMsg({ kind: 'err', text: '没改成：' + (d[which]?.error || '不知道为啥') })
          } else {
            setMsg({ kind: 'ok', text: '已保存' })
            setTimeout(() => setMsg(null), 1500)
          }
          await loadExt()
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + e.message })
        } finally { setBusy(false) }
      }
      ensureCss()

      /* ─────── 聊天强制事件：每轮回复掷一次，中了才塞一句话（哥哥 11-11） ─────── */
      function ChatRollsCard() {
        const [rows, setRows] = useState(null)
        const [busy, setBusy] = useState(false)
        const [msg, setMsg] = useState(null)

        const load = useCallback(async () => {
          try {
            const r = await jget('/rolls')
            if (!r || !r.ok) throw new Error((r && r.error) || '读不到')
            setRows(r.rolls || [])
          } catch (e) {
            setMsg({ kind: 'err', text: '读不到聊天强制事件：' + e.message })
          }
        }, [])
        useEffect(() => { load() }, [load])

        const save = async (next) => {
          setRows(next)
          setBusy(true)
          try {
            const r = await jpost('/rolls', { rolls: next })
            if (!r || !r.ok) throw new Error((r && r.error) || '没存上')
            setRows(r.rolls || next)
            setMsg({ kind: 'ok', text: '存好了，下一轮就用新的' })
            setTimeout(() => setMsg(null), 1600)
          } catch (e) {
            setMsg({ kind: 'err', text: '没存上：' + e.message })
          } finally { setBusy(false) }
        }
        const patch = (id, obj) => save(rows.map((r) => (r.id === id ? { ...r, ...obj } : r)))
        const add = () => {
          const id = 'r' + Date.now().toString(36)
          save([...rows, { id, label: '', chance: 20, enabled: true, builtin: false, gate: '' }])
        }
        const del = (id) => save(rows.filter((r) => r.id !== id))

        return h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-h': '' }, '聊天强制事件'),
          h('div', { 'data-bb-note': '' }, '每轮回复掷一次：中了才把这句话塞进这一轮，没中就什么都不塞。表情包那条是内置的，删不掉（能关、能改数）。'),
          ...(rows || []).map((r) => h('div', { 'data-bb-evbox': '', key: r.id },
            h('div', { 'data-bb-ev': '' },
              h('button', {
                'data-bb-sw': '', 'data-on': r.enabled !== false ? '' : undefined,
                style: { width: 30, height: 18 }, disabled: busy,
                onClick: () => patch(r.id, { enabled: r.enabled === false }),
              }, h('i', { style: { width: 12, height: 12, top: 3, left: r.enabled === false ? 3 : 15 } })),
              h('input', {
                'data-bb-input': '', 'data-bb-grow': '', type: 'text',
                defaultValue: dget('roll:' + r.id, r.label || ''), key: 'roll:' + r.id,
                placeholder: '这轮必须…（写给人看的一句）', maxLength: 60,
                onChange: (ev) => dset('roll:' + r.id, ev.target.value),
                onBlur: (ev) => { ddrop('roll:' + r.id); patch(r.id, { label: String(ev.target.value).trim() }) },
              }),
              h('input', {
                'data-bb-input': '', 'data-bb-num': '', type: 'number', min: 0, max: 100, step: 1,
                defaultValue: r.chance, key: 'rollw:' + r.id, style: { width: 64 },
                title: '每轮掷中的百分比',
                onBlur: (ev) => patch(r.id, { chance: Math.max(0, Math.min(100, Math.round(Number(ev.target.value) || 0))) }),
              }),
              h('span', { 'data-bb-note': '' }, '%'),
              r.builtin ? h('span', { 'data-bb-note': '' }, '固定') : h('button', {
                'data-bb-x': '', title: '删掉这条', disabled: busy, onClick: () => del(r.id),
              }, '×'),
            ),
            r.gate === 'voice' ? h('div', { 'data-bb-note': '' }, '这条要先探本地嗓子在不在线；不在线这轮跳过') : null,
          )),
          h('div', { 'data-bb-row': '', style: { marginTop: 8 } },
            h('button', { 'data-bb-btn': '', disabled: busy, onClick: add }, '+ 加一条'),
            h('span', { 'data-bb-note': '' }, '比如「这轮必须叫他一声哥哥」「这轮必须说一句方言」'),
          ),
        )
      }

      /* 每一组单独一块，顺序自己定（field 的声明顺序不是给人看的）。
         「群里必须 @ 才回」故意留在这页之外——它在 QQ 设置面板的权限组里，
         两边都放会出现两个开关写同一个键。 */
      const GROUPS = [
        ['识图', '识图（QQ 收到图片时）', '就地改运行中的配置，立刻生效；重启会回到 yml 里的值。'],
        ['人设', '人设', '原样插在每轮提示词最前面；留空 = 不加。人格本体还是会话自己的工作区。'],
        ['互动', '互动', '连着几条消息并成一轮的时机；表情包 / 语音这些每轮随机的，在下面那张「聊天强制事件」里。'],
        ['群聊', '群聊关键词（硬触发）', '听到这些词就直接接话，不用等 @。'],
        ['主动', '主动找人', '追一句之后最多再追几次、隔多久。'],
        ['其他', '其他', ''],
      ]
      return h('div', { 'data-bb-page': '' },
        h(Toast, { msg }),
        ...GROUPS.flatMap(([group, title, note]) => [h(ExtSection, {
          key: 'g-' + group, title, note: note || undefined,
          data: ext?.qq, which: 'qq', onSave: saveExt, busy, only: [group],
        }), group === '互动' ? h(ChatRollsCard, { key: 'rolls' }) : null].filter(Boolean)),
        // 「看视频」那组不在这页——它在「B站与视频」页里已经有一份了，
        // 两页都放就是同 14 个字段渲染两遍（哥哥 11-11 问「B站看视频和 QQ 看视频不是一个东西吗」）。
        h('div', { 'data-bb-note': '' }, '「看视频用哪个模型」在「B站与视频」页——跟刷视频的规矩放一起。'),
      )
    }

    return {
      inject: ['slots'],
      ui: UI,
      Panel: Panel,
      BiliPanel: BiliPanel,
      ExtQqSection: ExtQqSection,
      RetiredSessions: RetiredSessions,
      QqPower: QqPower,
      DoneTab: DoneTab,
      apply(ctx) {
        ensureCss()
        const slots = ctx.get('slots')
        if (!slots) return
        // 会话头那个 tab（原先是刷B站插件的「刷过的视频」，现在这位置归我们）
        try {
          slots.inject('conversation.view', () => slots.register({
            name: 'conversation.view',
            id: 'bubble-done',
            order: 20,
            label: '做过的事',
            scope: 'session',
          }, () => h(DoneTab)))
        } catch (e) { /* 老版本没这个槽位就算了 */ }
      },
    }
		})(require);
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-onebot-paopao";
		var REMOTE_NS = "onebotSettings"; // Typert Remote 命名空间（T1 §4，与 host 服务键一致）
		var NS = "dsh-onebot"; // locale 命名空间
		//#endregion

		//#region 四组 29 键字段定义（T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy：分组/键集/类型/默认值；与
		//  src/settings-remote.ts SETTINGS_GROUPS / SCHEMA_DEFAULTS / 类型分组逐字对齐，
		//  tests/client-settings.spec.ts 断言一致性。数值键 dedupWindowSeconds/
		//  actionRatePerMinute/actionRatePerDay/injectIntervalMs 与枚举键 traceLevel
		//  本期不上面板（host 白名单同样不含），仍走 patch config 手改——取舍见 DEVLOG W6。）
		/** 字段类型：enum（下拉）/ number / boolean / string / stringArray（多行文本）/ secret（密码型）。 */
		var GROUPS = [
			{
				id: "connection",
				title: "连接",
				fields: [
					{ key: "mode", label: "连接模式", type: "enum", options: ["reverse", "forward"], optionLabels: { reverse: "反向 WebSocket（NapCat 连接本插件）", forward: "正向 WebSocket（插件连接 NapCat）" }, hint: "reverse 时监听下方地址与端口；forward 时连接下方服务器地址。" },
					{ key: "host", label: "反向 WS 监听地址", type: "string", hint: "仅 reverse 模式生效。" },
					{ key: "port", label: "反向 WS 监听端口", type: "number", hint: "仅 reverse 模式生效。" },
					{ key: "url", label: "正向 WS 服务器地址", type: "string", hint: "仅 forward 模式生效，如 ws://127.0.0.1:3001。" },
					{ key: "accessToken", label: "访问令牌（AccessToken）", type: "secret", hint: "与 NapCat 侧一致的鉴权令牌；留空 = 不修改，勾选清除后保存 = 清空。" },
					{ key: "botQQ", label: "机器人 QQ 号", type: "string" },
					// W7：workspacePath 入面板（connection 组键序追加）。语义（对齐 README「会话工作区选择」）：
					// 修改只对新会话生效；已设 per-chat /workspace 覆盖的会话不受影响。
					{ key: "workspacePath", label: "会话默认工作区路径", type: "string", hint: "QQ 会话的工作区目录；保存后仅对新会话生效，已用 /workspace 设置 per-chat 覆盖的会话不受影响。留空 = 宿主进程工作目录。（配置键 workspacePath）" },
				],
			},
			{
				id: "permissions",
				title: "权限",
				fields: [
					{ key: "requireMention", label: "群聊必须 @ 机器人", type: "boolean" },
					{ key: "adminUsers", label: "管理员用户列表", type: "stringArray", hint: "每行一个 QQ 号。" },
					{ key: "dmPolicy", label: "私聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "groupPolicy", label: "群聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "allowAllUsers", label: "允许所有用户", type: "boolean", hint: "关闭时仅管理员可触发。" },
					{ key: "allowFrom", label: "私聊白名单", type: "stringArray", hint: "每行一个 QQ 号，仅白名单策略生效。" },
					{ key: "groupAllowFrom", label: "群聊白名单", type: "stringArray", hint: "每行一个群号，仅白名单策略生效。" },
				],
			},
			{
				id: "behavior",
				title: "行为",
				fields: [
					{ key: "interimMessages", label: "中间消息", type: "boolean", hint: "回合进行中发送流式中间消息。" },
					{ key: "interimRecall", label: "自动撤回中间消息", type: "boolean" },
					{ key: "interimRecallMs", label: "中间消息保留时长（秒）", type: "number", scale: 1000 },
					{ key: "sendErrorNotice", label: "发送错误通知", type: "boolean" },
					{ key: "unknownCommand", label: "未知命令处理", type: "enum", options: ["intercept", "passthrough"], optionLabels: { intercept: "拦截", passthrough: "透传" } },
					{ key: "rateLimitPerMinute", label: "每分钟消息频率上限", type: "number" },
					{ key: "newMessagePolicy", label: "任务运行中的新消息", type: "enum", options: ["queue", "steer"], optionLabels: { queue: "排队", steer: "插话" }, hint: "任务运行中收到新普通消息：排队=当前任务结束后按序处理（每回合至多提示一次）；插话=作为补充指令加入当前任务。图片/文件/语音/引用消息与受限用户始终按排队处理。（配置键 newMessagePolicy）" },
					{ key: "autoSteerPolicy", label: "自动插话资格", type: "enum", options: ["admin", "all"], optionLabels: { admin: "仅管理员", all: "所有成员" }, hint: "插话模式下运行中收到的新普通纯文字消息谁可自动插话：仅管理员（默认）或所有成员。不具备资格的消息按排队处理；/steer 命令始终仅管理员；受限用户任何档都不自动插话。（配置键 autoSteerPolicy）" },
					{ key: "deferredTimeoutMs", label: "等待模型回复超时（秒）", type: "number", scale: 1000, hint: "回合超过该时长（秒；0=关闭）无任何模型输出时提示超时并登记补发跟踪，任务完成后自动补发最终文字（超时补发）；发送失败最多重试 3 次，结果不确定时停止自动重试；/stop 终止该聊天的补发跟踪。0=关闭。（配置键 deferredTimeoutMs）" },
				],
			},
			{
				id: "diagnostics",
				title: "诊断",
				fields: [
					{ key: "actionAuditEnabled", label: "主动写审计", type: "boolean", hint: "每次主动发送/转发记一行审计到 qq-actions.log（含限额拦截）；关闭后拦截不再留审计痕迹。（配置键 actionAuditEnabled）" },
					{ key: "traceEnabled", label: "决策追踪（trace）", type: "boolean", hint: "把每个入站/出站决策事件写入 qq-trace.jsonl 便于排查；关闭后零文件、行为与关闭时完全一致。（配置键 traceEnabled）" },
					{ key: "recordInbound", label: "入站事件录制", type: "boolean", hint: "把收到的每条消息事件录制到 qq-inbox.jsonl（可离线回放）；关闭后不录制、无法回放。（配置键 recordInbound）" },
					{ key: "inboxRedact", label: "录制脱敏", type: "boolean", hint: "录制时把 QQ 号/群号等 6 位以上数字串打码；关闭后录制文件含明文号码，注意隐私。（配置键 inboxRedact）" },
					{ key: "injectEnabled", label: "事件注入（仅调试）", type: "boolean", hint: "轮询 qq-inject.jsonl 把文件里的消息喂进真实管线，离线调试用；生产环境勿开。（配置键 injectEnabled）" },
					{ key: "injectDryRun", label: "注入 dry-run", type: "boolean", hint: "拦截注入回合产生的所有出站发送（默认开）；关闭后注入消息会真实发出，仅限隔离环境。（配置键 injectDryRun）" },
				],
			},
		];
		/** 全部 29 键扁平表（顺序 = 四组声明顺序，与 host ALL_KEYS 语义一致；T2 起含 newMessagePolicy、T9 起含 autoSteerPolicy、T3 起含 deferredTimeoutMs）。 */
		var ALL_FIELDS = [];
		for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
			for (var fieldIndex = 0; fieldIndex < GROUPS[groupIndex].fields.length; fieldIndex++) {
				ALL_FIELDS.push(GROUPS[groupIndex].fields[fieldIndex]);
			}
		}
		/** schema 默认值（T1 §4 表；重置按钮与空快照兜底的唯一来源；与
		 *  src/settings-remote.ts SCHEMA_DEFAULTS 逐字对齐）。 */
		var DEFAULTS = {
			mode: "reverse",
			host: "127.0.0.1",
			port: 8643,
			url: "ws://127.0.0.1:3001",
			accessToken: "",
			botQQ: "",
			workspacePath: "",
			requireMention: true,
			adminUsers: [],
			dmPolicy: "open",
			groupPolicy: "open",
			allowAllUsers: false,
			allowFrom: [],
			groupAllowFrom: [],
			interimMessages: true,
			interimRecall: true,
			interimRecallMs: 90000,
			sendErrorNotice: true,
			unknownCommand: "intercept",
			rateLimitPerMinute: 30,
			newMessagePolicy: "queue",
			autoSteerPolicy: "admin",
			deferredTimeoutMs: 600000,
			actionAuditEnabled: true,
			traceEnabled: false,
			recordInbound: false,
			inboxRedact: false,
			injectEnabled: false,
			injectDryRun: true,
		};
		/** 分组 → 键数组（与 host SETTINGS_GROUPS 同构；供契约核对与快照渲染兜底）。 */
		var GROUP_KEYS = {};
		for (var gk = 0; gk < GROUPS.length; gk++) {
			GROUP_KEYS[GROUPS[gk].id] = GROUPS[gk].fields.map(function (field) { return field.key; });
		}
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用；与模板同款）
		function vString(min, max) {
			return {
				parse(value) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vNumber(min, max) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
					if (min !== undefined && value < min) throw new TypeError("expected number >= " + min);
					if (max !== undefined && value > max) throw new TypeError("expected number <= " + max);
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item) {
			return {
				parse(value) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map((entry) => item.parse(entry));
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner) {
			return {
				parse(value) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Remote 契约 schema（与 host lib/settings-remote.js 快照/校验逐字对齐）
		/** 29 键生效值（host buildSnapshot 的 effectiveConfig 全键返回；accessToken 恒 ''）。 */
		var configSchema = vObject({
			mode: vEnum(["reverse", "forward"]),
			host: vString(0, 256),
			port: vNumber(),
			url: vString(0, 512),
			accessToken: vString(0, 256),
			botQQ: vString(0, 64),
			workspacePath: vString(0, 1024),
			requireMention: vBoolean(),
			adminUsers: vArray(vString(0, 64)),
			dmPolicy: vEnum(["open", "allowlist", "disabled"]),
			groupPolicy: vEnum(["open", "allowlist", "disabled"]),
			allowAllUsers: vBoolean(),
			allowFrom: vArray(vString(0, 64)),
			groupAllowFrom: vArray(vString(0, 64)),
			interimMessages: vBoolean(),
			interimRecall: vBoolean(),
			interimRecallMs: vNumber(),
			sendErrorNotice: vBoolean(),
			unknownCommand: vEnum(["intercept", "passthrough"]),
			rateLimitPerMinute: vNumber(),
			newMessagePolicy: vEnum(["queue", "steer"]),
			autoSteerPolicy: vEnum(["admin", "all"]),
			deferredTimeoutMs: vNumber(),
			actionAuditEnabled: vBoolean(),
			traceEnabled: vBoolean(),
			recordInbound: vBoolean(),
			inboxRedact: vBoolean(),
			injectEnabled: vBoolean(),
			injectDryRun: vBoolean(),
		});
		var snapshotSchema = vObject({
			revision: vInt(0),
			entryActive: vBoolean(),
			config: configSchema,
			secrets: vArray(vObject({ path: vArray(vString(1, 64)), set: vBoolean() })),
			groups: vObject({
				connection: vArray(vString(1, 64)),
				permissions: vArray(vString(1, 64)),
				behavior: vArray(vString(1, 64)),
				diagnostics: vArray(vString(1, 64)),
			}),
			effect: vEnum(["restart"]), // T1 §5：19 键统一插件级热重启
		});
		/** updateSettings 入参（T1 §4 + W6 + W7：29 键任意子集的扁平 JSON；accessToken 缺省=不改，''=清空）。 */
		var patchSchema = vObject({
			mode: vOptional(vEnum(["reverse", "forward"])),
			host: vOptional(vString(0, 256)),
			port: vOptional(vNumber(1, 65535)),
			url: vOptional(vString(0, 512)),
			accessToken: vOptional(vString(0, 256)),
			botQQ: vOptional(vString(0, 64)),
			workspacePath: vOptional(vString(0, 1024)),
			requireMention: vOptional(vBoolean()),
			adminUsers: vOptional(vArray(vString(0, 64))),
			dmPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			groupPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			allowAllUsers: vOptional(vBoolean()),
			allowFrom: vOptional(vArray(vString(0, 64))),
			groupAllowFrom: vOptional(vArray(vString(0, 64))),
			interimMessages: vOptional(vBoolean()),
			interimRecall: vOptional(vBoolean()),
			interimRecallMs: vOptional(vNumber(0)),
			sendErrorNotice: vOptional(vBoolean()),
			unknownCommand: vOptional(vEnum(["intercept", "passthrough"])),
			rateLimitPerMinute: vOptional(vNumber(0)),
			newMessagePolicy: vOptional(vEnum(["queue", "steer"])),
			autoSteerPolicy: vOptional(vEnum(["admin", "all"])),
			deferredTimeoutMs: vOptional(vNumber(0)),
			actionAuditEnabled: vOptional(vBoolean()),
			traceEnabled: vOptional(vBoolean()),
			recordInbound: vOptional(vBoolean()),
			inboxRedact: vOptional(vBoolean()),
			injectEnabled: vOptional(vBoolean()),
			injectDryRun: vOptional(vBoolean()),
		});
		//#endregion

		//#region Typert Remote 严格 descriptor（与 host lib/settings-remote.js 服务方法面
		//  逐字对齐：getSettings() / updateSettings(patch, expectedRevision) /
		//  listWorkspaces()（W7），全 positional。
		//  host 侧未导出客户端 descriptor 数组——两侧各自持有一份，本数组为客户端真相源，
		//  变更须同步宿主侧并在 DEVLOG 记录；tests/client-settings.spec.ts 做契约核对。）
		/** W7：listWorkspaces 返回值（host WorkspaceListResult 同构）。 */
		var workspaceListSchema = vObject({
			available: vBoolean(),
			workspaces: vArray(vObject({ id: vString(1, 256), path: vString(0, 1024), sessionCount: vInt(0) })),
		});
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function onebotMethod(method, parameters, resultSchema, typeSymbol) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec(typeSymbol != null ? typeSymbol : "OnebotSettingsSnapshot", resultSchema || snapshotSchema),
			};
		}
		var ONEBOT_SETTINGS_DESCRIPTORS = [
			onebotMethod("getSettings", []),
			onebotMethod("updateSettings", [
				jsonParameter("patch", "OnebotSettingsPatch", patchSchema),
				jsonParameter("expectedRevision", "number", vOptional(vInt(0))),
			]),
			onebotMethod("listWorkspaces", [], workspaceListSchema, "WorkspaceListResult"),
		];
		var ONEBOT_SETTINGS_REMOTE = { package: PLUGIN_ID, descriptors: ONEBOT_SETTINGS_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式。
		//  分组标题与字段 label 是中文常量（T4 要求），不走词条。）
		var zh = {
			"settings.title": "QQ Bot（OneBot）设置",
			"settings.desc": "配置持久化为 profile 层 cordis.patch.yml 中 dsh-onebot 条目的 config 覆盖行，与手改 patch、宿主原生设置页同源。",
			"settings.loading": "正在加载设置…",
			"settings.reload": "重新加载",
			"settings.reset": "恢复默认值",
			"save.submit": "保存设置",
			"save.saving": "正在保存…",
			"save.done": "设置已保存。保存即热生效：插件秒级重启，QQ 桥会自动重连。",
			"save.noChanges": "没有需要保存的变更。",
			"save.badNumber": "数字字段不合法：{keys}",
			"effect.hint": "保存即热生效（无需重启宿主）：插件秒级原地重启，QQ 桥会自动重连；在途回合中断、频控窗口与中间消息缓冲清零，会话映射/历史不受影响。",
			"effect.entryInactive": "dsh-onebot 条目当前未激活，保存后可能无法生效，请检查插件加载状态。",
			"secret.set": "已配置（脱敏，不回显）",
			"secret.unset": "未配置",
			"secret.placeholder": "留空 = 不修改",
			"secret.clear": "清除已保存的 AccessToken",
			"conflict.title": "保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取最新配置，请检查后重试。",
			"status.error": "出错",
			"revision.label": "revision",
			// 批 2 第二档词条（integration §2.4/§2.5：交互文案 zh/en 同批新增，既有键
			// 文案不改）——脏状态 badge/保存禁用 title/危险操作确认框/密文清除三态
			// 提示/mode 联动 hint/加载与 workspace 重试/诊断折叠 summary/组描述（UX §2.2 版）。
			"common.retry": "重试",
			"save.dirtyBadge": "{count} 项未保存",
			"save.noChangesTitle": "没有未保存的修改",
			"confirm.discardChanges": "将丢弃 {count} 项未保存修改，确定继续吗？",
			"effect.entryInactiveTitle": "插件条目未激活，修改可能无法生效。",
			"secret.clearPending": "保存后清空",
			"secret.clearHint": "将清除已保存的值",
			"field.modeInactive": "当前模式不生效",
			"workspace.fetchFailed": "本次拉取 workspace 列表失败，可直接输入路径。",
			"diagnostics.summary": "{total} 项 · {enabled} 项默认开",
			"diagnostics.dirtyMark": "● 含未保存修改",
			"group.connection.desc": "NapCat/QQ 桥接参数",
			"group.permissions.desc": "谁能触发与使用",
			"group.behavior.desc": "回复与限流",
			"group.diagnostics.desc": "观测与调试开关",
			// 批 3 词条（UX §5.4/§5.6 + integration §3：冲突合并保留 + 数字行内校验，
			// zh/en 同批齐平；既有键文案不改）。
			"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。",
			"conflict.secretCleared": "accessToken 输入已清空，如需修改请重新输入。",
			"field.numberInvalid": "必须是 {range} 的有限数字",
			"field.remoteOverwritten": "已被其他来源修改，已同步为最新值",
		};
		var en = {
			"settings.title": "QQ Bot (OneBot) settings",
			"settings.desc": "Settings persist as the config override row of the dsh-onebot entry in the profile-layer cordis.patch.yml — same source as hand-edited patches and the host's native settings page.",
			"settings.loading": "Loading settings…",
			"settings.reload": "Reload",
			"settings.reset": "Reset to defaults",
			"save.submit": "Save settings",
			"save.saving": "Saving…",
			"save.done": "Settings saved. Hot-applied on save: the plugin restarts within seconds and the QQ bridge reconnects automatically.",
			"save.noChanges": "Nothing to save.",
			"save.badNumber": "Invalid number fields: {keys}",
			"effect.hint": "Hot-applied on save (no host restart): the plugin fiber restarts in place within seconds; the QQ bridge reconnects automatically. In-flight turns are interrupted and rate-limit windows/interim buffers reset; session mappings and history are unaffected.",
			"effect.entryInactive": "The dsh-onebot entry is currently inactive; saving may not take effect. Check the plugin's load state.",
			"secret.set": "Configured (redacted, never echoed)",
			"secret.unset": "Not configured",
			"secret.placeholder": "Leave empty = keep current",
			"secret.clear": "Clear the saved AccessToken",
			"conflict.title": "Save conflict: settings were changed by another source (revision mismatch). The latest snapshot has been re-fetched — review and retry.",
			"status.error": "Error",
			"revision.label": "revision",
			"common.retry": "Retry",
			"save.dirtyBadge": "{count} unsaved",
			"save.noChangesTitle": "No unsaved changes",
			"confirm.discardChanges": "Discard {count} unsaved change(s)?",
			"effect.entryInactiveTitle": "The plugin entry is inactive; changes may not take effect.",
			"secret.clearPending": "Clears on save",
			"secret.clearHint": "The saved value will be cleared",
			"field.modeInactive": "Not active in the current mode",
			"workspace.fetchFailed": "Couldn't fetch the workspace list this time — you can type a path directly.",
			"diagnostics.summary": "{total} items · {enabled} on by default",
			"diagnostics.dirtyMark": "● Unsaved changes",
			"group.connection.desc": "NapCat/QQ bridge settings",
			"group.permissions.desc": "Who can trigger and use the bot",
			"group.behavior.desc": "Replies and rate limiting",
			"group.diagnostics.desc": "Observability and debugging switches",
			// 批 3（UX §5.4/§5.6）：与 zh 同批新增的 4 键（冲突合并保留 + 数字行内校验）。
			"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again.",
			"conflict.secretCleared": "The accessToken input has been cleared; re-enter it if you still want to change it.",
			"field.numberInvalid": "Must be a finite number {range}",
			"field.remoteOverwritten": "Changed by another source — synced to the latest value",
		};
		/** 双语 key 集一致性自检：缺漏仅告警不致崩溃。 */
		function assertSameKeys(a, b) {
			var missing = Object.keys(a).filter((key) => !(key in b));
			var extra = Object.keys(b).filter((key) => !(key in a));
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-onebot] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 obx-）
		// 批 1 视觉基线（docs/design/settings-page-visual-proposal.md §1–§6）：
		// §5.1 token 表色值逐字采用（WCAG AA 实测校准），不自创/不改值；
		// 附加的 -bg / --obx-card-border / --obx-error-ring 为方案正文（§2/§3.1/§4.2）
		// 点名引用而 §5.1 未列值的衍生位——卡片描边延续现状组分隔发丝线色值，
		// 横幅浅底取同 hue alpha 淡化（延续原 error 浅底 .08 同族）。
		var CSS = [
			".obx-panel{--obx-fg:inherit;--obx-fg-muted:#6b7280;--obx-border:rgba(128,128,128,.75);--obx-border-strong:rgba(128,128,128,1);--obx-card-bg:rgba(128,128,128,.06);--obx-card-border:rgba(128,128,128,.2);--obx-input-bg:transparent;--obx-accent:var(--dsh-accent,#2563eb);--obx-focus-ring:rgba(37,99,235,.45);--obx-error:#e5484d;--obx-error-text:#d93036;--obx-error-bg:rgba(229,72,77,.10);--obx-error-ring:rgba(229,72,77,.45);--obx-warning:#d97706;--obx-warning-text:#92400e;--obx-warning-bg:rgba(217,119,6,.12);--obx-success:#2f9e63;--obx-success-text:#1a7f4b;--obx-success-bg:rgba(47,158,99,.10);--obx-switch-off:rgba(128,128,128,.7);--obx-switch-knob:#ffffff;--obx-radius-sm:6px;--obx-radius-md:8px;--obx-radius-lg:10px;--obx-fs-xs:11px;--obx-fs-sm:12px;--obx-fs-base:13px;--obx-fs-md:14px;--obx-fs-lg:16px;--obx-space-1:4px;--obx-space-2:8px;--obx-space-3:12px;--obx-space-4:16px;--obx-space-5:20px;--obx-space-6:24px;--obx-dur-fast:150ms ease;display:flex;flex-direction:column;gap:16px;font-size:var(--obx-fs-md);line-height:1.5;max-width:720px;container-type:inline-size;container-name:obx}",
			"@media (prefers-color-scheme: dark){.obx-panel{--obx-fg-muted:#9ca3af;--obx-border:rgba(255,255,255,.35);--obx-border-strong:rgba(255,255,255,.5);--obx-card-bg:rgba(128,128,128,.10);--obx-card-border:rgba(128,128,128,.2);--obx-accent:var(--dsh-accent,#60a5fa);--obx-focus-ring:rgba(96,165,250,.55);--obx-error-text:#ff8a8a;--obx-warning-text:#fbbf24;--obx-success-text:#4ade80;--obx-switch-off:rgba(128,128,128,.55);--obx-switch-knob:#e8e8e8}}",
			// §1 结构：720px 内容上限（左对齐不居中，由块级布局天然实现）
			".obx-title{font-size:var(--obx-fs-lg);font-weight:600;margin:0}",
			".obx-desc{color:var(--obx-fg-muted);font-size:var(--obx-fs-sm);margin:4px 0 0}",
			".obx-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".obx-spacer{flex:1}",
			// §4.2：revision 徽章 / entryInactive 升级 pill（badge 族 11px）
			".obx-meta{color:var(--obx-fg-muted);font-size:var(--obx-fs-xs);border:1px solid var(--obx-border);border-radius:999px;padding:1px 8px}",
			".obx-warn{color:var(--obx-warning-text);background:var(--obx-warning-bg);border-color:var(--obx-warning)}",
			// §4.2 反馈三态：左 3px 实色条 + 浅底 + 前置图标（CSS ::before 字形，DOM 零增节点；
			// 冲突态 obx-error--conflict 批 3 起由面板显式冲突状态挂载，见 OnebotSettingsPanel）
			".obx-error{border:1px solid var(--obx-error);border-left-width:3px;background:var(--obx-error-bg);color:var(--obx-error-text);border-radius:var(--obx-radius-md);padding:10px 12px;white-space:pre-wrap}",
			".obx-alert[role=alert]{white-space:pre-wrap}",
			".obx-error::before{content:'!';font-weight:700;margin-right:6px}",
			".obx-error--conflict::before{content:'↻'}",
			".obx-notice{border:1px solid var(--obx-success);border-left-width:3px;background:var(--obx-success-bg);color:var(--obx-success-text);border-radius:var(--obx-radius-md);padding:10px 12px;white-space:pre-wrap}",
			".obx-notice::before{content:'✓';font-weight:700;margin-right:6px}",
			// §4.1 热生效提示条：保留虚线框语义，升级为提示条样式（ⓘ 前缀同为 ::before 字形）
			".obx-effect{border:1px dashed var(--obx-border);border-radius:var(--obx-radius-md);padding:8px 12px;color:var(--obx-fg-muted);background:var(--obx-card-bg);font-size:var(--obx-fs-sm)}",
			".obx-effect::before{content:'ⓘ';margin-right:6px}",
			// §2 组卡片：r10、卡间距 16（.obx-panel gap）、组内字段行间 12
			".obx-group{display:flex;flex-direction:column;gap:12px;background:var(--obx-card-bg);border:1px solid var(--obx-card-border);border-radius:var(--obx-radius-lg);padding:14px 16px 16px}",
			".obx-group-title{font-size:var(--obx-fs-md);font-weight:600;margin:0}",
			// §6 旧内核兜底：字段行保留现状 flex-wrap；容器查询三档见末尾 @container 块
			".obx-field{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}",
			// §3.1/§5.1：字段 label 13px/400 + fg-muted（原 opacity 灰度不达 AA）
			".obx-label{font-size:var(--obx-fs-base);color:var(--obx-fg-muted);min-width:180px}",
			".obx-control{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;min-width:240px}",
			".obx-input,.obx-select,.obx-textarea{flex:1;min-width:160px;max-width:420px;box-sizing:border-box;border:1px solid var(--obx-border);border-radius:var(--obx-radius-md);background:var(--obx-input-bg);color:inherit;padding:5px 10px;font-family:inherit;font-size:var(--obx-fs-base)}",
			".obx-input,.obx-select{height:32px}",
			".obx-textarea{max-width:520px;min-height:88px;resize:vertical}",
			".obx-input:hover:not(:disabled),.obx-select:hover:not(:disabled),.obx-textarea:hover:not(:disabled){border-color:var(--obx-border-strong)}",
			".obx-input:focus-visible,.obx-select:focus-visible,.obx-textarea:focus-visible,.obx-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--obx-focus-ring);border-color:var(--obx-accent)}",
			".obx-input:disabled,.obx-select:disabled,.obx-textarea:disabled{opacity:.45;cursor:not-allowed;background:var(--obx-card-bg)}",
			// §3.1 数字输入收窄至 160px（渲染层经 obx-input--number 挂载）
			".obx-input--number{max-width:160px}",
			// §3.1 invalid 描红——批 2 预铺样式，批 3（UX §5.6 数字行内校验）挂载
			".obx-input--invalid{border-color:var(--obx-error);box-shadow:0 0 0 2px var(--obx-error-ring)}",
			// §3.2 纯 CSS 开关：36×20 轨道 + 16 滑块，checkbox 语义保留（视觉隐藏 +
			// 24×24 命中区覆盖轨道；track 为紧随 input 的兄弟节点，由兄弟选择器驱动）
			".obx-toggle{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--obx-fs-base)}",
			".obx-switch-input{position:absolute;left:6px;top:50%;width:24px;height:24px;margin:0;transform:translateY(-50%);opacity:0;cursor:pointer}",
			".obx-switch-track{position:relative;display:inline-block;flex:none;width:36px;height:20px;border-radius:999px;background:var(--obx-switch-off);transition:background var(--obx-dur-fast)}",
			".obx-switch-track::before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--obx-switch-knob);transition:transform var(--obx-dur-fast)}",
			".obx-switch-input:checked + .obx-switch-track{background:var(--obx-accent)}",
			".obx-switch-input:checked + .obx-switch-track::before{transform:translateX(16px)}",
			".obx-switch-input:disabled + .obx-switch-track{opacity:.45;cursor:not-allowed}",
			".obx-switch-input:focus-visible + .obx-switch-track{box-shadow:0 0 0 2px var(--obx-focus-ring)}",
			"@media (prefers-reduced-motion: reduce){.obx-switch-track,.obx-switch-track::before{transition:none}}",
			".obx-hint{color:var(--obx-fg-muted);font-size:var(--obx-fs-sm);flex-basis:100%}",
			// §3.4 密文徽章 + 8px 状态点（已配置=accent / 未配置=border-strong）
			".obx-secret-badge{font-size:var(--obx-fs-xs);border:1px solid var(--obx-border);border-radius:999px;padding:0 8px;color:var(--obx-fg-muted)}",
			".obx-secret-badge::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--obx-border-strong);margin-right:6px;vertical-align:middle}",
			".obx-secret-badge--set::before{background:var(--obx-accent)}",
			".obx-badge{font-size:var(--obx-fs-xs);border:1px solid var(--obx-border);border-radius:999px;padding:0 8px;color:var(--obx-fg-muted)}",
			// §3.5 按钮规格：primary 实底 accent / 次级描边（底色 card-bg，hover 描边 currentColor 保留）
			".obx-btn{cursor:pointer;border:1px solid var(--obx-border);border-radius:var(--obx-radius-md);background:var(--obx-card-bg);color:inherit;padding:6px 12px;height:32px;box-sizing:border-box;font-family:inherit;font-size:var(--obx-fs-base)}",
			".obx-btn:hover:not(:disabled){border-color:currentColor}",
			".obx-btn:disabled{opacity:.45;cursor:not-allowed}",
			".obx-btn.primary{background:var(--obx-accent);color:#fff;border:none;font-weight:600}",
			".obx-btn.primary:hover:not(:disabled){filter:brightness(1.06)}",
			// §3.6 workspace 选择器：卡片内嵌次级行
			".obx-workspace-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--obx-card-bg);border-radius:var(--obx-radius-md);padding:8px 12px}",
			// §6 容器查询三档（面板自身为查询源；旧内核不识别 @container → 回落上方 flex-wrap 兜底）
			"@container obx (min-width:720px){.obx-field{display:grid;grid-template-columns:176px minmax(240px,1fr) auto;column-gap:12px;row-gap:4px;align-items:center}.obx-field>.obx-label{grid-column:1;grid-row:1}.obx-field>.obx-input,.obx-field>.obx-select,.obx-field>.obx-textarea,.obx-field>.obx-control,.obx-field>.obx-toggle{grid-column:2;grid-row:1}.obx-field>.obx-badge{grid-column:3;grid-row:1}.obx-field>.obx-hint{grid-column:2/-1;grid-row:2}}",
			"@container obx (max-width:719px){.obx-field{display:grid;grid-template-columns:1fr;row-gap:4px}.obx-field>.obx-label{grid-column:1}.obx-field>.obx-badge{grid-column:1;justify-self:start}}",
			"@container obx (max-width:479px){.obx-toolbar .obx-btn{flex:1 1 auto}.obx-toolbar .obx-btn.primary{order:-1}.obx-input,.obx-select,.obx-textarea{max-width:none}.obx-group{padding:12px}.obx-secret-badge{flex-basis:100%}}",
			// 批 2 交互逻辑（UX §3.1/§3.2/§5.1/§6/§7 + integration §2.4）：
			// 诊断组 details/summary 折叠——summary 行 = 组标题 + 组描述 + meta pill
			//（「N 项 · M 项默认开」复用 .obx-meta）+ 脏标记；details 即组卡片本体。
			".obx-group-desc{color:var(--obx-fg-muted);font-size:var(--obx-fs-sm);margin:0}",
			".obx-group>.obx-group-desc{margin-top:-8px}",
			".obx-group-summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;cursor:pointer;list-style:none}",
			".obx-group-summary::-webkit-details-marker{display:none}",
			".obx-group-summary::before{content:'▸';flex:none;color:var(--obx-fg-muted);transition:transform var(--obx-dur-fast)}",
			".obx-group--collapsible[open]>.obx-group-summary::before{transform:rotate(90deg)}",
			"@media (prefers-reduced-motion: reduce){.obx-group-summary::before{transition:none}}",
			// 折叠 summary 脏标记 / mode 联动与密文清除的行内强调 hint（warning 文本色）
			".obx-group-dirty{color:var(--obx-warning-text);font-size:var(--obx-fs-xs);font-weight:600}",
			".obx-hint--warn{color:var(--obx-warning-text)}",
			// 批 3（UX §5.6）：数字行内校验红字 hint（错误文本色，与冲突横幅同族 token）
			".obx-hint--invalid{color:var(--obx-error-text)}",
			// UX §6 勾选清除：输入框描边 + 徽标转 warning（token 复用批 1 §5.1 色值）
			".obx-input--warn{border-color:var(--obx-warning)}",
			".obx-secret-badge--clear{color:var(--obx-warning-text);background:var(--obx-warning-bg);border-color:var(--obx-warning)}",
			".obx-secret-badge--clear::before{background:var(--obx-warning)}",
			// UX §4 workspace 拉取失败重试入口（行内链接式按钮）
			".obx-link-btn{cursor:pointer;border:none;background:none;color:var(--obx-accent);padding:0 0 0 4px;font:inherit;font-size:var(--obx-fs-sm);text-decoration:underline}",
			".obx-link-btn:disabled{opacity:.45;cursor:not-allowed;text-decoration:none}",
		].join("\n");
		//#endregion

		//#region 工具（纯函数，模块级可测）
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message}}。 */
		function unwrap(result) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			var error = new Error(detail);
			if (result != null && result.error != null && result.error.code != null) error.code = result.error.code;
			throw error;
		}
		/** 保存冲突判定（T1 §3.1：expectedRevision ≠ 当前 revision 拒写，
		 *  host 抛 RemoteError('onebot-settings/conflict')；message 兜底只匹配该
		 *  错误路径本身——不过宽匹配含 "revision" 的无关错误（评审 B5）。 */
		var CONFLICT_RE = /onebot-settings\/conflict/i;
		function isConflictError(cause) {
			if (cause == null) return false;
			return cause.code === "onebot-settings/conflict" || CONFLICT_RE.test(String(cause.message || ""));
		}
		/** 快照生效值 → 表单草稿（展示形态：number/stringArray/secret 均为可编辑文本；
		 *  accessToken 恒 ''，明文绝不进入草稿——host 快照已脱敏）。 */
		function snapshotValueToDraft(field, value) {
			if (field.type === "secret") return ""; // 脱敏回显：密码框恒空（T1 §3 敏感字段行）
			if (field.type === "stringArray") return Array.isArray(value) ? value.join("\n") : "";
			if (field.type === "number") return value === undefined || value === null ? "" : String(field.scale ? value / field.scale : value);
			if (field.type === "boolean") return value === true;
			return value === undefined || value === null ? "" : String(value);
		}
		function draftFromSnapshot(snapshot) {
			var config = snapshot != null && snapshot.config != null ? snapshot.config : {};
			var draft = {};
			for (var field of ALL_FIELDS) draft[field.key] = snapshotValueToDraft(field, config[field.key]);
			return draft;
		}
		function draftFromDefaults() {
			return draftFromSnapshot({ config: DEFAULTS });
		}
		/** 草稿展示值 → patch 值（stringArray 文本 → 行数组；number 文本 → 数字）。 */
		function coerceValue(field, raw) {
			if (field.type === "number") {
				var n = typeof raw === "number" ? raw : Number(String(raw).trim());
				if (!Number.isFinite(n)) return NaN;
				// scale：界面按秒填，存的是毫秒（哥哥 11-11）
				return field.scale ? Math.round(n * field.scale) : n;
			}
			if (field.type === "boolean") return raw === true;
			if (field.type === "stringArray") {
				return String(raw == null ? "" : raw).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
			}
			return String(raw == null ? "" : raw);
		}
		function valueEquals(a, b) {
			return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
		}
		/**
		 * 计算保存 patch（T1 §4 + W6 + W7：29 键任意子集的扁平 JSON）。
		 * @param draft 表单草稿（snapshotValueToDraft 形态）
		 * @param config 快照生效值（snapshot.config）
		 * @param opts.secretDraft 密码框输入（'' = 不修改 accessToken）
		 * @param opts.clearSecret true = 显式下发 accessToken: ''（host 语义：'' = 清空）
		 * @returns {patch, invalidKeys} 与生效值有差异的键集合；invalidKeys 为未通过
		 *          客户端数字校验的键（host validatePatch 仍会二次校验）。
		 */
		function computePatch(draft, config, opts) {
			var options = opts == null ? {} : opts;
			var config_ = config == null ? {} : config;
			var patch = {};
			var invalidKeys = [];
			for (var field of ALL_FIELDS) {
				if (field.type === "secret") continue; // accessToken 走 secretDraft/clearSecret 专用通道
				var next = coerceValue(field, draft[field.key]);
				if (field.type === "number" && Number.isNaN(next)) {
					invalidKeys.push(field.key);
					continue;
				}
				if (!valueEquals(next, config_[field.key])) patch[field.key] = next;
			}
			var secretDraft = options.secretDraft;
			if (options.clearSecret === true) patch.accessToken = ""; // host 语义：'' = 清空
			else if (typeof secretDraft === "string" && secretDraft !== "") patch.accessToken = secretDraft;
			// secretDraft 为空且未勾选清除 → 不含 accessToken 键 = 不修改（host 缺省语义）
			return { patch: patch, invalidKeys: invalidKeys };
		}

		/**
		 * 批 3（UX §5.6）：数字键行内校验合法范围——逐字抄自 host NUMBER_RANGE
		 * （src/settings-remote.ts L129-134；前端字面量副本，host 常量不改）。
		 * port 1–65535，时长/频控类 ≥0（max undefined = 无上限）。
		 */
		var NUMBER_RANGE = {
			port: [1, 65535],
			interimRecallMs: [0, undefined],
			rateLimitPerMinute: [0, undefined],
			deferredTimeoutMs: [0, undefined],
		};

		/**
		 * 批 3（UX §5.6）：数字行内校验——判定语义与 host validatePatch 逐字对齐
		 * （src/settings-remote.ts L351-353：Number.isFinite && >= min &&
		 * (max === undefined || <= max)）。'' 经 Number('')=0 入范围判定（与
		 * computePatch→coerceValue 同口径）；非数字文本（NaN）同样判非法。
		 * @returns null = 合法；string = 合法范围文案（"1–65535"/"≥0"），供
		 *          format(t("field.numberInvalid"), { range }) 组装行内红字。
		 */
		function numberRangeInvalid(field, raw) {
			if (field == null || field.type !== "number") return null;
			var range = Object.prototype.hasOwnProperty.call(NUMBER_RANGE, field.key) && Array.isArray(NUMBER_RANGE[field.key])
				? NUMBER_RANGE[field.key]
				: [0, undefined];
			var n = coerceValue(field, raw);
			if (Number.isFinite(n) && n >= range[0] && (range[1] === undefined || n <= range[1])) return null;
			// 带 scale 的字段（秒显示、毫秒存储）把范围也换算成秒，免得提示写成毫秒
			var sc = field.scale ? field.scale : 1;
			var lo = range[0] / sc;
			var hi = range[1] === undefined ? undefined : range[1] / sc;
			return hi === undefined ? "≥" + lo : lo + "–" + hi;
		}

		/**
		 * 批 3（UX §5.4）：冲突合并保留——保存遇 revision 冲突重拉快照后，不再
		 * 全量重建草稿（旧路径静默丢弃全部未保存编辑），改为逐键比较新旧快照值
		 *（旧 = 发起保存时 snapshot.config，新 = refetch 结果，复用 valueEquals）：
		 *   - 新旧快照值一致的键：保留草稿编辑（大概率可原样重提）；
		 *   - 新旧快照值不一致的键：跟随新快照（草稿按新值重写为展示形态）；其中
		 *     本地也改过的键记入 conflictKeys（本地编辑被丢弃，调用方行内橙标
		 *     「已被其他来源修改，已同步为最新值」）；
		 *   - 密文例外：secret 键不参与合并（脱敏值无法比对）——草稿恒 ''，明文
		 *     通道（secretDraft/clearSecret）由调用方一律清空并提示。
		 * 纯函数：不改任何入参。脏判定与 computePatch 同口径（coerceValue 后比较，
		 * 未编辑键不计脏）。
		 * @param draft 冲突前的表单草稿（snapshotValueToDraft 展示形态）
		 * @param oldCfg 发起保存时的 snapshot.config
		 * @param nextCfg 冲突重拉的新 snapshot.config
		 * @returns {draft, conflictKeys, keptCount} keptCount = 脏键数（draft 与
		 *          oldCfg 有差异的非 secret 键）− conflictKeys.length，即 UX §5.4
		 *          「已保留 N 项未冲突的修改」的 N；全部脏键被外部修改时为 0
		 *         （调用方退化为现状提示——此时 draft 与全量重建结果同值）。
		 */
		function mergeOnConflict(draft, oldCfg, nextCfg) {
			var sourceDraft = draft == null ? {} : draft;
			var oldConfig = oldCfg == null ? {} : oldCfg;
			var nextConfig = nextCfg == null ? {} : nextCfg;
			var merged = {};
			var conflictKeys = [];
			var dirtyCount = 0;
			for (var field of ALL_FIELDS) {
				if (field.type === "secret") {
					merged[field.key] = ""; // 密文例外（UX §5.4）：明文通道由调用方清空
					continue;
				}
				var remoteChanged = !valueEquals(oldConfig[field.key], nextConfig[field.key]);
				var dirty = Object.prototype.hasOwnProperty.call(sourceDraft, field.key)
					&& !valueEquals(coerceValue(field, sourceDraft[field.key]), oldConfig[field.key]);
				if (dirty) dirtyCount += 1;
				if (remoteChanged) {
					merged[field.key] = snapshotValueToDraft(field, nextConfig[field.key]);
					if (dirty) conflictKeys.push(field.key);
				} else {
					// 远端未变：保留草稿（含未编辑键——缺键防御经 snapshotValueToDraft
					// 重写为展示形态，与 draftFromSnapshot 同构）
					merged[field.key] = Object.prototype.hasOwnProperty.call(sourceDraft, field.key)
						? sourceDraft[field.key]
						: snapshotValueToDraft(field, nextConfig[field.key]);
				}
			}
			return { draft: merged, conflictKeys: conflictKeys, keptCount: dirtyCount - conflictKeys.length };
		}

		/**
		 * W7：把选中的 workspace path 填入草稿（「快速填入」的唯一写入口）。
		 * 纯函数、只返回新草稿对象——绝不触达 remote.updateSettings；保存仍走
		 * 「保存设置」显式通道（computePatch → updateSettings）。
		 */
		function fillWorkspacePath(draft, path) {
			var next = Object.assign({}, draft == null ? {} : draft);
			next.workspacePath = String(path == null ? "" : path);
			return next;
		}

		/**
		 * 批 2（UX §5.1）：脏状态派生——与保存流共用同一 computePatch 口径，键集 =
		 * 与快照生效值有差异的键 + 密文通道（secretDraft 非空 / clearSecret）。纯
		 * 客户端计算，不依赖冲突合并（mergeOnConflict 为批 3 范围）；数字非法键不进
		 * patch 故不入 dirtyKeys（badNumber 反馈仍走 save() 通道）。
		 */
		function computeDirtyKeys(draft, config, opts) {
			return Object.keys(computePatch(draft, config, opts).patch);
		}

		/**
		 * 批 2（UX §3.2）：mode 联动变暗禁用——反向连接只走 url、正向只走 host/port。
		 * 禁用≠清空：值保留在草稿，computePatch 值比较语义不变（patch 仍按原值比较）。
		 */
		function deriveModeInactiveKeys(mode) {
			if (mode === "reverse") return ["url"];
			if (mode === "forward") return ["host", "port"];
			return [];
		}

		/** 批 2（UX §3.1）：诊断组折叠态 sessionStorage 键（"1" = 展开；缺省 = 默认折叠）。 */
		var DIAGNOSTICS_EXPANDED_KEY = PLUGIN_ID + ".diagnosticsExpanded";
		/** 批 2（UX §4）：workspace 拉取失败后的重试冷却（10s 内不重复请求）。 */
		var WORKSPACE_RETRY_COOLDOWN_MS = 10000;
		//#endregion

		//#region 渲染（模块级可测的纯渲染函数：renderGroup 不依赖 hooks/副作用）
		function h(ReactImpl, tag, props) {
			var children = Array.prototype.slice.call(arguments, 3);
			return ReactImpl.createElement.apply(ReactImpl, [tag, props].concat(children));
		}
		/**
		 * 渲染一个设置分组（纯函数；值全部经 snapshotValueToDraft 脱敏形态传入，
		 * accessToken 明文按契约绝不进入本函数——host 快照侧已脱敏为 ''）。
		 * @param opts.onChange (field, nextDisplayValue) => void
		 * @param opts.onSecretChange (nextText) => void
		 * @param opts.onClearSecretChange (nextBoolean) => void
		 * @param opts.secretSet boolean（快照 secrets 标记：明文是否已配置）
		 * @param opts.clearSecret boolean（清除勾选态）
		 * @param opts.nonDefaultKeys 与 schema 默认值不同的键数组（W6「非默认」徽标；
		 *        以快照生效值为准而非草稿——徽标描述已保存状态，不是未保存编辑）
		 * @param opts.draft 表单草稿（snapshotValueToDraft 形态）
		 * @param opts.groupDesc 组描述文案（批 2 UX §2.2；缺省不渲染描述行）
		 * @param opts.modeInactiveKeys 当前连接模式下不生效的键（批 2 UX §3.2：命中
		 *        字段禁用变暗 + hint 追加「当前模式不生效」；值保留不清空）
		 * @param opts.texts 交互文案（批 2 locale 第二档经面板传入；缺省回退 zh 字面
		 *        量，模块级可测行为不变）：modeInactive/secretSet/secretUnset/
		 *        secretClearPending/secretClearHint/secretClear/remoteOverwritten
		 * @param opts.collapsible 折叠配置（批 2 UX §3.1：仅诊断组传入）——
		 *        {open, onToggle, summaryMeta, dirtyMark}；缺省保持 section 常开形态
		 * @param opts.invalidNumbers 数字行内校验标红（批 3 UX §5.6）：map key →
		 *        已本地化提示文案；命中字段输入框挂 obx-input--invalid（批 1 预铺
		 *        样式）+ aria-invalid，hint 行内嵌红字（.obx-hint--invalid）
		 * @param opts.remoteOverwrittenKeys 冲突合并被远端覆盖的键（批 3 UX §5.4）：
		 *        命中字段 hint 行内嵌橙标「已被其他来源修改，已同步为最新值」
		 * @param opts.onNumberBlur (field, rawText) => void——number 字段 blur 回调
		 *        （行内校验入口：面板侧记态标红/清除；stringArray/enum 不加校验）
		 */
		function renderGroup(ReactImpl, group, opts) {
			var options = opts == null ? {} : opts;
			var draft = options.draft == null ? {} : options.draft;
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var modeInactiveKeys = Array.isArray(options.modeInactiveKeys) ? options.modeInactiveKeys : [];
			var invalidNumbers = options.invalidNumbers != null ? options.invalidNumbers : {};
			var remoteOverwrittenKeys = Array.isArray(options.remoteOverwrittenKeys) ? options.remoteOverwrittenKeys : [];
			var groupDesc = options.groupDesc != null ? options.groupDesc : null;
			var collapsible = options.collapsible != null ? options.collapsible : null;
			var texts = options.texts != null ? options.texts : {};
			var modeInactiveText = texts.modeInactive != null ? texts.modeInactive : "当前模式不生效";
			var secretSetText = texts.secretSet != null ? texts.secretSet : "已配置（脱敏，不回显）";
			var secretUnsetText = texts.secretUnset != null ? texts.secretUnset : "未配置";
			var secretClearPendingText = texts.secretClearPending != null ? texts.secretClearPending : "保存后清空";
			var secretClearHintText = texts.secretClearHint != null ? texts.secretClearHint : "将清除已保存的值";
			var secretClearLabelText = texts.secretClear != null ? texts.secretClear : "清除已保存的 AccessToken";
			var remoteOverwrittenText = texts.remoteOverwritten != null ? texts.remoteOverwritten : "已被其他来源修改，已同步为最新值";
			var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
			var onSecretChange = typeof options.onSecretChange === "function" ? options.onSecretChange : function () {};
			var onClearSecretChange = typeof options.onClearSecretChange === "function" ? options.onClearSecretChange : function () {};
			var onNumberBlur = typeof options.onNumberBlur === "function" ? options.onNumberBlur : function () {};
			var fieldNodes = group.fields.map(function (field) {
				var value = draft[field.key];
				// 批 2（UX §3.2）：mode 联动——非当前模式的连接字段禁用变暗（值保留在
				// 草稿，computePatch 值比较语义不变；hint 行追加「当前模式不生效」）。
				var fieldInactive = modeInactiveKeys.indexOf(field.key) >= 0;
				// 批 3（UX §5.4/§5.6）：冲突橙标命中 + 数字行内校验标红命中。
				var overwritten = remoteOverwrittenKeys.indexOf(field.key) >= 0;
				var fieldInvalidMessage = field.type === "number" && invalidNumbers[field.key] != null
					? String(invalidNumbers[field.key])
					: null;
				var control;
				if (field.type === "boolean") {
					// §3.2 纯 CSS 开关：checkbox 语义保留（视觉隐藏 + 24×24 命中区覆盖轨道），
					// track 为紧随 input 的兄弟节点（兄弟选择器驱动轨道底色/滑块位移），开/关文本保留。
					control = h(ReactImpl, "label", { className: "obx-toggle" },
						h(ReactImpl, "input", {
							type: "checkbox", className: "obx-switch-input", checked: value === true, disabled: options.disabled === true || fieldInactive,
							onChange: function (event) { onChange(field, event.target.checked); },
						}),
						h(ReactImpl, "span", { className: "obx-switch-track", "aria-hidden": "true" }),
						value === true ? "开" : "关");
				} else if (field.type === "enum") {
					control = h(ReactImpl, "select", {
						className: "obx-select", value: String(value == null ? "" : value), disabled: options.disabled === true || fieldInactive,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					}, field.options.map(function (option) {
						return h(ReactImpl, "option", { key: option, value: option }, field.optionLabels[option] != null ? field.optionLabels[option] : option);
					}));
				} else if (field.type === "stringArray") {
					control = h(ReactImpl, "textarea", {
						className: "obx-textarea", rows: 3, value: String(value == null ? "" : value), disabled: options.disabled === true || fieldInactive,
						placeholder: "每行一个",
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				} else if (field.type === "secret") {
					// 密码型输入且不明文回显：value 恒为用户本次输入（初始 ''），占位符提示留空不改；
					// 已配置状态只展示脱敏徽标，绝不渲染任何明文。
					// 批 2（UX §6 + integration §2.4）徽标三态：已配置（accent 点）/ 未配置 /
					// 保存后清空（橙，仅「确有已保存值 + 勾选清除」时——secretSet:false +
					// 勾清除仍显「未配置」，保持既有渲染契约）；互斥由面板 onSecretChange
					// 实现（输入新值即取消清除勾选）。勾选清除时输入框描边转 --obx-warning
					// 并追加行内提示「将清除已保存的值」。
					var clearActive = options.clearSecret === true;
					var secretBadgeClassName = "obx-secret-badge";
					var secretBadgeText;
					if (clearActive && options.secretSet === true) {
						secretBadgeClassName += " obx-secret-badge--clear";
						secretBadgeText = secretClearPendingText;
					} else if (options.secretSet === true) {
						secretBadgeClassName += " obx-secret-badge--set";
						secretBadgeText = secretSetText;
					} else {
						secretBadgeText = secretUnsetText;
					}
					control = h(ReactImpl, "span", { className: "obx-control" },
						h(ReactImpl, "input", {
							type: "password", className: clearActive ? "obx-input obx-input--warn" : "obx-input", value: String(value == null ? "" : value),
							placeholder: "留空 = 不修改", autoComplete: "new-password", disabled: options.disabled === true || fieldInactive,
							onChange: function (event) { onSecretChange(event.target.value); },
							"aria-label": field.label,
						}),
						// §3.4 徽章加 8px 状态点：已配置=accent / 未配置=border-strong /
						// 保存后清空=warning（纯视觉状态点）
						h(ReactImpl, "span", { className: secretBadgeClassName }, secretBadgeText),
						h(ReactImpl, "label", { className: "obx-toggle" },
							h(ReactImpl, "input", {
								type: "checkbox", checked: clearActive, disabled: options.disabled === true || fieldInactive,
								onChange: function (event) { onClearSecretChange(event.target.checked); },
							}),
							secretClearLabelText),
						clearActive ? h(ReactImpl, "span", { className: "obx-hint obx-hint--warn" }, secretClearHintText) : null);
				} else {
					// §3.1 数字输入 160px：number 字段仍以 type=text 渲染（既有渲染形态不变），
					// 仅按类型加 obx-input--number 收窄 max-width。
					// 批 3（UX §5.6）：行内校验标红——非法命中挂 obx-input--invalid（批 1
					// 预铺样式）+ aria-invalid="true"；number 键 blur 触发面板侧校验
					//（标红不阻断输入，保存按钮禁用由面板层落位）。
					var isNumberField = field.type === "number";
					control = h(ReactImpl, "input", {
						type: "text",
						className: (isNumberField ? "obx-input obx-input--number" : "obx-input")
							+ (fieldInvalidMessage != null ? " obx-input--invalid" : ""),
						value: String(value == null ? "" : value), disabled: options.disabled === true || fieldInactive,
						onChange: function (event) { onChange(field, event.target.value); },
						onBlur: isNumberField ? function (event) { onNumberBlur(field, event.target.value); } : undefined,
						"aria-invalid": fieldInvalidMessage != null ? "true" : undefined,
						"aria-label": field.label,
					});
				}
				// 批 2（UX §3.2）：mode 不生效 hint 与既有字段 hint 合并为同一 hint 行
				//（@container grid 布局下 .obx-field>.obx-hint 固定占 row 2，双节点会
				// 重叠），不生效部分以 warning 色内嵌强调。
				var hintChildren = [];
				if (field.hint != null) hintChildren.push(field.hint);
				if (fieldInactive) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h(ReactImpl, "span", { className: "obx-hint--warn" }, modeInactiveText));
				}
				// 批 3（UX §5.4）：冲突合并后本地编辑被远端覆盖的键——行内橙标提示。
				if (overwritten) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h(ReactImpl, "span", { className: "obx-hint--warn" }, remoteOverwrittenText));
				}
				// 批 3（UX §5.6）：数字行内校验非法——行内红字提示合法范围。
				if (fieldInvalidMessage != null) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h(ReactImpl, "span", { className: "obx-hint--invalid" }, fieldInvalidMessage));
				}
				var nodes = [
					h(ReactImpl, "div", { className: "obx-field", key: field.key },
						h(ReactImpl, "span", { className: "obx-label" }, field.label),
						// W6「非默认」徽标（对齐竞品 v0.6.0 行话术）：快照生效值 ≠ schema 默认值
						// 时标注，帮助一眼识别改过哪些开关；「待重启」徽标不适用本插件——
						// 保存经宿主 configEditor.edit 热生效（整条 fiber 秒级原地重启，
						// docs/settings-page-design.md §5），不存在键级「配置文件值≠生效值」稳态。
						nonDefaultKeys.indexOf(field.key) >= 0
							? h(ReactImpl, "span", { className: "obx-badge", title: "与默认值不同" }, "非默认")
							: null,
						control,
						hintChildren.length > 0
							? h.apply(null, [ReactImpl, "span", { className: "obx-hint" }].concat(hintChildren))
							: null),
				];
				// W7：可选扩展点——字段行后追加组内附加行（connection 组 workspacePath
				// 下方的「快速填入 workspace」行由此注入；独立 class 不计入 obx-field 行数）。
				if (typeof options.renderExtraRow === "function") {
					var extra = options.renderExtraRow(field);
					if (extra != null) nodes.push(extra);
				}
				return nodes;
			});
			// 批 2（UX §2.2）：组描述行——标题下的一句人话（integration §2.5 裁定取
			// UX §2.2 版文案，经 opts.groupDesc 传入；缺省不渲染）。
			if (collapsible != null) {
				// 批 2（UX §3.1 + visual §2）：details/summary 原生折叠——键盘可达、零
				// JS 依赖；summary 行 = 组标题 + 组描述 + meta pill（「N 项 · M 项默认
				// 开」复用 .obx-meta）+ 脏标记（「● 含未保存修改」）。折叠不隐藏变更：
				// patch/保存与折叠无关，提交计数仍含诊断字段；aria-expanded/aria-controls 齐备。
				var summaryChildren = [h(ReactImpl, "h3", { className: "obx-group-title" }, group.title)];
				if (groupDesc != null) summaryChildren.push(h(ReactImpl, "span", { className: "obx-group-desc" }, groupDesc));
				if (collapsible.summaryMeta != null) summaryChildren.push(h(ReactImpl, "span", { className: "obx-meta" }, collapsible.summaryMeta));
				if (collapsible.dirtyMark != null) summaryChildren.push(h(ReactImpl, "span", { className: "obx-group-dirty" }, collapsible.dirtyMark));
				return h(ReactImpl, "details", {
					className: "obx-group obx-group--collapsible", "data-group": group.id,
					open: collapsible.open === true,
					onToggle: typeof collapsible.onToggle === "function" ? collapsible.onToggle : undefined,
				},
					h.apply(null, [ReactImpl, "summary",
						{ className: "obx-group-summary", "aria-expanded": collapsible.open === true, "aria-controls": "obx-group-body-" + group.id }]
						.concat(summaryChildren)),
					h(ReactImpl, "div", { className: "obx-group-body", id: "obx-group-body-" + group.id },
						fieldNodes));
			}
			var sectionChildren = [h(ReactImpl, "h3", { className: "obx-group-title" }, group.title)];
			if (groupDesc != null) sectionChildren.push(h(ReactImpl, "p", { className: "obx-group-desc" }, groupDesc));
			return h.apply(null, [ReactImpl, "section", { className: "obx-group", "data-group": group.id }]
				.concat(sectionChildren, [fieldNodes]));
		}
		//#endregion

		/**
		 * W7：渲染 workspacePath 字段下方的「快速填入 workspace」行（纯函数）。
		 * 数据来自面板打开时对 remote.listWorkspaces() 的一次现拉（不缓存陈旧列表）。
		 * 三态：
		 *   - loaded !== true（拉取中/未拉取）→ 不渲染；
		 *   - available !== true 或列表为空 → 隐藏下拉与按钮，仅渲染一行说明
		 *     （可直接输入路径，不阻塞手输）；
		 *   - 正常 → select（选项 = path（N 会话），value = id，避免同名 path 冲突）
		 *     + 「填入」按钮：仅把选中 path 写进输入框当前值（onApply → fillWorkspacePath），
		 *     不自动保存。
		 * @param opts.workspaces host listWorkspaces().workspaces
		 * @param opts.available host listWorkspaces().available
		 * @param opts.loaded 面板打开后拉取是否已完成
		 * @param opts.selectedId 当前选中的 workspace id（'' = 未选）
		 * @param opts.onApply (path: string) => void（填入回调；本函数绝不调用保存）
		 * @param opts.fetchFailed true = 本次拉取失败（批 2 UX §4：与「宿主未提供注册表」
		 *        降级态文案区分，并提供重试入口）
		 * @param opts.retryBlocked true = 失败后 10s 冷却内，重试入口禁用（不重复请求）
		 * @param opts.onRetry 重试回调（面板侧重跑 listWorkspaces 拉取，不新增请求方法）
		 * @param opts.fetchFailedText / opts.retryText 文案（locale 第二档；缺省回退 zh）
		 */
		function renderWorkspacePicker(ReactImpl, opts) {
			var options = opts == null ? {} : opts;
			if (options.loaded !== true) return null;
			var workspaces = Array.isArray(options.workspaces) ? options.workspaces : [];
			if (options.available !== true || workspaces.length === 0) {
				// 批 2（UX §4）：失败态（fetchFailed=true）与宿主未提供注册表（available=false）
				// 文案区分；失败态追加重试入口，10s 冷却内禁用。既有降级态结构不变
				//（无 select/button，可直接输入路径）。
				if (options.fetchFailed === true) {
					return h(ReactImpl, "p", { className: "obx-hint obx-workspace-empty" },
						typeof options.fetchFailedText === "string" ? options.fetchFailedText : "本次拉取 workspace 列表失败，可直接输入路径。",
						h(ReactImpl, "button", {
							className: "obx-link-btn", type: "button", disabled: options.retryBlocked === true,
							onClick: function () {
								var onRetry = options.onRetry;
								if (typeof onRetry === "function") onRetry();
							},
						}, typeof options.retryText === "string" ? options.retryText : "重试"));
				}
				return h(ReactImpl, "p", { className: "obx-hint obx-workspace-empty" },
					options.available === true
						? "暂无 workspace 记录，可直接输入路径。"
						: "无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。");
			}
			var selectedId = typeof options.selectedId === "string" ? options.selectedId : "";
			var selected = null;
			for (var workspace of workspaces) {
				if (workspace != null && String(workspace.id) === selectedId) selected = workspace;
			}
			var disabled = options.disabled === true;
			return h(ReactImpl, "div", { className: "obx-workspace-row", "data-role": "workspace-picker" },
				h(ReactImpl, "span", { className: "obx-label" }, "快速填入 workspace"),
				h(ReactImpl, "select", {
					className: "obx-select", value: selectedId, disabled: disabled,
					"aria-label": "快速填入 workspace",
					title: "列出宿主 workspace 注册表中的工作区；选中后点「填入」写入上方路径输入框（只填值，保存仍走「保存设置」按钮）",
					onChange: function (event) {
						var onSelectedChange = options.onSelectedChange;
						if (typeof onSelectedChange === "function") onSelectedChange(event.target.value);
					},
				},
					h(ReactImpl, "option", { key: "", value: "" }, "选择 workspace…"),
					workspaces.map(function (workspace) {
						var label = String(workspace.path == null ? "" : workspace.path) + "（" + String(workspace.sessionCount == null ? 0 : workspace.sessionCount) + " 会话）";
						return h(ReactImpl, "option", { key: String(workspace.id), value: String(workspace.id) }, label);
					})),
				h(ReactImpl, "button", {
					className: "obx-btn", type: "button", disabled: disabled || selected == null,
					onClick: function () {
						var onApply = options.onApply;
						if (selected != null && typeof onApply === "function") onApply(selected.path);
					},
				}, "填入"),
				h(ReactImpl, "span", { className: "obx-hint" }, "选中后点「填入」仅写入上方输入框；需点「保存设置」才会保存（对新会话生效，已设 /workspace 覆盖的会话不受影响）。"));
		}

		//#region 面板组件
		/**
		 * QQ Bot 设置面板。
		 * @param props t 为宿主注入的翻译函数（locale: NS，语言切换自动重渲染）；
		 *        remote 为挂载后的 `remote.onebotSettings` API。
		 */
		function OnebotSettingsPanel(props) {
			// 宿主在 plugins.bundle.config 里会给 t；从设置页自己的分区进来时可能没有，
			// 缺了就退回原键，别让一个 undefined 把整页渲染炸掉。
			var t = props.t || function (k) { return k; };
			var remote = props.remote;
			var snapshotState = React.useState(null);
			var snapshot = snapshotState[0];
			var setSnapshot = snapshotState[1];
			var draftState = React.useState(null);
			var draft = draftState[0];
			var setDraft = draftState[1];
			var secretState = React.useState("");
			var secretDraft = secretState[0];
			var setSecretDraft = secretState[1];
			var clearSecretState = React.useState(false);
			var clearSecret = clearSecretState[0];
			var setClearSecret = clearSecretState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			// 批 3（UX §5.6）：数字行内校验标红态——map key → 合法范围文案（"1–65535"/
			// "≥0"）；number 键 blur 记入、输入修正自动消除，accept()/reset 全量重建清空。
			var invalidNumbersState = React.useState({});
			var invalidNumbers = invalidNumbersState[0];
			var setInvalidNumbers = invalidNumbersState[1];
			// 批 3（UX §5.4）：冲突合并结果态——被远端覆盖的键（行内橙标）+ 显式冲突
			// 横幅标记（替换批 1 的文案恒等派生；refetchMerged 置位，其余错误路径复位）。
			var conflictKeysState = React.useState([]);
			var conflictKeys = conflictKeysState[0];
			var setConflictKeys = conflictKeysState[1];
			var conflictActiveState = React.useState(false);
			var conflictActive = conflictActiveState[0];
			var setConflictActive = conflictActiveState[1];
			// W7：「快速填入 workspace」数据态——面板打开时（挂载 effect）对
			// remote.listWorkspaces() 现拉一次，不缓存跨会话的陈旧列表。
			var workspaceState = React.useState({ loaded: false, available: false, workspaces: [], selectedId: "" });
			var workspace = workspaceState[0];
			var setWorkspace = workspaceState[1];
			// 批 2（UX §3.1）：诊断组折叠态——sessionStorage 持久化（键
			// dsh-onebot-paopao.diagnosticsExpanded，"1" = 展开），默认折叠；读写均容错
			//（隐私模式/非浏览器环境静默降级为默认折叠）。
			var diagnosticsExpandedState = React.useState(function () {
				try {
					return window.sessionStorage.getItem(DIAGNOSTICS_EXPANDED_KEY) === "1";
				} catch (error) {
					return false;
				}
			});
			var diagnosticsExpanded = diagnosticsExpandedState[0];
			var setDiagnosticsExpanded = diagnosticsExpandedState[1];
			var toggleDiagnostics = function (event) {
				var nextOpen = event != null && event.target != null && event.target.open === true;
				setDiagnosticsExpanded(nextOpen);
				try {
					window.sessionStorage.setItem(DIAGNOSTICS_EXPANDED_KEY, nextOpen ? "1" : "0");
				} catch (error) { /* 持久化不可用时仅内存态生效 */ }
			};
			// 批 2（UX §4）：重试冷却计时器 + 卸载哨兵——计时器/在途 Promise 不在卸载
			// 之后写 state（沿用本面板 alive 守卫纪律）。
			var workspaceRetryTimerRef = React.useRef(null);
			var workspaceMountedRef = React.useRef(true);
			React.useEffect(function () {
				workspaceMountedRef.current = true;
				return function () {
					workspaceMountedRef.current = false;
					if (workspaceRetryTimerRef.current != null) {
						clearTimeout(workspaceRetryTimerRef.current);
						workspaceRetryTimerRef.current = null;
					}
				};
			}, []);

			/** 接受新快照：草稿按快照重置（accessToken 明文绝不进入草稿）。 */
			var accept = function (next) {
				setSnapshot(next);
				setDraft(draftFromSnapshot(next));
				// 批 3（UX §5.6）：全量重建后草稿均为快照展示形态（合法值），清除行内标红；
				// 冲突横幅/橙标一并复位（本函数即「回到与快照一致」的统一入口）。
				setInvalidNumbers({});
				setConflictKeys([]);
				setConflictActive(false);
			};

			React.useEffect(function () {
				var alive = true;
				void remote.getSettings().then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
					if (alive) setError(messageOf(cause));
				});
				// W7：辅助查询独立拉取（挂载与「重试」共用 fetchWorkspaces，见下）——
				// 失败降级为 fetch-failed 提示行 + 重试入口，绝不阻塞/污染 getSettings
				// 主链路与错误横幅。
				fetchWorkspaces();
				return function () { alive = false; };
			}, [remote]);

			/** 批 2（UX §4）：workspace 列表现拉（挂载与「重试」唯一入口，不缓存陈旧列表）。 */
			var fetchWorkspaces = function () {
				void Promise.resolve().then(function () {
					return remote.listWorkspaces();
				}).then(function (result) {
					if (workspaceMountedRef.current !== true) return;
					var value = unwrap(result);
					if (workspaceRetryTimerRef.current != null) {
						clearTimeout(workspaceRetryTimerRef.current);
						workspaceRetryTimerRef.current = null;
					}
					setWorkspace({
						loaded: true,
						available: value != null && value.available === true,
						workspaces: value != null && Array.isArray(value.workspaces) ? value.workspaces : [],
						selectedId: "",
						fetchFailed: false,
						retryBlocked: false,
					});
				}).catch(function () {
					// 失败态与「宿主未提供注册表」降级态区分（fetchFailed 标记）；重试
					// 入口在 10s 冷却内禁用（retryBlocked），防止失败风暴下重复请求。
					if (workspaceMountedRef.current !== true) return;
					setWorkspace({ loaded: true, available: false, workspaces: [], selectedId: "", fetchFailed: true, retryBlocked: true });
					if (workspaceRetryTimerRef.current != null) clearTimeout(workspaceRetryTimerRef.current);
					workspaceRetryTimerRef.current = setTimeout(function () {
						workspaceRetryTimerRef.current = null;
						if (workspaceMountedRef.current !== true) return;
						setWorkspace(function (previous) {
							return Object.assign({}, previous, { retryBlocked: false });
						});
					}, WORKSPACE_RETRY_COOLDOWN_MS);
				});
			};

			var refetch = function () {
				void remote.getSettings().then(function (result) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause) {
					setConflictActive(false);
					setError(messageOf(cause));
				});
			};

			/**
			 * 批 3（UX §5.4）：冲突合并保留——保存遇 revision 冲突时重拉快照并逐键
			 * 合并（mergeOnConflict），不再全量重建丢弃未保存编辑：
			 *   - 远端未变的键保留草稿编辑；keptCount > 0 → 结果条在 conflict.title
			 *     后追加「已保留 N 项未冲突的修改，请核对后重新保存」；
			 *   - 远端已变的键跟随新快照，本地同改的键记入 conflictKeys 行内橙标；
			 *   - 密文例外：secretDraft/clearSecret 一律清空（脱敏值无法比对），
			 *     确有明文输入时以 notice 提示「accessToken 输入已清空…」。
			 * revision 取新快照，用户核对后可直接重放保存；行内标红按合并结果修剪
			 *（跟随远端的键已合法，保留的本地编辑仍非法则继续标红）。
			 */
			var refetchMerged = function () {
				void remote.getSettings().then(function (result) {
					var next = unwrap(result);
					var merged = mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config);
					setSnapshot(next);
					setDraft(merged.draft);
					setConflictKeys(merged.conflictKeys);
					setConflictActive(true);
					setInvalidNumbers(function (previous) {
						var pruned = {};
						Object.keys(previous).forEach(function (key) {
							var field = ALL_FIELDS.find(function (item) { return item.key === key; });
							if (field != null && numberRangeInvalid(field, merged.draft[key]) != null) pruned[key] = previous[key];
						});
						return pruned;
					});
					var hadSecretChannel = secretDraft !== "" || clearSecret === true;
					setSecretDraft("");
					setClearSecret(false);
					setError(merged.keptCount > 0
						? t("conflict.title") + format(t("conflict.kept"), { count: merged.keptCount })
						: t("conflict.title"));
					setNotice(hadSecretChannel ? t("conflict.secretCleared") : "");
				}).catch(function (cause) {
					setConflictActive(false);
					setError(messageOf(cause));
				});
			};

			/** 保存统一通道：updateSettings(patch, expectedRevision)；冲突时合并保留并重拉快照。 */
			var save = function () {
				if (busy || snapshot == null || draft == null) return;
				setError(null);
				setNotice("");
				setConflictActive(false); // 批 3：新一轮保存开始即撤销上一轮冲突横幅（若再次冲突由 refetchMerged 重新置位）
				var computed = computePatch(draft, snapshot.config, { secretDraft: secretDraft, clearSecret: clearSecret });
				if (computed.invalidKeys.length > 0) {
					var labels = computed.invalidKeys.map(function (key) {
						var field = ALL_FIELDS.find(function (item) { return item.key === key; });
						return field != null ? field.label : key;
					});
					setError(format(t("save.badNumber"), { keys: labels.join("、") }));
					return;
				}
				if (Object.keys(computed.patch).length === 0) {
					setNotice(t("save.noChanges"));
					return;
				}
				setBusy(true);
				void Promise.resolve().then(function () {
					return remote.updateSettings(computed.patch, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("save.done")); // 生效方式提示（T1 §5）：热生效、插件秒级重启、桥重连
					setClearSecret(false);
					setSecretDraft("");
				}).catch(function (cause) {
					if (isConflictError(cause)) {
						// 批 3（UX §5.4）：冲突合并保留——重拉快照后逐键合并，保留未冲突的
						// 本地编辑（不再全量重建丢弃）；结果条/行内橙标/密文清空见 refetchMerged。
						refetchMerged();
					} else {
						setError(messageOf(cause));
					}
				}).finally(function () {
					setBusy(false);
				});
			};

			// 批 2（UX §5.1）：脏状态渲染期派生——无新增 state，与保存流共用同一
			// computePatch 口径（draft vs 快照生效值 + secretDraft/clearSecret 密文通道）；
			// 批 3 冲突合并后草稿已随 mergeOnConflict 更新，本派生自动与新草稿一致
			//（合并保留的本地编辑仍计入 badge，跟随远端的键不再计入）；数字非法键不进
			// patch 故不入 dirtyKeys（badNumber 反馈仍走 save() 通道）。
			var dirtyKeys = snapshot === null || draft === null
				? []
				: computeDirtyKeys(draft, snapshot.config, { secretDraft: secretDraft, clearSecret: clearSecret });
			var dirtyCount = dirtyKeys.length;

			// 批 3（UX §5.6）：数字行内校验——blur 记态（非法 → 合法范围文案），修正
			// 自动消除（onChange 对已标红键即时重校验）。标红不阻断输入；保存按钮禁用
			// 由渲染层按标红键数落位（§5.6 原文「保存按钮禁用并 title 说明」），
			// computePatch 的 NaN invalidKeys 拦截保留为 save() 内最后防线。
			var handleNumberBlur = function (field, rawText) {
				var range = numberRangeInvalid(field, rawText); // null = 合法；string = 合法范围文案
				setInvalidNumbers(function (previous) {
					if (range == null) {
						if (previous[field.key] == null) return previous;
						var cleared = Object.assign({}, previous);
						delete cleared[field.key];
						return cleared;
					}
					if (previous[field.key] === range) return previous;
					return Object.assign({}, previous, (function () { var marked = {}; marked[field.key] = range; return marked; })());
				});
			};

			// 批 2（UX §5.7）：有未保存修改时注册 beforeunload 离开防护（浏览器原生
			// 确认框，文案由浏览器决定、不可定制）。已知限制（UX 方案 A3/§10.3）：
			// beforeunload 只能拦截页面级离开/刷新；宿主 SPA 内路由切换时面板随路由
			// 卸载、页面本身不重载，原生不触发该事件，宿主亦未提供未保存更改离开守卫
			// 扩展点——如实不拦截，不做 history 劫持等过界方案。
			React.useEffect(function () {
				if (dirtyCount === 0) return undefined;
				var handler = function (event) {
					event.preventDefault();
					event.returnValue = ""; // Chrome/Edge 需显式 returnValue 才弹原生确认
					return "";
				};
				window.addEventListener("beforeunload", handler);
				return function () { window.removeEventListener("beforeunload", handler); };
			}, [dirtyCount > 0]);

			if (snapshot === null || draft === null) {
				// 批 2（UX §7）：加载失败停留当前面板——错误横幅 + 重试按钮走既有
				// refetch（不新增请求方法）；成功后快照落位回到完整面板。
				return h(React, "div", { className: "obx-panel" },
					h(React, "p", { className: "obx-hint" }, t("settings.loading")),
					error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error),
					error === null ? null : h(React, "button", { className: "obx-btn", type: "button", onClick: refetch }, t("common.retry")));
			}

			var secretSet = false;
			if (Array.isArray(snapshot.secrets)) {
				for (var secretEntry of snapshot.secrets) {
					if (secretEntry != null && Array.isArray(secretEntry.path) && secretEntry.path.indexOf("accessToken") >= 0 && secretEntry.set === true) secretSet = true;
				}
			}
			// 批 2（UX §6）：secretSet 保持「宿主侧确有已保存值」语义不变——勾选清除
			// 的「保存后清空」三态徽标在 renderGroup 内按 secretSet+clearSecret 派生
			//（旧版此处把勾选压成「未配置」的行已移除：secretSet:false + 勾清除仍显
			// 「未配置」，与既有渲染契约一致）。

			// W6「非默认」徽标数据源：快照生效值 vs schema 默认值（DEFAULTS），
			// 反映已保存状态；草稿未保存的改动不打徽标。
			var nonDefaultKeys = [];
			if (snapshot.config != null) {
				for (var field of ALL_FIELDS) {
					if (valueEquals(snapshot.config[field.key], DEFAULTS[field.key]) === false) nonDefaultKeys.push(field.key);
				}
			}

			// 批 2（UX §3.2）：mode 联动变暗禁用——reverse→url、forward→host/port；
			// 禁用≠清空（值保留在草稿，computePatch 值比较语义不变）。
			var modeInactiveKeys = deriveModeInactiveKeys(draft.mode);

			// 批 2（UX §3.1）：诊断组折叠 summary 数据——「N 项 · M 项默认开」按
			// GROUPS/DEFAULTS 派生（M = 默认 true 的 actionAuditEnabled/injectDryRun）；
			// 脏标记只看诊断键是否落入 dirtyKeys——折叠不隐藏变更（patch/保存与折叠
			// 无关，工具栏 badge 与提交计数仍含诊断字段）。
			var diagnosticsGroup = GROUPS.find(function (group) { return group.id === "diagnostics"; });
			var diagnosticsTotal = diagnosticsGroup != null ? diagnosticsGroup.fields.length : 0;
			var diagnosticsDefaultOnCount = diagnosticsGroup == null
				? 0
				: diagnosticsGroup.fields.filter(function (field) { return DEFAULTS[field.key] === true; }).length;
			var diagnosticsKeys = GROUP_KEYS.diagnostics != null ? GROUP_KEYS.diagnostics : [];
			var diagnosticsDirty = dirtyKeys.some(function (key) { return diagnosticsKeys.indexOf(key) >= 0; });

			// 批 2（UX §5.7）：危险操作确认——有未保存修改时，「重新加载」「恢复默认值」
			// 先经浏览器原生 confirm（「将丢弃 N 项未保存修改」）；无脏改动直接执行。
			var confirmDiscard = function () {
				if (dirtyCount === 0) return true;
				return window.confirm(format(t("confirm.discardChanges"), { count: dirtyCount }));
			};
			var handleReload = function () {
				if (confirmDiscard()) refetch();
			};
			var handleReset = function () {
				if (!confirmDiscard()) return;
				setDraft(draftFromDefaults());
				setSecretDraft(""); // UX §5.7 补重置项：恢复默认值同时清空密文草稿…
				setClearSecret(false); // …与「清除已保存」勾选
				setInvalidNumbers({}); // 批 3（UX §5.6）：默认值均合法，一并清除行内标红
			};

			// 批 2（integration §2.4/§2.5）：交互文案走 locale 第二档（zh/en 同批），
			// 经 opts.texts 传入纯渲染函数（渲染函数对缺省回退 zh 字面量，模块级
			// 可测行为不变）。
			var texts = {
				modeInactive: t("field.modeInactive"),
				secretSet: t("secret.set"),
				secretUnset: t("secret.unset"),
				secretClearPending: t("secret.clearPending"),
				secretClearHint: t("secret.clearHint"),
				secretClear: t("secret.clear"),
				remoteOverwritten: t("field.remoteOverwritten"),
			};

			// 批 3（UX §5.6）：标红键的行内红字文案（范围文案 → 本地化句式）+ 键 label
			//（保存按钮禁用 title 与字段行内提示共用一份标红数据源）。
			var invalidNumberMessages = {};
			var invalidNumberLabels = [];
			Object.keys(invalidNumbers).forEach(function (key) {
				var field = ALL_FIELDS.find(function (item) { return item.key === key; });
				if (field != null) invalidNumberLabels.push(field.label);
				invalidNumberMessages[key] = format(t("field.numberInvalid"), { range: invalidNumbers[key] });
			});
			var invalidNumberCount = Object.keys(invalidNumbers).length;

			var changeHandlers = {
				disabled: busy,
				secretSet: secretSet,
				clearSecret: clearSecret,
				nonDefaultKeys: nonDefaultKeys,
				draft: draft,
				// 批 3（UX §5.6/§5.4）：行内校验标红数据源 + blur 校验入口 + 冲突橙标键
				invalidNumbers: invalidNumberMessages,
				onNumberBlur: handleNumberBlur,
				remoteOverwrittenKeys: conflictKeys,
				// W7：workspacePath 字段行下方的「快速填入 workspace」行（独立于
				// obx-field 行；onApply 只写草稿不保存——保存仍走 save() 显式通道）。
				renderExtraRow: function (field) {
					if (field.key !== "workspacePath") return null;
					return renderWorkspacePicker(React, {
						loaded: workspace.loaded,
						available: workspace.available,
						workspaces: workspace.workspaces,
						selectedId: workspace.selectedId,
						disabled: busy,
						fetchFailed: workspace.fetchFailed === true,
						retryBlocked: workspace.retryBlocked === true,
						onRetry: fetchWorkspaces,
						fetchFailedText: t("workspace.fetchFailed"),
						retryText: t("common.retry"),
						onSelectedChange: function (nextId) {
							setWorkspace(Object.assign({}, workspace, { selectedId: nextId }));
						},
						onApply: function (path) {
							setDraft(fillWorkspacePath(draft, path));
						},
					});
				},
				onChange: function (field, nextValue) {
					setDraft(Object.assign({}, draft, (function () { var next = {}; next[field.key] = nextValue; return next; })()));
					// 批 3（UX §5.6）：已标红的数字键随输入重校验，修正后自动消除标红
					if (field.type === "number" && invalidNumbers[field.key] != null) handleNumberBlur(field, nextValue);
					// 批 3（UX §5.4）：冲突键被再次编辑后撤销行内橙标（该提示描述的是被
					// 覆盖时刻的状态，用户改值后不再成立）
					if (conflictKeys.indexOf(field.key) >= 0) setConflictKeys(conflictKeys.filter(function (key) { return key !== field.key; }));
				},
				onSecretChange: function (nextText) {
					setSecretDraft(nextText);
					setDraft(Object.assign({}, draft, (function () { var next = {}; next.accessToken = nextText; return next; })()));
					setClearSecret(false); // 批 2（UX §6）互斥：输入新值即取消「清除已保存」勾选
				},
				onClearSecretChange: function (nextChecked) {
					setClearSecret(nextChecked);
				},
			};

			// 批 3（UX §5.4）：冲突横幅改显式状态——refetchMerged 置位 conflictActive，
			// save() 开场/失败分支与 refetch()/accept() 复位（替换批 1 的文案恒等派生）。

			return h(React, "div", { className: "obx-panel" },
				h(React, "h2", { className: "obx-title" }, t("settings.title")),
				h(React, "p", { className: "obx-desc" }, t("settings.desc")),
				h(React, "div", { className: "obx-toolbar" },
					h(React, "span", { className: "obx-meta" }, t("revision.label") + " " + String(snapshot.revision)),
					snapshot.entryActive === true ? null : h(React, "span", { className: "obx-meta obx-warn", title: t("effect.entryInactiveTitle") }, t("effect.entryInactive")),
					h(React, "span", { className: "obx-spacer" }),
					// 批 2（UX §5.1）：脏状态 badge——「N 项未保存」（含诊断组：折叠不隐藏变更）
					dirtyCount > 0 ? h(React, "span", { className: "obx-badge obx-warn" }, format(t("save.dirtyBadge"), { count: dirtyCount })) : null,
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: handleReload }, t("settings.reload")),
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: handleReset }, t("settings.reset")),
					// 批 2（UX §5.1）：无未保存修改时保存禁用（title 说明）；批 3（UX §5.6）
					// 数字行内校验非法时同样禁用（title 优先说明非法键——「保存按钮禁用并
					// title 说明」；noChanges 兜底文案保留在 save() 内）
					h(React, "button", {
						className: "obx-btn primary", type: "button",
						disabled: busy || dirtyCount === 0 || invalidNumberCount > 0,
						title: invalidNumberCount > 0
							? format(t("save.badNumber"), { keys: invalidNumberLabels.join("、") })
							: dirtyCount === 0 ? t("save.noChangesTitle") : undefined,
						onClick: save,
					}, busy ? t("save.saving") : t("save.submit"))),
				// UX §5.5 / UI §4.1：反馈结果条上移至工具栏之后、热生效提示条之前
				// （纯 DOM 移动，role/文案/逻辑全保留——本批唯一 createElement 结构调整）。
				error === null ? null : h(React, "div", { className: "obx-error" + (conflictActive ? " obx-error--conflict" : ""), role: "alert" }, t("status.error") + "：" + error),
				notice === "" ? null : h(React, "p", { className: "obx-notice" }, notice),
				h(React, "div", { className: "obx-effect" }, t("effect.hint")),
				GROUPS.map(function (group) {
					// 批 2：交互 opts（texts/groupDesc/modeInactiveKeys）+ 诊断组折叠配置
					//（UX §3.1：仅诊断组可折叠，默认收起，开合持久化 sessionStorage）。
					return renderGroup(React, group, Object.assign({}, changeHandlers, {
						texts: texts,
						groupDesc: t("group." + group.id + ".desc"),
						modeInactiveKeys: modeInactiveKeys,
						collapsible: group.id === "diagnostics" ? {
							open: diagnosticsExpanded,
							onToggle: toggleDiagnostics,
							summaryMeta: format(t("diagnostics.summary"), { total: diagnosticsTotal, enabled: diagnosticsDefaultOnCount }),
							dirtyMark: diagnosticsDirty ? t("diagnostics.dirtyMark") : null,
						} : undefined,
					}));
				}));
		}
		//#endregion

		//#region 合体设置面板（分页：陪伴 / QQ 通道）
/**
 * 分页设置：陪伴是一页，QQ 通道另是一页。
 * 不写死在长列表里——哥哥原话：不要分上下，干脆分页。
 */
function CombinedPanel(props) {
  var UI = BubbleUI.ui || {};
  var tabState = React.useState(UI.tab || "companion");
  var tab = tabState[0];
  // 页签也寄在模块里：宿主重画面板时不至于每次都弹回第一页
  var setTab = function (v) { UI.tab = v; tabState[1](v); };
  var tabs = [["companion", "泡泡"], ["bili", "B站与视频"], ["qq", "QQ 通道"]];
  var tabBar = React.createElement("div", {
    style: { display: "flex", gap: 6, margin: "0 0 14px", flexWrap: "wrap" },
  }, tabs.map(function (pair) {
    var on = tab === pair[0];
    return React.createElement("button", {
      key: pair[0], type: "button",
      onClick: function () { setTab(pair[0]); },
      style: {
        padding: "5px 14px", borderRadius: 999, fontSize: 12, cursor: "pointer",
        border: "1px solid " + (on ? "transparent" : "var(--dsw-alias-border, rgba(255,255,255,.18))"),
        background: on ? "var(--dsw-alias-brand, #3b82f6)" : "transparent",
        color: on ? "#fff" : "inherit",
      },
    }, pair[1]);
  }));
  return React.createElement("div", null,
    tabBar,
    tab === "qq"
      ? React.createElement(React.Fragment, null,
        React.createElement(BubbleUI.QqPower, null),
        React.createElement(BubbleUI.ExtQqSection, null),
        React.createElement(BubbleUI.RetiredSessions, null),
        React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: props.remote })))
      : tab === "bili"
        ? React.createElement(BubbleUI.BiliPanel, null)
        : React.createElement(BubbleUI.Panel, { goChannel: function () { setTab("qq"); } }));
}
//#endregion

		//#region 客户端入口
		var inject = ["slots", "locale", "remote"];
		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（对照先例：只回收 Remote 挂载；
		 *          样式/词条/slot 注册由宿主 ctx.effect 与 slot 生命周期回收）。
		 */
		async function apply(ctx) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "onebot-settings: style");

			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "onebot-settings: dictionaries");
			var t = ctx.locale.bind(NS);

			// 页面里出的错自己记一份回来（控制台我们这头看不见）。
			// 只挂一次；报错接口是插件自己的 /api/bubble/client-log。
			try {
				if (!window.__bubbleErrHook) {
					window.__bubbleErrHook = true;
					var reportClientError = function (where, err) {
						try {
							var body = {
								where: where,
								message: String((err && err.message) || err || "unknown"),
								stack: String((err && err.stack) || ""),
								extra: { href: String(location.href || "") },
							};
							void fetch("/api/bubble/client-log", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(body),
							}).catch(function () {});
						} catch (e) { /* 记不下来也不能再抛 */ }
					};
					window.__bubbleErrReport = reportClientError;
					window.addEventListener("error", function (ev) {
						reportClientError("window.error@" + String(ev.filename || "") + ":" + String(ev.lineno || 0),
							(ev.error && ev.error.message) ? ev.error : ev.message);
					});
					window.addEventListener("unhandledrejection", function (ev) {
						reportClientError("unhandledrejection", ev.reason);
					});
				}
			} catch (e) { /* 老环境没有 window 就算了 */ }

			// namespace 是独立 Cordis 服务：必须挂载后 ctx.get() 获取，
			// 直接读 ctx.remote.onebotSettings 会要求预先注入并死锁（先例同款注释）。
			var disposeRemote = await ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE);
			var remote = ctx.get("remote." + REMOTE_NS);
			if (remote === undefined) throw new Error("onebot-settings Remote 挂载后不可用");

			ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register(
				{ name: "plugins.bundle.config", key: "dsh-onebot-paopao", locale: NS },
				function (props) { if (props && props.view === "summary") return t("settings.desc"); return React.createElement(CombinedPanel, Object.assign({}, props, { remote: remote })); },
			); });

			// 设置页左边也直接给一条「泡泡」，不用先点进插件列表再找。
			// 里面还是 泡泡 / B站与视频 / QQ 通道 三个 tab（同一个 CombinedPanel）。
			ctx.slots.inject("settings.section", function () { return ctx.slots.register(
				{ name: "settings.section", id: "bubble", order: 32, label: "泡泡" },
				function (props) { return React.createElement(CombinedPanel, Object.assign({}, props, { remote: remote, t: t })); },
			); });

			// 陪伴那边自己的槽位（会话头的「做过的事」tab）
			try { BubbleUI.apply(ctx); } catch (e) { /* 槽位没有就算了 */ }

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.ONEBOT_SETTINGS_REMOTE = ONEBOT_SETTINGS_REMOTE;
		exports.ONEBOT_SETTINGS_DESCRIPTORS = ONEBOT_SETTINGS_DESCRIPTORS;
		exports.GROUPS = GROUPS;
		exports.ALL_FIELDS = ALL_FIELDS;
		exports.DEFAULTS = DEFAULTS;
		exports.GROUP_KEYS = GROUP_KEYS;
		exports.computePatch = computePatch;
		exports.computeDirtyKeys = computeDirtyKeys;
		exports.deriveModeInactiveKeys = deriveModeInactiveKeys;
		exports.coerceValue = coerceValue;
		exports.snapshotValueToDraft = snapshotValueToDraft;
		exports.draftFromSnapshot = draftFromSnapshot;
		exports.fillWorkspacePath = fillWorkspacePath;
		exports.renderWorkspacePicker = renderWorkspacePicker;
		exports.isConflictError = isConflictError;
		exports.unwrap = unwrap;
		exports.renderGroup = renderGroup;
		exports.OnebotSettingsPanel = OnebotSettingsPanel;
		// 批 3（UX §5.4/§5.6）：冲突合并保留 + 数字行内校验（纯函数，单测护航）
		exports.NUMBER_RANGE = NUMBER_RANGE;
		exports.numberRangeInvalid = numberRangeInvalid;
		exports.mergeOnConflict = mergeOnConflict;

		return module.exports;
	}
});
