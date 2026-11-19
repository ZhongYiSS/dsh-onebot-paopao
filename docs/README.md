---
title: 泡泡文档入口
---

# 泡泡文档（从这里进）

- [[FEATURES]] —— 功能与关系全景：**所有功能长什么样、谁把什么交给谁、哪里容易踩雷**（一份 215 行的大纲，Obsidian 里按大纲层级看）
- [[ARCHITECTURE]] —— 实现细节：模块、数据流、闸门顺序、每个配置键落在哪
- [[MarkMap 那套渲染已退役]]（见文末）

## 怎么图省事地看

1. 左上角 / 右侧栏打开「**大纲**（Outline）」，就是一列可点的头层级
2. `Ctrl+O` 直接搜文件名、`Ctrl+Shift+F` 全库搜正文
3. 想看成图：装上 **Markmap** 或 **Mind Map** 插件，打开 `FEATURES.md` 后在右侧栏点插件图标，md 的标题层级就长成一张可折叠的图
4. 这张图**是从 md 现渲染的**，不落盘 —— 所以图和你看到的内容永远是同一份，不会各有各的版本

## 谁改什么

- **文字内容**：我改 `FEATURES.md` / `ARCHITECTURE.md`（普通 md，git 一起提交）
- **图的形状/展开层级**：你在 Obsidian 里拖、折，属于「看的时候的样子」，不改文件
- **想留一张能拖的图**：用 Excalidraw 插件，它存成 `.excalidraw.md`（本质还是 md + 一段 JSON），文字我改得动，图形别手改

## 以前那套

`FEATURES.html`（markmap 生成的单文件）还留着，双击能开，适合发给别人看；但**别指望它跟着改**——每次都要重跑：

```
cd D:\AI\聊天\dsh-onebot
markmap docs\FEATURES.md --offline -o docs\FEATURES.html
```

新方式（Obsidian）不用重跑，打开就是最新的。