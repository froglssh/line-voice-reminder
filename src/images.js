// AI 圖片：用 OpenAI（ChatGPT Images）生成賀卡圖片，存進資料庫，並提供公開網址讓 LINE 下載。

const DEFAULT_MODEL = 'gpt-image-2.5-flare';
const DEFAULT_DAILY_LIMIT = 20;
const MAX_BYTES = 1.9 * 1024 * 1024; // 資料庫單筆上限約 2MB

export const SHAPES = {
  portrait: '1024x1536',
  square: '1024x1024',
  landscape: '1536x1024',
};

function randomKey() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 回傳 { key, url } 或 { error }
export async function generateImage(env, { prompt, shape }, now = Date.now()) {
  if (!env.OPENAI_API_KEY) return { error: '尚未設定 OpenAI 金鑰（OPENAI_API_KEY）' };
  const text = String(prompt ?? '').trim();
  if (!text) return { error: '請描述想要的圖片' };

  const limit = Number(env.IMAGE_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM images WHERE created_at > ?')
    .bind(now - 24 * 60 * 60 * 1000)
    .first();
  if (n >= limit) return { error: `今天已經做了 ${n} 張圖，達到每日上限（${limit} 張），明天再試` };

  const base = env.OPENAI_API_BASE || 'https://api.openai.com';
  let res;
  try {
    res = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL,
        prompt: text,
        size: SHAPES[shape] || SHAPES.portrait,
        quality: env.OPENAI_IMAGE_QUALITY || 'medium',
        output_format: 'jpeg',
        output_compression: 85,
        n: 1,
      }),
    });
  } catch (err) {
    return { error: `連不上 OpenAI：${err.message}` };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error?.message || `HTTP ${res.status}`;
    console.error('openai image failed', res.status, detail);
    if (res.status === 401) return { error: 'OpenAI 金鑰不正確' };
    if (res.status === 429 || /quota|billing|credit/i.test(detail)) {
      return { error: 'OpenAI 帳戶餘額不足或達到使用上限，請到 OpenAI 儲值或調高上限' };
    }
    if (/safety|moderation|content policy/i.test(detail)) return { error: '這個圖片描述被 OpenAI 的安全規則擋下，請換個說法' };
    return { error: `OpenAI 生成失敗：${detail}` };
  }

  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return { error: 'OpenAI 沒有回傳圖片' };
  const bytes = base64ToBytes(b64);
  if (bytes.length > MAX_BYTES) return { error: '圖片檔案太大，請重做一次' };

  const key = randomKey();
  await env.DB.prepare('INSERT INTO images (key, data, mime, prompt, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(key, bytes, 'image/jpeg', text, now)
    .run();
  return { key, url: `/img/${key}.jpg` };
}

export async function serveImage(env, key) {
  if (!/^[0-9a-f]{32}$/.test(key)) return new Response('not found', { status: 404 });
  const row = await env.DB.prepare('SELECT data, mime FROM images WHERE key = ?').bind(key).first();
  if (!row) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(row.data), {
    headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=86400' },
  });
}

export async function imageExists(env, key) {
  return !!(await env.DB.prepare('SELECT 1 AS ok FROM images WHERE key = ?').bind(String(key ?? '')).first());
}

// 沒有被任何提醒使用、超過一天的草稿圖片，以及提醒已刪除後留下的圖片
export function cleanupImagesStatement(env, now) {
  return env.DB.prepare(
    `DELETE FROM images WHERE created_at < ?
     AND key NOT IN (SELECT image_key FROM reminders WHERE image_key IS NOT NULL)`,
  ).bind(now - 24 * 60 * 60 * 1000);
}
