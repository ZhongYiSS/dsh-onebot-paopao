---
title: 泡泡文档入口
---

# 泡泡文档（从这里进）

- [[FEATURES]] —— 功能与关系全景：**所有功能长什么样、谁把什么交给谁、哪里容易踩雷**
- [[ARCHITECTURE]] —— 实现细节：模块、数据流、闸门顺序、每个配置键落在哪

## 看文档

1. 直接读 md 就行，标题层级本身就是大纲
2. 想要一张能折叠的图：用 `scripts/md-to-mm.mjs` 把 md 转成 `.mm`，再用 Freeplane 打开（库那边 `泡泡\` 目录里已经有生成好的两份）
3. `Ctrl+O` 搜文件名、`Ctrl+Shift+F` 全库搜正文（编辑器自带的功能）

## 谁改什么

- **文字内容**：改 `FEATURES.md` / `ARCHITECTURE.md`（普通 md，git 一起提交）；库里的副本由 `scripts/sync-docs.mjs` 单向同步（库 → 仓库）
- **图**：`.mm` 是从 md 生成的产物，别手改；要在图里加东西就说一声，回头同步回 md

## 以前那套（已退役）

`FEATURES.html`（markmap 单文件）已经删了，`sync-docs.mjs` 也不再生成它 —— 2026-11-19 哥哥定的：有 Freeplane 就直接看图，HTML 那套不要了。旧命令 `markmap docs/FEATURES.md --offline -o docs/FEATURES.html` 现在跑出来也没人用，别再跑。