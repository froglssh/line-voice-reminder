// 程式進入點：處理網頁 API、LINE webhook，以及每分鐘的排程。

import qrcode from 'qrcode-generator';
import { ensureSchema, contactToJson, reminderToJson } from './db.js';
import { isLoggedIn, login, logout } from './auth.js';
import { handleWebhook, getBotInfo } from './line.js';
import { sendDueReminders, sendNow, cleanup } from './scheduler.js';
import { serveImage } from './images.js';
import { insertReminder } from './reminders.js';
import { createVoiceSession, runVoiceTool } from './voice.js';

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
  const result = await insertReminder(env, {
    message: body.message,
    contactId: Number(body.contactId),
    dueAt: Number(body.dueAt),
  });
  return result.error ? json({ error: result.error }, 400) : json(result.reminder, 201);
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
    return json({ ownerName: env.OWNER_NAME || 'froglssh', lineReady: !!env.LINE_CHANNEL_ACCESS_TOKEN });
  }

  if (pathname === '/api/reminders' && method === 'GET') return json(await listReminders(env));
  if (pathname === '/api/reminders' && method === 'POST') return createReminder(env, await readJson(request));

  const sendMatch = pathname.match(/^\/api\/reminders\/(\d+)\/send$/);
  if (sendMatch && method === 'POST') {
    const result = await sendNow(env, Number(sendMatch[1]), url.origin);
    if (!result) return json({ error: '這則提醒正在傳送中或已不存在' }, 409);
    return result.status === 'sent' ? json({ ok: true }) : json({ error: result.last_error || '傳送失敗' }, 502);
  }

  const reminderMatch = pathname.match(/^\/api\/reminders\/(\d+)$/);
  if (reminderMatch && method === 'DELETE') {
    // 正在傳送中的提醒不能刪，其他狀態都可以
    const res = await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND status != 'sending'")
      .bind(Number(reminderMatch[1]))
      .run();
    return res.meta.changes ? json({ ok: true }) : json({ error: '這則提醒正在傳送中或已不存在' }, 409);
  }

  if (pathname === '/api/voice/session' && method === 'POST') {
    const result = await createVoiceSession(env);
    return json(result.body, result.status);
  }
  if (pathname === '/api/voice/tool' && method === 'POST') {
    const body = await readJson(request);
    return json(await runVoiceTool(env, String(body.name || ''), body.args || {}));
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
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/line/') || url.pathname.startsWith('/img/')) {
        await ensureSchema(env.DB);
      }
      if (url.pathname === '/line/webhook' && request.method === 'POST') return handleWebhook(request, env);
      const img = url.pathname.match(/^\/img\/([0-9a-f]{32})\.jpg$/);
      if (img && request.method === 'GET') return serveImage(env, img[1]);
      if (url.pathname.startsWith('/img/')) return new Response('not found', { status: 404 });
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
