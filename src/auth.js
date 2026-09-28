// 單一使用者登入：密碼存在 Cloudflare Secret（APP_PASSWORD），登入後發一個 30 天的 session cookie。

const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const COOKIE = 'sid';

const enc = new TextEncoder();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 先各自雜湊再比較，避免因字串長度不同而洩漏資訊
async function passwordMatches(input, expected) {
  const [a, b] = await Promise.all([sha256Hex(String(input)), sha256Hex(String(expected))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookieHeader(value, maxAgeSeconds) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export async function isLoggedIn(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .first();
  return !!row && row.expires_at > Date.now();
}

export async function login(request, env) {
  if (!env.APP_PASSWORD) {
    return { status: 500, body: { error: '尚未設定登入密碼（APP_PASSWORD）' } };
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const lockMs = LOCK_MINUTES * 60 * 1000;

  const fail = await env.DB.prepare('SELECT count, first_at FROM login_failures WHERE ip = ?').bind(ip).first();
  if (fail && fail.count >= MAX_FAILURES && now - fail.first_at < lockMs) {
    const wait = Math.ceil((lockMs - (now - fail.first_at)) / 60000);
    return { status: 429, body: { error: `密碼錯誤太多次，請 ${wait} 分鐘後再試` } };
  }

  let password = '';
  try {
    password = (await request.json()).password ?? '';
  } catch {}

  if (!(await passwordMatches(password, env.APP_PASSWORD))) {
    if (!fail || now - fail.first_at >= lockMs) {
      await env.DB.prepare('INSERT OR REPLACE INTO login_failures (ip, count, first_at) VALUES (?, 1, ?)')
        .bind(ip, now)
        .run();
    } else {
      await env.DB.prepare('UPDATE login_failures SET count = count + 1 WHERE ip = ?').bind(ip).run();
    }
    return { status: 401, body: { error: '密碼錯誤' } };
  }

  const token = randomToken();
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip),
    env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(
      await sha256Hex(token),
      now + maxAge * 1000,
    ),
  ]);
  return { status: 200, body: { ok: true }, cookie: cookieHeader(token, maxAge) };
}

export async function logout(request, env) {
  const token = readCookie(request, COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return cookieHeader('', 0);
}
