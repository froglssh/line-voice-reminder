// 語音對話：向 Google 申請一次性的短效通行證（ephemeral token），並處理 AI 呼叫的工具（建立／查詢／取消提醒）。
// 正式的 GEMINI_API_KEY 只留在伺服器，瀏覽器只拿到 30 分鐘內有效、只能用一次、設定被鎖定的通行證。

import { insertReminder } from './reminders.js';
import { generateImage, imageExists } from './images.js';

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 台灣沒有日光節約時間，固定 UTC+8
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DEFAULT_MODEL = 'gemini-3.8-live';
const DEFAULT_VOICE = 'Kore';

// ---------- 台灣時間工具 ----------

function taipei(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function formatTaipei(ms) {
  const t = taipei(ms);
  return `${t.y}-${pad(t.m)}-${pad(t.d)}（星期${WEEKDAYS[t.wd]}）${pad(t.h)}:${pad(t.min)}`;
}

// "2026-10-07 10:00"（台灣時間）→ 毫秒；格式錯誤回傳 NaN
export function parseTaipei(text) {
  const m = String(text ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  const [, y, mo, d, h, min] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) return NaN;
  const ms = Date.UTC(y, mo - 1, d, h, min) - TZ_OFFSET_MS;
  // 擋掉 2 月 30 日這類不存在的日期
  return taipei(ms).d === d ? ms : NaN;
}

// 給 AI 看的日曆：未來三週每天的日期與「今天／明天／本週三／下週三」等說法，避免 AI 算錯日期
export function calendarHint(now) {
  const today = taipei(now);
  const mondayOffset = (today.wd + 6) % 7; // 距離本週一幾天（週一為一週的第一天）
  const lines = [];
  for (let i = 0; i < 21; i++) {
    const t = taipei(now + i * 86400000);
    const week = Math.floor((mondayOffset + i) / 7); // 0 = 本週，1 = 下週，2 = 下下週
    const labels = [];
    if (i === 0) labels.push('今天');
    if (i === 1) labels.push('明天');
    if (i === 2) labels.push('後天');
    if (week <= 2) labels.push(`${['本週', '下週', '下下週'][week]}${WEEKDAYS[t.wd]}`);
    lines.push(`${t.y}-${pad(t.m)}-${pad(t.d)} 星期${WEEKDAYS[t.wd]}${labels.length ? `：${labels.join('、')}` : ''}`);
  }
  return lines.join('\n');
}

// ---------- 聯絡人比對 ----------

const normalize = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

function contactNames(c) {
  return [c.name, c.line_display_name, ...(c.aliases ? c.aliases.split(',') : [])].filter(Boolean);
}

export function findContact(contacts, recipient, ownerName) {
  const want = normalize(recipient);
  if (!want) return null;
  const selfWords = ['我', '自己', '我自己', normalize(ownerName)];
  if (selfWords.includes(want)) return contacts.find((c) => c.is_self) ?? null;
  return contacts.find((c) => contactNames(c).some((n) => normalize(n) === want)) ?? null;
}

function describeContacts(contacts, ownerName) {
  const usable = contacts.filter((c) => !c.blocked);
  if (!usable.length) return '（目前還沒有任何聯絡人，請告訴使用者先到「聯絡人」頁面邀請好友）';
  return usable
    .map((c) => {
      const main = c.is_self ? `我（${ownerName}本人）` : c.name || c.line_display_name;
      const others = contactNames(c).filter((n) => n !== main && n !== c.name);
      return `- ${main}${others.length ? `（也可以叫：${others.join('、')}）` : ''}`;
    })
    .join('\n');
}

// ---------- 給 AI 的指示 ----------

function systemInstruction(ownerName, contacts, now) {
  return `你是「${ownerName}」的個人語音提醒助理，工作是幫他建立 LINE 提醒，也可以用 AI 畫圖片賀卡並定時傳給親友。
請一律用台灣的繁體中文口語回答，語氣親切、簡短，每次回答盡量不超過兩句話。

【開場】
對話一開始，請只說：「嗨，${ownerName}，有什麼我可以幫忙的？」

【現在時間】
現在是台灣時間 ${formatTaipei(now)}。
日期對照表（一週從星期一開始；「這週／本週」指本週，「下週」指下一週）：
${calendarHint(now)}

【可以提醒的對象】
${describeContacts(contacts, ownerName)}
如果使用者說「提醒我」，對象就是「我」。
如果使用者說的人不在名單上，請告訴他這個人還沒加入提醒小幫手的 LINE 好友，並問他要不要改成提醒自己。

【建立提醒的流程】
1. 弄清楚三件事：提醒內容、時間、提醒誰。
2. 缺少資訊就追問，不要自己猜。例如只說「明天」沒說幾點，要問幾點；說「八點」但分不出早上或晚上，要問清楚。
3. 時間已經過去的話，請告訴使用者並請他重新說一個時間。
4. 確認：建立之前，一定要把「日期（含星期幾）、時間、提醒誰、提醒內容」完整念一次，然後問「對嗎？」。
5. 只有在使用者明確同意（例如：對、沒錯、好、可以）之後，才呼叫 create_reminder。使用者要修改，就修改後再確認一次。
6. 相對時間（例如「一個小時後」「30 分鐘後」）請用 in_minutes；其他時間請用 due_at，格式為「YYYY-MM-DD HH:mm」（台灣時間、24 小時制）。
7. 建立成功後，簡短告訴使用者已經建立好，並問還有沒有其他要提醒的。建立失敗就說明原因。

【圖片賀卡】
使用者請你「做一張圖／賀卡」並在某個時間傳給某人時，照這個流程：
1. 弄清楚：圖片要畫什麼、傳給誰、什麼時候傳。圖片形狀預設「直式」，使用者說要方形或橫式才改。
2. 先說「好，我來畫，大約需要十幾秒，請稍等」，然後呼叫 create_card_image。
   prompt 請寫成詳細的畫面描述（主題、構圖、風格、色調、氣氛）。如果圖上要有文字，請用繁體中文，並用「」標明確切文字，文字盡量簡短。
3. 圖片完成後會顯示在使用者的畫面上。請說「圖片好了，請看一下畫面，滿意嗎？要重做或修改哪裡嗎？」
4. 使用者要重做或修改，就依照他的意思調整 prompt，再呼叫一次 create_card_image（每次都會產生新圖片）。
5. 使用者滿意後，幫他擬一句要跟圖片一起傳出的祝福文字（一兩句，例如「中秋節快樂！祝闔家團圓、平安喜樂」），念給他聽並確認，可以依他的意思修改。
6. 最後把「日期（含星期幾）、時間、傳給誰、祝福文字」完整念一次，問「對嗎？」。使用者同意後，才呼叫 schedule_card，image_id 用最後一張他滿意的圖片。
7. 如果日期已經過了（例如今年的節日已過），要提醒使用者並問是不是明年。

【其他功能】
- 使用者想知道有哪些提醒（含圖片賀卡），呼叫 list_reminders。
- 使用者想取消提醒，先呼叫 list_reminders 找到是哪一則，念給他確認後，再呼叫 cancel_reminder。

【提醒內容的寫法】
message 要寫成收到的人一看就懂的短句，例如「去繳信用卡卡費」「去蝦皮店到店取貨」，不要包含時間和對象。`;
}

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'create_reminder',
        description: '在使用者口頭確認後，建立一則定時 LINE 提醒。',
        parameters: {
          type: 'OBJECT',
          properties: {
            message: { type: 'STRING', description: '提醒內容，例如「去繳信用卡卡費」' },
            recipient: { type: 'STRING', description: '提醒誰：「我」或名單上的名字' },
            due_at: { type: 'STRING', description: '提醒時間，台灣時間，格式 YYYY-MM-DD HH:mm。使用 in_minutes 時可省略' },
            in_minutes: { type: 'INTEGER', description: '幾分鐘後提醒，用於「一個小時後」這類相對時間' },
          },
          required: ['message', 'recipient'],
        },
      },
      {
        name: 'create_card_image',
        description: '用 AI 畫一張圖片（賀卡），完成後會顯示在使用者畫面上。每次呼叫都會產生一張新圖片。',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: { type: 'STRING', description: '詳細的畫面描述；圖上文字用繁體中文並以「」標明' },
            shape: { type: 'STRING', enum: ['portrait', 'square', 'landscape'], description: '直式 portrait（預設）、方形 square、橫式 landscape' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'schedule_card',
        description: '在使用者確認圖片、祝福文字、時間與對象後，排定時間把圖片賀卡傳到對方 LINE。',
        parameters: {
          type: 'OBJECT',
          properties: {
            image_id: { type: 'STRING', description: 'create_card_image 回傳的 image_id' },
            recipient: { type: 'STRING', description: '傳給誰：「我」或名單上的名字' },
            greeting: { type: 'STRING', description: '跟圖片一起傳的祝福文字' },
            due_at: { type: 'STRING', description: '傳送時間，台灣時間，格式 YYYY-MM-DD HH:mm。使用 in_minutes 時可省略' },
            in_minutes: { type: 'INTEGER', description: '幾分鐘後傳送' },
          },
          required: ['image_id', 'recipient', 'greeting'],
        },
      },
      {
        name: 'list_reminders',
        description: '列出所有還沒送出的提醒與圖片賀卡。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'cancel_reminder',
        description: '取消一則還沒送出的提醒或圖片賀卡。',
        parameters: {
          type: 'OBJECT',
          properties: { reminder_id: { type: 'INTEGER', description: 'list_reminders 回傳的提醒編號' } },
          required: ['reminder_id'],
        },
      },
    ],
  },
];

// ---------- API ----------

async function loadContacts(env) {
  const { results } = await env.DB.prepare('SELECT * FROM contacts ORDER BY is_self DESC, created_at ASC').all();
  return results;
}

export async function createVoiceSession(env) {
  if (!env.GEMINI_API_KEY) {
    return { status: 503, body: { error: '尚未設定 Gemini 金鑰（GEMINI_API_KEY），請參考設定教學第 6 步' } };
  }
  const now = Date.now();
  const ownerName = env.OWNER_NAME || 'froglssh';
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const contacts = await loadContacts(env);

  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_VOICE || DEFAULT_VOICE } } },
    },
    systemInstruction: { role: 'user', parts: [{ text: systemInstruction(ownerName, contacts, now) }] },
    tools: TOOLS,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  const base = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
  let res;
  try {
    res = await fetch(`${base}/v1alpha/auth_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
        bidiGenerateContentSetup: setup,
      }),
    });
  } catch (err) {
    return { status: 502, body: { error: `連不上 Google：${err.message}` } };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.name) {
    const detail = data.error?.message || `HTTP ${res.status}`;
    const reason =
      res.status === 400 && /api key/i.test(detail)
        ? 'Gemini 金鑰不正確'
        : res.status === 403
          ? 'Gemini 金鑰沒有權限'
          : res.status === 429
            ? 'Gemini 免費額度暫時用完了，請稍後再試'
            : `Gemini 連線失敗：${detail}`;
    console.error('auth_tokens failed', res.status, detail);
    return { status: 502, body: { error: reason } };
  }

  return {
    status: 200,
    body: {
      token: data.name,
      model: setup.model,
      wsUrl:
        env.GEMINI_WS_URL ||
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
    },
  };
}

export async function runVoiceTool(env, name, args, now = Date.now()) {
  const ownerName = env.OWNER_NAME || 'froglssh';

  if (name === 'create_reminder' || name === 'schedule_card') {
    const contacts = await loadContacts(env);
    const contact = findContact(contacts, args.recipient, ownerName);
    if (!contact) {
      const names = contacts.filter((c) => !c.blocked).map((c) => (c.is_self ? '我' : c.name || c.line_display_name));
      return { ok: false, error: `名單上找不到「${args.recipient}」。目前可以傳送的對象：${names.join('、') || '（沒有）'}` };
    }
    const minutes = Number(args.in_minutes);
    const dueAt = Number.isFinite(minutes) && minutes > 0 ? now + minutes * 60 * 1000 : parseTaipei(args.due_at);
    if (!Number.isFinite(dueAt)) return { ok: false, error: '時間格式不正確，請用 YYYY-MM-DD HH:mm 或 in_minutes' };

    let imageKey = null;
    if (name === 'schedule_card') {
      imageKey = String(args.image_id ?? '');
      if (!(await imageExists(env, imageKey))) return { ok: false, error: '找不到這張圖片，請重新畫一張' };
    }
    const message = name === 'schedule_card' ? args.greeting : args.message;
    const result = await insertReminder(env, { message, contactId: contact.id, dueAt, imageKey });
    if (result.error) return { ok: false, error: result.error };
    const r = result.reminder;
    return {
      ok: true,
      reminder: { id: r.id, message: r.message, recipient: r.contactIsSelf ? '我' : r.contactName, due: formatTaipei(r.dueAt), imageUrl: r.imageUrl },
    };
  }

  if (name === 'create_card_image') {
    const result = await generateImage(env, { prompt: args.prompt, shape: args.shape }, now);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, image_id: result.key, image_url: result.url, note: '圖片已顯示在使用者畫面上' };
  }

  if (name === 'list_reminders') {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.message, r.due_at, r.image_key, c.is_self, COALESCE(c.name, c.line_display_name) AS who
       FROM reminders r LEFT JOIN contacts c ON c.id = r.contact_id
       WHERE r.status IN ('pending', 'card') ORDER BY r.due_at LIMIT 30`,
    ).all();
    return {
      ok: true,
      reminders: results.map((r) => ({
        id: r.id,
        type: r.image_key ? '圖片賀卡' : '文字提醒',
        message: r.message,
        recipient: r.is_self ? '我' : r.who,
        due: formatTaipei(r.due_at),
      })),
    };
  }

  if (name === 'cancel_reminder') {
    const res = await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND status IN ('pending', 'card')")
      .bind(Number(args.reminder_id))
      .run();
    return res.meta.changes ? { ok: true } : { ok: false, error: '找不到這則提醒，可能已經送出或刪除了' };
  }

  return { ok: false, error: `不認得的功能：${name}` };
}
