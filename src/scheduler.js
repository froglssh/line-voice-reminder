// 每分鐘執行一次：送出到期的提醒（文字提醒與圖片賀卡）、重試暫時失敗的、清除過期資料。
// 狀態：pending＝等待中的文字提醒、card＝等待中的圖片賀卡、sending＝傳送中、sent＝已送出、failed＝失敗

import { pushMessages, pushText } from './line.js';
import { cleanupImagesStatement } from './images.js';

const MAX_ATTEMPTS = 3;
const STUCK_MS = 5 * 60 * 1000;
const CARD_LATE_MS = 6 * 60 * 60 * 1000; // 賀卡超過 6 小時沒送出就不補送，避免節日過了才收到

const waitingStatus = (reminder) => (reminder.image_key ? 'card' : 'pending');

export function formatMessage(env, reminder, contact) {
  const text = `⏰ 提醒：${reminder.message}`;
  return contact.is_self ? text : `${text}\n—— 來自 ${env.OWNER_NAME || 'froglssh'}`;
}

export function buildMessages(env, reminder, contact, baseUrl) {
  if (!reminder.image_key) return [{ type: 'text', text: formatMessage(env, reminder, contact) }];
  const url = `${baseUrl}/img/${reminder.image_key}.jpg`;
  const greeting = contact.is_self
    ? reminder.message
    : `${reminder.message}\n—— 來自 ${env.OWNER_NAME || 'froglssh'}`;
  return [
    { type: 'image', originalContentUrl: url, previewContentUrl: url },
    { type: 'text', text: greeting },
  ];
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
  const what = reminder.image_key ? '圖片賀卡' : '提醒';
  await pushText(env, self.line_user_id, `⚠️ 給 ${who} 的${what}沒送出去：「${reminder.message}」\n原因：${reason}`);
}

// 送出一則已「認領」（status = sending）的提醒，並更新狀態
export async function deliver(env, reminder, baseUrl, now = Date.now()) {
  const db = env.DB;
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').bind(reminder.contact_id).first();
  if (!contact) return markFailed(env, reminder, '收件人已不存在', null);
  if (contact.blocked) return markFailed(env, reminder, '對方已封鎖提醒小幫手', contact);
  if (reminder.image_key && reminder.due_at < now - CARD_LATE_MS) {
    return markFailed(env, reminder, '錯過傳送時間超過 6 小時，已取消傳送', contact);
  }

  const result = await pushMessages(env, contact.line_user_id, buildMessages(env, reminder, contact, baseUrl));
  if (result.ok) {
    await db.prepare("UPDATE reminders SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
      .bind(Date.now(), reminder.id)
      .run();
  } else if (!result.permanent && reminder.attempts < MAX_ATTEMPTS) {
    await db.prepare('UPDATE reminders SET status = ?, last_error = ? WHERE id = ?')
      .bind(waitingStatus(reminder), result.reason, reminder.id)
      .run();
  } else {
    await markFailed(env, reminder, result.reason, contact);
  }
}

export async function sendDueReminders(env, now = Date.now()) {
  const db = env.DB;
  await db.prepare(
    `UPDATE reminders SET status = CASE WHEN image_key IS NULL THEN 'pending' ELSE 'card' END
     WHERE status = 'sending' AND claimed_at < ?`,
  )
    .bind(now - STUCK_MS)
    .run();

  // 先把要送的提醒「認領」起來，避免兩次排程重複傳送
  const { results: due } = await db
    .prepare(
      `UPDATE reminders SET status = 'sending', attempts = attempts + 1, claimed_at = ?
       WHERE id IN (SELECT id FROM reminders WHERE status IN ('pending', 'card') AND due_at <= ? ORDER BY due_at LIMIT 50)
       RETURNING *`,
    )
    .bind(now, now)
    .all();

  const baseUrl = env.PUBLIC_BASE_URL || '';
  for (const reminder of due) await deliver(env, reminder, baseUrl, now);
  return due.length;
}

// 「現在送出」：不等排程，立刻傳送一則等待中的提醒
export async function sendNow(env, id, baseUrl) {
  const reminder = await env.DB.prepare(
    `UPDATE reminders SET status = 'sending', attempts = attempts + 1, claimed_at = ?
     WHERE id = ? AND status IN ('pending', 'card', 'failed') RETURNING *`,
  )
    .bind(Date.now(), id)
    .first();
  if (!reminder) return null;
  // 手動送出不受「錯過 6 小時」限制
  await deliver(env, { ...reminder, due_at: Date.now() }, baseUrl);
  return env.DB.prepare('SELECT status, last_error FROM reminders WHERE id = ?').bind(id).first();
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
    cleanupImagesStatement(env, now),
  ]);
}
