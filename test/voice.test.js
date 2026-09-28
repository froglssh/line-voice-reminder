import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaipei, formatTaipei, calendarHint, findContact } from '../src/voice.js';

// 2026-09-28 14:05 台灣時間（星期一）
const NOW = Date.UTC(2026, 8, 28, 6, 5);

test('台灣時間解析與格式化', () => {
  assert.equal(formatTaipei(NOW), '2026-09-28（星期一）14:05');
  assert.equal(parseTaipei('2026-10-07 10:00'), Date.UTC(2026, 9, 7, 2, 0));
  assert.equal(formatTaipei(parseTaipei('2026-10-07 10:00')), '2026-10-07（星期三）10:00');
  assert.ok(Number.isNaN(parseTaipei('2026-02-30 10:00')));
  assert.ok(Number.isNaN(parseTaipei('明天十點')));
});

test('日曆對照：下週三', () => {
  const cal = calendarHint(NOW);
  assert.match(cal, /2026-09-28 星期一：今天、本週一/);
  assert.match(cal, /2026-09-29 星期二：明天、本週二/);
  assert.match(cal, /2026-10-04 星期日：本週日/);
  assert.match(cal, /2026-10-07 星期三：下週三/);
  assert.match(cal, /2026-10-14 星期三：下下週三/);
});

test('日曆對照：今天是星期日', () => {
  const sunday = Date.UTC(2026, 9, 4, 2, 0);
  const cal = calendarHint(sunday);
  assert.match(cal, /2026-10-04 星期日：今天、本週日/);
  assert.match(cal, /2026-10-05 星期一：明天、下週一/);
  assert.equal(cal.split('\n').length, 21);
});

test('聯絡人比對', () => {
  const contacts = [
    { id: 1, is_self: 1, name: 'froglssh', line_display_name: 'Frog', aliases: '', blocked: 0 },
    { id: 2, is_self: 0, name: '小明', line_display_name: 'Ming', aliases: '明明,阿明', blocked: 0 },
  ];
  assert.equal(findContact(contacts, '我', 'froglssh').id, 1);
  assert.equal(findContact(contacts, 'froglssh', 'froglssh').id, 1);
  assert.equal(findContact(contacts, '小明', 'froglssh').id, 2);
  assert.equal(findContact(contacts, ' 阿明 ', 'froglssh').id, 2);
  assert.equal(findContact(contacts, 'ming', 'froglssh').id, 2);
  assert.equal(findContact(contacts, '阿花', 'froglssh'), null);
});
