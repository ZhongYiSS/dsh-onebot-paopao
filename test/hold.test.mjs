import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHold, stripMarkers } from '../lib/markers.js';

// 11-14：`[HOLD]` 改成「独立成行 / 在结尾」才算，正文里提一句不算（以前会把整轮吞掉）。
test('HOLD：独占一行算', () => {
  assert.equal(hasHold('[HOLD]'), true);
  assert.equal(hasHold('本鱼知道。\n[HOLD]'), true);
  assert.equal(hasHold('  [hold]  '), true);
});

test('HOLD：在结尾算（带标点也行）', () => {
  assert.equal(hasHold('那本鱼不说了。[HOLD]'), true);
  assert.equal(hasHold('嗯。[HOLD]。'), true);
});

test('HOLD：正文里提到不算', () => {
  assert.equal(hasHold('这个[HOLD]标记是这么用的'), false);
  assert.equal(hasHold('要是写了 [HOLD] 就不发出去'), false);
  assert.equal(hasHold(''), false);
});

test('HOLD：剥离仍然剥干净', () => {
  assert.equal(stripMarkers('说了。[HOLD]'), '说了。');
});
