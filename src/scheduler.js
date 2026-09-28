// 每分鐘執行一次：送出到期的提醒、重試暫時失敗的、清除過期資料。

import { pushText } from './line.js';

const MAX_ATTEMPTS = 3;
const STUCK_MS = 5 * 60 * 1000;

export function formatMessage(env, reminder, contact) {
  const text = `⏰ 提醒：${reminder.message}`;
  return contact.is_self ? text : `${text}\n—— 來自 ${env.OWNER_NAME || 'Papaya'}`;
}

async function markFailed(env, reminder, reason, contact) {
  await env.DB.prepare("UPDATE reminders SET status = 'failed', last_error = ? WHERE id = ?")
    .bind(reason, reminder.id)
    .run();

  // 傳給別人失敗時，通知本人（額度用完時就不必再試）
  if (/額度/.test(reason)) return;
  const self = await env.DB.prepare('SELECT * FROM contacts WHERE is_self = 1 AND blocked = 0 LIMIT 1').first();
  if (!self || (contact && self.id === contact.id)) return;
  const who = contact?.name || contact?.line_display_name || '對方';
  await pushText(env, self.line_user_id, `⚠️ 給 ${who} 的提醒沒送出去：「${reminder.message}」\n原因：${reason}`);
}

export async function sendDueReminders(env, now = Date.now()) {
  const db = env.DB;
  await db.prepare("UPDATE reminders SET status = 'pending' WHERE status = 'sending' AND claimed_at < ?")
    .bind(now - STUCK_MS)
    .run();

  // 先把要送的提醒「認領」起來，避免兩次排程重複傳送
  const { results: due } = await db
    .prepare(
      `UPDATE reminders SET status = 'sending', attempts = attempts + 1, claimed_at = ?
       WHERE id IN (SELECT id FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 50)
       RETURNING *`,
    )
    .bind(now, now)
    .all();

  for (const reminder of due) {
    const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(reminder.contact_id).first();
    if (!contact) {
      await markFailed(env, reminder, '收件人已不存在', null);
      continue;
    }
    if (contact.blocked) {
      await markFailed(env, reminder, '對方已封鎖提醒小幫手', contact);
      continue;
    }

    const result = await pushText(env, contact.line_user_id, formatMessage(env, reminder, contact));
    if (result.ok) {
      await db.prepare("UPDATE reminders SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
        .bind(Date.now(), reminder.id)
        .run();
    } else if (!result.permanent && reminder.attempts < MAX_ATTEMPTS) {
      await db.prepare("UPDATE reminders SET status = 'pending', last_error = ? WHERE id = ?")
        .bind(result.reason, reminder.id)
        .run();
    } else {
      await markFailed(env, reminder, result.reason, contact);
    }
  }
  return due.length;
}

export async function cleanup(env, now = Date.now()) {
  const configured = Number(env.RETENTION_MINUTES);
  const minutes = env.RETENTION_MINUTES !== undefined && Number.isFinite(configured) ? configured : 10080;
  const cutoff = now - minutes * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reminders WHERE status = 'sent' AND sent_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM reminders WHERE status = 'failed' AND due_at < ?").bind(cutoff),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_failures WHERE first_at < ?').bind(now - 24 * 60 * 60 * 1000),
  ]);
}
