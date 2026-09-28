// 建立提醒的共用邏輯（打字新增與語音新增都走這裡）。

import { reminderToJson } from './db.js';

const MAX_MESSAGE_LENGTH = 500;
const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

// 回傳 { reminder } 或 { error }
export async function insertReminder(env, { message, contactId, dueAt, imageKey = null }) {
  const text = String(message ?? '').trim();
  const now = Date.now();

  if (!text) return { error: '請填寫提醒內容' };
  if (text.length > MAX_MESSAGE_LENGTH) return { error: `提醒內容請少於 ${MAX_MESSAGE_LENGTH} 字` };
  if (!Number.isFinite(dueAt)) return { error: '提醒時間格式不正確' };
  if (dueAt < now - 60 * 1000) return { error: '提醒時間已經過了，請選擇未來的時間' };
  if (dueAt > now + MAX_FUTURE_MS) return { error: '提醒時間太遠了（最多 5 年內）' };

  const contact = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first();
  if (!contact) return { error: '找不到這位收件人' };
  if (contact.blocked) return { error: '這位收件人已封鎖提醒小幫手，無法傳送' };

  const row = await env.DB.prepare(
    'INSERT INTO reminders (message, contact_id, due_at, created_at, image_key, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
  )
    .bind(text, contactId, Math.round(dueAt), now, imageKey, imageKey ? 'card' : 'pending')
    .first();
  row.contact_name = contact.name || contact.line_display_name;
  row.contact_is_self = contact.is_self;
  return { reminder: reminderToJson(row) };
}
