import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../src/scheduler.js';

const env = { OWNER_NAME: 'froglssh' };
const self = { is_self: 1 };
const friend = { is_self: 0 };

test('文字提醒：給自己不加落款、給別人加落款', () => {
  assert.deepEqual(buildMessages(env, { message: '喝水' }, self, 'https://x'), [{ type: 'text', text: '⏰ 提醒：喝水' }]);
  assert.equal(buildMessages(env, { message: '取貨' }, friend, 'https://x')[0].text, '⏰ 提醒：取貨\n—— 來自 froglssh');
});

test('圖片賀卡：先傳圖片再傳祝福文字', () => {
  const msgs = buildMessages(env, { message: '中秋節快樂！', image_key: 'abc' }, friend, 'https://site');
  assert.deepEqual(msgs[0], {
    type: 'image',
    originalContentUrl: 'https://site/img/abc.jpg',
    previewContentUrl: 'https://site/img/abc.jpg',
  });
  assert.deepEqual(msgs[1], { type: 'text', text: '中秋節快樂！\n—— 來自 froglssh' });
  assert.equal(buildMessages(env, { message: '中秋節快樂！', image_key: 'abc' }, self, 'https://site')[1].text, '中秋節快樂！');
});
