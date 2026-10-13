const PROFILES = { akif: { name: 'Akif', initial: 'A' }, mehmet: { name: 'Mehmet', initial: 'M' }, ugur: { name: 'Uğur', initial: 'U' } };
const SUPABASE_URL = 'https://jbheyqmqickfuuhyesog.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jfLnVG_RBLbzj8-HftUFlA_xgZ0Ag6X';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let activeProfile = null;
let tasks = [];
let filter = 'all';
let channel = null;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function localTasks(profile) { try { return JSON.parse(localStorage.getItem(`unipakt-tasks-${profile}-v1`) || '[]'); } catch { return []; } }
function localNote(profile) { return localStorage.getItem(`unipakt-note-${profile}-v1`) || (profile === 'akif' ? localStorage.getItem('unipakt-akif-note-v1') || '' : ''); }
function setSyncStatus(text, offline = false) { $('#sync-label').textContent = text; $('.sync-dot').classList.toggle('offline', offline); }
function taskFromDb(row) { return { id: row.id, title: row.title, detail: row.detail || '', assignee: row.assignee, due: row.due || '', done: row.done, createdAt: row.created_at, completedAt: row.completed_at }; }
function taskToDb(task) { return { id: task.id, title: task.title, detail: task.detail || '', assignee: task.assignee, due: task.due || null, done: task.done, created_at: task.createdAt || new Date().toISOString(), completed_at: task.completedAt || null }; }
async function refreshTasks() {
  if (!activeProfile) return;
  const { data, error } = await db.from('tasks').select('*').order('created_at', { ascending: false });
  if (error) { setSyncStatus('Bağlantı bekleniyor', true); return; }
  tasks = (data || []).map(taskFromDb);
  try { localStorage.setItem(`unipakt-tasks-${activeProfile}-v1`, JSON.stringify(tasks)); } catch {}
  setSyncStatus('Ortak kayıt açık'); render();
}
async function saveTasks() {
  try { localStorage.setItem(`unipakt-tasks-${activeProfile}-v1`, JSON.stringify(tasks)); } catch {}
  render();
  if (!tasks.length) return;
  const { error } = await db.from('tasks').upsert(tasks.map(taskToDb), { onConflict: 'id' });
  setSyncStatus(error ? 'Eşitleme başarısız' : 'Ortak kayıt açık', Boolean(error));
}
async function chooseProfile(profileId) {
  activeProfile = profileId;
  const profile = PROFILES[profileId];
  $('#profile-picker').classList.add('hidden'); $('.shell').classList.remove('hidden');
  $('#profile-name').textContent = profile.name; $('#profile-avatar').textContent = profile.initial;
  $('#task-form').elements.assignee.value = profile.name;
  $('.note-head span:last-of-type').textContent = profileId === 'ugur' ? "UĞUR'UN NOTU" : `${profile.name.toLocaleUpperCase('tr-TR')}'İN NOTU`;
  $('#sticky-note').value = '';
  $('#note-count').textContent = '0/600';
  setView('tasks'); filter = 'all';
  document.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
  tasks = []; render(); setSyncStatus('Bağlanıyor…');
  const { data, error } = await db.from('tasks').select('*').order('created_at', { ascending: false });
  if (error) { tasks = localTasks(profileId); setSyncStatus('Bağlantı kurulamadı', true); render(); return; }
  tasks = (data || []).map(taskFromDb);
  const legacyTasks = localTasks(profileId);
  if (!tasks.length && legacyTasks.length) {
    const { error: migrateError } = await db.from('tasks').upsert(legacyTasks.map(taskToDb), { onConflict: 'id' });
    if (!migrateError) tasks = legacyTasks;
  }
  try { localStorage.setItem(`unipakt-tasks-${profileId}-v1`, JSON.stringify(tasks)); } catch {}
  const { data: noteRows, error: noteError } = await db.from('profile_notes').select('body').eq('profile_id', profileId).maybeSingle();
  let noteText = noteRows?.body || '';
  if (!noteError && !noteRows) {
    noteText = localNote(profileId);
    if (noteText) await db.from('profile_notes').upsert({ profile_id: profileId, body: noteText, updated_at: new Date().toISOString() }, { onConflict: 'profile_id' });
  }
  $('#sticky-note').value = noteText;
  $('#note-count').textContent = `${noteText.length}/600`;
  setSyncStatus(noteError ? 'Not eşitlenemedi' : 'Ortak kayıt açık', Boolean(noteError));
  render();
  if (channel) await db.removeChannel(channel);
  channel = db.channel('unipakt-shared-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => refreshTasks())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profile_notes', filter: `profile_id=eq.${profileId}` }, payload => {
      const text = payload.new?.body;
      if (typeof text === 'string' && document.activeElement !== $('#sticky-note')) {
        $('#sticky-note').value = text; $('#note-count').textContent = `${text.length}/600`;
      }
    }).subscribe(status => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSyncStatus('Canlı eşitleme bekleniyor', true); });
}
function openProfilePicker() { $('#profile-picker').classList.remove('hidden'); $('.shell').classList.add('hidden'); }
document.querySelectorAll('[data-profile]').forEach(button => button.addEventListener('click', () => chooseProfile(button.dataset.profile)));
$('#profile-switch').addEventListener('click', openProfilePicker);
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
$('#task-list').addEventListener('change',async event=>{if(event.target.matches('[data-toggle]')){const task=tasks.find(item=>item.id===event.target.dataset.toggle);task.done=event.target.checked;task.completedAt=task.done?new Date().toISOString():null;const { error } = await db.from('tasks').update({ done: task.done, completed_at: task.completedAt }).eq('id', task.id);setSyncStatus(error?'Eşitleme başarısız':'Ortak kayıt açık',Boolean(error));render();}});
$('#task-list').addEventListener('click',async event=>{const button=event.target.closest('[data-delete]');if(button){const { error } = await db.from('tasks').delete().eq('id',button.dataset.delete);if(error){setSyncStatus('Görev silinemedi',true);return;}tasks=tasks.filter(task=>task.id!==button.dataset.delete);try{localStorage.setItem(`unipakt-tasks-${activeProfile}-v1`,JSON.stringify(tasks));}catch{}render();}});
$('#sticky-note').addEventListener('input',()=>{$('#note-count').textContent=`${$('#sticky-note').value.length}/600`;$('#note-status').textContent='Kaydediliyor…';clearTimeout(window.noteTimer);window.noteTimer=setTimeout(async()=>{const {error}=await db.from('profile_notes').upsert({profile_id:activeProfile,body:$('#sticky-note').value,updated_at:new Date().toISOString()},{onConflict:'profile_id'});try{localStorage.setItem(`unipakt-note-${activeProfile}-v1`,$('#sticky-note').value);}catch{}$('#note-status').textContent=error?'Eşitlenemedi':'Ortak kaydedildi';setSyncStatus(error?'Eşitleme başarısız':'Ortak kayıt açık',Boolean(error));},500);});
$('#clear-note').addEventListener('click',async()=>{const {error}=await db.from('profile_notes').delete().eq('profile_id',activeProfile);if(error){setSyncStatus('Not silinemedi',true);return;}$('#sticky-note').value='';try{localStorage.removeItem(`unipakt-note-${activeProfile}-v1`);}catch{}$('#note-count').textContent='0/600';$('#note-status').textContent='Not temizlendi';});
$('#export-report').addEventListener('click',()=>{const done=tasks.filter(task=>task.done);const rows=[['Görev','Detay','Sorumlu','Tamamlanma tarihi'],...done.map(task=>[task.title,task.detail,task.assignee,task.completedAt?new Intl.DateTimeFormat('tr-TR',{dateStyle:'short',timeStyle:'short'}).format(new Date(task.completedAt)):''])];const csv='\ufeff'+rows.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(';')).join('\r\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download=`unipakt-gorev-raporu-${todayKey()}.csv`;link.click();URL.revokeObjectURL(link.href);});
$('#note-count').textContent=`${$('#sticky-note').value.length}/600`;render();
