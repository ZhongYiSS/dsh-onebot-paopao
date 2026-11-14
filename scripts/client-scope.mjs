// 粗粒度的「看得见吗」检查：不用解析器，只认大括号和函数作用域。
//
// 起因：11-14 我把 `SettingsOverrideCard` 写进了 `BiliPanel` 的函数体里，
// 却在 `ExtQqSection` 里 `h()` 它 —— 浏览器控制台报 ReferenceError，
// 界面上表现成整块设置消失，而我们在服务端看不到。这条脚本就是防这个。
//
// 只处理我们自己的代码风格（不用 with / 不用 label），字符串、模板串、正则、注释都跳过。

export function tokenize(src) {
  const out = [];       // { kind: 'code'|'newline', text }
  let i = 0;
  let line = 1;
  let prev = '';        // 上一个有意义的字符（判断 / 是除号还是正则）
  const tmpl = [];      // 模板串里 ${ } 的嵌套：每层记录「正常代码」里的大括号深度
  let braceDepth = 0;
  const push = (ch) => out.push({ kind: 'code', text: ch });

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (c === '\n') { out.push({ kind: 'newline' }); line++; i++; prev = ''; continue; }

    // 注释
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { out.push({ kind: 'newline' }); line++; } i++; } i += 2; continue; }

    // 字符串
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') { out.push({ kind: 'newline' }); line++; i++; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      push('"'); prev = '"'; continue;
    }

    // 模板串
    if (c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') { out.push({ kind: 'newline' }); line++; i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { i += 2; tmpl.push(braceDepth); braceDepth++; push('{'); break; }
        if (src[i] === '`') { i++; break; }
        i++;
      }
      prev = '"'; continue;
    }

    // 正则字面量（启发式：前一个有意义字符说明这里得是表达式开头）
    if (c === '/' && /[=(,:;[!&|?{};+\-*%<>~^]$|^$/.test(prev)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        else if (d === '\n') break;
        i++;
      }
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      push('"'); prev = '"'; continue;
    }

    if (c === '{') { braceDepth++; push('{'); prev = '{'; i++; continue; }
    if (c === '}') {
      if (tmpl.length && braceDepth - 1 === tmpl[tmpl.length - 1]) {
        // 模板串里那段 ${...} 结束，回到模板串继续读
        tmpl.pop();
        braceDepth--;
        i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '\n') { out.push({ kind: 'newline' }); line++; i++; continue; }
          if (src[i] === '$' && src[i + 1] === '{') { i += 2; tmpl.push(braceDepth); braceDepth++; push('{'); break; }
          if (src[i] === '`') { i++; break; }
          i++;
        }
        prev = '"';
        continue;
      }
      braceDepth--;
      push('}'); prev = '}'; i++; continue;
    }

    if (!/\s/.test(c)) prev = c;
    push(c);
    i++;
  }
  return out;
}

/** 拆成行，并记录每行的作用域链与函数定义 */
export function analyze(src) {
  const tokens = tokenize(src);
  const lines = [[]];
  for (const t of tokens) {
    if (t.kind === 'newline') lines.push([]);
    else lines[lines.length - 1].push(t.text);
  }
  const scopes = [{ name: null }];
  const defs = new Map();
  const uses = [];
  let armed = null;
  lines.forEach((chars, idx) => {
    const text = chars.join('');
    const chain = scopes.map((s) => s.name).filter(Boolean);
    const fm = text.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (fm && !defs.has(fm[1])) defs.set(fm[1], { name: fm[1], line: idx + 1, chain: chain.slice() });
    if (fm) armed = fm[1];
    for (const m of text.matchAll(/\bh\(([A-Z][\w$]*)/g)) uses.push({ name: m[1], line: idx + 1, chain: chain.slice() });
    for (const ch of chars) {
      if (ch === '{') { scopes.push({ name: armed ?? '→' }); armed = null; }
      else if (ch === '}') { if (scopes.length > 1) scopes.pop(); }
    }
  });
  return { defs, uses };
}

/** 返回「定义处看不见使用处」的组件清单 */
export function invisibleRenders(src) {
  const { defs, uses } = analyze(src);
  const bad = [];
  for (const u of uses) {
    const d = defs.get(u.name);
    if (!d) continue;
    const visible = d.chain.length <= u.chain.length && d.chain.every((n, i) => u.chain[i] === n);
    if (!visible) bad.push(`${u.name}：定义在 ${d.chain.join(' > ') || '顶层'}（第 ${d.line} 行），却在 ${u.chain.join(' > ') || '顶层'} 里用（第 ${u.line} 行）`);
  }
  return bad;
}
