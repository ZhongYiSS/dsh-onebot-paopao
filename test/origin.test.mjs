import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, originAllowed } from '../lib/companion/origin.mjs';

test('isLocalHost 认得出本机与局域网', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '192.168.1.9', '10.0.0.5', '172.20.1.1', '169.254.1.1', 'box.local']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['evil.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) {
    assert.equal(isLocalHost(h), false, h);
  }
});

test('面板从桌面壳或局域网打开要放行（0.5.26 的 403 事故）', () => {
  const host = '127.0.0.1:64257';
  assert.equal(originAllowed({ origin: 'dsh-app://app', host }), true);
  assert.equal(originAllowed({ origin: 'file://', host }), true);
  assert.equal(originAllowed({ origin: 'http://192.168.1.9:3081', host: '192.168.1.9:3081' }), true);
  assert.equal(originAllowed({ origin: 'http://192.168.1.9:3081', host }), true);
  assert.equal(originAllowed({ origin: `http://${host}`, host }), true);
});

test('公网页面还是拒，只有令牌能通', () => {
  const host = '127.0.0.1:64257';
  assert.equal(originAllowed({ origin: 'https://evil.com', host }), false);
  assert.equal(originAllowed({ origin: 'http://8.8.8.8:3081', host }), false);
  assert.equal(originAllowed({ origin: 'https://evil.com', host, token: 'k', want: 'k' }), true);
  assert.equal(originAllowed({ origin: 'https://evil.com', host, token: 'k', want: '' }), false);
});

test('没有 Origin 时看 Sec-Fetch-Site', () => {
  const host = '127.0.0.1:64257';
  assert.equal(originAllowed({ host, site: 'same-origin' }), true);
  assert.equal(originAllowed({ host, site: 'none' }), true);
  assert.equal(originAllowed({ host, site: 'cross-site' }), false);
  assert.equal(originAllowed({ host }), false);
});
