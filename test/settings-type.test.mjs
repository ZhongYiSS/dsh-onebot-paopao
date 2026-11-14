import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, settingTypeOk } from '../lib/index.js';

// 11-14：settings.json 里的值覆盖到运行期配置之前要验一遍 ——
// 以前用 `Config.safeParse`（宿主 schemastery 没有这个方法）→ 每个键都被当「类型不对」
// 丢掉，面板存的模型/关键词/关键词目录全部静默失效。这条测试盯着「好值必须过」。
test('正常值全部通过', () => {
  assert.equal(settingTypeOk('port', 8643), true);
  assert.equal(settingTypeOk('visionModel', 'deepseek-v4.1-flash'), true);
  assert.equal(settingTypeOk('groupKeywords', ['钟壹', '汐儿']), true);
  assert.equal(settingTypeOk('groupAbilities', ['voice', 'draw']), true);
  assert.equal(settingTypeOk('groupMediaWorkspace', true), true);
  assert.equal(settingTypeOk('memeDir', 'D:/AI/蓝色大肥鱼/图片/表情包/memes'), true);
  assert.equal(settingTypeOk('visionHeaders', '{"x-opencode-session":"paopao-vision"}'), true);
  assert.equal(settingTypeOk('cardFooter', ''), true);
});

test('明显不对的值被挡下来', () => {
  assert.equal(settingTypeOk('port', 'abc'), false);
  assert.equal(settingTypeOk('port', Number.NaN), false);
  assert.equal(settingTypeOk('visionModel', 123), false);
  assert.equal(settingTypeOk('groupKeywords', '钟壹,汐儿'), false);
  assert.equal(settingTypeOk('groupMediaWorkspace', 'yes'), false);
  assert.equal(settingTypeOk('noSuchKey', 1), false);
});

test('schema 自己就有这些键（防止改名后静默全丢）', () => {
  const dft = Config({});
  for (const k of ['port', 'visionModel', 'groupKeywords', 'groupAbilities', 'groupMediaWorkspace', 'memeDir', 'cardFooter']) {
    assert.ok(k in dft, k + ' 应该在 schema 里');
  }
});
