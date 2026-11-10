# 第三方代码与许可说明 / Third-Party Notices

泡泡（`dsh-PaoPao`）本体以 **MIT** 发布，正文见 `LICENSE`。

本项目的 QQ 通道部分是 [dsh-onebot](https://github.com/mario841859784/dsh-onebot) 的二次开发版，
B站 相关能力在设计上参考了 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)。
两份原始许可都要求保留版权声明，所以全文抄录如下。

`PaoPao` itself is released under the **MIT** license (see `LICENSE`). It is a derivative
work of [dsh-onebot](https://github.com/mario841859784/dsh-onebot) (BSD 3-Clause) and was
inspired in part by [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT).
Both licenses require their notices to be retained, so they are reproduced in full below.

---

## 1. dsh-onebot — 本项目的底座 / the upstream base

- 来源 / Source: <https://github.com/mario841859784/dsh-onebot>
- 许可 / License: **BSD 3-Clause**
- 我们用到的 / What we use: 整个 QQ 通道（OneBot 11 适配、会话桥、入站出站、设置页骨架）。
  在此基础上新增了陪伴层（泡泡）、B站 视频挑选与「看视频」工具。
- **声明**：本仓库由 PaoPao 的维护者维护，是独立发布，**不代表原作者，也未获其背书**
  （BSD-3 第 3 条）。上游原名与版权行保留如下。

> 本版本与上游的差异见 `CHANGELOG.md`；发现问题请提到本仓库，不要打扰上游作者。

```
BSD 3-Clause License

Copyright (c) 2026, dsh-external contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 2. dsh-bili-scroll（刷B站）— 设计参考 / design reference

- 来源 / Source: <https://github.com/c1overzz/dsh-bili-scroll>
- 许可 / License: **MIT**，Copyright (c) 2026 c1overzz
- 它内含 / it bundles: `vendor/bilibili-mcp`，**MIT**，Copyright (c) 2026 AGI_Ananas
- 我们用到的 / What we use：**没有包含它的源代码** —— 本仓库没有 `vendor/` 目录、不引用
  `bilibili-mcp`、也没有复制它的 prompts。这里的「刷视频 / 挑视频 / 看画面」是自行实现的。
  沿用的是它的**凭证路径约定**（`$DSH_HOME/bili-duty/bili_credential.json`，方便已经登过 B站
  的机器直接复用），以及它的功能形态与交互思路（例如「值得看 / 可以看 / 不值当」这套判断）。
- 为免疑义，仍附 MIT 全文如下。

```
MIT License

Copyright (c) 2026 c1overzz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`vendor/bilibili-mcp` 只在原仓库里存在，本项目未分发它；若将来引入，需一并附上
Copyright (c) 2026 AGI_Ananas 的 MIT 全文。

---

## 3. 协议与外部程序 / Protocols and external programs

本项目**不打包**下列软件，只是通过网络协议或命令行调用它们：

| 名称 | 用途 | 许可 |
|---|---|---|
| [NapCat](https://github.com/NapNeko/NapCatQQ) | QQ ↔ OneBot 11 网关 | 见其仓库 |
| [OneBot 11](https://github.com/botuniverse/onebot-11) | 聊天机器人应用层协议 | 见其仓库 |
| [FFmpeg](https://ffmpeg.org/) | 抽帧、转码、抽音轨 | LGPL/GPL（按其构建而定） |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 站外链接下载（可选，B站 走 playurl 不需要它） | Unlicense |

运行时依赖（`ws` 等）各自的许可随 npm 包分发，未在此重复抄录。