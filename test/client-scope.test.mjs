import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invisibleRenders } from '../scripts/client-scope.mjs';

// 11-14 的事故：`SettingsOverrideCard` 被写在 `BiliPanel` 的函数体里，
// 却在 `ExtQqSection` 里 `h()` 它 —— 浏览器里 ReferenceError，
// 界面上表现成整块设置消失（服务端完全看不出异常）。
const clientSrc = () => readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

test('client.js：组件只在能看到它的层里被渲染', () => {
  const bad = invisibleRenders(clientSrc());
  assert.deepEqual(bad, [], '这些组件渲染时不可见：\n' + bad.join('\n'));
});

test('检查器本身有效（拿那次事故的形状喂它）', () => {
  const broken = [
    'var X = (function (require) {',
    '  function Panel() {',
    '    function Inner() { return h("div", null, "x") }',
    '    return h("div", null, h(Inner))',
    '  }',
    '  function Other() { return h("div", null, h(Inner)) }',
    '  return { Panel: Panel, Other: Other }',
    '})(require)',
  ].join('\n');
  const bad = invisibleRenders(broken);
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.match(bad[0], /^Inner：/);
  const fine = broken.replace('return h("div", null, h(Inner)) }\n  return {', 'return h("div", null, "ok") }\n  return {');
  assert.deepEqual(invisibleRenders(fine), []);
});
