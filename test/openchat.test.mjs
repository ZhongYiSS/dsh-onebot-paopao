// 11-15：常驻「随意聊聊」名单（openChatGroups）
// 判据：名单里的群恒开、不开窗、不挂计时器、关窗词不生效；不在名单里的群一切照旧。
import test from 'node:test';
import assert from 'node:assert/strict';
import { InboundPipeline } from '../lib/inbound.js';

/** 只用到 ctx.config / ctx.log 的最小壳，直接拿原型方法跑。 */
function rig(config = {}) {
    const logs = [];
    const p = Object.create(InboundPipeline.prototype);
    p.ctx = {
        config: {
            openChatMaxMs: 1_200_000,
            openChatDefaultMs: 600_000,
            ...config,
        },
        log: (level, msg) => logs.push(level + ': ' + msg),
        selfId: () => '3490240357',
        now: () => Date.now(),
    };
    p.openChatUntil = new Map();
    p.openChatTimers = new Map();
    p.now = () => 1_700_000_000_000;
    p.nudges = [];
    p.nudgeSelf = (chatId, note) => p.nudges.push([chatId, note]);
    return { p, logs };
}

test('常驻名单：纯群号与 group: 前缀都认，空白项跳过', () => {
    const { p } = rig({ openChatGroups: ['1126062180', 'group:999', '  ', ''] });
    assert.equal(p.permanentOpenChat('group:1126062180'), true);
    assert.equal(p.permanentOpenChat('group:999'), true);
    assert.equal(p.permanentOpenChat('group:111'), false);
    assert.equal(p.permanentOpenChat('private:1094335744'), false);
});

test('没配名单时一律不算常驻（老行为不变）', () => {
    for (const bad of [undefined, null, [], 'not-an-array']) {
        const { p } = rig({ openChatGroups: bad });
        assert.equal(p.permanentOpenChat('group:1126062180'), false);
    }
});

test('常驻群恒开，且不需要任何窗口记录', () => {
    const { p } = rig({ openChatGroups: ['1126062180'] });
    assert.equal(p.openChatActive('group:1126062180'), true);
    assert.equal(p.openChatUntil.size, 0);
});

test('普通群还是看窗口到期', () => {
    const { p } = rig({ openChatGroups: ['1126062180'] });
    assert.equal(p.openChatActive('group:111'), false);
    p.openChatUntil.set('group:111', p.now() - 1);
    assert.equal(p.openChatActive('group:111'), false);
    p.openChatUntil.set('group:222', p.now() + 60_000);
    assert.equal(p.openChatActive('group:222'), true);
});

test('常驻群被要求开窗：不开窗、不挂计时器、照样算「在随意聊」', async () => {
    const { p, logs } = rig({ openChatGroups: ['1126062180'] });
    const totalMin = await p.startOpenChat('group:1126062180', 30);
    assert.equal(totalMin, 0);
    assert.equal(p.openChatUntil.size, 0);
    assert.equal(p.openChatTimers.size, 0);
    assert.ok(logs.some((l) => l.includes('一直随意聊')));
});

test('普通群开窗仍受上限约束（20 分钟封顶）', async () => {
    const { p } = rig({ openChatGroups: ['1126062180'] });
    const totalMin = await p.startOpenChat('group:111', 120);
    assert.equal(totalMin, 20);
    assert.equal(p.openChatUntil.size, 1);
    assert.equal(p.openChatTimers.size, 1);
    for (const t of p.openChatTimers.values()) clearTimeout(t);
});
