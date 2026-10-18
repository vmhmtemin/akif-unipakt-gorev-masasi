/* =============================================================================
   Unipakt Görev Masası — istemci
   Tüm veri Supabase'deki SECURITY DEFINER fonksiyonlarından (RPC) geçer.
   Tarayıcıda yalnızca publishable key bulunur; oturum anahtarı sadece
   bellekte tutulur (sayfa kapanınca biter). Görev ve notlar cihaza
   kaydedilmez.
   ============================================================================= */

// ---------- Ayarlar ----------
const PROFILES = {
  akif:   { name: 'Akif',   initial: 'A' },
  mehmet: { name: 'Mehmet', initial: 'M' },
  ugur:   { name: 'Uğur',   initial: 'U' },
};
const SUPABASE_URL = 'https://jbheyqmqickfuuhyesog.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jfLnVG_RBLbzj8-HftUFlA_xgZ0Ag6X';
const POLL_MS = 8000;
const NOTE_MAX = 600;

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ---------- Durum ----------
let activeProfile = null;        // ekranda seçili profil
let authenticatedProfile = null; // oturum anahtarının ait olduğu profil
let accessToken = null;          // yalnızca bellekte
let tasks = [];
let filter = 'all';
let pollTimer = null;
let noteTimer = null;

// PIN ekranı durumu
let pinMode = 'login';           // 'login' | 'setup' | 'change'
let pinStage = 'first';          // 'first' | 'confirm'
let pendingPin = '';
let pinReturnToWorkspace = false;

// ---------- Yardımcılar ----------
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

/** Eski sürümlerin cihazda bıraktığı görev/not kopyalarını siler. */
function purgeLegacyStorage() {
  try {
    Object.keys(localStorage)
      .filter((key) => /^unipakt-(tasks|note)-[a-z]+-v1$/.test(key) || key === 'unipakt-akif-note-v1')
      .forEach((key) => localStorage.removeItem(key));
  } catch { /* depolama kapalıysa sorun değil */ }
}

function setSyncStatus(text, offline = false) {
  $('#sync-label').textContent = text;
  $('.sync-dot').classList.toggle('offline', offline);
}

function setNoteText(text) {
  $('#sticky-note').value = text;
  $('#note-count').textContent = `${text.length}/${NOTE_MAX}`;
}

const isMissingSchema = (error) => error?.code === 'PGRST202' || /schema cache/i.test(error?.message || '');
const isSessionError = (error) => /Access denied/i.test(error?.message || '');

/** Sunucunun görev doğrulama hatalarını okunur mesaja çevirir. */
function taskErrorMessage(error) {
  const field = /INVALID_TASK:(\w+)/.exec(error?.message || '')?.[1];
  return {
    title: 'Başlık 1–120 karakter olmalı.',
    detail: 'Detay en fazla 400 karakter olabilir.',
    assignee: 'Sorumlu 1–60 karakter olmalı.',
    id: 'Görev kimliği geçersiz.',
  }[field] || 'Görev kaydedilemedi. Tekrar dene.';
}

/**
 * RPC çağrısı. Oturum düşmüşse kullanıcıyı giriş ekranına döndürür.
 * @returns {Promise<{data:any, error:any, expired:boolean}>}
 */
async function rpc(name, params) {
  const { data, error } = await db.rpc(name, params);
  if (error && isSessionError(error)) {
    expireSession();
    return { data: null, error, expired: true };
  }
  return { data, error, expired: false };
}

// ---------- Oturum ----------
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** 12 saatlik oturum bitti: her şeyi temizle ve kodu tekrar iste. */
function expireSession() {
  if (!accessToken) return;
  stopPolling();
  clearTimeout(noteTimer);
  accessToken = null;
  authenticatedProfile = null;
  tasks = [];
  $('#task-dialog').open && $('#task-dialog').close();
  showPinGate('login', true);
  pinMessage('Oturum süresi doldu, kodunu tekrar gir.');
}

// ---------- Görevler: sunucu ----------
function taskFromDb(row) {
  return {
    id: row.id, title: row.title, detail: row.detail || '', assignee: row.assignee,
    due: row.due || '', done: row.done, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

async function refreshTasks() {
  if (!activeProfile || !accessToken) return;
  const list = await rpc('list_tasks', { p_session_token: accessToken });
  if (list.expired) return;
  if (list.error) { setSyncStatus('Bağlantı bekleniyor', true); return; }
  tasks = (list.data || []).map(taskFromDb);

  const note = await rpc('get_profile_note', { p_session_token: accessToken, p_profile_id: activeProfile });
  if (note.expired) return;
  if (!note.error && document.activeElement !== $('#sticky-note')) setNoteText(note.data || '');
  setSyncStatus(note.error ? 'Not eşitlenemedi' : 'Ortak kayıt açık', Boolean(note.error));
  render();
}

/** Yalnızca YENİ görevi gönderir; başkalarının görevlerine dokunmaz. */
async function addTask(task) {
  const payload = {
    id: task.id, title: task.title, detail: task.detail, assignee: task.assignee, due: task.due || null,
  };
  let result = await rpc('add_task', { p_session_token: accessToken, p_task: payload });
  // SQL güncellemesi henüz çalıştırılmadıysa: eski fonksiyonla sadece bu görevi gönder
  if (result.error && isMissingSchema(result.error)) {
    result = await rpc('upsert_task', {
      p_session_token: accessToken,
      p_task: { ...payload, done: false, created_at: task.createdAt, completed_at: null },
    });
  }
  return result;
}

// ---------- Çalışma alanı ----------
async function openWorkspace(profileId) {
  activeProfile = profileId;
  const profile = PROFILES[profileId];
  $('#profile-picker').classList.add('hidden');
  $('.shell').classList.remove('hidden');
  $('#profile-name').textContent = profile.name;
  $('#profile-avatar').textContent = profile.initial;
  $('#task-form').elements.assignee.value = profile.name;
  $('.note-head span:last-of-type').textContent =
    profileId === 'ugur' ? "UĞUR'UN NOTU" : `${profile.name.toLocaleUpperCase('tr-TR')}'İN NOTU`;
  setNoteText('');
  setView('tasks');
  setFilter('all');
  tasks = [];
  render();
  setSyncStatus('Bağlanıyor…');

  stopPolling();
  await refreshTasks();
  if (accessToken) pollTimer = setInterval(refreshTasks, POLL_MS);
}

// ---------- PIN ekranı ----------
function pinMessage(message) { $('#pin-error').textContent = message; }

function setPinTexts(title, subtitle, label, submit) {
  $('#pin-title').textContent = title;
  $('#pin-subtitle').textContent = subtitle;
  $('#pin-label').textContent = label;
  $('#pin-submit').textContent = submit;
}

function showPinGate(mode, returnToWorkspace = false) {
  pinMode = mode; pinStage = 'first'; pendingPin = ''; pinReturnToWorkspace = returnToWorkspace;
  $('#profile-picker').classList.add('hidden');
  $('.shell').classList.add('hidden');
  $('#code-gate').classList.remove('hidden');
  $('#pin-code').value = '';
  pinMessage('');
  const name = PROFILES[activeProfile]?.name || '';
  if (mode === 'login') setPinTexts(`${name} için giriş kodu`, 'Bu profil için belirlenmiş 4 haneli kodu gir.', 'Giriş kodu', 'Giriş yap');
  else setPinTexts(mode === 'change' ? 'Yeni giriş kodu' : `${name} için kod belirle`, 'Bu profile özel 4 haneli yeni kodunu oluştur.', 'Yeni kod', 'Devam et');
  $('#pin-code').focus();
}

function openProfilePicker() {
  $('#code-gate').classList.add('hidden');
  $('.shell').classList.add('hidden');
  $('#profile-picker').classList.remove('hidden');
  $('#pin-change').classList.toggle('hidden', !accessToken || authenticatedProfile !== activeProfile);
}

function continueAfterPin(token) {
  accessToken = token;
  authenticatedProfile = activeProfile;
  $('#code-gate').classList.add('hidden');
  if (pinReturnToWorkspace && activeProfile) openWorkspace(activeProfile);
  else openProfilePicker();
}

async function chooseProfile(profileId) {
  activeProfile = profileId;
  if (accessToken && authenticatedProfile === profileId) { await openWorkspace(profileId); return; }
  stopPolling();
  accessToken = null; authenticatedProfile = null;
  $('#pin-change').classList.add('hidden');
  showPinGate('login', true);
  const { data, error } = await db.rpc('has_access_pin', { p_profile_id: profileId });
  if (error) {
    pinMessage(isMissingSchema(error) ? 'Supabase SQL kurulumu henüz yapılmamış. Sayfayı yenileyip tekrar dene.' : 'Supabase bağlantısı kurulamadı. Tekrar dene.');
    return;
  }
  if (!data) showPinGate('setup', true);
}

function resetPinToFirst(message) {
  pinMessage(message);
  pinStage = 'first'; pendingPin = '';
  $('#pin-code').value = '';
  setPinTexts('Yeni giriş kodu', '4 haneli yeni kodunu oluştur.', 'Yeni kod', 'Devam et');
  $('#pin-code').focus();
}

async function submitPin(pin) {
  const input = $('#pin-code');

  if (pinMode === 'login') {
    const { data, error } = await db.rpc('verify_access_pin', { p_profile_id: activeProfile, p_pin: pin });
    if (error) throw error;
    if (!data) { pinMessage('Kod doğru değil. Tekrar dene.'); input.value = ''; input.focus(); return; }
    continueAfterPin(data);
    return;
  }

  if (pinStage === 'first') {
    pendingPin = pin; pinStage = 'confirm'; input.value = '';
    setPinTexts('Kodu tekrar yaz', 'Aynı kodu doğrulamak için bir kez daha gir.', 'Yeni kodu onayla', 'Kodu onayla');
    input.focus();
    return;
  }
  if (pin !== pendingPin) { resetPinToFirst('Kodlar eşleşmedi. İlk kodu yeniden yaz.'); return; }

  const result = pinMode === 'setup'
    ? await db.rpc('setup_access_pin', { p_profile_id: activeProfile, p_pin: pin })
    : await db.rpc('change_access_pin', { p_new_pin: pin, p_session_token: accessToken });
  if (result.error) throw result.error;
  if (!result.data) {
    pendingPin = ''; pinStage = 'first';
    pinMessage(pinMode === 'setup' ? 'Kod daha önce belirlenmiş. Sayfayı yenileyip giriş yap.' : 'Oturumun süresi dolmuş. Önce giriş yap.');
    return;
  }
  continueAfterPin(pinMode === 'change' ? accessToken : result.data);
}

$('#pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = $('#pin-code').value.trim();
  if (!/^\d{4}$/.test(pin)) { pinMessage('Kod 4 rakamdan oluşmalı.'); return; }
  $('#pin-submit').disabled = true;
  pinMessage('');
  try {
    await submitPin(pin);
  } catch (error) {
    const locked = /PIN_LOCKED:(\d+)/.exec(error?.message || '');
    if (locked) {
      pinMessage(`Çok fazla hatalı deneme. ${locked[1]} dakika sonra tekrar dene.`);
      $('#pin-code').value = '';
    } else {
      pinMessage(isMissingSchema(error) ? 'Supabase SQL kurulumu henüz yapılmamış.' : 'Supabase bağlantısı kurulamadı. Tekrar dene.');
    }
  } finally {
    $('#pin-submit').disabled = false;
  }
});
$('#pin-change').addEventListener('click', () => showPinGate('change', Boolean(activeProfile)));
$$('[data-profile]').forEach((button) => button.addEventListener('click', () => chooseProfile(button.dataset.profile)));
$('#profile-switch').addEventListener('click', openProfilePicker);

// ---------- Görünüm ----------
function dateLabel(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const isToday = (value) => value && new Date(value).toDateString() === new Date().toDateString();
const longDate = (value) => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));

function taskRowHtml(task) {
  const id = escapeHtml(task.id);
  const late = !task.done && task.due && task.due < todayKey();
  const soon = !task.done && task.due === todayKey();
  const due = task.due ? `<span class="due ${late ? 'late' : soon ? 'soon' : ''}">${late ? 'Gecikti · ' : ''}${dateLabel(task.due)}</span>` : '';
  return `<div class="task-row ${task.done ? 'completed' : ''}">`
    + `<input class="check" type="checkbox" data-toggle="${id}" ${task.done ? 'checked' : ''} aria-label="${task.done ? 'Tamamlandı' : 'Tamamlandı olarak işaretle'}">`
    + `<div class="task-content"><div class="task-title">${escapeHtml(task.title)}</div>${task.detail ? `<div class="task-detail">${escapeHtml(task.detail)}</div>` : ''}</div>`
    + `<div class="task-meta">${due}<span class="assignee">${escapeHtml(task.assignee)}</span></div>`
    + `<button class="delete-task" data-delete="${id}" aria-label="Görevi sil" title="Görevi sil">×</button></div>`;
}

function reportRowHtml(task) {
  return `<div class="report-row"><div class="report-name">${escapeHtml(task.title)}</div>`
    + `${task.detail ? `<div class="report-detail">${escapeHtml(task.detail)}</div>` : ''}`
    + `<div class="report-date">Tamamlandı: ${task.completedAt ? longDate(task.completedAt) : 'Tarih yok'}</div>`
    + `<span class="report-badge">✓ ${escapeHtml(task.assignee)}</span></div>`;
}

function render() {
  const open = tasks.filter((t) => !t.done);
  const completed = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  const visible = filter === 'open' ? open : filter === 'done' ? completed : [...open, ...completed];

  $('#stat-open').textContent = open.length;
  $('#nav-open').textContent = open.length;
  $('#stat-done').textContent = completed.filter((t) => isToday(t.completedAt)).length;
  $('#stat-late').textContent = open.filter((t) => t.due && t.due < todayKey()).length;
  $('#task-list').innerHTML = visible.map(taskRowHtml).join('');
  $('#empty-state').style.display = visible.length ? 'none' : 'block';

  const week = new Date(); week.setDate(week.getDate() - 6); week.setHours(0, 0, 0, 0);
  $('#report-total').textContent = completed.length;
  $('#report-week').textContent = completed.filter((t) => t.completedAt && new Date(t.completedAt) >= week).length;
  $('#report-list').innerHTML = completed.map(reportRowHtml).join('');
  $('#report-empty').style.display = completed.length ? 'none' : 'block';
}

function setView(view) {
  const reports = view === 'reports';
  $('#tasks-view').classList.toggle('hidden', reports);
  $('#reports-view').classList.toggle('hidden', !reports);
  $('#crumb-view').textContent = reports ? 'Raporlar' : 'Görevler';
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

function setFilter(value) {
  filter = value;
  $$('.filter').forEach((b) => b.classList.toggle('active', b.dataset.filter === value));
}

// ---------- Görev formu ----------
function openDialog() {
  $('#task-form-error') && ($('#task-form-error').textContent = '');
  $('#task-dialog').showModal();
  $('#task-form').elements.title.focus();
}
$('#open-task').addEventListener('click', openDialog);
$('#empty-add').addEventListener('click', openDialog);
$('#close-dialog').addEventListener('click', () => $('#task-dialog').close());
$('#cancel-dialog').addEventListener('click', () => $('#task-dialog').close());

$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const task = {
    id: crypto.randomUUID(),
    title: data.get('title').trim(),
    detail: data.get('detail').trim(),
    assignee: data.get('assignee').trim() || PROFILES[activeProfile].name,
    due: data.get('due'),
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  const { error, expired } = await addTask(task);
  if (submit) submit.disabled = false;
  if (expired) return;
  if (error) {
    const message = taskErrorMessage(error);
    setSyncStatus('Görev eklenemedi', true);
    if ($('#task-form-error')) $('#task-form-error').textContent = message; else alert(message);
    return;
  }
  form.reset();
  form.elements.assignee.value = PROFILES[activeProfile].name;
  $('#task-dialog').close();
  setFilter('all');
  tasks.unshift(task);
  render();
  setSyncStatus('Ortak kayıt açık');
});

$$('.filter').forEach((button) => button.addEventListener('click', () => { setFilter(button.dataset.filter); render(); }));
$$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

// ---------- Tamamla / geri al ----------
$('#task-list').addEventListener('change', async (event) => {
  const box = event.target;
  if (!box.matches('[data-toggle]')) return;
  const task = tasks.find((t) => t.id === box.dataset.toggle);
  if (!task) return;
  const before = { done: task.done, completedAt: task.completedAt };
  task.done = box.checked;
  task.completedAt = task.done ? new Date().toISOString() : null;
  box.disabled = true;
  const { error, expired } = await rpc('update_task_state', {
    p_session_token: accessToken, p_task_id: task.id, p_done: task.done, p_completed_at: task.completedAt,
  });
  if (expired) return;
  if (error) Object.assign(task, before); // başarısızsa eski haline döndür
  setSyncStatus(error ? 'Eşitleme başarısız' : 'Ortak kayıt açık', Boolean(error));
  render();
});

// ---------- Sil ----------
$('#task-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete]');
  if (!button) return;
  const id = button.dataset.delete;
  const task = tasks.find((t) => t.id === id);
  if (!confirm(`"${task?.title || 'Bu görev'}" silinsin mi? Bu işlem geri alınamaz.`)) return;
  button.disabled = true;
  const { error, expired } = await rpc('delete_task', { p_session_token: accessToken, p_task_id: id });
  if (expired) return;
  if (error) { button.disabled = false; setSyncStatus('Görev silinemedi', true); return; }
  tasks = tasks.filter((t) => t.id !== id);
  render();
  setSyncStatus('Ortak kayıt açık');
});

// ---------- Not ----------
$('#sticky-note').addEventListener('input', () => {
  $('#note-count').textContent = `${$('#sticky-note').value.length}/${NOTE_MAX}`;
  $('#note-status').textContent = 'Kaydediliyor…';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    const { error, expired } = await rpc('save_profile_note', {
      p_session_token: accessToken, p_profile_id: activeProfile, p_body: $('#sticky-note').value,
    });
    if (expired) return;
    $('#note-status').textContent = error ? 'Eşitlenemedi' : 'Ortak kaydedildi';
    setSyncStatus(error ? 'Eşitleme başarısız' : 'Ortak kayıt açık', Boolean(error));
  }, 500);
});

$('#clear-note').addEventListener('click', async () => {
  if ($('#sticky-note').value && !confirm('Not temizlensin mi?')) return;
  const { error, expired } = await rpc('clear_profile_note', { p_session_token: accessToken, p_profile_id: activeProfile });
  if (expired) return;
  if (error) { setSyncStatus('Not silinemedi', true); return; }
  setNoteText('');
  $('#note-status').textContent = 'Not temizlendi';
});

// ---------- CSV raporu ----------
/** Excel'in hücreyi formül sanmasını engeller (=, +, -, @, sekme, satır başı). */
const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

$('#export-report').addEventListener('click', () => {
  const stamp = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  const rows = [
    ['Görev', 'Detay', 'Sorumlu', 'Tamamlanma tarihi'],
    ...tasks.filter((t) => t.done).map((t) => [t.title, t.detail, t.assignee, t.completedAt ? stamp.format(new Date(t.completedAt)) : '']),
  ];
  const csv = '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `unipakt-gorev-raporu-${todayKey()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---------- Başlat ----------
purgeLegacyStorage();
setNoteText('');
render();
openProfilePicker();
