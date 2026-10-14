const PROFILES = { akif: { name: 'Akif', initial: 'A' }, mehmet: { name: 'Mehmet', initial: 'M' }, ugur: { name: 'Uğur', initial: 'U' } };
const SUPABASE_URL = 'https://jbheyqmqickfuuhyesog.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jfLnVG_RBLbzj8-HftUFlA_xgZ0Ag6X';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let activeProfile = null;
let authenticatedProfile = null;
let tasks = [];
let filter = 'all';
let pollTimer = null;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function localTasks(profile) { try { return JSON.parse(localStorage.getItem(`unipakt-tasks-${profile}-v1`) || '[]'); } catch { return []; } }
function localNote(profile) { return localStorage.getItem(`unipakt-note-${profile}-v1`) || (profile === 'akif' ? localStorage.getItem('unipakt-akif-note-v1') || '' : ''); }
function setSyncStatus(text, offline = false) { $('#sync-label').textContent = text; $('.sync-dot').classList.toggle('offline', offline); }
function taskFromDb(row) { return { id: row.id, title: row.title, detail: row.detail || '', assignee: row.assignee, due: row.due || '', done: row.done, createdAt: row.created_at, completedAt: row.completed_at }; }
function taskToDb(task) { return { id: task.id, title: task.title, detail: task.detail || '', assignee: task.assignee, due: task.due || null, done: task.done, created_at: task.createdAt || new Date().toISOString(), completed_at: task.completedAt || null }; }
async function refreshTasks() {
  if (!activeProfile || !accessToken) return;
  const { data, error } = await db.rpc('list_tasks', { p_session_token: accessToken });
  if (error) { setSyncStatus('Bağlantı bekleniyor', true); return; }
  tasks = (data || []).map(taskFromDb);
  try { localStorage.setItem(`unipakt-tasks-${activeProfile}-v1`, JSON.stringify(tasks)); } catch {}
  const noteResult = await db.rpc('get_profile_note', { p_session_token: accessToken, p_profile_id: activeProfile });
  if (!noteResult.error && document.activeElement !== $('#sticky-note')) {
    const text = noteResult.data || '';
    $('#sticky-note').value = text; $('#note-count').textContent = `${text.length}/600`;
  }
  setSyncStatus(noteResult.error ? 'Not eşitlenemedi' : 'Ortak kayıt açık', Boolean(noteResult.error)); render();
}
async function saveTasks() {
  try { localStorage.setItem(`unipakt-tasks-${activeProfile}-v1`, JSON.stringify(tasks)); } catch {}
  render();
  for (const task of tasks) {
    const { error } = await db.rpc('upsert_task', { p_session_token: accessToken, p_task: taskToDb(task) });
    if (error) { setSyncStatus('Eşitleme başarısız', true); return; }
  }
  setSyncStatus('Ortak kayıt açık');
}
async function openWorkspace(profileId) {
  activeProfile = profileId;
  const profile = PROFILES[profileId];
  $('#profile-picker').classList.add('hidden'); $('.shell').classList.remove('hidden');
  $('#profile-name').textContent = profile.name; $('#profile-avatar').textContent = profile.initial;
  $('#task-form').elements.assignee.value = profile.name;
  $('.note-head span:last-of-type').textContent = profileId === 'ugur' ? "UĞUR'UN NOTU" : `${profile.name.toLocaleUpperCase('tr-TR')}'İN NOTU`;
  $('#sticky-note').value = ''; $('#note-count').textContent = '0/600';
  setView('tasks'); filter = 'all';
  document.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
  tasks = []; render(); setSyncStatus('Bağlanıyor…');
  const { data, error } = await db.rpc('list_tasks', { p_session_token: accessToken });
  if (error) { tasks = localTasks(profileId); setSyncStatus('Bağlantı kurulamadı', true); render(); return; }
  tasks = (data || []).map(taskFromDb);
  const legacyTasks = localTasks(profileId);
  if (!tasks.length && legacyTasks.length) {
    let migrated = true;
    for (const task of legacyTasks) {
      const { error: migrateError } = await db.rpc('upsert_task', { p_session_token: accessToken, p_task: taskToDb(task) });
      if (migrateError) { migrated = false; break; }
    }
    if (migrated) tasks = legacyTasks;
  }
  try { localStorage.setItem(`unipakt-tasks-${profileId}-v1`, JSON.stringify(tasks)); } catch {}
  const noteResult = await db.rpc('get_profile_note', { p_session_token: accessToken, p_profile_id: profileId });
  let noteText = noteResult.data || '';
  if (!noteResult.error && !noteText) {
    noteText = localNote(profileId);
    if (noteText) await db.rpc('save_profile_note', { p_session_token: accessToken, p_profile_id: profileId, p_body: noteText });
  }
  $('#sticky-note').value = noteText;
  $('#note-count').textContent = `${noteText.length}/600`;
  setSyncStatus(noteResult.error ? 'Not eşitlenemedi' : 'Ortak kayıt açık', Boolean(noteResult.error));
  render();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshTasks, 8000);
}
let accessToken = null;
let pinMode = 'setup';
let pinStage = 'first';
let pendingPin = '';
let pinReturnToWorkspace = false;
function showPinGate(mode, returnToWorkspace = false) {
  pinMode = mode; pinStage = 'first'; pendingPin = ''; pinReturnToWorkspace = returnToWorkspace;
  $('#profile-picker').classList.add('hidden'); $('.shell').classList.add('hidden'); $('#code-gate').classList.remove('hidden');
  $('#pin-code').value = ''; $('#pin-error').textContent = '';
  const profileName = PROFILES[activeProfile]?.name || '';
  $('#pin-title').textContent = mode === 'login' ? `${profileName} için giriş kodu` : mode === 'change' ? 'Yeni giriş kodu' : `${profileName} için kod belirle`;
  $('#pin-subtitle').textContent = mode === 'login' ? 'Bu profil için belirlenmiş 4 haneli kodu gir.' : 'Bu profile özel 4 haneli yeni kodunu oluştur.';
  $('#pin-label').textContent = mode === 'login' ? 'Giriş kodu' : 'Yeni kod';
  $('#pin-submit').textContent = mode === 'login' ? 'Giriş yap' : 'Devam et';
  $('#pin-code').focus();
}
function openProfilePicker() {
  $('#code-gate').classList.add('hidden'); $('.shell').classList.add('hidden'); $('#profile-picker').classList.remove('hidden');
  $('#pin-change').classList.toggle('hidden', !accessToken || authenticatedProfile !== activeProfile);
}
function pinMessage(message) { $('#pin-error').textContent = message; }
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
  accessToken = null; authenticatedProfile = null;
  $('#pin-change').classList.add('hidden');
  showPinGate('setup', true);
  const { data, error } = await db.rpc('has_access_pin', { p_profile_id: profileId });
  if (error) { pinMessage(error.message?.includes('schema cache') || error.code === 'PGRST202' ? 'Supabase SQL kurulumu henüz yapılmamış. Sayfayı yenileyip tekrar dene.' : 'Supabase bağlantısı kurulamadı. Tekrar dene.'); return; }
  showPinGate(data ? 'login' : 'setup', true);
}
$('#pin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#pin-code');
  const pin = input.value.trim();
  if (!/^\d{4}$/.test(pin)) { pinMessage('Kod 4 rakamdan oluşmalı.'); return; }
  $('#pin-submit').disabled = true; pinMessage('');
  try {
    if (pinMode === 'login') {
      const { data, error } = await db.rpc('verify_access_pin', { p_profile_id: activeProfile, p_pin: pin });
      if (error) throw error;
      if (!data) { pinMessage('Kod doğru değil. Tekrar dene.'); input.value = ''; input.focus(); return; }
      continueAfterPin(data); return;
    }
    if (pinStage === 'first') {
      pendingPin = pin; pinStage = 'confirm'; input.value = '';
      $('#pin-title').textContent = 'Kodu tekrar yaz'; $('#pin-subtitle').textContent = 'Aynı kodu doğrulamak için bir kez daha gir.';
      $('#pin-label').textContent = 'Yeni kodu onayla'; $('#pin-submit').textContent = 'Kodu onayla'; input.focus(); return;
    }
    if (pin !== pendingPin) { pinMessage('Kodlar eşleşmedi. İlk kodu yeniden yaz.'); pinStage = 'first'; pendingPin = ''; input.value = ''; $('#pin-title').textContent = 'Yeni giriş kodu'; $('#pin-subtitle').textContent = '4 haneli yeni kodunu oluştur.'; $('#pin-label').textContent = 'Yeni kod'; $('#pin-submit').textContent = 'Devam et'; input.focus(); return; }
    const result = pinMode === 'setup'
      ? await db.rpc('setup_access_pin', { p_profile_id: activeProfile, p_pin: pin })
      : await db.rpc('change_access_pin', { p_new_pin: pin, p_session_token: accessToken });
    if (result.error) throw result.error;
    if (!result.data) {
      pinMessage(pinMode === 'setup' ? 'Kod daha önce belirlenmiş. Sayfayı yenileyip giriş yap.' : 'Oturumun süresi dolmuş. Önce giriş yap.');
      pendingPin = ''; pinStage = 'first'; return;
    }
    continueAfterPin(pinMode === 'change' ? accessToken : result.data);
  } catch (error) {
    pinMessage(error.message?.includes('schema cache') || error.code === 'PGRST202' ? 'Supabase SQL kurulumu henüz yapılmamış.' : 'Supabase bağlantısı kurulamadı. Tekrar dene.');
  } finally { $('#pin-submit').disabled = false; }
});
$('#pin-change').addEventListener('click', () => showPinGate('change', Boolean(activeProfile)));
document.querySelectorAll('[data-profile]').forEach(button => button.addEventListener('click', () => chooseProfile(button.dataset.profile)));
$('#profile-switch').addEventListener('click', openProfilePicker);
async function initializePinGate() {
  openProfilePicker();
}
function dateLabel(value) { if (!value) return ''; return new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'short'}).format(new Date(`${value}T12:00:00`)); }
function todayKey() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function isToday(value) { return value && new Date(value).toDateString() === new Date().toDateString(); }
function render() {
  const open = tasks.filter(task => !task.done);
  const completed = tasks.filter(task => task.done).sort((a,b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  const visible = (filter === 'open' ? open : filter === 'done' ? completed : [...open,...completed]);
  $('#stat-open').textContent = open.length; $('#nav-open').textContent = open.length;
  $('#stat-done').textContent = completed.filter(task => isToday(task.completedAt)).length;
  $('#stat-late').textContent = open.filter(task => task.due && task.due < todayKey()).length;
  $('#task-list').innerHTML = visible.map(task => {
    const late = !task.done && task.due && task.due < todayKey();
    const soon = !task.done && task.due === todayKey();
    return `<div class="task-row ${task.done?'completed':''}"><input class="check" type="checkbox" data-toggle="${task.id}" ${task.done?'checked':''} aria-label="${task.done?'Tamamlandı':'Tamamlandı olarak işaretle'}"><div class="task-content"><div class="task-title">${escapeHtml(task.title)}</div>${task.detail?`<div class="task-detail">${escapeHtml(task.detail)}</div>`:''}</div><div class="task-meta">${task.due?`<span class="due ${late?'late':soon?'soon':''}">${late?'Gecikti · ':''}${dateLabel(task.due)}</span>`:''}<span class="assignee">${escapeHtml(task.assignee)}</span></div><button class="delete-task" data-delete="${task.id}" aria-label="Görevi sil" title="Görevi sil">×</button></div>`;
  }).join('');
  $('#empty-state').style.display = visible.length ? 'none' : 'block';
  $('#report-total').textContent = completed.length;
  const week = new Date(); week.setDate(week.getDate()-6); week.setHours(0,0,0,0);
  $('#report-week').textContent = completed.filter(task => task.completedAt && new Date(task.completedAt) >= week).length;
  $('#report-list').innerHTML = completed.map(task => `<div class="report-row"><div class="report-name">${escapeHtml(task.title)}</div>${task.detail?`<div class="report-detail">${escapeHtml(task.detail)}</div>`:''}<div class="report-date">Tamamlandı: ${task.completedAt?new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric'}).format(new Date(task.completedAt)): 'Tarih yok'}</div><span class="report-badge">✓ ${escapeHtml(task.assignee)}</span></div>`).join('');
  $('#report-empty').style.display = completed.length ? 'none' : 'block';
}
function setView(view) {
  const reports = view === 'reports'; $('#tasks-view').classList.toggle('hidden',reports); $('#reports-view').classList.toggle('hidden',!reports);
  $('#crumb-view').textContent = reports ? 'Raporlar' : 'Görevler';
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active',button.dataset.view===view));
}
function openDialog() { $('#task-dialog').showModal(); $('#task-form').elements.title.focus(); }
$('#open-task').addEventListener('click',openDialog); $('#empty-add').addEventListener('click',openDialog);
$('#close-dialog').addEventListener('click',()=>$('#task-dialog').close()); $('#cancel-dialog').addEventListener('click',()=>$('#task-dialog').close());
$('#task-form').addEventListener('submit',async event=>{event.preventDefault();const data=new FormData(event.currentTarget);tasks.unshift({id:crypto.randomUUID(),title:data.get('title').trim(),detail:data.get('detail').trim(),assignee:data.get('assignee').trim(),due:data.get('due'),done:false,createdAt:new Date().toISOString()});event.currentTarget.reset();event.currentTarget.elements.assignee.value=PROFILES[activeProfile].name;$('#task-dialog').close();filter='all';document.querySelectorAll('.filter').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));await saveTasks();});
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('.filter').forEach(item=>item.classList.toggle('active',item===button));render();}));
document.querySelectorAll('.nav-item').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$('#task-list').addEventListener('change',async event=>{if(event.target.matches('[data-toggle]')){const task=tasks.find(item=>item.id===event.target.dataset.toggle);task.done=event.target.checked;task.completedAt=task.done?new Date().toISOString():null;const { error } = await db.rpc('update_task_state', { p_session_token: accessToken, p_task_id: task.id, p_done: task.done, p_completed_at: task.completedAt });setSyncStatus(error?'Eşitleme başarısız':'Ortak kayıt açık',Boolean(error));render();}});
$('#task-list').addEventListener('click',async event=>{const button=event.target.closest('[data-delete]');if(button){const { error } = await db.rpc('delete_task', { p_session_token: accessToken, p_task_id: button.dataset.delete });if(error){setSyncStatus('Görev silinemedi',true);return;}tasks=tasks.filter(task=>task.id!==button.dataset.delete);try{localStorage.setItem(`unipakt-tasks-${activeProfile}-v1`,JSON.stringify(tasks));}catch{}render();}});
$('#sticky-note').addEventListener('input',()=>{$('#note-count').textContent=`${$('#sticky-note').value.length}/600`;$('#note-status').textContent='Kaydediliyor…';clearTimeout(window.noteTimer);window.noteTimer=setTimeout(async()=>{const {error}=await db.rpc('save_profile_note',{p_session_token:accessToken,p_profile_id:activeProfile,p_body:$('#sticky-note').value});try{localStorage.setItem(`unipakt-note-${activeProfile}-v1`,$('#sticky-note').value);}catch{}$('#note-status').textContent=error?'Eşitlenemedi':'Ortak kaydedildi';setSyncStatus(error?'Eşitleme başarısız':'Ortak kayıt açık',Boolean(error));},500);});
$('#clear-note').addEventListener('click',async()=>{const {error}=await db.rpc('clear_profile_note',{p_session_token:accessToken,p_profile_id:activeProfile});if(error){setSyncStatus('Not silinemedi',true);return;}$('#sticky-note').value='';try{localStorage.removeItem(`unipakt-note-${activeProfile}-v1`);}catch{}$('#note-count').textContent='0/600';$('#note-status').textContent='Not temizlendi';});
$('#export-report').addEventListener('click',()=>{const done=tasks.filter(task=>task.done);const rows=[['Görev','Detay','Sorumlu','Tamamlanma tarihi'],...done.map(task=>[task.title,task.detail,task.assignee,task.completedAt?new Intl.DateTimeFormat('tr-TR',{dateStyle:'short',timeStyle:'short'}).format(new Date(task.completedAt)):''])];const csv='\ufeff'+rows.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(';')).join('\r\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download=`unipakt-gorev-raporu-${todayKey()}.csv`;link.click();URL.revokeObjectURL(link.href);});
$('#note-count').textContent=`${$('#sticky-note').value.length}/600`;render();initializePinGate();
