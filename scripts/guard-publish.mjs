#!/usr/bin/env node
/**
 * 发布前守卫：把「本机私有」漏进去的东西挡在 npm pack 之前。
 *
 * 检查项：
 * 1. `files` 里不该出现备份（`.bak-`）、测试脚本（`tmp/`）、临时目录；
 * 2. 会随包发布的文件里不许出现本机路径、私人 QQ 号、网关域名、token；
 * 3. `package.json` 的 `dshx.contributes.tools` 必须与实际注册的工具一一对上。
 *
 * 用法：`node scripts/guard-publish.mjs`（`prepublishOnly` 会自动调）。
 * 退出码 0 = 干净；1 = 有问题并打印全部命中。
 * @module dsh-onebot/scripts/guard-publish
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 会随包发布的内容：11-14 体检 D7 之前这里是手抄的保守版（lib + scripts），
 * 而 package.json 的 files 还包含 bin/、assets/、screenshots.json 等 —— 守卫结构上管不到。
 * 现在从 package.json 的 files 推导，另加「总要扫」的几个根文件（README/LICENSE 之类）。
 */
const PUBLISH_DIRS = new Set(['lib', 'scripts']);
const PUBLISH_FILES = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']);
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
    const name = String(entry).trim();
    if (name === '' || name.startsWith('!')) continue;
    const abs = join(ROOT, name);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { isDir = !/\.[a-z0-9]+$/i.test(name); }
    if (isDir) PUBLISH_DIRS.add(name.replace(/\/+$/, ''));
    else PUBLISH_FILES.add(name);
  }
} catch {
  // 读不到 package.json 就按保守版扫（不至于因为推导失败就放行）
}

/** 本机私有痕迹：命中就要改。 */
const FORBIDDEN = [
  { re: /1094335744/, why: '私人 QQ 号' },
  { re: /蓝色大肥鱼/, why: '本机人格/项目名' },
  { re: /[A-Za-z]:[\\/]{1,2}(Users|AI)[\\/]/i, why: '本机绝对路径' },
  { re: /\bintern-ai\b/i, why: '私人网关域名' },
  { re: /\bapigoto\b/i, why: '私人网关域名' },
  { re: /fish-33f7488281da6144/, why: '反连 token' },
  { re: /\bhb109\b/, why: '本机用户名' },
];

/** 这些文件允许出现上面那些词（说明用途 / 正则自身）。 */
const ALLOW = new Set([
  join(ROOT, 'scripts', 'guard-publish.mjs'),
]);

/** 不该被打包的文件名。 */
const BAD_NAMES = [/\.bak-/, /\.new$/, /\.orig$/, /\.log$/, /\.tmp$/];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tmp') continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const problems = [];

// 1. 文件名体检
const shipped = [];
for (const dir of PUBLISH_DIRS) shipped.push(...walk(join(ROOT, dir)));
for (const file of PUBLISH_FILES) {
  const full = join(ROOT, file);
  try {
    if (statSync(full).isFile()) shipped.push(full);
  } catch {
    /* 可选文件不存在就算了 */
  }
}
// 仓库根目录的散落残件（手改留下的 .new/.bak）也算
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (BAD_NAMES.some((re) => re.test(entry.name))) {
    problems.push(`${entry.name}：仓库根目录不该留备份/临时文件（挪去存档备份）`);
  }
}
for (const full of shipped) {
  const base = full.slice(full.lastIndexOf(sep) + 1);
  if (BAD_NAMES.some((re) => re.test(base))) {
    problems.push(`${relative(ROOT, full)}：备份/临时文件不该随包发布（挪去存档备份）`);
  }
}

// 2. 私有痕迹
for (const full of shipped) {
  if (ALLOW.has(full)) continue;
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(lines[i])) {
        problems.push(`${relative(ROOT, full)}:${i + 1}：${why} —— ${lines[i].trim().slice(0, 120)}`);
      }
    }
  }
}

// 3. 工具清单对齐
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const declared = pkg?.dshx?.contributes?.tools;
if (!Array.isArray(declared) || declared.length === 0) {
  problems.push('package.json：没有 dshx.contributes.tools');
} else {
  const toolsSrc = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8');
  const registered = new Set();
  for (const match of toolsSrc.matchAll(/name:\s*'([a-z0-9_]+)'/gi)) registered.add(match[1]);
  for (const name of declared) {
    if (!registered.has(name)) problems.push(`package.json：声明了 ${name}，但 lib/tools.js 里没注册`);
  }
  for (const name of registered) {
    if (!declared.includes(name)) problems.push(`package.json：lib/tools.js 注册了 ${name}，但没写进 contributes.tools`);
  }
}

// 4. 代码里 import 的裸模块，必须在依赖表里（11-11 安装记录：qrcode 没写进 dependencies，
//    别人装完入口 import 直接抛错，整个插件不挂载，设置页显示「未运行」）
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => 'node:' + m),
]);
const DECLARED_DEPS = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);
/** 一行里可能出现的取模块写法：from 'x' / import('x') / require('x') / import 'x' */
const IMPORT_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*import\s*['"]([^'"]+)['"]/,
];
/** 客户端 bundle 从宿主运行时拿的模块（平台冻结表，不在 npm 依赖里）。 */
const BARE_ALLOW = new Set(['react', 'react-dom']);
/** 像不像一个模块名：`qrcode`、`ws`、`@scope/pkg`；`" + chatId + "` 这种不算。 */
const MODULE_SPEC_RE = /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/;
const isShippedCode = (full) => /\.(?:m?js)$/.test(full) && shipped.includes(full);
for (const full of shipped.filter(isShippedCode)) {
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;   // 注释里提到的不算
    const spec = IMPORT_RES.map((re) => re.exec(line)?.[1]).find(Boolean);
    if (!spec) continue;
    if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue;
    if (!MODULE_SPEC_RE.test(spec)) continue;          // 字符串拼接，不是模块名
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (BARE_ALLOW.has(name)) continue;
    if (!DECLARED_DEPS.has(name)) {
      problems.push(`${relative(ROOT, full)}:${i + 1}：import 了 ${name}，但 package.json 的依赖里没有它`);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ 发布前检查没过（${problems.length} 条）：`);
  for (const line of problems) console.error('  - ' + line);
  process.exit(1);
}
console.log(`✓ 发布前检查通过（${shipped.length} 个文件，工具 ${declared.length} 个）`);
