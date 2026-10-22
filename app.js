/* =============================================================================
   Unipakt Görev Masası — istemci
   Tüm veri Supabase'deki SECURITY DEFINER fonksiyonlarından (RPC) geçer.
   Tarayıcıda yalnızca publishable key bulunur; oturum anahtarı sadece
   bellekte tutulur (sayfa kapanınca biter). Görev ve notlar cihaza
   kaydedilmez. Takvim sekmesi calendar.js içindedir.

   Roller (sunucuda zorunlu tutulur, burada yalnızca arayüz için yansıtılır):
     owner  (Akif)          herkese görev atar, Merkez üyesi ekler
     merkez (Mehmet, Uğur)  kendine ve Yönetim Kurulu'na atar, YK üyesi ekler
     yk     (Yönetim Kurulu) yalnızca kendi görevlerini görür ve ekler
   ============================================================================= */

// ---------- Ayarlar ----------
const SUPABASE_URL = 'https://jbheyqmqickfuuhyesog.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jfLnVG_RBLbzj8-HftUFlA_xgZ0Ag6X';
const POLL_MS = 8000;
const NOTE_MAX = 600;
const UNDO_MS = 5000;
const MERKEZ = 'merkez'; // "Tüm Merkez" ortak sorumlu kimliği
const VIEW_LABELS = { tasks: 'Görevler', calendar: 'Takvim', reports: 'Raporlar', team: 'Ekip' };
const ROLE_LABELS = { owner: 'Merkez · Yönetici', merkez: 'Merkez', yk: 'Yönetim Kurulu' };
const STATUSES = [
  { id: 'todo', label: 'Yapılacak' },
  { id: 'doing', label: 'Devam ediyor' },
  { id: 'waiting', label: 'Beklemede' },
  { id: 'done', label: 'Tamamlandı' },
];
// v3 SQL çalıştırılmadıysa kullanılan eski sabit profiller
const LEGACY_PROFILES = [
  { id: 'akif', name: 'Akif', initial: 'A', color: '#8b7cf0', role: 'owner' },
  { id: 'mehmet', name: 'Mehmet', initial: 'M', color: '#45b5a6', role: 'merkez' },
  { id: 'ugur', name: 'Uğur', initial: 'U', color: '#f0a75f', role: 'merkez' },
];

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ---------- Durum ----------
let serverV3 = null;             // v3_team.sql çalıştırıldı mı
let loginProfiles = [];          // giriş ekranındaki kişiler
let activeProfile = null;        // seçilen profil kimliği
let authenticatedProfile = null; // oturumun sahibi
let accessToken = null;          // yalnızca bellekte
let me = null;                   // { id, name, initial, role, color }
let team = [];                   // ekip listesi (rollerle)
let tasks = [];
let filter = 'all';              // 'all' | 'open' | 'done'
let scope = 'mine';              // 'mine' | 'team'
let layout = 'list';             // 'list' | 'board'
let projectFilter = null;
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
let pinForced = false;           // ilk girişte kod değiştirme zorunluluğu

// ---------- Yardımcılar ----------
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));
const lowerTr = (value) => String(value || '').toLocaleLowerCase('tr-TR');
const safeId = (id) => (/^[a-z0-9-]{1,40}$/.test(id || '') ? id : 'other');
const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#8e8c9a');
const PIN_LEN = () => (serverV3 ? 6 : 4);

const person = (id) => (id === MERKEZ
  ? { id: MERKEZ, name: 'Tüm Merkez', initial: 'TM', color: '#d986b4', role: 'merkez' }
  : team.find((p) => p.id === id) || loginProfiles.find((p) => p.id === id) || null);
const personName = (id) => person(id)?.name || '';
const isLead = () => me && (me.role === 'owner' || me.role === 'merkez');

/** Eski serbest metin sorumluları kimliğe çevirir (v3 öncesi kayıtlar için). */
function legacyAssigneeId(name) {
  const n = lowerTr(name).trim();
  if (n === 'uğur' || n === 'ugur') return 'ugur';
  if (n === 'akif' || n === 'mehmet') return n;
  return MERKEZ;
}

/** Ekipteki her kişi için renk sınıfı (.p-<kimlik>) üretir. */
function applyPersonColors() {
  const rules = [...team, person(MERKEZ)].map((p) => `.p-${safeId(p.id)}{--pc:${safeColor(p.color)}}`).join('');
  let tag = $('#person-colors');
  if (!tag) { tag = document.createElement('style'); tag.id = 'person-colors'; document.head.append(tag); }
  tag.textContent = rules;
}

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
  if (/TASK_NOT_FOUND/.test(msg)) return 'Bu görev silinmiş ya da artık sana görünmüyor.';
  if (/NOT_ALLOWED/.test(msg)) return 'Bu işlem için yetkin yok.';
  if (isMissingSchema(error)) return 'Bu özellik için Supabase güncellemesi gerekiyor.';
  const field = /INVALID_TASK:(\w+)/.exec(msg)?.[1];
  return {
    title: 'Başlık 1–120 karakter olmalı.',
    detail: 'Detay en fazla 400 karakter olabilir.',
    assignee: 'Geçerli bir sorumlu seç.',
    priority: 'Öncelik geçersiz.',
    kind: 'Kayıt türü geçersiz.',
    meet_date: 'Meet için tarih seçmelisin.',
    meet_time: 'Meet için saat seçmelisin.',
    meet_link: 'Meet bağlantısı https:// ile başlamalı.',
    due: 'Son tarih geçersiz.',
    status: 'Durum geçersiz.',
    project: 'Proje adı en fazla 40 karakter olabilir.',
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

// ---------- Yetkiler (sunucudaki kuralların arayüz yansıması) ----------
/** Bu kişiye bu türde kayıt atayabilir miyim? */
function canAssign(assigneeId, kind = 'task') {
  if (!me) return false;
  if (assigneeId === MERKEZ) return me.role === 'owner' || (me.role === 'merkez' && kind === 'meet');
  const p = team.find((x) => x.id === assigneeId && x.active !== false);
  if (!p) return false;
  if (me.role === 'owner') return true;
  if (me.role === 'merkez') return p.id === me.id || p.role === 'yk';
  return p.id === me.id;
}
function canEdit(task) {
  if (!me) return false;
  if (me.role === 'owner') return true;
  if (me.role === 'merkez') return task.createdBy === me.id || task.assigneeId === me.id || person(task.assigneeId)?.role === 'yk';
  return task.createdBy === me.id && task.assigneeId === me.id;
}
const canDelete = (task) => me && (me.role === 'owner' || task.createdBy === me.id);

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
  me = null;
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
  const done = Boolean(row.done);
  return {
    id: row.id, title: row.title, detail: row.detail || '',
    assignee: row.assignee, assigneeId: row.assignee_id || legacyAssigneeId(row.assignee),
    due: row.due || '', done, priority: row.priority || 'normal',
    status: row.status || (done ? 'done' : 'todo'), project: row.project || '',
    createdAt: row.created_at, completedAt: row.completed_at,
    createdBy: row.created_by || null, completedBy: row.completed_by || null,
    updatedAt: row.updated_at || null,
    kind: row.kind === 'meet' ? 'meet' : 'task',
    meetTime: row.meet_time ? String(row.meet_time).slice(0, 5) : '',
    meetLink: row.meet_link || '',
  };
}
const isMeet = (task) => task.kind === 'meet';
/** Bağlantı yalnızca https ise kullanılır (sayfaya zararlı bağlantı girmesin). */
const safeLink = (url) => (/^https:\/\/[^\s"'<>]+$/.test(url || '') ? url : '');

/** Sunucuya gönderilen görev alanları (düzenlenebilir olanlar). */
const editablePayload = (task) => ({
  id: task.id, title: task.title, detail: task.detail || '',
  assignee_id: task.assigneeId, assignee: personName(task.assigneeId) || task.assignee, // assignee: eski sürüm uyumu
  due: task.due || null, priority: task.priority || 'normal', project: task.project || '',
  kind: task.kind || 'task', meet_time: isMeet(task) ? task.meetTime || null : null,
  meet_link: isMeet(task) ? task.meetLink || null : null,
});

async function refreshTasks() {
  if (!activeProfile || !accessToken) return;
  const list = await rpc('list_tasks', { p_session_token: accessToken });
  if (list.expired) return;
  if (list.error) { setSyncStatus('Bağlantı bekleniyor', true); return; }
  tasks = (list.data || []).map(taskFromDb);

  if (serverV3 && isLead()) await loadTeam(); // yeni eklenen kişiler herkeste görünsün

  const note = await rpc('get_profile_note', { p_session_token: accessToken, p_profile_id: activeProfile });
  if (note.expired) return;
  if (!note.error && document.activeElement !== $('#sticky-note')) setNoteText(note.data || '');
  setSyncStatus(note.error ? 'Not eşitlenemedi' : 'Ortak kayıt açık', Boolean(note.error));
  render();
}

/** Yalnızca YENİ görevi gönderir; başkalarının görevlerine dokunmaz. */
async function addTask(task) {
  return rpc('add_task', { p_session_token: accessToken, p_task: editablePayload(task) });
}

/** Görevi düzenler. Arada başkası değiştirdiyse TASK_CONFLICT döner. */
async function updateTask(task, expectedUpdatedAt) {
  return rpc('update_task', { p_session_token: accessToken, p_task: editablePayload(task), p_expected: expectedUpdatedAt || null });
}

/** Durum değiştirir (pano, onay kutusu). Başarısız olursa eski hâline döner. */
async function setStatus(task, status) {
  if (task.status === status) return;
  const before = { status: task.status, done: task.done, completedAt: task.completedAt, completedBy: task.completedBy };
  task.status = status;
  task.done = status === 'done';
  task.completedAt = task.done ? (before.done ? before.completedAt : new Date().toISOString()) : null;
  task.completedBy = task.done ? (before.done ? before.completedBy : me?.id) : null;
  render();
  let result;
  if (serverV3) {
    result = await rpc('set_task_status', { p_session_token: accessToken, p_task_id: task.id, p_status: status });
    if (!result.error) task.updatedAt = result.data;
  } else {
    result = await rpc('update_task_state', { p_session_token: accessToken, p_task_id: task.id, p_done: task.done, p_completed_at: task.completedAt });
  }
  if (result.expired) return;
  if (result.error) { Object.assign(task, before); toast(taskErrorMessage(result.error)); }
  setSyncStatus(result.error ? 'Eşitleme başarısız' : 'Ortak kayıt açık', Boolean(result.error));
  render();
}

/** Son tarihi değiştirir (takvimde sürükle-bırak). */
async function moveTask(id, due) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (!canEdit(task)) { toast('Bu görevin tarihini değiştirme yetkin yok.'); return; }
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

// ---------- Ekip ----------
async function loadTeam() {
  if (!serverV3) { team = LEGACY_PROFILES.map((p) => ({ ...p, active: true })); applyPersonColors(); return; }
  const { data, error } = await rpc('list_team', { p_session_token: accessToken });
  if (!error && data) { team = data; applyPersonColors(); }
}

/** Oturumun sahibini öğrenir; ilk girişte kod değişikliği gerekiyorsa söyler. */
async function loadMe() {
  if (!serverV3) {
    me = { ...LEGACY_PROFILES.find((p) => p.id === activeProfile), mustChange: false };
    return true;
  }
  const { data, error, expired } = await rpc('my_session', { p_session_token: accessToken });
  if (expired || error || !data) return false;
  me = { id: data.id, name: data.name, initial: data.initial, role: data.role, color: data.color, mustChange: data.must_change_pin };
  return true;
}

// ---------- Çalışma alanı ----------
async function openWorkspace() {
  $('#profile-picker').classList.add('hidden');
  $('#code-gate').classList.add('hidden');
  $('.shell').classList.remove('hidden');
  $('#profile-name').textContent = me.name;
  $('#profile-avatar').textContent = me.initial;
  $('#profile-role').textContent = ROLE_LABELS[me.role] || 'Unipakt ekibi';
  $('.note-head span:last-of-type').textContent = `${me.name.toLocaleUpperCase('tr-TR')} · NOT`;
  $('#nav-team').classList.toggle('hidden', !isLead() || !serverV3);
  $('#scope-tabs').classList.toggle('hidden', !isLead());
  $('#open-meet').classList.toggle('hidden', !isLead());
  setNoteText('');
  scope = 'mine';
  projectFilter = null;
  syncSegments();
  setView('tasks');
  setFilter('all');
  tasks = [];
  render();
  setSyncStatus('Bağlanıyor…');

  stopPolling();
  await loadTeam();
  await refreshTasks();
  startPolling();
}

// ---------- Giriş ekranı ----------
async function loadLoginProfiles() {
  const { data, error } = await db.rpc('list_login_profiles');
  serverV3 = !error;
  loginProfiles = !error && data?.length ? data : LEGACY_PROFILES;
  $('#profile-options').innerHTML = loginProfiles.map((p) => `<button class="profile-option" data-profile="${escapeHtml(safeId(p.id))}">`
    + `<span class="profile-tile" style="background:${safeColor(p.color)}">${escapeHtml(p.initial)}</span><strong>${escapeHtml(p.name)}</strong></button>`).join('');
}
$('#profile-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-profile]');
  if (button) chooseProfile(button.dataset.profile);
});

function pinMessage(message) { $('#pin-error').textContent = message; }

function setPinTexts(title, subtitle, label, submit) {
  $('#pin-title').textContent = title;
  $('#pin-subtitle').textContent = subtitle;
  $('#pin-label').textContent = label;
  $('#pin-submit').textContent = submit;
}

function showPinGate(mode, returnToWorkspace = false, forced = false) {
  pinMode = mode; pinStage = 'first'; pendingPin = ''; pinReturnToWorkspace = returnToWorkspace; pinForced = forced;
  $('#profile-picker').classList.add('hidden');
  $('.shell').classList.add('hidden');
  $('#code-gate').classList.remove('hidden');
  $('#pin-code').value = '';
  $('#pin-code').maxLength = mode === 'login' ? 6 : PIN_LEN();
  pinMessage('');
  const name = personName(activeProfile);
  const len = PIN_LEN();
  if (mode === 'login') setPinTexts(`${name} için giriş kodu`, 'Giriş kodunu gir.', 'Giriş kodu', 'Giriş yap');
  else if (forced) setPinTexts('Kendi kodunu belirle', `Güvenliğin için ${len} haneli yeni bir giriş kodu belirle. Bu kodu kimseyle paylaşma.`, 'Yeni kod', 'Devam et');
  else setPinTexts(mode === 'change' ? 'Yeni giriş kodu' : `${name} için kod belirle`, `${len} haneli yeni kodunu oluştur.`, 'Yeni kod', 'Devam et');
  $('#pin-code').focus();
}

function openProfilePicker() {
  if (pinForced && accessToken) return; // kod değiştirilmeden çıkılamaz
  stopPolling();
  $('#code-gate').classList.add('hidden');
  $('.shell').classList.add('hidden');
  $('#profile-picker').classList.remove('hidden');
  $('#pin-change').classList.toggle('hidden', !accessToken || authenticatedProfile !== activeProfile);
}

/** Kod doğrulandı: oturumu kur, gerekiyorsa kod değiştirmeye zorla. */
async function continueAfterPin(token) {
  accessToken = token;
  authenticatedProfile = activeProfile;
  if (!(await loadMe())) { pinMessage('Oturum açılamadı. Tekrar dene.'); accessToken = null; return; }
  if (me.mustChange) { showPinGate('change', true, true); return; }
  if (pinReturnToWorkspace) openWorkspace(); else openProfilePicker();
}

async function chooseProfile(profileId) {
  activeProfile = profileId;
  if (accessToken && authenticatedProfile === profileId && me) { await openWorkspace(); return; }
  stopPolling();
  accessToken = null; authenticatedProfile = null; me = null;
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
  setPinTexts('Yeni giriş kodu', `${PIN_LEN()} haneli yeni kodunu oluştur.`, 'Yeni kod', 'Devam et');
  $('#pin-code').focus();
}

async function submitPin(pin) {
  const input = $('#pin-code');

  if (pinMode === 'login') {
    const { data, error } = await db.rpc('verify_access_pin', { p_profile_id: activeProfile, p_pin: pin });
    if (error) throw error;
    if (!data) { pinMessage('Kod doğru değil. Tekrar dene.'); input.value = ''; input.focus(); return; }
    await continueAfterPin(data);
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
  const wasForced = pinForced;
  pinForced = false;
  if (pinMode === 'change') {
    if (me) me.mustChange = false;
    toast('Giriş kodun güncellendi.');
    if (wasForced || pinReturnToWorkspace) openWorkspace(); else openProfilePicker();
    return;
  }
  await continueAfterPin(result.data);
}

$('#pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = $('#pin-code').value.trim();
  const len = PIN_LEN();
  if (pinMode === 'login' ? !/^\d{4,6}$/.test(pin) : !new RegExp(`^\\d{${len}}$`).test(pin)) {
    pinMessage(pinMode === 'login' ? 'Kod 4–6 rakamdan oluşmalı.' : `Yeni kod ${len} rakamdan oluşmalı.`);
    return;
  }
  $('#pin-submit').disabled = true;
  pinMessage('');
  try {
    await submitPin(pin);
  } catch (error) {
    const locked = /PIN_LOCKED:(\d+)/.exec(error?.message || '');
    if (locked) {
      pinMessage(`Çok fazla hatalı deneme. ${locked[1]} dakika sonra tekrar dene.`);
      $('#pin-code').value = '';
    } else if (/six digits/i.test(error?.message || '')) {
      pinMessage('Yeni kod 6 rakamdan oluşmalı.');
    } else {
      pinMessage(isMissingSchema(error) ? 'Supabase SQL kurulumu henüz yapılmamış.' : 'Supabase bağlantısı kurulamadı. Tekrar dene.');
    }
  } finally {
    $('#pin-submit').disabled = false;
  }
});
$('#pin-change').addEventListener('click', () => showPinGate('change', Boolean(activeProfile)));
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
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

/**
 * Açık görev sırası: Meet'ler, sonra dikkat isteyenler (geciken, bugün biten, acil),
 * kendi içinde acil önce, sonra son tarihe göre, tarihsizler en sonda.
 */
function sortOpen(list) {
  const today = todayKey();
  const attention = (t) => (isMeet(t) ? -1 : (t.due && t.due <= today) || t.priority === 'urgent' ? 0 : 1);
  return list.sort((a, b) => attention(a) - attention(b)
    || (isMeet(a) && isMeet(b) ? `${a.due} ${a.meetTime}`.localeCompare(`${b.due} ${b.meetTime}`) : 0)
    || (b.priority === 'urgent') - (a.priority === 'urgent')
    || (a.due || '9999-12-31').localeCompare(b.due || '9999-12-31')
    || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** Benim ekranım: bana atananlar + (Merkez isem) Tüm Merkez işleri. */
function isMine(task) {
  if (!me) return false;
  return task.assigneeId === me.id || (task.assigneeId === MERKEZ && isLead());
}
/** Kapsam + proje + arama filtresinden geçen görevler. */
function scopedTasks() {
  return tasks.filter((t) => (scope === 'team' && isLead() ? true : isMine(t))
    && (!projectFilter || t.project === projectFilter)
    && (!searchQuery || lowerTr(`${t.title} ${t.detail} ${personName(t.assigneeId)} ${t.project}`).includes(searchQuery)));
}

function whoLine(task) {
  const parts = [];
  if (task.createdBy && task.createdBy !== task.assigneeId) parts.push(`${personName(task.createdBy)} atadı`);
  else if (task.createdBy) parts.push(`${personName(task.createdBy)} ekledi`);
  if (task.done && task.completedBy) parts.push(`${personName(task.completedBy)} tamamladı`);
  return parts.join(' · ');
}

const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || '';

function taskRowHtml(task) {
  const id = escapeHtml(task.id);
  const today = todayKey();
  const late = !task.done && task.due && task.due < today;
  const soon = !task.done && task.due === today;
  const urgent = task.priority === 'urgent';
  const meet = isMeet(task);
  const when = meet && task.meetTime ? ` · ${task.meetTime}` : '';
  const lateText = meet ? 'Geçti · ' : 'Gecikti · ';
  const due = task.due ? `<span class="due ${late ? 'late' : soon ? 'soon' : ''}">${late ? lateText : soon ? 'Bugün · ' : ''}${dateLabel(task.due)}${when}</span>` : '';
  const link = meet && !task.done ? safeLink(task.meetLink) : '';
  const join = link ? `<a class="meet-join" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Katıl</a>` : '';
  const badge = meet ? '<span class="badge-meet">● Meet</span>' : urgent ? '<span class="badge-urgent">Acil</span>' : '';
  const state = !task.done && (task.status === 'doing' || task.status === 'waiting')
    ? `<span class="status-pill s-${task.status}">${statusLabel(task.status)}</span>` : '';
  const project = task.project ? `<span class="project-tag">#${escapeHtml(task.project)}</span>` : '';
  const who = whoLine(task);
  return `<div class="task-row ${task.done ? 'completed' : ''} ${urgent && !task.done && !meet ? 'urgent' : ''} ${meet ? 'meet' : ''}">`
    + `<input class="check" type="checkbox" data-toggle="${id}" ${task.done ? 'checked' : ''} aria-label="${task.done ? 'Tamamlandı' : 'Tamamlandı olarak işaretle'}">`
    + `<button type="button" class="task-content" data-edit="${id}" title="${canEdit(task) ? 'Düzenle' : 'Ayrıntılar'}">`
    + `<span class="task-title">${badge}${escapeHtml(task.title)}</span>`
    + `${task.detail ? `<span class="task-detail">${escapeHtml(task.detail)}</span>` : ''}`
    + `<span class="task-who">${state}${project}${who ? `<span>${escapeHtml(who)}</span>` : ''}</span></button>`
    + `<div class="task-meta">${join}${due}<span class="assignee p-${safeId(task.assigneeId)}">${escapeHtml(personName(task.assigneeId) || task.assignee)}</span></div>`
    + `${canDelete(task) ? `<button class="delete-task" data-delete="${id}" aria-label="Görevi sil" title="Görevi sil">×</button>` : '<span class="delete-spacer"></span>'}</div>`;
}

/** Liste: Benim görevlerim (düz) ya da Ekip takibi (kişi kişi gruplu). */
function renderList(list) {
  const open = sortOpen(list.filter((t) => !t.done));
  const completed = list.filter((t) => t.done).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  const pick = (arr) => (filter === 'open' ? arr.filter((t) => !t.done) : filter === 'done' ? arr.filter((t) => t.done) : arr);

  if (scope === 'team' && isLead()) {
    const groups = [person(MERKEZ), ...team.filter((p) => p.active !== false)];
    const today = todayKey();
    const html = groups.map((p) => {
      const mine = list.filter((t) => t.assigneeId === p.id);
      if (!mine.length && p.id === MERKEZ) return '';
      const doneCount = mine.filter((t) => t.done).length;
      const lateCount = mine.filter((t) => !t.done && t.due && t.due < today).length;
      const rows = pick([...sortOpen(mine.filter((t) => !t.done)), ...mine.filter((t) => t.done)]);
      return `<div class="team-group p-${safeId(p.id)}"><div class="team-group-head">`
        + `<span class="avatar small" style="background:${safeColor(p.color)}">${escapeHtml(p.initial)}</span>`
        + `<div><strong>${escapeHtml(p.name)}</strong><small>${ROLE_LABELS[p.role] || ''}</small></div>`
        + `<span class="group-stats">${mine.length - doneCount} açık${lateCount ? ` · <b class="late">${lateCount} geciken</b>` : ''}</span>`
        + `<span class="progress" title="%${pct(doneCount, mine.length)} tamamlandı"><i style="width:${pct(doneCount, mine.length)}%"></i></span></div>`
        + `${rows.length ? rows.map(taskRowHtml).join('') : '<div class="group-empty">Görev yok</div>'}</div>`;
    }).join('');
    $('#task-list').innerHTML = html;
    return list.length;
  }
  const visible = pick([...open, ...completed]);
  $('#task-list').innerHTML = visible.map(taskRowHtml).join('');
  return visible.length;
}

/** Pano: dört durum sütunu, kartlar sürüklenebilir (telefonda durum menüsü). */
function renderBoard(list) {
  const today = todayKey();
  $('#task-board').innerHTML = STATUSES.map((s) => {
    const items = s.id === 'done'
      ? list.filter((t) => t.status === 'done').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 30)
      : sortOpen(list.filter((t) => t.status === s.id));
    return `<section class="board-col s-${s.id}" data-status="${s.id}"><header><span>${s.label}</span><b>${items.length}</b></header>`
      + `<div class="board-cards">${items.map((t) => {
        const late = !t.done && t.due && t.due < today;
        return `<article class="card ${isMeet(t) ? 'meet' : ''} ${t.priority === 'urgent' && !isMeet(t) ? 'urgent' : ''}" draggable="true" data-card="${escapeHtml(t.id)}">`
          + `<button type="button" class="card-title" data-edit="${escapeHtml(t.id)}">${isMeet(t) ? '<span class="badge-meet">● Meet</span>' : ''}${escapeHtml(t.title)}</button>`
          + `<div class="card-meta">${t.project ? `<span class="project-tag">#${escapeHtml(t.project)}</span>` : ''}`
          + `${t.due ? `<span class="due ${late ? 'late' : ''}">${dateLabel(t.due)}${isMeet(t) && t.meetTime ? ` · ${t.meetTime}` : ''}</span>` : ''}`
          + `<span class="assignee p-${safeId(t.assigneeId)}">${escapeHtml(personName(t.assigneeId) || t.assignee)}</span></div>`
          + `<select class="card-status" data-status-for="${escapeHtml(t.id)}" aria-label="Durumu değiştir">${STATUSES.map((o) => `<option value="${o.id}" ${o.id === t.status ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`
          + '</article>';
      }).join('') || '<div class="board-empty">Boş</div>'}</div></section>`;
  }).join('');
  return list.length;
}

/** Proje şeridi: her projenin ilerlemesi; tıklayınca o projeye süzülür. */
function renderProjects(base) {
  const map = new Map();
  for (const t of base) {
    if (!t.project) continue;
    const m = map.get(t.project) || { total: 0, done: 0 };
    m.total += 1; if (t.done) m.done += 1;
    map.set(t.project, m);
  }
  if (projectFilter && !map.has(projectFilter)) projectFilter = null;
  const chips = [...map.entries()].sort((a, b) => b[1].total - a[1].total).map(([name, m]) => {
    const p = pct(m.done, m.total);
    return `<button type="button" class="project-chip ${projectFilter === name ? 'active' : ''}" data-project="${escapeHtml(name)}">`
      + `<span>#${escapeHtml(name)}</span><small>${m.done}/${m.total}</small><span class="progress"><i style="width:${p}%"></i></span><b>%${p}</b></button>`;
  });
  $('#project-strip').innerHTML = chips.length
    ? `<button type="button" class="project-chip all ${projectFilter ? '' : 'active'}" data-project="">Tüm projeler</button>${chips.join('')}` : '';
  $('#project-options').innerHTML = [...new Set(tasks.map((t) => t.project).filter(Boolean))].map((p) => `<option value="${escapeHtml(p)}">`).join('');
}

function reportRowHtml(task) {
  const by = task.completedBy ? ` · ${escapeHtml(personName(task.completedBy))}` : '';
  return `<div class="report-row"><div class="report-name">${escapeHtml(task.title)}${task.project ? ` <span class="project-tag">#${escapeHtml(task.project)}</span>` : ''}</div>`
    + `${task.detail ? `<div class="report-detail">${escapeHtml(task.detail)}</div>` : ''}`
    + `<div class="report-date">Tamamlandı: ${task.completedAt ? longDate(task.completedAt) : 'Tarih yok'}${by}</div>`
    + `<span class="report-badge">✓ ${escapeHtml(personName(task.assigneeId) || task.assignee)}</span></div>`;
}

function render() {
  const today = todayKey();
  // Proje şeridi ve özet kartları, proje süzgecinden ÖNCEKİ kapsamı gösterir
  const savedProject = projectFilter;
  projectFilter = null;
  const base = scopedTasks();
  projectFilter = savedProject;
  renderProjects(base);
  const list = scopedTasks();

  const open = list.filter((t) => !t.done);
  $('#stat-open').textContent = open.length;
  $('#nav-open').textContent = tasks.filter((t) => isMine(t) && !t.done).length;
  $('#stat-done').textContent = list.filter((t) => t.done && isToday(t.completedAt)).length;
  $('#stat-late').textContent = open.filter((t) => t.due && t.due < today).length;

  const teamMode = scope === 'team' && isLead();
  $('#panel-title').textContent = teamMode ? 'Ekip takibi' : 'Görevlerim';
  $('#panel-sub').textContent = teamMode ? 'Herkesin işleri kişi kişi' : (isLead() ? 'Sana ve Tüm Merkez’e atanan işler' : 'Sana atanan işler');
  $('#task-list').classList.toggle('hidden', layout === 'board');
  $('.workspace-grid').classList.toggle('board-mode', layout === 'board');
  $('#task-board').classList.toggle('hidden', layout !== 'board');
  $('#status-filters').classList.toggle('hidden', layout === 'board');

  const count = layout === 'board' ? renderBoard(list) : renderList(list);
  const narrowed = Boolean(searchQuery || projectFilter || filter !== 'all');
  $('#empty-state').style.display = count || (teamMode && layout === 'list') ? 'none' : 'block';
  $('#empty-title').textContent = narrowed && tasks.length ? 'Eşleşen görev yok' : 'Henüz görev yok';
  $('#empty-text').textContent = narrowed && tasks.length ? 'Filtreleri veya aramayı değiştir.' : 'İlk görevi ekleyerek başlayın.';

  // Raporlar: yetkin olan her şey (YK için yalnızca kendi işleri)
  const completed = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  const week = new Date(); week.setDate(week.getDate() - 6); week.setHours(0, 0, 0, 0);
  $('#report-total').textContent = completed.length;
  $('#report-week').textContent = completed.filter((t) => t.completedAt && new Date(t.completedAt) >= week).length;
  $('#report-list').innerHTML = completed.map(reportRowHtml).join('');
  $('#report-empty').style.display = completed.length ? 'none' : 'block';

  if (currentView === 'team') renderTeam();
  window.GorevTakvim.render(tasks);
}

function setView(view) {
  if (view === 'team' && !isLead()) view = 'tasks';
  currentView = view;
  $$('.view').forEach((section) => section.classList.toggle('hidden', section.id !== `${view}-view`));
  $('#crumb-view').textContent = VIEW_LABELS[view];
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'calendar') window.GorevTakvim.render(tasks);
  if (view === 'team') renderTeam();
}

function setFilter(value) {
  filter = value;
  $$('.filter[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === value));
}
function syncSegments() {
  $$('#scope-tabs [data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
  $$('#layout-tabs [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
}

$$('.filter[data-filter]').forEach((button) => button.addEventListener('click', () => { setFilter(button.dataset.filter); render(); }));
$$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#scope-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-scope]'); if (!b) return; scope = b.dataset.scope; syncSegments(); render(); });
$('#layout-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]'); if (!b) return;
  layout = b.dataset.layout; syncSegments(); render();
  try { localStorage.setItem('gorev-layout', layout); } catch { /* yoksay */ }
});
$('#project-strip').addEventListener('click', (e) => {
  const b = e.target.closest('[data-project]'); if (!b) return;
  projectFilter = b.dataset.project && b.dataset.project !== projectFilter ? b.dataset.project : null;
  render();
});
$('#task-search').addEventListener('input', (event) => { searchQuery = lowerTr(event.target.value.trim()); render(); });

// ---------- Görev formu (ekle / düzenle) ----------
const form = $('#task-form');

/** Sorumlu listesi: yalnızca atama yetkim olan kişiler (+ düzenlenen görevin mevcut sorumlusu). */
function fillAssigneeOptions(selected, kind) {
  const options = [person(MERKEZ), ...team.filter((p) => p.active !== false)].filter((p) => canAssign(p.id, kind));
  if (selected && !options.some((p) => p.id === selected) && person(selected)) options.unshift(person(selected));
  form.elements.assignee.innerHTML = options.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.id === me?.id ? ' (ben)' : ''}</option>`).join('');
  form.elements.assignee.value = options.some((p) => p.id === selected) ? selected : (options.find((p) => p.id === me?.id) || options[0])?.id || '';
  form.elements.assignee.disabled = options.length <= 1;
}

/** Formu görev ya da meet moduna geçirir. */
function setFormKind(kind, isEdit) {
  const meet = kind === 'meet';
  form.elements.kind.value = meet ? 'meet' : 'task';
  $('#task-dialog').classList.toggle('is-meet', meet);
  $('#meet-fields').classList.toggle('hidden', !meet);
  form.querySelector('.priority-field').classList.toggle('hidden', meet);
  form.elements.meet_time.required = meet;
  form.elements.due.required = meet;
  $('#due-label').textContent = meet ? 'Tarih' : 'Son tarih';
  $('#title-label').textContent = meet ? 'Meet adı' : 'Görev adı';
  form.elements.title.placeholder = meet ? 'Örn. Sponsor görüşmesi' : 'Örn. Haftalık stok kontrolünü yap';
  $('#dialog-eyebrow').textContent = meet ? (isEdit ? 'MEET · DÜZENLE' : 'ÇOK ÖNEMLİ') : (isEdit ? 'DÜZENLE' : 'YENİ İŞ');
  $('#dialog-title').textContent = meet ? (isEdit ? 'Meet’i düzenle' : 'Meet oluştur') : (isEdit ? 'Görevi düzenle' : 'Görev oluştur');
  $('#dialog-submit').textContent = isEdit ? 'Kaydet' : meet ? 'Meet’i oluştur' : 'Görevi ekle';
}

/**
 * @param {object} [task] verilirse düzenleme modu
 * @param {string} [due] yeni görev için hazır son tarih (takvimden)
 * @param {'task'|'meet'} [kind] yeni kaydın türü
 */
function openDialog(task, due, kind = 'task') {
  editing = task ? { id: task.id, updatedAt: task.updatedAt } : null;
  form.reset();
  $('#task-form-error').textContent = '';
  const k = task ? task.kind : kind;
  setFormKind(k, Boolean(task));
  fillAssigneeOptions(task ? task.assigneeId : k === 'meet' && canAssign(MERKEZ, 'meet') ? MERKEZ : me?.id, k);
  form.elements.meet_time.value = task?.meetTime || '';
  form.elements.meet_link.value = task?.meetLink || '';
  form.elements.title.value = task?.title || '';
  form.elements.detail.value = task?.detail || '';
  form.elements.due.value = task?.due || due || '';
  form.elements.priority.value = task?.priority || 'normal';
  form.elements.project.value = task?.project || (projectFilter && !task ? projectFilter : '');
  form.elements.status.value = task?.status || 'todo';
  $('#status-field').classList.toggle('hidden', !task);

  // Yetkim yoksa yalnızca görüntüle (durum değiştirilebilir)
  const readOnly = Boolean(task) && !canEdit(task);
  ['title', 'detail', 'due', 'priority', 'project', 'meet_time', 'meet_link'].forEach((n) => { form.elements[n].disabled = readOnly; });
  if (readOnly) form.elements.assignee.disabled = true;
  if (readOnly) { $('#dialog-eyebrow').textContent = 'AYRINTILAR'; $('#dialog-submit').textContent = 'Durumu kaydet'; }
  $('#task-dialog').dataset.readonly = readOnly ? '1' : '';
  $('#task-dialog').showModal();
  (readOnly ? form.elements.status : form.elements.title).focus();
}
const closeDialog = () => { editing = null; $('#task-dialog').close(); };

$('#open-task').addEventListener('click', () => openDialog());
$('#open-meet').addEventListener('click', () => openDialog(null, todayKey(), 'meet'));
$('#empty-add').addEventListener('click', () => openDialog());
$('#close-dialog').addEventListener('click', closeDialog);
$('#cancel-dialog').addEventListener('click', closeDialog);
$('#task-dialog').addEventListener('close', () => { editing = null; });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const original = editing ? tasks.find((t) => t.id === editing.id) : null;

  // Yalnızca görüntüleme: sadece durum değişebilir
  if ($('#task-dialog').dataset.readonly && original) {
    const status = data.get('status');
    closeDialog();
    await setStatus(original, status);
    return;
  }

  const fields = {
    title: data.get('title').trim(),
    detail: data.get('detail').trim(),
    assigneeId: form.elements.assignee.value || me?.id,
    due: data.get('due') || '',
    priority: data.get('priority') === 'urgent' ? 'urgent' : 'normal',
    project: (data.get('project') || '').trim(),
    kind: data.get('kind') === 'meet' ? 'meet' : 'task',
    meetTime: data.get('meet_time') || '',
    meetLink: (data.get('meet_link') || '').trim(),
  };
  if (fields.kind === 'meet') {
    fields.priority = 'urgent';
    if (!fields.due || !fields.meetTime) { $('#task-form-error').textContent = 'Meet için tarih ve saat seçmelisin.'; return; }
    if (fields.meetLink && !safeLink(fields.meetLink)) { $('#task-form-error').textContent = 'Meet bağlantısı https:// ile başlamalı.'; return; }
  }
  const submit = $('#dialog-submit');
  submit.disabled = true;

  if (editing) {
    const updated = { ...(original || {}), ...fields, id: editing.id };
    const { data: updatedAt, error, expired } = await updateTask(updated, editing.updatedAt);
    if (expired) { submit.disabled = false; return; }
    if (error) {
      submit.disabled = false;
      $('#task-form-error').textContent = taskErrorMessage(error);
      if (/TASK_CONFLICT/.test(error.message)) {
        await refreshTasks();
        const fresh = tasks.find((t) => t.id === editing?.id);
        if (fresh && editing) editing.updatedAt = fresh.updatedAt; // yeni hâli gördükten sonra tekrar kaydedebilir
      }
      return;
    }
    const newStatus = data.get('status');
    if (original) Object.assign(original, fields, { updatedAt, assignee: personName(fields.assigneeId) });
    submit.disabled = false;
    closeDialog();
    if (original && newStatus && newStatus !== original.status) await setStatus(original, newStatus);
    render();
    setSyncStatus('Ortak kayıt açık');
    toast(fields.kind === 'meet' ? 'Meet güncellendi.' : 'Görev güncellendi.');
    return;
  }

  const task = {
    id: crypto.randomUUID(), ...fields, assignee: personName(fields.assigneeId), done: false, status: 'todo',
    createdAt: new Date().toISOString(), completedAt: null,
    createdBy: me?.id, completedBy: null, updatedAt: null,
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
  if (task.assigneeId !== me?.id && !isMine(task)) toast(`Görev ${personName(task.assigneeId)}'e atandı. "Ekip takibi"nde görebilirsin.`, null, 4500);
  refreshTasks(); // sunucu saatini (updated_at) hemen al; düzenleme kontrolü için gerekli
});

// "N" yeni görev, "M" yeni Meet
document.addEventListener('keydown', (event) => {
  const keyName = event.key.toLowerCase();
  if (keyName !== 'n' && keyName !== 'm') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  if ($('#task-dialog').open || $('.shell').classList.contains('hidden')) return;
  event.preventDefault();
  if (keyName === 'm' && isLead()) openDialog(null, todayKey(), 'meet'); else if (keyName === 'n') openDialog();
});

// ---------- Görev listesi ve pano: düzenle / tamamla / sil / durum ----------
const findTask = (id) => tasks.find((t) => t.id === id);

$('#task-list').addEventListener('change', (event) => {
  const box = event.target;
  if (!box.matches('[data-toggle]')) return;
  const task = findTask(box.dataset.toggle);
  if (task) setStatus(task, box.checked ? 'done' : 'todo');
});

async function deleteTask(id) {
  const task = findTask(id);
  if (!task) return;
  const { error, expired } = await rpc('delete_task', { p_session_token: accessToken, p_task_id: id });
  if (expired) return;
  if (error) { toast(taskErrorMessage(error)); setSyncStatus('Görev silinemedi', true); return; }
  tasks = tasks.filter((t) => t.id !== id);
  render();
  setSyncStatus('Ortak kayıt açık');
  toast(`${isMeet(task) ? 'Meet' : 'Görev'} silindi: "${task.title}"`, { label: 'Geri al', onClick: () => restoreTask(task) }, UNDO_MS);
}

$('#task-list').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit]');
  if (edit) { const task = findTask(edit.dataset.edit); if (task) openDialog(task); return; }
  const del = event.target.closest('[data-delete]');
  if (del) { del.disabled = true; deleteTask(del.dataset.delete); }
});

$('#task-board').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit]');
  if (edit) { const task = findTask(edit.dataset.edit); if (task) openDialog(task); }
});
$('#task-board').addEventListener('change', (event) => {
  const sel = event.target.closest('[data-status-for]');
  if (!sel) return;
  const task = findTask(sel.dataset.statusFor);
  if (task) setStatus(task, sel.value);
});
// Sürükle-bırak (masaüstü)
let dragCard = null;
$('#task-board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-card]');
  if (!card) return;
  dragCard = card.dataset.card;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragCard);
  card.classList.add('dragging');
});
$('#task-board').addEventListener('dragend', () => {
  dragCard = null;
  $$('#task-board .dragging, #task-board .drop').forEach((x) => x.classList.remove('dragging', 'drop'));
});
$('#task-board').addEventListener('dragover', (e) => {
  const col = e.target.closest('[data-status]');
  if (!col || !dragCard) return;
  e.preventDefault();
  $$('#task-board .drop').forEach((x) => x !== col && x.classList.remove('drop'));
  col.classList.add('drop');
});
$('#task-board').addEventListener('drop', (e) => {
  const col = e.target.closest('[data-status]');
  if (!col || !dragCard) return;
  e.preventDefault();
  const task = findTask(dragCard);
  col.classList.remove('drop');
  if (task) setStatus(task, col.dataset.status);
});

/** Silinen görevi aynen geri koyar. */
async function restoreTask(task) {
  const payload = {
    ...editablePayload(task), done: task.done, status: task.status, created_at: task.createdAt, completed_at: task.completedAt,
    created_by: task.createdBy, completed_by: task.completedBy,
  };
  const result = await rpc('restore_task', { p_session_token: accessToken, p_task: payload });
  if (result.expired) return;
  if (result.error) { toast('Görev geri alınamadı.'); return; }
  await refreshTasks();
  toast('Görev geri alındı.');
}

// ---------- Ekip yönetimi ----------
function renderTeam() {
  if (!isLead()) return;
  const canManage = (p) => p.id !== me.id && p.role !== 'owner' && (me.role === 'owner' || p.role === 'yk');
  $('#team-sub').textContent = `${team.filter((p) => p.active !== false).length} aktif kişi`;
  $('#team-list').innerHTML = team.map((p) => {
    const open = tasks.filter((t) => t.assigneeId === p.id && !t.done).length;
    return `<div class="member-row ${p.active === false ? 'inactive' : ''}">`
      + `<span class="avatar small" style="background:${safeColor(p.color)}">${escapeHtml(p.initial)}</span>`
      + `<div class="member-info"><strong>${escapeHtml(p.name)}${p.id === me.id ? ' <small>(sen)</small>' : ''}</strong><small>${ROLE_LABELS[p.role] || ''}${p.active === false ? ' · pasif' : ` · ${open} açık görev`}</small></div>`
      + (canManage(p) ? `<div class="member-actions"><button type="button" class="secondary" data-reset="${escapeHtml(p.id)}">Kodu sıfırla</button>`
        + `<button type="button" class="secondary" data-active="${escapeHtml(p.id)}" data-to="${p.active === false ? '1' : '0'}">${p.active === false ? 'Aktifleştir' : 'Pasifleştir'}</button></div>` : '')
      + '</div>';
  }).join('');
  $('#member-form').elements.role.querySelector('[value="merkez"]').disabled = me.role !== 'owner';
}

const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const memberError = (error) => {
  const msg = error?.message || '';
  if (/NOT_ALLOWED/.test(msg)) return 'Bu işlem için yetkin yok.';
  if (/INVALID_MEMBER:name/.test(msg)) return 'Ad 1–40 karakter olmalı.';
  if (/INVALID_MEMBER:pin/.test(msg)) return 'Kod 6 rakamdan oluşmalı.';
  if (/INVALID_MEMBER:limit/.test(msg)) return 'Kişi sınırına ulaşıldı.';
  if (isMissingSchema(error)) return 'Bu özellik için Supabase güncellemesi (v3_team.sql) gerekiyor.';
  return 'İşlem yapılamadı. Tekrar dene.';
};

$('#member-pin-gen').addEventListener('click', () => { $('#member-form').elements.pin.value = randomPin(); });
$('#member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = event.currentTarget;
  const name = f.elements.name.value.trim();
  const role = f.elements.role.value;
  const pin = f.elements.pin.value.trim();
  $('#member-error').textContent = '';
  if (!/^\d{6}$/.test(pin)) { $('#member-error').textContent = 'İlk kod 6 rakamdan oluşmalı.'; return; }
  const { error, expired } = await rpc('add_member', { p_session_token: accessToken, p_name: name, p_role: role, p_initial_pin: pin });
  if (expired) return;
  if (error) { $('#member-error').textContent = memberError(error); return; }
  f.reset();
  await loadTeam();
  render();
  toast(`${name} eklendi. İlk giriş kodu: ${pin} — kendisine ilet.`, null, 9000);
});

$('#team-list').addEventListener('click', async (event) => {
  const reset = event.target.closest('[data-reset]');
  const act = event.target.closest('[data-active]');
  if (!reset && !act) return;
  const id = (reset || act).dataset.reset || (reset || act).dataset.active;
  const p = person(id);
  let params;
  if (reset) {
    const pin = window.prompt(`${p?.name} için yeni ilk giriş kodu (6 hane):`, randomPin());
    if (pin === null) return;
    if (!/^\d{6}$/.test(pin.trim())) { toast('Kod 6 rakamdan oluşmalı.'); return; }
    params = { p_active: null, p_reset_pin: pin.trim() };
  } else {
    const toActive = act.dataset.to === '1';
    if (!toActive && !confirm(`${p?.name} pasifleştirilsin mi? Giriş yapamaz, açık oturumu kapanır. Görevleri silinmez.`)) return;
    params = { p_active: toActive, p_reset_pin: null };
  }
  const { error, expired } = await rpc('update_member', { p_session_token: accessToken, p_member_id: id, ...params });
  if (expired) return;
  if (error) { toast(memberError(error)); return; }
  await loadTeam();
  render();
  toast(reset ? `${p?.name} için yeni ilk kod: ${params.p_reset_pin} — kendisine ilet.` : `${p?.name} ${params.p_active ? 'aktifleştirildi' : 'pasifleştirildi'}.`, null, reset ? 9000 : 3200);
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
    ['Görev', 'Tür', 'Proje', 'Detay', 'Sorumlu', 'Öncelik', 'Ekleyen', 'Tamamlayan', 'Tamamlanma tarihi'],
    ...tasks.filter((t) => t.done).map((t) => [
      t.title, isMeet(t) ? `Meet ${t.due} ${t.meetTime}` : 'Görev', t.project, t.detail,
      personName(t.assigneeId) || t.assignee, t.priority === 'urgent' ? 'Acil' : 'Normal',
      personName(t.createdBy), personName(t.completedBy),
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
  personKey: (task) => safeId(task.assigneeId),
  people: () => (isLead() ? [person(MERKEZ), ...team.filter((p) => p.active !== false)] : []).map((p) => ({ id: safeId(p.id), name: p.name })),
  notify: (message) => toast(message),
  onDayClick: (due) => openDialog(null, due),
  onTaskClick: (id) => { const task = findTask(id); if (task) openDialog(task); },
  onMove: moveTask,
});

// ---------- Başlat ----------
purgeLegacyStorage();
try { layout = localStorage.getItem('gorev-layout') === 'board' ? 'board' : 'list'; } catch { /* yoksay */ }
setNoteText('');
loadLoginProfiles().then(openProfilePicker);
