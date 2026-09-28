// 資料庫結構。每次 Worker 啟動時確認資料表存在，不需要另外跑 migration。

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT UNIQUE NOT NULL,
    line_display_name TEXT,
    name TEXT,
    aliases TEXT NOT NULL DEFAULT '',
    is_self INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    contact_id INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    claimed_at INTEGER,
    sent_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders(status, due_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_failures (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    first_at INTEGER NOT NULL
  )`,
  // AI 生成的圖片（JPEG），以難以猜測的 key 公開給 LINE 下載
  `CREATE TABLE IF NOT EXISTS images (
    key TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    mime TEXT NOT NULL,
    prompt TEXT,
    created_at INTEGER NOT NULL
  )`,
];

// 舊資料表補欄位：reminders.image_key（有值代表這是一張圖片賀卡）
async function migrate(db) {
  const { results } = await db.prepare('PRAGMA table_info(reminders)').all();
  if (!results.some((c) => c.name === 'image_key')) {
    await db
      .prepare('ALTER TABLE reminders ADD COLUMN image_key TEXT')
      .run()
      .catch((err) => {
        // 另一個程序剛好同時加過了
        if (!/duplicate column/i.test(err.message)) throw err;
      });
  }
}

let schemaReady = null;

export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => migrate(db))
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

export function contactToJson(row) {
  return {
    id: row.id,
    name: row.name,
    lineDisplayName: row.line_display_name,
    aliases: row.aliases ? row.aliases.split(',').filter(Boolean) : [],
    isSelf: !!row.is_self,
    blocked: !!row.blocked,
    createdAt: row.created_at,
  };
}

export function reminderToJson(row) {
  return {
    id: row.id,
    message: row.message,
    contactId: row.contact_id,
    contactName: row.contact_name ?? null,
    contactIsSelf: !!row.contact_is_self,
    dueAt: row.due_at,
    status: row.status,
    lastError: row.last_error,
    imageUrl: row.image_key ? `/img/${row.image_key}.jpg` : null,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}
