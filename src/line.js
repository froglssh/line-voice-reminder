// LINE Messaging API：推播提醒、接收加好友／封鎖事件、取得官方帳號資訊。

const enc = new TextEncoder();

function base(env) {
  return env.LINE_API_BASE || 'https://api.line.me';
}

function authHeaders(env) {
  return {
    Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function verifySignature(env, rawBody, signature) {
  if (!env.LINE_CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.LINE_CHANNEL_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// 回傳 { ok: true } 或 { ok: false, permanent, reason }
export async function pushText(env, to, text) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, permanent: true, reason: '尚未設定 LINE 金鑰' };
  }
  let res;
  try {
    res = await fetch(`${base(env)}/v2/bot/message/push`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
  } catch (err) {
    return { ok: false, permanent: false, reason: `連不上 LINE：${err.message}` };
  }
  if (res.ok) return { ok: true };

  const detail = await res.text().catch(() => '');
  if (res.status === 429 && /monthly limit/i.test(detail)) {
    return { ok: false, permanent: true, reason: '本月 LINE 免費訊息額度已用完' };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, permanent: false, reason: `LINE 暫時忙碌（${res.status}）` };
  }
  if (res.status === 401) {
    return { ok: false, permanent: true, reason: 'LINE 金鑰錯誤或已失效' };
  }
  return { ok: false, permanent: true, reason: `LINE 拒絕傳送（${res.status}）${detail.slice(0, 120)}` };
}

export async function replyText(env, replyToken, text) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !replyToken) return;
  await fetch(`${base(env)}/v2/bot/message/reply`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  }).catch(() => {});
}

export async function getProfile(env, userId) {
  const res = await fetch(`${base(env)}/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: authHeaders(env),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export async function getBotInfo(env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  const res = await fetch(`${base(env)}/v2/bot/info`, { headers: authHeaders(env) }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export async function handleWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifySignature(env, raw, request.headers.get('x-line-signature')))) {
    return new Response('bad signature', { status: 401 });
  }
  const { events = [] } = JSON.parse(raw || '{}');
  const now = Date.now();

  for (const ev of events) {
    const userId = ev.source?.type === 'user' ? ev.source.userId : null;
    if (!userId) continue;

    if (ev.type === 'follow') {
      const profile = await getProfile(env, userId);
      await env.DB.prepare(
        `INSERT INTO contacts (line_user_id, line_display_name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(line_user_id) DO UPDATE SET blocked = 0,
           line_display_name = COALESCE(excluded.line_display_name, line_display_name)`,
      )
        .bind(userId, profile?.displayName ?? null, now)
        .run();
      await replyText(
        env,
        ev.replyToken,
        `嗨${profile?.displayName ? ` ${profile.displayName}` : ''}！我是 ${env.OWNER_NAME || 'Papaya'} 的提醒小幫手，之後會在這裡傳提醒給你 ⏰`,
      );
    } else if (ev.type === 'unfollow') {
      await env.DB.prepare('UPDATE contacts SET blocked = 1 WHERE line_user_id = ?').bind(userId).run();
    } else if (ev.type === 'message') {
      await replyText(env, ev.replyToken, '我只負責傳送提醒，沒辦法回覆訊息喔 🙏');
    }
  }
  return new Response('ok');
}
