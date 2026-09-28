// 網頁畫面的主程式：登入、提醒清單、聯絡人、邀請 QR Code。

import { VoiceSession } from './voice.js';

const $ = (sel) => document.querySelector(sel);
const TZ = 'Asia/Taipei';

const state = {
  ownerName: 'froglssh',
  reminders: [],
  contacts: [],
};

// ---------- 小工具 ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error(data.error || '請先登入');
  }
  if (!res.ok) throw new Error(data.error || '發生錯誤');
  return data;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const dateFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TZ,
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatTime(ms) {
  return dateFmt.format(new Date(ms));
}

function contactLabel(c) {
  if (c.isSelf) return `我${c.name && c.name !== '我' ? `（${c.name}）` : ''}`;
  return c.name || c.lineDisplayName || '未命名';
}

// datetime-local 需要「本地時間」字串
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- 登入 ----------

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#password').focus();
}

async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await Promise.all([loadContacts(), loadReminders()]);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    const me = await api('/api/me');
    state.ownerName = me.ownerName;
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  voice?.stop();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------- 分頁 ----------

document.querySelectorAll('[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $('#tab-reminders').hidden = name !== 'reminders';
    $('#tab-contacts').hidden = name !== 'contacts';
    if (name === 'contacts') loadInvite();
  });
});

// ---------- 提醒 ----------

async function loadReminders() {
  state.reminders = await api('/api/reminders');
  renderReminders();
}

function reminderItem(r) {
  const who = r.contactIsSelf ? '我' : r.contactName || '（已刪除的聯絡人）';
  const badge = {
    pending: '<span class="badge pending">等待中</span>',
    sending: '<span class="badge pending">傳送中</span>',
    sent: '<span class="badge sent">已送出</span>',
    failed: '<span class="badge failed">傳送失敗</span>',
  }[r.status];
  const when = r.status === 'sent' ? `送出於 ${formatTime(r.sentAt)}` : formatTime(r.dueAt);
  const canDelete = r.status !== 'sending';
  return `
    <article class="reminder ${r.status}">
      <div class="reminder-main">
        <div class="reminder-msg">${escapeHtml(r.message)}</div>
        <div class="reminder-meta">${badge}<span>${escapeHtml(when)}</span><span>→ ${escapeHtml(who)}</span></div>
        ${r.status === 'failed' && r.lastError ? `<div class="reminder-error">${escapeHtml(r.lastError)}</div>` : ''}
        ${r.status === 'pending' && r.lastError ? `<div class="reminder-error">上次沒送成功，稍後自動重試：${escapeHtml(r.lastError)}</div>` : ''}
      </div>
      ${canDelete ? `<button class="icon-btn" data-delete="${r.id}" aria-label="刪除這則提醒" title="刪除">✕</button>` : ''}
    </article>`;
}

function renderReminders() {
  const groups = [
    { title: '等待中', items: state.reminders.filter((r) => r.status === 'pending' || r.status === 'sending') },
    { title: '傳送失敗', items: state.reminders.filter((r) => r.status === 'failed') },
    {
      title: '已送出（一週後自動刪除）',
      items: state.reminders.filter((r) => r.status === 'sent').sort((a, b) => b.sentAt - a.sentAt),
    },
  ];
  const html = groups
    .filter((g) => g.items.length)
    .map((g) => `<h2 class="section-title">${g.title}</h2><div class="list">${g.items.map(reminderItem).join('')}</div>`)
    .join('');
  $('#reminder-groups').innerHTML = html || '<p class="empty">目前沒有提醒。按上方的麥克風，說說看要提醒什麼吧！</p>';
}

$('#reminder-groups').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  const r = state.reminders.find((x) => x.id === Number(btn.dataset.delete));
  if (r?.status === 'pending' && !confirm(`確定要取消「${r.message}」這則提醒嗎？`)) return;
  try {
    await api(`/api/reminders/${btn.dataset.delete}`, { method: 'DELETE' });
    await loadReminders();
    toast('已刪除');
  } catch (err) {
    toast(err.message);
  }
});

$('#add-panel').addEventListener('toggle', () => {
  if ($('#add-panel').open && !$('#add-due').value) {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    $('#add-due').value = toLocalInput(d);
  }
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('#add-error').textContent = '';
  try {
    const created = await api('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        message: $('#add-message').value,
        contactId: Number($('#add-contact').value),
        dueAt: new Date($('#add-due').value).getTime(),
      }),
    });
    $('#add-message').value = '';
    $('#add-due').value = '';
    $('#add-panel').open = false;
    await loadReminders();
    toast(`已建立：${formatTime(created.dueAt)} 提醒${created.contactIsSelf ? '我' : created.contactName}`);
  } catch (err) {
    $('#add-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 聯絡人 ----------

async function loadContacts() {
  state.contacts = await api('/api/contacts');
  renderContactOptions();
  renderContacts();
}

function renderContactOptions() {
  const usable = state.contacts.filter((c) => !c.blocked);
  $('#add-contact').innerHTML = usable.length
    ? usable.map((c) => `<option value="${c.id}">${escapeHtml(contactLabel(c))}</option>`).join('')
    : '<option value="" disabled selected>請先到「聯絡人」邀請好友</option>';
}

function renderContacts() {
  const list = $('#contact-list');
  if (!state.contacts.length) {
    list.replaceChildren($('#empty-contacts').content.cloneNode(true));
    return;
  }
  list.innerHTML = `<div class="list">${state.contacts
    .map(
      (c) => `
      <form class="card contact" data-contact="${c.id}">
        <div class="contact-head">
          <strong>${escapeHtml(contactLabel(c))}</strong>
          ${c.blocked ? '<span class="badge failed">已封鎖</span>' : c.name || c.isSelf ? '' : '<span class="badge pending">請取名字</span>'}
        </div>
        <div class="contact-line">LINE 名稱：${escapeHtml(c.lineDisplayName || '（未知）')}</div>
        <div class="contact-fields">
          <label>稱呼（跟 AI 說的名字）
            <input name="name" value="${escapeHtml(c.name || '')}" placeholder="例如：小明" maxlength="30">
          </label>
          <label>其他叫法（用逗號分開）
            <input name="aliases" value="${escapeHtml(c.aliases.join('，'))}" placeholder="例如：明明，阿明">
          </label>
        </div>
        <div class="contact-foot">
          <label class="check"><input type="checkbox" name="isSelf" ${c.isSelf ? 'checked' : ''}> 這是我自己</label>
          <button class="btn soft small" type="submit">儲存</button>
        </div>
      </form>`,
    )
    .join('')}</div>`;
}

$('#contact-list').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('[data-contact]');
  const data = new FormData(form);
  try {
    await api(`/api/contacts/${form.dataset.contact}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: data.get('name'),
        aliases: String(data.get('aliases') || '').split(/[,，、]/),
        isSelf: data.get('isSelf') === 'on',
      }),
    });
    await Promise.all([loadContacts(), loadReminders()]);
    toast('已儲存');
  } catch (err) {
    toast(err.message);
  }
});

let inviteLoaded = false;
async function loadInvite() {
  loadContacts().catch(() => {});
  if (inviteLoaded) return;
  const box = $('#invite-body');
  try {
    const invite = await api('/api/invite');
    inviteLoaded = true;
    box.innerHTML = `
      <div class="qr">${invite.qrSvg}</div>
      <p class="muted">用 LINE 掃描，加入「${escapeHtml(invite.botName)}」</p>
      <div class="invite-actions">
        <button class="btn soft small" id="copy-invite">複製邀請連結</button>
        ${navigator.share ? '<button class="btn soft small" id="share-invite">分享給家人</button>' : ''}
      </div>`;
    const text = `請把「${invite.botName}」加為 LINE 好友，我之後會用它傳提醒給你：${invite.link}`;
    $('#copy-invite').addEventListener('click', async () => {
      await navigator.clipboard.writeText(invite.link);
      toast('已複製邀請連結');
    });
    $('#share-invite')?.addEventListener('click', () => navigator.share({ text }).catch(() => {}));
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

// ---------- 麥克風與語音對話 ----------

let voice = null;

function setMicState(stateName, text) {
  const mic = $('#mic');
  mic.dataset.state = stateName;
  mic.setAttribute('aria-pressed', String(stateName !== 'idle'));
  mic.setAttribute('aria-label', stateName === 'idle' ? '開始語音對話' : '結束語音對話');
  $('#mic-status').textContent = text;
  if (stateName === 'idle') {
    voice = null;
    $('#caption').textContent = '';
  }
}

$('#mic').addEventListener('click', () => {
  if (voice) {
    voice.stop();
    return;
  }
  voice = new VoiceSession({
    onState: setMicState,
    onCaption: (who, text) => {
      const el = $('#caption');
      el.dataset.who = who;
      el.textContent = text;
    },
    onReminderChange: async (name, result) => {
      await loadReminders().catch(() => {});
      if (name === 'create_reminder' && result.reminder) {
        toast(`已建立：${result.reminder.due} 提醒${result.reminder.recipient}`);
      }
      if (name === 'cancel_reminder') toast('已取消提醒');
    },
    onError: (message) => toast(message),
  });
  voice.start();
});

// ---------- 啟動 ----------

async function start() {
  try {
    const me = await api('/api/me');
    state.ownerName = me.ownerName;
    await showApp();
  } catch {
    showLogin();
  }
}

// 畫面開著的時候每 30 秒更新一次，讓「已送出」狀態自動出現
setInterval(() => {
  if (!document.hidden && !$('#app-view').hidden) loadReminders().catch(() => {});
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('#app-view').hidden) loadReminders().catch(() => {});
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

start();
