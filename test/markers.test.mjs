/**
 * 机制标记的解析 / 剥离必须用同一份正则（2026-11-14 冷审发现的那类 bug：
 * 陪伴侧认「分钟」，QQ 侧只认「m」→ 不排队还把标记印进聊天框）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasLater, matchLater, matchScore, stripMarkers } from '../lib/markers.js';
import { readLater } from '../lib/companion/prompt.mjs';

test('标记：`[LATER 30分钟]` 这种中文单位也认（以前不排队、还会漏进聊天框）', () => {
  assert.equal(hasLater('等等 [LATER 30分钟]'), true);
  const m = matchLater('等等 [LATER 30分钟]');
  assert.equal(Number(m[1]), 30);
  assert.equal(m[2], '分钟');
});

test('标记：分钟/秒/m/s 都换算成秒', () => {
  assert.equal(readLater('[LATER 25]'), 25 * 60);
  assert.equal(readLater('[LATER 25m]'), 25 * 60);
  assert.equal(readLater('[LATER 90s]'), 90);
  assert.equal(readLater('[LATER 30分钟]'), 30 * 60);
  assert.equal(readLater('[LATER 45秒]'), 45);
  assert.equal(readLater('[LATER 15秒]'), null); // 少于 30 秒不排（太近没意义）
});

test('标记：`[AT 23:00]` 已砍掉 —— 不认，但要能被剥掉', () => {
  assert.equal(readLater('[AT 23:00]'), null);
  assert.equal(stripMarkers('晚安 [AT 23:00]').includes('[AT'), false);
});

test('标记：剥完之后正文干净，[HOLD]/[SKIP]/[SCORE] 都不留', () => {
  const out = stripMarkers('困了 [SCORE 7] [LATER 20分钟] [HOLD]');
  assert.equal(out.includes('[SCORE'), false);
  assert.equal(out.includes('[LATER'), false);
  assert.equal(out.includes('[HOLD'), false);
  assert.equal(out.trim(), '困了');
});

test('标记：同一段里出现两次也能取到（正则不带 /g 残留）', () => {
  const text = '[SCORE 3] 一次 [SCORE 9] 两次';
  assert.equal(Number(matchScore(text)), 3);
  assert.equal(Number(matchScore(text)), 3); // 连调两次结果一样
});
