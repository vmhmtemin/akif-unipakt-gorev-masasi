/* =============================================================================
   Unipakt Görev Masası — Takvim sekmesi ve .ics dışa aktarma
   app.js'den bağımsız bir modül: veriyi render(tasks) ile alır, kullanıcı
   etkileşimlerini mount() sırasında verilen geri çağırmalarla bildirir.
     onDayClick(dateKey)        boş güne tıklandı  → yeni görev
     onTaskClick(taskId)        göreve tıklandı    → düzenle
     onMove(taskId, dateKey)    görev sürüklendi   → son tarihi değiştir
     personKey(assigneeName)    'akif' | 'mehmet' | 'ugur' | 'herkes' | 'other'
     notify(message)            kısa bilgi mesajı
   Telefonda (≤690px) aylık ızgara yerine haftalık liste gösterilir.
   ============================================================================= */
(function () {
  const MOBILE = window.matchMedia('(max-width: 690px)');
  const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const MAX_CHIPS = 3;

  let opts = null;
  let tasks = [];
  let cursor = startOfDay(new Date()); // gösterilen ay/haftanın içindeki bir gün
  let person = 'all';
  const expanded = new Set();          // "+N daha" ile açılmış günler

  const $ = (s) => document.querySelector(s);
  const esc = (v = '') => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Tarih yardımcıları (yerel saat, YYYY-AA-GG anahtarları) ----------
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function key(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function mondayOf(d) { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); }
  const fmt = (o) => new Intl.DateTimeFormat('tr-TR', o);

  // ---------- Veri ----------
  function visibleTasks() {
    return tasks.filter((t) => t.due && (person === 'all' || opts.personKey(t.assignee) === person));
  }
  function byDay(list) {
    const map = new Map();
    for (const t of list) { if (!map.has(t.due)) map.set(t.due, []); map.get(t.due).push(t); }
    for (const items of map.values()) {
      // Meet'ler en üstte (saate göre), sonra acil görevler
      items.sort((a, b) => a.done - b.done
        || (b.kind === 'meet') - (a.kind === 'meet')
        || (a.meetTime || '').localeCompare(b.meetTime || '')
        || (b.priority === 'urgent') - (a.priority === 'urgent')
        || a.title.localeCompare(b.title, 'tr'));
    }
    return map;
  }

  function chipHtml(t, today) {
    const late = !t.done && t.due < today;
    const meet = t.kind === 'meet';
    const cls = ['cal-chip', `p-${opts.personKey(t.assignee)}`, meet && 'meet', t.done && 'done', late && !meet && 'late', t.priority === 'urgent' && !meet && 'urgent'].filter(Boolean).join(' ');
    const tip = `${meet ? `MEET ${t.meetTime} · ` : ''}${t.title} · ${t.assignee}${t.done ? ' · tamamlandı' : late ? (meet ? ' · geçti' : ' · gecikti') : ''}`;
    const mark = meet ? `<i aria-hidden="true">●</i><b>${esc(t.meetTime)}</b>` : t.priority === 'urgent' ? '<i aria-hidden="true">!</i>' : '';
    return `<button type="button" class="${cls}" data-task-id="${esc(t.id)}" draggable="${!t.done && !MOBILE.matches}" title="${esc(tip)}">`
      + `${mark}<span>${esc(t.title)}</span></button>`;
  }

  // ---------- Aylık ızgara ----------
  function renderMonth(map, today) {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = mondayOf(first);
    $('#cal-title').textContent = fmt({ month: 'long', year: 'numeric' }).format(first);
    let html = WEEKDAYS.map((d) => `<div class="cal-head">${d}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const k = key(day);
      const items = map.get(k) || [];
      const open = expanded.has(k);
      const shown = open ? items : items.slice(0, MAX_CHIPS);
      const cls = ['cal-cell', day.getMonth() !== first.getMonth() && 'out', k === today && 'today', i % 7 > 4 && 'weekend'].filter(Boolean).join(' ');
      html += `<div class="${cls}" data-date="${k}" role="gridcell" aria-label="${fmt({ day: 'numeric', month: 'long' }).format(day)}, ${items.length} görev">`
        + `<div class="cal-day"><span>${day.getDate()}</span><b class="cal-plus" aria-hidden="true">＋</b></div>`
        + `<div class="cal-chips">${shown.map((t) => chipHtml(t, today)).join('')}`
        + `${items.length > MAX_CHIPS ? `<button type="button" class="cal-more" data-more="${k}">${open ? 'Daha az' : `+${items.length - MAX_CHIPS} daha`}</button>` : ''}</div></div>`;
    }
    const grid = $('#cal-grid');
    grid.className = 'cal-grid month';
    grid.setAttribute('role', 'grid');
    grid.innerHTML = html;
  }

  // ---------- Haftalık liste (telefon) ----------
  function renderWeek(map, today) {
    const start = mondayOf(cursor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    $('#cal-title').textContent = `${fmt(sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' }).format(start)} – ${fmt({ day: 'numeric', month: 'long' }).format(end)}`;
    let html = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i);
      const k = key(day);
      const items = map.get(k) || [];
      html += `<div class="cal-wday${k === today ? ' today' : ''}" data-date="${k}">`
        + `<div class="cal-wday-head"><b>${WEEKDAYS[i]}</b><span>${fmt({ day: 'numeric', month: 'long' }).format(day)}</span>`
        + `<button type="button" class="cal-add" data-add="${k}" aria-label="${fmt({ day: 'numeric', month: 'long' }).format(day)} için görev ekle">＋</button></div>`
        + `<div class="cal-wlist">${items.length ? items.map((t) => chipHtml(t, today)).join('') : '<span class="cal-none">Görev yok</span>'}</div></div>`;
    }
    const grid = $('#cal-grid');
    grid.className = 'cal-grid week';
    grid.removeAttribute('role');
    grid.innerHTML = html;
  }

  function render(nextTasks) {
    if (nextTasks) tasks = nextTasks;
    if (!opts || $('#calendar-view').classList.contains('hidden')) return;
    const today = key(new Date());
    const list = visibleTasks();
    const map = byDay(list);
    if (MOBILE.matches) renderWeek(map, today); else renderMonth(map, today);
    const undated = tasks.filter((t) => !t.due && !t.done && (person === 'all' || opts.personKey(t.assignee) === person)).length;
    $('#cal-undated').textContent = undated ? `Son tarihi olmayan ${undated} açık görev takvimde görünmez.` : '';
  }

  // ---------- .ics ----------
  function icsText(value) { return String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  /** RFC 5545: satırlar 75 baytı geçmesin; UTF-8 karakterleri bölünmesin. */
  function fold(line) {
    const enc = new TextEncoder();
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  function exportIcs() {
    const list = visibleTasks().filter((t) => !t.done);
    if (!list.length) { opts.notify('Aktarılacak son tarihli açık görev yok.'); return; }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unipakt//Gorev Masasi//TR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Unipakt Görevler'];
    for (const t of list) {
      const meet = t.kind === 'meet' && t.meetTime;
      const link = /^https:\/\/[^\s"'<>]+$/.test(t.meetLink || '') ? t.meetLink : '';
      const detail = [t.detail, `Sorumlu: ${t.assignee}`, link && `Bağlantı: ${link}`, !meet && t.priority === 'urgent' ? 'Öncelik: Acil' : ''].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', `UID:${t.id}@unipakt-gorev-masasi`, `DTSTAMP:${stamp}`);
      if (meet) {
        // Saatli etkinlik: tarayıcının saat diliminden UTC'ye çevrilir, 1 saat sürer
        const begin = new Date(`${t.due}T${t.meetTime}:00`);
        const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        lines.push(`DTSTART:${utc(begin)}`, `DTEND:${utc(new Date(begin.getTime() + 3600000))}`,
          `SUMMARY:${icsText(`🔴 MEET: ${t.title}`)}`, 'TRANSP:OPAQUE');
        if (link) lines.push(`URL:${link}`, `LOCATION:${icsText(link)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${t.due.replaceAll('-', '')}`,
          `DTEND;VALUE=DATE:${key(addDays(new Date(`${t.due}T12:00:00`), 1)).replaceAll('-', '')}`,
          `SUMMARY:${icsText((t.priority === 'urgent' ? '❗ ' : '') + t.title)}`, 'TRANSP:TRANSPARENT');
      }
      lines.push(`DESCRIPTION:${icsText(detail)}`);
      // Meet'ler için 15 dk önce hatırlatma (alt bileşen, özelliklerden sonra gelmeli)
      if (meet) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(t.title)}`, 'TRIGGER:-PT15M', 'END:VALARM');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.map(fold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `unipakt-gorevler-${key(new Date())}.ics`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    opts.notify(`${list.length} görev .ics dosyasına aktarıldı.`);
  }

  // ---------- Etkileşimler ----------
  function step(dir) {
    if (MOBILE.matches) cursor = addDays(cursor, dir * 7);
    else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
    expanded.clear();
    render();
  }

  function mount(options) {
    opts = options;
    $('#cal-prev').addEventListener('click', () => step(-1));
    $('#cal-next').addEventListener('click', () => step(1));
    $('#cal-today').addEventListener('click', () => { cursor = startOfDay(new Date()); expanded.clear(); render(); });
    $('#cal-export').addEventListener('click', exportIcs);
    $('#cal-people').addEventListener('click', (e) => {
      const b = e.target.closest('[data-person]');
      if (!b) return;
      person = b.dataset.person;
      document.querySelectorAll('#cal-people [data-person]').forEach((x) => x.classList.toggle('active', x === b));
      render();
    });

    const grid = $('#cal-grid');
    grid.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) { const k = more.dataset.more; expanded.has(k) ? expanded.delete(k) : expanded.add(k); render(); return; }
      const chip = e.target.closest('[data-task-id]');
      if (chip) { opts.onTaskClick(chip.dataset.taskId); return; }
      const add = e.target.closest('[data-add]');
      if (add) { opts.onDayClick(add.dataset.add); return; }
      const cell = e.target.closest('.cal-cell');
      if (cell) opts.onDayClick(cell.dataset.date);
    });

    // Sürükle-bırak (yalnızca masaüstü ızgara)
    let dragId = null;
    grid.addEventListener('dragstart', (e) => {
      const chip = e.target.closest('[data-task-id]');
      if (!chip) return;
      dragId = chip.dataset.taskId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      chip.classList.add('dragging');
    });
    grid.addEventListener('dragend', () => { dragId = null; grid.querySelectorAll('.dragging,.drop').forEach((x) => x.classList.remove('dragging', 'drop')); });
    grid.addEventListener('dragover', (e) => {
      const cell = e.target.closest('.cal-cell');
      if (!cell || !dragId) return;
      e.preventDefault();
      grid.querySelectorAll('.drop').forEach((x) => x !== cell && x.classList.remove('drop'));
      cell.classList.add('drop');
    });
    grid.addEventListener('drop', (e) => {
      const cell = e.target.closest('.cal-cell');
      if (!cell || !dragId) return;
      e.preventDefault();
      const id = dragId;
      const task = tasks.find((t) => t.id === id);
      cell.classList.remove('drop');
      if (task && task.due !== cell.dataset.date) opts.onMove(id, cell.dataset.date);
    });

    MOBILE.addEventListener('change', () => render());
  }

  window.GorevTakvim = { mount, render };
})();
