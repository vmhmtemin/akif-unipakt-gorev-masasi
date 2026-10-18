/* =============================================================================
   Unipakt Görev Masası — istemci
   Tüm veri Supabase'deki SECURITY DEFINER fonksiyonlarından (RPC) geçer.
   Tarayıcıda yalnızca publishable key bulunur; oturum anahtarı sadece
   bellekte tutulur (sayfa kapanınca biter). Görev ve notlar cihaza
   kaydedilmez. Takvim sekmesi calendar.js içindedir.
   ============================================================================= */

// ---------- Ayarlar ----------
const PROFILES = {
  akif:   { name: 'Akif',   initial: 'A' },
  mehmet: { name: 'Mehmet', initial: 'M' },
  ugur:   { name: 'Uğur',   initial: 'U' },
};
const ASSIGNEES = ['Akif', 'Mehmet', 'Uğur', 'Herkes'];
const SUPABASE_URL = 'https://jbheyqmqickfuuhyesog.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jfLnVG_RBLbzj8-HftUFlA_xgZ0Ag6X';
const POLL_MS = 8000;
const NOTE_MAX = 600;
const UNDO_MS = 5000;
const VIEW_LABELS = { tasks: 'Görevler', calendar: 'Takvim', reports: 'Raporlar' };

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ---------- Durum ----------
let activeProfile = null;        // ekranda seçili profil
let authenticatedProfile = null; // oturum anahtarının ait olduğu profil
let accessToken = null;          // yalnızca bellekte
let tasks = [];
let filter = 'all';              // 'all' | 'open' | 'done'
let onlyMine = false;
let searchQuery = '';
let currentView = 'tasks';
let pollTimer = null;
let noteTimer = null;
let editing = null;              // düzenlenen görev: { id, updatedAt } | null

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
const lowerTr = (value) => String(value || '').toLocaleLowerCase('tr-TR');

/** Sorumlu adını renk/filtre anahtarına çevirir (eski serbest metinler dahil). */
function personKey(name) {
  const n = lowerTr(name).trim();
  if (n === 'akif') return 'akif';
  if (n === 'mehmet') return 'mehmet';
  if (n === 'uğur' || n === 'ugur') return 'ugur';
  if (n === 'herkes') return 'herkes';
  return 'other';
}
const profileName = (key) => PROFILES[key]?.name || '';

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

const isMissingSchema = (error) => error?.code === 'PGRST202' || /schema cache|Could not find the function/i.test(error?.message || '');
const isSessionError = (error) => /Access denied/i.test(error?.message || '');

/** Sunucunun görev hatalarını okunur mesaja çevirir. */
function taskErrorMessage(error) {
  const msg = error?.message || '';
  if (/TASK_CONFLICT/.test(msg)) return 'Bu görev az önce başka biri tarafından değiştirildi. Liste yenilendi, tekrar dene.';
  if (/TASK_NOT_FOUND/.test(msg)) return 'Bu görev silinmiş.';
  if (isMissingSchema(error)) return 'Bu özellik için Supabase’de supabase/v2_features.sql çalıştırılmalı.';
  const field = /INVALID_TASK:(\w+)/.exec(msg)?.[1];
  return {
    title: 'Başlık 1–120 karakter olmalı.',
    detail: 'Detay en fazla 400 karakter olabilir.',
    assignee: 'Sorumlu 1–60 karakter olmalı.',
    priority: 'Öncelik geçersiz.',
    due: 'Son tarih geçersiz.',
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

// ---------- Bildirim (alt köşedeki kısa mesaj) ----------
let toastTimer = null;
/**
 * @param {string} text
 * @param {{label:string, onClick:Function}} [action] isteğe bağlı düğme (ör. Geri al)
 */
function toast(text, action, duration = 3200) {
  const box = $('#toast');
  const button = $('#toast-action');
  $('#toast-text').textContent = text;
  button.classList.toggle('hidden', !action);
  button.textContent = action?.label || '';
  button.onclick = action ? () => { hideToast(); action.onClick(); } : null;
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}
function hideToast() { clearTimeout(toastTimer); $('#toast').classList.add('hidden'); }

// ---------- Oturum ----------
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
function startPolling() {
  stopPolling();
  if (accessToken && activeProfile && !document.hidden) pollTimer = setInterval(refreshTasks, POLL_MS);
}

/** 12 saatlik oturum bitti: her şeyi temizle ve kodu tekrar iste. */
function expireSession() {
  if (!accessToken) return;
  stopPolling();
  clearTimeout(noteTimer);
  hideToast();
  accessToken = null;
  authenticatedProfile = null;
  tasks = [];
  if ($('#task-dialog').open) $('#task-dialog').close();
  showPinGate('login', true);
  pinMessage('Oturum süresi doldu, kodunu tekrar gir.');
}

// Sekme arka plandayken yenileme durur, öne gelince hemen yenilenir
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPolling(); return; }
  if (accessToken && activeProfile && !$('.shell').classList.contains('hidden')) { refreshTasks(); startPolling(); }
});

// ---------- Görevler: sunucu ----------
function taskFromDb(row) {
  return {
    id: row.id, title: row.title, detail: row.detail || '', assignee: row.assignee,
    due: row.due || '', done: row.done, priority: row.priority || 'normal',
    createdAt: row.created_at, completedAt: row.completed_at,
    createdBy: row.created_by || null, completedBy: row.completed_by || null,
    updatedAt: row.updated_at || null,
  };
}

/** Sunucuya gönderilen görev alanları (düzenlenebilir olanlar). */
const editablePayload = (task) => ({
  id: task.id, title: task.title, detail: task.detail || '', assignee: task.assignee,
  due: task.due || null, priority: task.priority || 'normal',
});

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
  const payload = editablePayload(task);
  let result = await rpc('add_task', { p_session_token: accessToken, p_task: payload });
  // Güvenlik SQL'i henüz çalıştırılmadıysa: eski fonksiyonla sadece bu görevi gönder
  if (result.error && isMissingSchema(result.error)) {
    result = await rpc('upsert_task', {
      p_session_token: accessToken,
      p_task: { ...payload, done: false, created_at: task.createdAt, completed_at: null },
    });
  }
  return result;
}

/** Görevi düzenler. Arada başkası değiştirdiyse TASK_CONFLICT döner. */
async function updateTask(task, expectedUpdatedAt) {
  return rpc('update_task', { p_session_token: accessToken, p_task: editablePayload(task), p_expected: expectedUpdatedAt || null });
}

/** Son tarihi değiştirir (takvimde sürükle-bırak). */
async function moveTask(id, due) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const before = task.due;
  task.due = due;
  render();
  const { data, error, expired } = await updateTask(task, task.updatedAt);
  if (expired) return;
  if (error) {
    task.due = before;
    toast(taskErrorMessage(error));
    if (/TASK_CONFLICT|TASK_NOT_FOUND/.test(error.message)) await refreshTasks(); else render();
    return;
  }
  task.updatedAt = data;
  const label = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(new Date(`${due}T12:00:00`));
  toast(`"${task.title}" ${label} tarihine taşındı.`);
}

// ---------- Çalışma alanı ----------
async function openWorkspace(profileId) {
  activeProfile = profileId;
  const profile = PROFILES[profileId];
  $('#profile-picker').classList.add('hidden');
  $('.shell').classList.remove('hidden');
  $('#profile-name').textContent = profile.name;
  $('#profile-avatar').textContent = profile.initial;
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
  startPolling();
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
  const name = profileName(activeProfile);
  if (mode === 'login') setPinTexts(`${name} için giriş kodu`, 'Bu profil için belirlenmiş 4 haneli kodu gir.', 'Giriş kodu', 'Giriş yap');
  else setPinTexts(mode === 'change' ? 'Yeni giriş kodu' : `${name} için kod belirle`, 'Bu profile özel 4 haneli yeni kodunu oluştur.', 'Yeni kod', 'Devam et');
  $('#pin-code').focus();
}

function openProfilePicker() {
  stopPolling();
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

// ---------- Görünüm yardımcıları ----------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateLabel(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
}
const isToday = (value) => value && new Date(value).toDateString() === new Date().toDateString();
const longDate = (value) => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));

/**
 * Açık görev sırası: önce dikkat isteyenler (geciken, bugün biten, acil),
 * kendi içinde acil önce, sonra son tarihe göre, tarihsizler en sonda.
 */
function sortOpen(list) {
  const today = todayKey();
  const attention = (t) => ((t.due && t.due <= today) || t.priority === 'urgent' ? 0 : 1);
  return list.sort((a, b) => attention(a) - attention(b)
    || (b.priority === 'urgent') - (a.priority === 'urgent')
    || (a.due || '9999-12-31').localeCompare(b.due || '9999-12-31')
    || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function matchesSearch(task) {
  if (!searchQuery) return true;
  return lowerTr(`${task.title} ${task.detail} ${task.assignee}`).includes(searchQuery);
}
function isMine(task) {
  const key = personKey(task.assignee);
  return key === activeProfile || key === 'herkes';
}

function whoLine(task) {
  const parts = [];
  if (task.createdBy) parts.push(`${profileName(task.createdBy)} ekledi`);
  if (task.done && task.completedBy) parts.push(`${profileName(task.completedBy)} tamamladı`);
  return parts.join(' · ');
}

function taskRowHtml(task) {
  const id = escapeHtml(task.id);
  const today = todayKey();
  const late = !task.done && task.due && task.due < today;
  const soon = !task.done && task.due === today;
  const urgent = task.priority === 'urgent';
  const due = task.due ? `<span class="due ${late ? 'late' : soon ? 'soon' : ''}">${late ? 'Gecikti · ' : soon ? 'Bugün · ' : ''}${dateLabel(task.due)}</span>` : '';
  const who = whoLine(task);
  return `<div class="task-row ${task.done ? 'completed' : ''} ${urgent && !task.done ? 'urgent' : ''}">`
    + `<input class="check" type="checkbox" data-toggle="${id}" ${task.done ? 'checked' : ''} aria-label="${task.done ? 'Tamamlandı' : 'Tamamlandı olarak işaretle'}">`
    + `<button type="button" class="task-content" data-edit="${id}" title="Düzenle">`
    + `<span class="task-title">${urgent ? '<span class="badge-urgent">Acil</span>' : ''}${escapeHtml(task.title)}</span>`
    + `${task.detail ? `<span class="task-detail">${escapeHtml(task.detail)}</span>` : ''}`
    + `${who ? `<span class="task-who">${escapeHtml(who)}</span>` : ''}</button>`
    + `<div class="task-meta">${due}<span class="assignee p-${personKey(task.assignee)}">${escapeHtml(task.assignee)}</span></div>`
    + `<button class="delete-task" data-delete="${id}" aria-label="Görevi sil" title="Görevi sil">×</button></div>`;
}

function reportRowHtml(task) {
  const by = task.completedBy ? ` · ${escapeHtml(profileName(task.completedBy))}` : '';
  return `<div class="report-row"><div class="report-name">${escapeHtml(task.title)}</div>`
    + `${task.detail ? `<div class="report-detail">${escapeHtml(task.detail)}</div>` : ''}`
    + `<div class="report-date">Tamamlandı: ${task.completedAt ? longDate(task.completedAt) : 'Tarih yok'}${by}</div>`
    + `<span class="report-badge">✓ ${escapeHtml(task.assignee)}</span></div>`;
}

function render() {
  const today = todayKey();
  const open = sortOpen(tasks.filter((t) => !t.done));
  const completed = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  // Özet kartları her zaman tüm ekibi gösterir
  $('#stat-open').textContent = open.length;
  $('#nav-open').textContent = open.length;
  $('#stat-done').textContent = completed.filter((t) => isToday(t.completedAt)).length;
  $('#stat-late').textContent = open.filter((t) => t.due && t.due < today).length;

  const base = filter === 'open' ? open : filter === 'done' ? completed : [...open, ...completed];
  const visible = base.filter((t) => (!onlyMine || isMine(t)) && matchesSearch(t));
  $('#task-list').innerHTML = visible.map(taskRowHtml).join('');
  const narrowed = Boolean(searchQuery || onlyMine || filter !== 'all');
  $('#empty-state').style.display = visible.length ? 'none' : 'block';
  $('#empty-title').textContent = narrowed && tasks.length ? 'Eşleşen görev yok' : 'Henüz görev yok';
  $('#empty-text').textContent = narrowed && tasks.length ? 'Filtreleri veya aramayı değiştir.' : 'İlk görevi ekleyerek başlayın.';

  const week = new Date(); week.setDate(week.getDate() - 6); week.setHours(0, 0, 0, 0);
  $('#report-total').textContent = completed.length;
  $('#report-week').textContent = completed.filter((t) => t.completedAt && new Date(t.completedAt) >= week).length;
  $('#report-list').innerHTML = completed.map(reportRowHtml).join('');
  $('#report-empty').style.display = completed.length ? 'none' : 'block';

  window.GorevTakvim.render(tasks);
}

function setView(view) {
  currentView = view;
  $$('.view').forEach((section) => section.classList.toggle('hidden', section.id !== `${view}-view`));
  $('#crumb-view').textContent = VIEW_LABELS[view];
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'calendar') window.GorevTakvim.render(tasks);
}

function setFilter(value) {
  filter = value;
  $$('.filter[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === value));
}

$$('.filter[data-filter]').forEach((button) => button.addEventListener('click', () => { setFilter(button.dataset.filter); render(); }));
$$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#mine-toggle').addEventListener('click', (event) => {
  onlyMine = !onlyMine;
  event.currentTarget.setAttribute('aria-pressed', String(onlyMine));
  event.currentTarget.classList.toggle('active', onlyMine);
  render();
});
$('#task-search').addEventListener('input', (event) => { searchQuery = lowerTr(event.target.value.trim()); render(); });

// ---------- Görev formu (ekle / düzenle) ----------
const form = $('#task-form');

/** Sorumlu listesini doldurur; listede olmayan eski bir isim varsa onu da ekler. */
function fillAssigneeOptions(selected) {
  const names = ASSIGNEES.includes(selected) || !selected ? ASSIGNEES : [...ASSIGNEES, selected];
  form.elements.assignee.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  form.elements.assignee.value = selected || profileName(activeProfile);
}

/**
 * @param {object} [task] verilirse düzenleme modu
 * @param {string} [due] yeni görev için hazır son tarih (takvimden)
 */
function openDialog(task, due) {
  editing = task ? { id: task.id, updatedAt: task.updatedAt } : null;
  form.reset();
  $('#task-form-error').textContent = '';
  $('#dialog-eyebrow').textContent = task ? 'DÜZENLE' : 'YENİ İŞ';
  $('#dialog-title').textContent = task ? 'Görevi düzenle' : 'Görev oluştur';
  $('#dialog-submit').textContent = task ? 'Kaydet' : 'Görevi ekle';
  fillAssigneeOptions(task ? task.assignee : profileName(activeProfile));
  form.elements.title.value = task?.title || '';
  form.elements.detail.value = task?.detail || '';
  form.elements.due.value = task?.due || due || '';
  form.elements.priority.value = task?.priority || 'normal';
  $('#task-dialog').showModal();
  form.elements.title.focus();
}
const closeDialog = () => { editing = null; $('#task-dialog').close(); };

$('#open-task').addEventListener('click', () => openDialog());
$('#empty-add').addEventListener('click', () => openDialog());
$('#close-dialog').addEventListener('click', closeDialog);
$('#cancel-dialog').addEventListener('click', closeDialog);
$('#task-dialog').addEventListener('close', () => { editing = null; });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const fields = {
    title: data.get('title').trim(),
    detail: data.get('detail').trim(),
    assignee: data.get('assignee') || profileName(activeProfile),
    due: data.get('due') || '',
    priority: data.get('priority') === 'urgent' ? 'urgent' : 'normal',
  };
  const submit = $('#dialog-submit');
  submit.disabled = true;

  if (editing) {
    const original = tasks.find((t) => t.id === editing.id);
    const updated = { ...(original || {}), ...fields, id: editing.id };
    const { data: updatedAt, error, expired } = await updateTask(updated, editing.updatedAt);
    submit.disabled = false;
    if (expired) return;
    if (error) {
      $('#task-form-error').textContent = taskErrorMessage(error);
      if (/TASK_CONFLICT/.test(error.message)) {
        await refreshTasks();
        const fresh = tasks.find((t) => t.id === editing?.id);
        if (fresh && editing) editing.updatedAt = fresh.updatedAt; // yeni hâli gördükten sonra tekrar kaydedebilir
      }
      return;
    }
    if (original) Object.assign(original, fields, { updatedAt });
    closeDialog();
    render();
    setSyncStatus('Ortak kayıt açık');
    toast('Görev güncellendi.');
    return;
  }

  const task = {
    id: crypto.randomUUID(), ...fields, done: false,
    createdAt: new Date().toISOString(), completedAt: null,
    createdBy: authenticatedProfile, completedBy: null, updatedAt: null,
  };
  const { error, expired } = await addTask(task);
  submit.disabled = false;
  if (expired) return;
  if (error) {
    setSyncStatus('Görev eklenemedi', true);
    $('#task-form-error').textContent = taskErrorMessage(error);
    return;
  }
  closeDialog();
  if (currentView === 'tasks') setFilter('all');
  tasks.unshift(task);
  render();
  setSyncStatus('Ortak kayıt açık');
  refreshTasks(); // sunucu saatini (updated_at) hemen al; düzenleme kontrolü için gerekli
});

// "N" tuşu: yeni görev
document.addEventListener('keydown', (event) => {
  if (event.key !== 'n' && event.key !== 'N') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  if ($('#task-dialog').open || $('.shell').classList.contains('hidden')) return;
  event.preventDefault();
  openDialog();
});

// ---------- Görev listesi: düzenle / tamamla / sil ----------
$('#task-list').addEventListener('change', async (event) => {
  const box = event.target;
  if (!box.matches('[data-toggle]')) return;
  const task = tasks.find((t) => t.id === box.dataset.toggle);
  if (!task) return;
  const before = { done: task.done, completedAt: task.completedAt, completedBy: task.completedBy };
  task.done = box.checked;
  task.completedAt = task.done ? new Date().toISOString() : null;
  task.completedBy = task.done ? authenticatedProfile : null;
  box.disabled = true;
  const { error, expired } = await rpc('update_task_state', {
    p_session_token: accessToken, p_task_id: task.id, p_done: task.done, p_completed_at: task.completedAt,
  });
  if (expired) return;
  if (error) Object.assign(task, before); // başarısızsa eski hâline döndür
  setSyncStatus(error ? 'Eşitleme başarısız' : 'Ortak kayıt açık', Boolean(error));
  render();
});

$('#task-list').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit]');
  if (edit) { const task = tasks.find((t) => t.id === edit.dataset.edit); if (task) openDialog(task); return; }

  const button = event.target.closest('[data-delete]');
  if (!button) return;
  const id = button.dataset.delete;
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  button.disabled = true;
  const { error, expired } = await rpc('delete_task', { p_session_token: accessToken, p_task_id: id });
  if (expired) return;
  if (error) { button.disabled = false; setSyncStatus('Görev silinemedi', true); return; }
  tasks = tasks.filter((t) => t.id !== id);
  render();
  setSyncStatus('Ortak kayıt açık');
  toast(`"${task.title}" silindi.`, { label: 'Geri al', onClick: () => restoreTask(task) }, UNDO_MS);
});

/** Silinen görevi aynen geri koyar. */
async function restoreTask(task) {
  const payload = {
    ...editablePayload(task), done: task.done, created_at: task.createdAt, completed_at: task.completedAt,
    created_by: task.createdBy, completed_by: task.completedBy,
  };
  let result = await rpc('restore_task', { p_session_token: accessToken, p_task: payload });
  if (result.error && isMissingSchema(result.error)) {
    result = await rpc('upsert_task', { p_session_token: accessToken, p_task: payload });
  }
  if (result.expired) return;
  if (result.error) { toast('Görev geri alınamadı.'); return; }
  await refreshTasks();
  toast('Görev geri alındı.');
}

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
    ['Görev', 'Detay', 'Sorumlu', 'Öncelik', 'Ekleyen', 'Tamamlayan', 'Tamamlanma tarihi'],
    ...tasks.filter((t) => t.done).map((t) => [
      t.title, t.detail, t.assignee, t.priority === 'urgent' ? 'Acil' : 'Normal',
      profileName(t.createdBy), profileName(t.completedBy),
      t.completedAt ? stamp.format(new Date(t.completedAt)) : '',
    ]),
  ];
  const csv = '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `unipakt-gorev-raporu-${todayKey()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---------- Takvim ----------
window.GorevTakvim.mount({
  personKey,
  notify: (message) => toast(message),
  onDayClick: (due) => openDialog(null, due),
  onTaskClick: (id) => { const task = tasks.find((t) => t.id === id); if (task) openDialog(task); },
  onMove: moveTask,
});

// ---------- Başlat ----------
purgeLegacyStorage();
setNoteText('');
render();
openProfilePicker();
