import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, originAllowed, judgeOrigin } from '../lib/companion/origin.mjs';

const H = '127.0.0.1:54505';

test('isLocalHost 认得出本机与局域网', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '192.168.1.9', '10.0.0.5', '172.20.1.1', '169.254.1.1', 'box.local']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['evil.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isLocalHost(h), false, h);
});

test('自己人的各种打开方式都放行', () => {
  // 桌面壳 / 本地文件 / 沙箱同源
  assert.equal(originAllowed({ origin: 'dsh-app://app', host: H }), true);
  assert.equal(originAllowed({ origin: 'file://', host: H }), true);
  assert.equal(originAllowed({ origin: 'null', host: H, site: 'same-origin' }), true);
  // 局域网打开
  assert.equal(originAllowed({ origin: 'http://192.168.1.9:3081', host: '192.168.1.9:3081' }), true);
  assert.equal(originAllowed({ origin: 'http://192.168.1.9:3081', host: H }), true);
  assert.equal(originAllowed({ origin: 'http://localhost:3081', host: H }), true);
  // 同源 GET 本来就不带 Origin，curl 也不带
  assert.equal(originAllowed({ host: H }), true);
  assert.equal(originAllowed({ host: H, site: 'same-origin' }), true);
});

test('公网页面还是挡在外面（0.5.26 那条 CSRF 的初衷不能丢）', () => {
  assert.equal(originAllowed({ origin: 'https://evil.com', host: H }), false);
  assert.equal(originAllowed({ origin: 'http://8.8.8.8:3081', host: H }), false);
  assert.equal(originAllowed({ origin: 'null', host: H, site: 'cross-site' }), false);
  assert.equal(originAllowed({ origin: 'https://evil.com', host: H, referer: 'http://127.0.0.1:54505/' }), false);
  // 带对令牌才放
  assert.equal(originAllowed({ origin: 'https://evil.com', host: H, token: 'k', want: 'k' }), true);
  assert.equal(originAllowed({ origin: 'https://evil.com', host: H, token: 'k', want: '' }), false);
});

test('判定要能说出为什么（面板上要显示这个）', () => {
  assert.equal(judgeOrigin({ origin: 'dsh-app://app', host: H }).why, 'local-scheme');
  assert.equal(judgeOrigin({ origin: 'https://evil.com', host: H }).why, 'foreign-origin');
  const j = judgeOrigin({ origin: 'https://evil.com', host: H });
  assert.equal(j.seen.host, H);
  assert.equal(j.seen.origin, 'https://evil.com');
});
