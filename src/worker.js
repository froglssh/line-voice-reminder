// 程式進入點：處理網頁 API、LINE webhook，以及每分鐘的排程。

import qrcode from 'qrcode-generator';
import { ensureSchema, contactToJson, reminderToJson } from './db.js';
import { isLoggedIn, login, logout } from './auth.js';
import { handleWebhook, getBotInfo } from './line.js';
import { sendDueReminders, cleanup } from './scheduler.js';

const MAX_MESSAGE_LENGTH = 500;
const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function listReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, COALESCE(c.name, c.line_display_name) AS contact_name, c.is_self AS contact_is_self
     FROM reminders r LEFT JOIN contacts c ON c.id = r.contact_id
     ORDER BY r.due_at ASC`,
  ).all();
  return results.map(reminderToJson);
}

async function createReminder(env, body) {
  const message = String(body.message ?? '').trim();
  const contactId = Number(body.contactId);
  const dueAt = Number(body.dueAt);
  const now = Date.now();

  if (!message) return json({ error: '請填寫提醒內容' }, 400);
  if (message.length > MAX_MESSAGE_LENGTH) return json({ error: `提醒內容請少於 ${MAX_MESSAGE_LENGTH} 字` }, 400);
  if (!Number.isFinite(dueAt)) return json({ error: '提醒時間格式不正確' }, 400);
  if (dueAt < now - 60 * 1000) return json({ error: '提醒時間已經過了，請選擇未來的時間' }, 400);
  if (dueAt > now + MAX_FUTURE_MS) return json({ error: '提醒時間太遠了（最多 5 年內）' }, 400);

  const contact = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first();
  if (!contact) return json({ error: '找不到這位收件人' }, 400);
  if (contact.blocked) return json({ error: '這位收件人已封鎖提醒小幫手，無法傳送' }, 400);

  const row = await env.DB.prepare(
    'INSERT INTO reminders (message, contact_id, due_at, created_at) VALUES (?, ?, ?, ?) RETURNING *',
  )
    .bind(message, contactId, Math.round(dueAt), now)
    .first();
  row.contact_name = contact.name || contact.line_display_name;
  row.contact_is_self = contact.is_self;
  return json(reminderToJson(row), 201);
}

async function updateContact(env, id, body) {
  const contact = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  if (!contact) return json({ error: '找不到這位聯絡人' }, 404);

  const name = body.name === undefined ? contact.name : String(body.name).trim().slice(0, 30) || null;
  const aliases =
    body.aliases === undefined
      ? contact.aliases
      : [].concat(body.aliases).map((a) => String(a).trim().slice(0, 30)).filter(Boolean).join(',');
  const isSelf = body.isSelf === undefined ? contact.is_self : body.isSelf ? 1 : 0;

  const stmts = [];
  if (isSelf) stmts.push(env.DB.prepare('UPDATE contacts SET is_self = 0 WHERE id != ?').bind(id));
  stmts.push(
    env.DB.prepare('UPDATE contacts SET name = ?, aliases = ?, is_self = ? WHERE id = ?').bind(name, aliases, isSelf, id),
  );
  await env.DB.batch(stmts);
  const row = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  return json(contactToJson(row));
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/login' && method === 'POST') {
    const result = await login(request, env);
    return json(result.body, result.status, result.cookie ? { 'Set-Cookie': result.cookie } : {});
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': await logout(request, env) });
  }

  if (!(await isLoggedIn(request, env))) return json({ error: '請先登入' }, 401);

  if (pathname === '/api/me' && method === 'GET') {
    return json({ ownerName: env.OWNER_NAME || 'Papaya', lineReady: !!env.LINE_CHANNEL_ACCESS_TOKEN });
  }

  if (pathname === '/api/reminders' && method === 'GET') return json(await listReminders(env));
  if (pathname === '/api/reminders' && method === 'POST') return createReminder(env, await readJson(request));

  const reminderMatch = pathname.match(/^\/api\/reminders\/(\d+)$/);
  if (reminderMatch && method === 'DELETE') {
    // 正在傳送中的提醒不能刪，其他狀態都可以
    const res = await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND status != 'sending'")
      .bind(Number(reminderMatch[1]))
      .run();
    return res.meta.changes ? json({ ok: true }) : json({ error: '這則提醒正在傳送中或已不存在' }, 409);
  }

  if (pathname === '/api/contacts' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM contacts ORDER BY is_self DESC, created_at ASC').all();
    return json(results.map(contactToJson));
  }
  const contactMatch = pathname.match(/^\/api\/contacts\/(\d+)$/);
  if (contactMatch && method === 'PATCH') {
    return updateContact(env, Number(contactMatch[1]), await readJson(request));
  }

  if (pathname === '/api/invite' && method === 'GET') {
    const info = await getBotInfo(env);
    if (!info?.basicId) return json({ error: 'LINE 官方帳號尚未連接' }, 503);
    const link = `https://line.me/R/ti/p/${encodeURIComponent(info.basicId)}`;
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    return json({
      link,
      botName: info.displayName,
      pictureUrl: info.pictureUrl ?? null,
      qrSvg: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }),
    });
  }

  return json({ error: '找不到這個功能' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/line/')) {
        await ensureSchema(env.DB);
      }
      if (url.pathname === '/line/webhook' && request.method === 'POST') return handleWebhook(request, env);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: '系統發生錯誤，請稍後再試' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    const now = event.scheduledTime || Date.now();
    await sendDueReminders(env, now);
    ctx.waitUntil(cleanup(env, now));
  },
};
