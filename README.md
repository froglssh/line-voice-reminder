# 提醒小幫手（LINE Voice Reminder）

用說的建立提醒，時間到自動傳到自己或家人的 LINE。只給 froglssh 一個人使用。

- 📋 [計劃書](docs/計劃書.md)：功能清單與測試方法
- 🛠️ [設定教學](docs/設定教學.md)：申請帳號、讓網站上線的逐步說明

## 進度

- [x] 第 1 階段：網頁外觀、登入、提醒清單（打字新增）
- [x] 第 2 階段：雲端排程、LINE 發送、聯絡人與邀請 QR Code
- [ ] 第 3 階段：Gemini 3.8 Live 語音對話
- [ ] 第 4 階段：整體打磨

## 給維護者

- Cloudflare Workers（`src/`）＋ 靜態網頁（`public/`）＋ D1 資料庫，設定見 `wrangler.jsonc`。
- 需要的 Secrets：`APP_PASSWORD`、`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`（第 3 階段加上 `GEMINI_API_KEY`）。
- 本機開發：`npm install`，建立 `.dev.vars` 放上述 Secrets，再執行 `npm run dev -- --test-scheduled`；
  用 `curl "localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"` 手動觸發排程。
- 重新產生圖示：`NODE_PATH=$(npm root -g) node scripts/make-icons.mjs`（讀取根目錄的 `icon.png`）。
