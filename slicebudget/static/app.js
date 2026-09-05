/* SliceBudget UI — vanilla JS single page app. */
(function () {
  'use strict';
  // ------------------------------------------------------------ utilities
  const $ = (s, r) => (r || document).querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const fmt = (v, d = 1) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);
  const fmtg = (v, d = 1) => v == null ? '—' : fmt(v, d);
  const signed = (v, d = 1) => (v > 0 ? '+' : '') + fmt(v, d);
  const money = v => v == null ? '' : '$' + Number(v).toFixed(2);
  const dateStr = (t) => t ? new Date(t * 1000).toLocaleString([], { dateStr: 'short' }).replace(',', '') : '';
  const today = () => new Date().toISOString().slice(0, 10);
  const secs = s => s == null ? '—' : s < 60 ? s.toFixed(1) + ' s' : (s / 60).toFixed(1) + ' min';
  const hms = s => { if (s == null) return '—'; const hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60); return hh ? `${hh}h ${mm}m` : `${mm}m`; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(method, path, body, raw) {
    const opts = { method, headers: {} };
    if (body instanceof ArrayBuffer || body instanceof Blob) { opts.body = body; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    if (raw && raw.headers) Object.assign(opts.headers, raw.headers);
    const r = await fetch('/api/' + path, opts);
    if (raw && raw.blob) return r.blob();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    $('#toasts').append(t); setTimeout(() => t.remove(), err ? 7000 : 3500);
  }
  function fail(e) { console.error(e); toast(e.message || String(e), true); }

  function modal(title, body, buttons, opts = {}) {
    const root = $('#modal-root');
    const close = () => { bg.remove(); if (opts.onClose) opts.onClose(); };
    const bg = h('div', { class: 'modal-bg', onClick: e => { if (e.target === bg && !opts.sticky) close(); } },
      h('div', { class: 'modal', style: opts.width ? { width: opts.width } : null, role: 'dialog', 'aria-modal': 'true' },
        h('header', null, h('h2', null, title), h('button', { class: 'btn icon x', onClick: close, 'aria-label': 'Close' }, '✕')),
        h('div', { class: 'body' }, body),
        buttons && h('footer', null, ...buttons.map(b => h('button', { class: 'btn ' + (b.cls || ''), onClick: async () => { try { const r = await b.onClick?.(close); if (r !== false && !b.keep) close(); } catch (e) { fail(e); } } }, b.label)))));
    root.append(bg);
    const first = bg.querySelector('input,select,textarea,button:not(.x)'); if (first && !opts.noFocus) setTimeout(() => first.focus(), 30);
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.target.tagName === 'INPUT' && buttons && opts.enterSubmits !== false) { const prim = bg.querySelector('footer .btn.primary'); prim && prim.click(); } });
    return close;
  }
  function confirmModal(msg, onYes, label = 'Delete') {
    modal('Are you sure?', h('p', null, msg), [{ label: 'Cancel' }, { label, cls: 'danger', onClick: onYes }]);
  }
  function field(label, input) { return h('div', { class: 'field' }, h('label', null, label), input); }
  function input(attrs) { return h('input', Object.assign({ class: 'w' }, attrs)); }
  function select(options, value, attrs) {
    const s = h('select', Object.assign({ class: 'w' }, attrs));
    for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; s.append(h('option', { value: v, selected: String(v) === String(value) }, l)); }
    return s;
  }
  function menu(anchor, items) {
    document.querySelectorAll('.menu').forEach(m => m.remove());
    const r = anchor.getBoundingClientRect();
    const m = h('div', { class: 'menu', style: { top: (r.bottom + window.scrollY + 4) + 'px', left: Math.min(r.left, window.innerWidth - 230) + 'px' } });
    for (const it of items) {
      if (it === '-') { m.append(h('hr')); continue; }
      m.append(h('button', { class: it.cls || '', onClick: () => { m.remove(); it.onClick(); } }, it.label));
    }
    document.body.append(m);
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  }
  // editable cell: click to edit, Enter/blur saves
  function edCell(value, onSave, opts = {}) {
    const td = h('td', { class: 'ed ' + (opts.cls || ''), title: opts.title || 'Click to edit' });
    const show = () => { td.textContent = ''; td.append(opts.render ? opts.render(value) : (value == null || value === '' ? (opts.placeholder || '—') : (opts.fmt ? opts.fmt(value) : value))); };
    show();
    td.addEventListener('click', () => {
      if (td.querySelector('input,select')) return;
      let inp;
      if (opts.options) { inp = select(opts.options, value); }
      else { inp = h('input', { type: opts.type || 'text', value: value == null ? '' : value, class: opts.type === 'number' ? 'num' : '', step: opts.step || 'any' }); if (opts.list) inp.setAttribute('list', opts.list); }
      const done = async (save) => {
        if (!save) { show(); return; }
        let v = inp.value;
        if (opts.type === 'number') v = v === '' ? null : parseFloat(v);
        if (v === value || (v === '' && value == null)) { show(); return; }
        try { value = v; show(); await onSave(v); } catch (e) { fail(e); }
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      if (inp.tagName === 'SELECT') inp.addEventListener('change', () => done(true));
      td.textContent = ''; td.append(inp); inp.focus(); if (inp.select) inp.select();
    });
    return td;
  }

  // ------------------------------------------------------------ state
  const S = { state: null, robot: null, robotId: null, view: 'home', param: null, jobs: null, es: null, lib: null, runs: null, cache: {} };
  // ------------------------------------------------------------ sortable tables
  // Every table with a header becomes click-to-sort. Rows are re-ordered in place (listeners survive);
  // group rows (section headers, sums) stay where they are and only the rows between them are sorted.
  const SORT = {};
  const FIXED_ROW = r => ['sec-h', 'grp', 'sum', 'nosort'].some(c => r.classList.contains(c));
  function cellKey(tr, i) {
    const td = tr.children[i]; if (!td) return '';
    if (td.dataset.sort != null) return td.dataset.sort;
    const inp = td.querySelector('input,select');
    const t = inp ? (inp.tagName === 'SELECT' ? (inp.options[inp.selectedIndex] || {}).text : inp.value) : td.textContent;
    return (t || '').trim();
  }
  const NUM_RE = /^[-+−]?\d[\d,]*(\.\d+)?/;
  function sortTable(tbl, col, dir) {
    const th = tbl.tHead && tbl.tHead.rows[0] && tbl.tHead.rows[0].children[col];
    const forceNum = th && th.classList.contains('num');
    for (const tb of tbl.tBodies) {
      const out = []; let group = [];
      const flush = () => {
        if (!group.length) return;
        const keyed = group.map(r => ({ r, k: cellKey(r, col) }));
        const nonEmpty = keyed.filter(x => x.k && x.k !== '—');
        const numeric = forceNum || (nonEmpty.length && nonEmpty.every(x => /^[-+−]?\d[\d,]*(\.\d+)?(\s*\S{0,4})?$/.test(x.k)));
        for (const x of keyed) { const m = x.k.replace('−', '-').match(NUM_RE); x.n = m ? parseFloat(m[0].replace(/,/g, '')) : (x.k && x.k !== '—' ? NaN : -Infinity); }
        keyed.sort((a, b) => {
          let c;
          if (numeric) { const an = isNaN(a.n) ? -Infinity : a.n, bn = isNaN(b.n) ? -Infinity : b.n; c = an - bn; if (!c) c = a.k.localeCompare(b.k); }
          else c = (a.k === '' || a.k === '—') - (b.k === '' || b.k === '—') || a.k.localeCompare(b.k, undefined, { numeric: true, sensitivity: 'base' });
          return dir === 'desc' ? -c : c;
        });
        out.push(...keyed.map(x => x.r)); group = [];
      };
      for (const r of [...tb.rows]) { if (FIXED_ROW(r)) { flush(); out.push(r); } else group.push(r); }
      flush(); out.forEach(r => tb.append(r));
    }
    for (const t of tbl.tHead.rows[0].children) { t.classList.remove('asc', 'desc'); }
    if (th) th.classList.add(dir);
  }
  function tableKey(tbl) {
    const inModal = tbl.closest('.modal, dialog');
    const root = inModal || document.getElementById('main');
    const idx = [...root.querySelectorAll('table')].indexOf(tbl);
    return (inModal ? 'modal' : S.view) + '#' + idx;
  }
  function makeSortable(root) {
    for (const tbl of root.querySelectorAll('table')) {
      if (tbl.dataset.sortable || !tbl.tHead || !tbl.tHead.rows.length) continue;
      const ths = [...tbl.tHead.rows[0].children];
      if (!ths.some(t => t.textContent.trim())) continue;
      tbl.dataset.sortable = '1';
      const key = tableKey(tbl);
      ths.forEach((th, i) => {
        if (!th.textContent.trim() || th.classList.contains('nosort')) return;
        th.classList.add('sortable'); th.title = 'Click to sort';
        th.addEventListener('click', () => {
          const cur = SORT[key];
          const dir = cur && cur.col === i && cur.dir === 'asc' ? 'desc' : 'asc';
          SORT[key] = { col: i, dir }; sortTable(tbl, i, dir);
        });
      });
      const saved = SORT[key];
      if (saved && ths[saved.col]) sortTable(tbl, saved.col, saved.dir);
    }
  }
  new MutationObserver(() => { if (makeSortable._t) return; makeSortable._t = requestAnimationFrame(() => { makeSortable._t = 0; makeSortable(document.body); }); }).observe(document.body, { childList: true, subtree: true });

  const ROLES = [['armor', 'Armor · walls first'], ['structure', 'Structure'], ['internal', 'Internal'], ['cosmetic', 'Cosmetic'], ['weapon', 'Weapon']];
  const STATUSES = [['', '—'], ['planned', 'planned'], ['ordered', 'ordered'], ['on hand', 'on hand'], ['installed', 'installed']];
  const PATTERNS = ['cubic', 'grid', 'gyroid', 'triangles', 'rectilinear', 'honeycomb', '3dhoneycomb', 'adaptivecubic', 'supportcubic', 'lightning', 'alignedrectilinear', 'stars', 'concentric'];

  async function loadState() { S.state = await api('GET', 'state'); }
  async function loadRobot(id) {
    if (!id) { S.robot = null; return; }
    S.robot = await api('GET', 'robots/' + id); S.robotId = id; localStorage.setItem('sb.robot', id);
  }
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [view, param] = hash.split('/');
    S.view = view || 'home'; S.param = param || null;
  }
  function go(view, param) { location.hash = '#/' + view + (param != null ? '/' + param : ''); }

  // ------------------------------------------------------------ shell
  function renderShell() {
    const st = S.state, r = S.robot;
    // robot switcher
    const sw = $('#robot-switch'); sw.textContent = '';
    const sel = select([['', '— choose a robot —'], ...st.robots.filter(x => x.status === 'active').map(x => [x.id, x.name])], S.robotId || '', { onChange: async e => { const id = +e.target.value; if (!id) return; await loadRobot(id); if (['home', 'library', 'filaments', 'jobs'].includes(S.view)) go('sheet'); else render(); } });
    sw.append(sel);
    if (r && r.queue) sw.append(h('span', { class: 'dirty' }, `● ${r.queue} slice${r.queue > 1 ? 's' : ''} in queue`));
    // budget bar
    const b = $('#budget'); b.textContent = '';
    if (r) {
      const t = r.totals, cls = r.weight_class_g, over = t.over_under;
      const bar = h('div', { class: 'bar', title: 'Sections left to right; orange = printed parts; black line = class limit' });
      let x = 0; const total = Math.max(t.best_known, cls) * 1.02;
      for (const s of r.sections.filter(s => s.counts)) {
        const w = (s.items.filter(i => i.counted).reduce((a, i) => a + i.total_grams, 0)) / total * 100;
        const printed = s.items.some(i => i.part) && s.items.every(i => i.part || !i.counted);
        bar.append(h('i', { style: { left: x + '%', width: w + '%', background: printed ? 'var(--accent)' : 'var(--slate)', opacity: printed ? 1 : (0.55 + 0.1 * (x / 20 % 3)) } })); x += w;
      }
      bar.append(h('i', { class: 'lim', style: { left: (cls / total * 100) + '%' } }));
      b.append(h('div', { class: 'lbl' }, `${r.class_name || 'class'} · limit `, h('b', null, fmt(cls, 1) + ' g'), ' · margin ', h('b', null, fmt(r.margin_g, 1) + ' g')), bar,
        h('div', { class: 'status ' + (over > 0 ? 'over' : 'under') }, over > 0 ? `${fmt(over)} g over` : `${fmt(-over)} g under`));
    }
    // top actions
    const ta = $('#top-actions'); ta.textContent = '';
    if (r) ta.append(h('button', { class: 'btn ghost', onClick: e => exportMenu(e.currentTarget) }, 'Export ▾'));
    ta.append(h('span', { class: 'hint', style: { margin: 0 }, title: 'Every edit is saved to the local database immediately' }, 'Saved ✓'));
    // nav
    const nav = $('#nav'); nav.textContent = '';
    const item = (id, label, badge, badgeCls) => h('button', { class: 'nav', role: 'tab', 'aria-selected': String(S.view === id), onClick: () => go(id) }, label, badge != null && h('span', { class: 'k ' + (badgeCls || '') }, badge));
    nav.append(item('home', 'All robots', st.robots.length));
    if (r) {
      nav.append(h('div', { class: 'sec' }, 'This robot'));
      const nParts = r.sections.reduce((a, s) => a + s.items.filter(i => i.part).length, 0);
      nav.append(item('sheet', 'Weight sheet', r.totals.flags || null, 'warn'), item('parts', 'Printed parts', nParts), item('part', 'Part detail'), item('optimizer', 'Optimizer'), item('runs', 'Runs'), item('events', 'Event log'));
    }
    nav.append(h('div', { class: 'sec' }, 'Library'), item('library', 'Components'), item('filaments', 'Filaments & profiles'));
    nav.append(h('div', { class: 'sec' }, 'Tool'), item('calc', 'Calculators'), item('jobs', 'Jobs & setup', st.slicer.slicer ? null : '!', 'warn'));
    const q = st.slicer;
    nav.append(h('div', { class: 'foot' }, q.slicer ? h('span', null, h('b', null, (q.slicer_label || q.slicer).split('+')[0]), h('br'), `${q.workers} worker${q.workers > 1 ? 's' : ''} · ${q.running} running · ${q.queued} queued`) : h('span', null, h('b', { style: { color: 'var(--warn)' } }, 'PrusaSlicer not installed'), h('br'), 'Open Jobs & setup')));
  }

  function exportMenu(anchor) {
    const rid = S.robotId, dl = (k) => () => { window.open(`/api/robots/${rid}/export/${k}`, '_blank'); };
    menu(anchor, [
      { label: 'Weight sheet as Excel (.xlsx, your layout)', onClick: dl('xlsx') },
      { label: 'Weight sheet as CSV', onClick: dl('csv') },
      { label: 'Purchase list (CSV)', onClick: dl('purchase') },
      '-',
      { label: 'Print sheet (HTML, printable)', onClick: dl('printsheet') },
      { label: 'Bambu Studio process presets (zip of JSON)', onClick: dl('presets') },
      { label: 'Bambu Studio project (.3mf, beta)', onClick: dl('bambu3mf') },
      '-',
      { label: 'Robot archive (.slicebudget.zip)', onClick: dl('archive') },
    ]);
  }

  // ------------------------------------------------------------ views
  const V = {};

  V.home = function (m) {
    const st = S.state;
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Robots'), h('p', null, 'Each robot has its own weight sheet, printed parts, runs and event log. The library is shared.')),
      h('div', { class: 'tb' }, h('button', { class: 'btn', onClick: importArchive }, 'Import archive'), h('button', { class: 'btn primary', onClick: newRobotModal }, '＋ New robot'))));
    const grid = h('div', { class: 'robots' });
    const active = st.robots.filter(r => r.status === 'active'), archived = st.robots.filter(r => r.status !== 'active');
    for (const r of active) grid.append(robotCard(r));
    grid.append(h('button', { class: 'rcard new', onClick: newRobotModal }, '＋ New robot'));
    m.append(grid);
    if (archived.length) {
      m.append(h('h3', { style: { marginTop: '24px', fontSize: '12px', color: 'var(--ink3)', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Archived'));
      const g2 = h('div', { class: 'robots' }); for (const r of archived) g2.append(robotCard(r)); m.append(g2);
    }
  };
  function robotCard(r) {
    const t = r.totals, over = t.over_under;
    return h('button', { class: 'rcard', onClick: async () => { await loadRobot(r.id); go('sheet'); } },
      h('div', { class: 't' }, h('b', null, r.name), h('span', { class: 'cls' }, r.class_name || fmt(r.weight_class_g, 0) + ' g')),
      h('div', { class: 'g' }, fmt(t.best_known), h('small', null, ' g best known')),
      h('span', { class: 'pill ' + (over > 0 ? 'bad' : 'good') }, over > 0 ? `${fmt(over)} g over` : `${fmt(-over)} g under`),
      h('div', { class: 'meta' }, h('span', null, `${r.printed_parts} printed parts`), h('span', null, `${Math.round(t.measured_fraction * 100)}% measured`), h('span', null, r.status === 'active' ? dateStr(r.updated) : 'archived')));
  }
  function newRobotModal(src) {
    const st = S.state;
    const name = input({ placeholder: 'e.g. PLAnti Drum v3', value: src ? src.name + ' v2' : '' });
    const cls = select(st.classes.map(c => [c.grams, c.name]), src ? src.weight_class_g : 453.592);
    const margin = input({ type: 'number', value: src ? src.margin_g : 4.5, step: '0.1' });
    cls.addEventListener('change', () => { margin.value = (parseFloat(cls.value) * 0.01).toFixed(1); });
    const printer = select(st.printers.map(p => [p.id, p.name]), src ? src.printer_id : st.settings.default_printer_id);
    modal(src ? 'Duplicate robot' : 'New robot', h('div', null, field('Name', name), field('Weight class', cls), field('Margin (g)', margin), field('Printer', printer)),
      [{ label: 'Cancel' }, { label: src ? 'Duplicate' : 'Create', cls: 'primary', onClick: async () => {
        let r;
        if (src) r = await api('POST', `robots/${src.id}/duplicate`, { name: name.value });
        else r = await api('POST', 'robots', { name: name.value, weight_class_g: parseFloat(cls.value), class_name: cls.selectedOptions[0].textContent, margin_g: parseFloat(margin.value), printer_id: +printer.value });
        if (src) await api('PUT', `robots/${r.id}`, { weight_class_g: parseFloat(cls.value), class_name: cls.selectedOptions[0].textContent, margin_g: parseFloat(margin.value), printer_id: +printer.value });
        await loadState(); await loadRobot(r.id); go('sheet');
      } }]);
  }
  function importArchive() {
    const inp = h('input', { type: 'file', accept: '.zip,.slicebudget' });
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return;
      try { const r = await api('POST', 'import/archive', await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } }); await loadState(); await loadRobot(r.id); go('sheet'); toast('Imported ' + r.name); } catch (e) { fail(e); }
    });
    inp.click();
  }

  // ---------------------------------------------------------------- sheet
  V.sheet = function (m) {
    const r = S.robot; if (!r) return needRobot(m);
    const t = r.totals;
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Weight sheet'), h('p', null, 'Printed-part estimates come from the slicer; measured weights from your scale win when present.')),
      h('div', { class: 'tb' },
        h('button', { class: 'btn', onClick: () => addLineModal() }, '＋ Line'),
        h('button', { class: 'btn', onClick: () => fromLibraryModal() }, '＋ From library'),
        h('button', { class: 'btn', onClick: () => addSectionModal() }, '＋ Section'),
        h('button', { class: 'btn', onClick: robotWeighInModal }, 'Weigh-in…'),
        h('button', { class: 'btn', onClick: e => robotMenu(e.currentTarget) }, 'Robot ▾'),
        h('button', { class: 'btn primary', onClick: () => go('optimizer') }, 'Fix weight →'))));
    const over = t.over_under;
    m.append(h('div', { class: 'hdr' },
      stat('Best known', fmt(t.best_known), 'g', h('div', null, h('div', { class: 'sbar' }, h('i', { style: { width: (t.measured_fraction * 100) + '%', background: 'var(--good)' } }), h('i', { style: { flex: 1, background: 'var(--slate-soft)' } })), h('div', { class: 'hint', style: { marginTop: '4px' } }, `${Math.round(t.measured_fraction * 100)}% of mass measured`))),
      stat('Estimated only', fmt(t.estimated_only), 'g', h('div', { class: 'hint' }, 'if every line used its estimate')),
      stat('Over / under limit', signed(over), 'g', h('div', { class: 'hint' }, `${signed(t.over_under_margin)} g including ${fmt(r.margin_g)} g margin`), over > 0 ? 'over' : 'under'),
      stat('Printed parts', fmt(t.printed), `g · ${t.best_known ? Math.round(t.printed / t.best_known * 100) : 0}%`, h('div', { class: 'hint' }, `budget for printed parts: ${fmt(t.printed_budget)} g`)),
      stat('Flags', String(t.flags), '', h('div', { class: 'hint' }, 'need re-weigh'))));

    const tbl = h('table', null, h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Qty'), h('th', null, 'Description'), h('th', null, 'Purpose / notes'), h('th', { class: 'num' }, 'Estimated'), h('th', { class: 'num' }, 'Measured'), h('th', { class: 'num' }, 'Best'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Price'), h('th', null, 'Status'), h('th', null, ''), h('th', null, ''))));
    const tb = h('tbody'); tbl.append(tb);
    for (const s of r.sections) {
      tb.append(h('tr', { class: 'sec-h' }, h('td', { colspan: 6 }, s.name, !s.counts && h('span', { class: 'off' }, 'not counted toward weigh-in')),
        h('td', { class: 'num' }, s.counts ? fmt(s.subtotal) : `(${fmt(s.subtotal)})`), h('td', { colspan: 3 }),
        h('td', null, h('button', { class: 'btn icon', title: 'Section menu', onClick: e => sectionMenu(e.currentTarget, s) }, '⋯'))));
      for (const it of s.items) tb.append(lineRow(it, s));
      if (!s.items.length) tb.append(h('tr', { class: 'dim' }, h('td', { colspan: 11, style: { textAlign: 'center' } }, h('button', { class: 'btn small ghost', onClick: () => addLineModal(s.id) }, '＋ add a line to ' + s.name))));
    }
    tb.append(h('tr', { class: 'sum' }, h('td'), h('td', null, 'Weigh-in total'), h('td'), h('td', { class: 'num' }, fmt(t.estimated_only)), h('td'), h('td'), h('td', { class: 'num' }, fmt(t.best_known)), h('td', { class: 'num' }, money(r.sections.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.price || 0) * (i.qty || 0), 0), 0))), h('td', { colspan: 3 })));
    m.append(h('div', { class: 'tw' }, tbl));
    m.append(h('p', { class: 'hint' }, 'Click a cell to edit. Red dot = needs re-weigh (set automatically when a profile, mesh or library weight changes after a measurement). Grey rows are excluded from the total (e.g. an assembly line supersedes them).'));
  };
  function stat(label, value, unit, extra, cls) { return h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value, unit && h('small', null, unit)), extra); }
  function needRobot(m) { m.append(h('div', { class: 'empty' }, 'Choose a robot first.', h('br'), h('button', { class: 'btn primary', style: { marginTop: '10px' }, onClick: () => go('home') }, 'All robots'))); }

  function lineRow(it, s) {
    const upd = (patch) => api('PUT', `items/${it.id}`, patch).then(refreshRobot);
    const p = it.part;
    const tr = h('tr', { class: (!it.counted ? 'dim ' : '') + (p && p.locked ? 'locked' : '') });
    tr.append(edCell(it.qty, v => upd({ qty: v }), { type: 'number', cls: 'num', fmt: v => Number(v) % 1 ? v : String(v) }));
    // description
    const descCell = edCell(it.description, v => upd({ description: v }), { render: v => h('span', null, v || h('i', { style: { color: 'var(--ink3)' } }, 'untitled'), p && p.locked && h('span', { class: 'pill lock', style: { marginLeft: '6px' } }, '🔒'), p && h('span', { class: 'sub' }, p.mesh ? `${p.mesh.filename} · ${p.filament ? p.filament.name : ''}` : 'printed part · no mesh attached', p.role ? ` · ${p.role}` : '')) });
    tr.append(descCell);
    if (p) tr.append(h('td', { class: 'wrap' }, h('a', { href: '#/part/' + p.id, class: 'prof' }, p.profile ? p.profile.string : '—')));
    else tr.append(edCell(it.purpose, v => upd({ purpose: v }), { cls: 'wrap', render: v => h('span', { class: 'rng' }, v || '') }));
    // estimated
    if (p) {
      const j = p.slice;
      tr.append(h('td', { class: 'num' }, j && j.status === 'done' ? h('span', null, fmt(p.corrected_grams ?? j.grams), h('span', { class: 'src' }, 'slicer')) :
        j && (j.status === 'queued' || j.status === 'running') ? h('span', { class: 'pill warn' }, j.status === 'running' ? 'slicing…' : 'queued') :
          j && j.status === 'error' ? h('span', { class: 'pill bad', title: j.error }, 'slice error') :
            h('span', null, fmt(it.est_grams), h('span', { class: 'src' }, p.mesh ? it.est_source : 'no mesh'))));
    } else {
      tr.append(edCell(it.est_grams, v => upd({ est_grams: v }), { type: 'number', cls: 'num', render: v => h('span', null, fmt(v), h('span', { class: 'src' }, it.est_source || 'manual')) }));
    }
    // measured
    tr.append(h('td', { class: 'num ed', title: 'Add a weigh-in', onClick: () => weighInModal(it) }, it.measured_grams != null ? fmt(it.measured_grams) : h('span', { style: { color: 'var(--ink3)' } }, '—'), it.weigh_ins.length > 1 && h('span', { class: 'src' }, `×${it.weigh_ins.length}`)));
    tr.append(h('td', { class: 'num' }, fmt(it.best_grams)));
    tr.append(h('td', { class: 'num', style: { fontWeight: 600 } }, fmt(it.total_grams)));
    tr.append(edCell(it.price, v => upd({ price: v }), { type: 'number', cls: 'num', fmt: v => Number(v).toFixed(2), placeholder: '' }));
    tr.append(edCell(it.status || '', v => upd({ status: v || null }), { options: STATUSES, render: v => v ? h('span', { class: 'pill auto' }, v) : h('span', { style: { color: 'var(--ink3)' } }, '—') }));
    tr.append(h('td', null, h('span', { class: 'flag ' + (it.needs_reweigh ? '' : (it.measured_grams != null ? 'ok' : 'none')), title: it.needs_reweigh ? 'Needs re-weigh: changed since it was measured' : (it.measured_grams != null ? 'Measured' : 'Not measured') })));
    tr.append(h('td', null, h('button', { class: 'btn icon', title: 'Line menu', onClick: e => lineMenu(e.currentTarget, it, s) }, '⋯')));
    return tr;
  }
  function lineMenu(anchor, it, s) {
    const r = S.robot, items = [];
    if (it.part) items.push({ label: 'Open part detail', onClick: () => go('part', it.part.id) });
    else items.push({ label: 'Attach a mesh (make this a printed part)…', onClick: () => attachMeshModal(it) });
    items.push({ label: 'Add weigh-in…', onClick: () => weighInModal(it) });
    if (it.weigh_ins.length) items.push({ label: 'Weigh-in history…', onClick: () => weighHistoryModal(it) });
    items.push({ label: it.counted ? 'Exclude from total' : 'Include in total', onClick: () => api('PUT', `items/${it.id}`, { counted: !it.counted }).then(refreshRobot).catch(fail) });
    items.push({ label: it.to_buy ? 'Unmark “to buy”' : 'Mark “to buy”', onClick: () => api('PUT', `items/${it.id}`, { to_buy: !it.to_buy }).then(refreshRobot).catch(fail) });
    if (it.needs_reweigh) items.push({ label: 'Clear re-weigh flag', onClick: () => api('PUT', `items/${it.id}`, { needs_reweigh: 0 }).then(refreshRobot).catch(fail) });
    items.push({ label: 'Edit link / dimensions / notes…', onClick: () => editLineModal(it) });
    items.push('-');
    items.push({ label: 'Move to section ▸', onClick: () => modal('Move to section', select(r.sections.map(x => [x.id, x.name]), s.id, { id: 'mv-sec' }), [{ label: 'Cancel' }, { label: 'Move', cls: 'primary', onClick: async () => { await api('POST', `items/${it.id}/move`, { section_id: +$('#mv-sec').value }); await refreshRobot(); } }]) });
    if (!it.part) items.push({ label: 'Save to library as component', onClick: async () => { await api('POST', 'components', { name: it.description, category: s.name, link: it.link, price: it.price, dimensions: it.dimensions, grams: it.measured_grams ?? it.est_grams, grams_source: it.measured_grams != null ? 'measured' : 'manual' }); toast('Added to library'); } });
    items.push('-', { label: 'Delete line', cls: 'danger', onClick: () => confirmModal(`Delete “${it.description}”?`, async () => { await api('DELETE', `items/${it.id}`); await refreshRobot(); }) });
    menu(anchor, items);
  }
  function sectionMenu(anchor, s) {
    menu(anchor, [
      { label: '＋ Add line here', onClick: () => addLineModal(s.id) },
      { label: 'Rename…', onClick: () => { const i = input({ value: s.name }); modal('Rename section', field('Name', i), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { await api('PUT', `sections/${s.id}`, { name: i.value }); await refreshRobot(); } }]); } },
      { label: s.counts ? 'Exclude section from weigh-in total' : 'Count section toward weigh-in total', onClick: () => api('PUT', `sections/${s.id}`, { counts: !s.counts }).then(refreshRobot).catch(fail) },
      { label: 'Move up', onClick: () => reorderSection(s, -1) }, { label: 'Move down', onClick: () => reorderSection(s, 1) },
      '-', { label: 'Delete section and its lines', cls: 'danger', onClick: () => confirmModal(`Delete section “${s.name}” and ${s.items.length} lines?`, async () => { await api('DELETE', `sections/${s.id}`); await refreshRobot(); }) },
    ]);
  }
  async function reorderSection(s, dir) {
    const secs = S.robot.sections, i = secs.indexOf(s), j = i + dir; if (j < 0 || j >= secs.length) return;
    await api('PUT', `sections/${s.id}`, { ord: j }); await api('PUT', `sections/${secs[j].id}`, { ord: i }); await refreshRobot();
  }
  function robotMenu(anchor) {
    const r = S.robot;
    menu(anchor, [
      { label: 'Robot settings (name, class, margin, printer)…', onClick: robotSettingsModal },
      { label: 'Duplicate robot…', onClick: () => newRobotModal(r) },
      { label: r.status === 'active' ? 'Archive robot' : 'Un-archive robot', onClick: async () => { await api('PUT', `robots/${r.id}`, { status: r.status === 'active' ? 'archived' : 'active' }); await loadState(); await refreshRobot(); } },
      '-', { label: 'Delete robot', cls: 'danger', onClick: () => confirmModal(`Delete “${r.name}” with all its parts and runs? Meshes stay in the library of files.`, async () => { await api('DELETE', `robots/${r.id}`); S.robot = null; S.robotId = null; localStorage.removeItem('sb.robot'); await loadState(); go('home'); }) },
    ]);
  }
  function robotSettingsModal() {
    const r = S.robot, st = S.state;
    const name = input({ value: r.name }), cls = select([...st.classes.map(c => [c.grams, c.name]), ['custom', 'Custom…']], st.classes.some(c => Math.abs(c.grams - r.weight_class_g) < 0.01) ? r.weight_class_g : 'custom');
    const custom = input({ type: 'number', value: r.weight_class_g, step: '0.1' }), margin = input({ type: 'number', value: r.margin_g, step: '0.1' });
    const printer = select(st.printers.map(p => [p.id, p.name]), r.printer_id), nozzle = select([[0.4, '0.4 mm'], [0.6, '0.6 mm']], r.nozzle || 0.4), notes = h('textarea', null, r.notes || '');
    modal('Robot settings', h('div', null, field('Name', name), field('Weight class', cls), field('Custom limit (g)', custom), field('Margin (g)', margin), field('Printer', printer), field('Nozzle', nozzle), field('Notes', notes)),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        const g = cls.value === 'custom' ? parseFloat(custom.value) : parseFloat(cls.value);
        await api('PUT', `robots/${r.id}`, { name: name.value, weight_class_g: g, class_name: cls.value === 'custom' ? `${fmt(g, 0)} g custom` : cls.selectedOptions[0].textContent, margin_g: parseFloat(margin.value), printer_id: +printer.value, nozzle: parseFloat(nozzle.value), notes: notes.value });
        await loadState(); await refreshRobot();
      } }]);
  }
  function addSectionModal() {
    const name = input({ placeholder: 'e.g. Armor' }), counts = h('input', { type: 'checkbox', checked: true });
    modal('New section', h('div', null, field('Name', name), field('Counts toward weigh-in', counts)), [{ label: 'Cancel' }, { label: 'Add', cls: 'primary', onClick: async () => { await api('POST', `robots/${S.robotId}/sections`, { name: name.value, counts: counts.checked }); await refreshRobot(); } }]);
  }
  function addLineModal(sectionId) {
    const r = S.robot;
    const sec = select(r.sections.map(s => [s.id, s.name]), sectionId || r.sections[0]?.id);
    const desc = input({ placeholder: 'Description' }), qty = input({ type: 'number', value: 1, step: '1' }), est = input({ type: 'number', placeholder: 'estimated g', step: '0.01' });
    const meas = input({ type: 'number', placeholder: 'measured g (optional)', step: '0.01' }), purpose = input({ placeholder: 'Purpose / notes' }), price = input({ type: 'number', placeholder: '$', step: '0.01' }), link = input({ placeholder: 'https://' });
    const printed = h('input', { type: 'checkbox' });
    modal('Add line', h('div', null, field('Section', sec), field('Description', desc), field('Qty', qty), field('Estimated weight', est), field('Measured weight', meas), field('Purpose / notes', purpose), field('Price', price), field('Link', link), field('Printed part', h('label', null, printed, ' create as a printed part (attach mesh next)'))),
      [{ label: 'Cancel' }, { label: 'Add', cls: 'primary', onClick: async () => {
        const body = { description: desc.value, qty: parseFloat(qty.value) || 1, est_grams: est.value === '' ? null : parseFloat(est.value), measured_grams: meas.value === '' ? null : parseFloat(meas.value), purpose: purpose.value || null, price: price.value === '' ? null : parseFloat(price.value), link: link.value || null };
        const it = await api('POST', `sections/${sec.value}/items`, body);
        if (printed.checked) await api('POST', `robots/${r.id}/parts`, { line_item_id: it.id, name: desc.value });
        await refreshRobot();
      } }]);
  }
  function editLineModal(it) {
    const link = input({ value: it.link || '' }), dims = input({ value: it.dimensions || '' }), notes = h('textarea', null, it.notes || ''), purpose = input({ value: it.purpose || '' });
    modal('Edit line', h('div', null, field('Purpose', purpose), field('Link', link), field('Dimensions', dims), field('Notes', notes), it.link && h('p', { class: 'hint' }, h('a', { href: it.link, target: '_blank', rel: 'noopener' }, 'open link ↗'))),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { await api('PUT', `items/${it.id}`, { link: link.value || null, dimensions: dims.value || null, notes: notes.value || null, purpose: purpose.value || null }); await refreshRobot(); } }]);
  }
  function weighInModal(it) {
    const g = input({ type: 'number', step: '0.01', placeholder: 'grams from the scale' }), d = input({ type: 'date', value: today() }), note = input({ placeholder: 'note (spool, event…)' });
    const lib = it.component_id ? h('input', { type: 'checkbox', checked: true }) : null;
    modal(`Weigh-in · ${it.description}`, h('div', null, field('Measured (g)', g), field('Date', d), field('Note', note), lib && field('Update library', h('label', null, lib, ' also update the library component')),
      it.part && it.part.slice && it.part.slice.grams != null && h('p', { class: 'hint' }, `Slicer says ${fmt(it.part.slice.grams, 2)} g for the current profile. This weigh-in feeds the ${it.part.filament ? it.part.filament.name : ''} correction factor.`)),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { if (g.value === '') return false; await api('POST', `items/${it.id}/weighins`, { grams: parseFloat(g.value), date: d.value, note: note.value || null, update_library: lib ? lib.checked : false }); await refreshRobot(); await loadState(); } }]);
  }
  function weighHistoryModal(it) {
    const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num' }, 'Grams'), h('th', null, 'Profile at the time'), h('th', null, 'Note'), h('th'))),
      h('tbody', null, ...[...it.weigh_ins].reverse().map(w => h('tr', null, h('td', { class: 'mono' }, w.date || ''), h('td', { class: 'num' }, fmt(w.grams, 2)), h('td', { class: 'prof' }, w.profile_string || ''), h('td', null, w.note || ''),
        h('td', null, h('button', { class: 'btn icon', onClick: async () => { await api('DELETE', `weighins/${w.id}`); await refreshRobot(); close(); weighHistoryModal(S.robot.sections.flatMap(s => s.items).find(x => x.id === it.id)); } }, '✕'))))));
    const close = modal(`Weigh-ins · ${it.description}`, h('div', { class: 'tw' }, tbl), [{ label: 'Close' }]);
  }
  function robotWeighInModal() {
    const r = S.robot, g = input({ type: 'number', step: '0.1', placeholder: 'whole robot on the scale, g' }), note = input({ placeholder: 'note' });
    modal('Robot weigh-in', h('div', null, h('p', null, `Sheet says ${fmt(r.totals.best_known)} g. Record what the scale says and the run log keeps the drift.`), field('Scale (g)', g), field('Note', note)),
      [{ label: 'Cancel' }, { label: 'Record', cls: 'primary', onClick: async () => { if (!g.value) return false; const run = await api('POST', `robots/${r.id}/weighin`, { grams: parseFloat(g.value), note: note.value }); toast(`Recorded. Drift vs sheet: ${signed(run ? JSON.parse(run.results_json).drift : 0)} g`); } }]);
  }
  async function fromLibraryModal(sectionId) {
    const r = S.robot, comps = await api('GET', 'components');
    const search = input({ placeholder: 'Search components…', class: 'search w' });
    const sec = select(r.sections.map(s => [s.id, s.name]), sectionId || r.sections[0]?.id);
    const qty = input({ type: 'number', value: 1, step: '1' });
    const list = h('div', { class: 'tw', style: { maxHeight: '360px', overflow: 'auto', marginTop: '10px' } });
    let chosen = null;
    const draw = () => {
      const q = search.value.toLowerCase(); list.textContent = '';
      const tb = h('tbody');
      for (const c of comps.filter(c => !q || (c.name + ' ' + (c.category || '')).toLowerCase().includes(q)).slice(0, 200)) {
        tb.append(h('tr', { class: chosen === c ? 'sel' : '', style: { cursor: 'pointer' }, onClick: () => { chosen = c; draw(); } }, h('td', null, c.name, h('span', { class: 'sub' }, c.category || '')), h('td', { class: 'num' }, fmt(c.grams, 2)), h('td', null, h('span', { class: 'pill ' + (c.grams_source === 'measured' ? 'mea' : 'auto') }, c.grams_source || '')), h('td', { class: 'num' }, money(c.price))));
      }
      list.append(h('table', null, tb));
    };
    search.addEventListener('input', draw); draw();
    modal('Add from library', h('div', null, field('Section', sec), field('Qty', qty), search, list), [{ label: 'Cancel' }, { label: 'Add', cls: 'primary', onClick: async () => { if (!chosen) { toast('Pick a component'); return false; } await api('POST', `sections/${sec.value}/items`, { component_id: chosen.id, qty: parseFloat(qty.value) || 1, description: chosen.name }); await refreshRobot(); } }], { width: '720px' });
  }
  function attachMeshModal(it) {
    const inp = h('input', { type: 'file', accept: '.stl,.obj,.3mf,.ply' });
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const res = await api('POST', 'meshes?split=0', await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } });
        const mesh = res.meshes[0];
        if (it.part) await api('PUT', `parts/${it.part.id}`, { mesh_id: mesh.id, force: true });
        else await api('POST', `robots/${S.robotId}/parts`, { line_item_id: it.id, mesh_id: mesh.id });
        await refreshRobot(); toast('Mesh attached; slicing…');
      } catch (e) { fail(e); }
    });
    inp.click();
  }

  // ---------------------------------------------------------------- parts
  V.parts = function (m) {
    const r = S.robot; if (!r) return needRobot(m);
    const st = S.state;
    const parts = r.sections.flatMap(s => s.items.filter(i => i.part).map(i => ({ it: i, p: i.part, s })));
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Printed parts'), h('p', null, 'Every printed line on the sheet with its mesh, profile and slicer result. Drop STL/OBJ/3MF files anywhere on this page to add parts.')),
      h('div', { class: 'tb' }, h('button', { class: 'btn', onClick: () => pickFiles() }, '＋ Add STLs / 3MF'),
        h('button', { class: 'btn', onClick: () => applyProfileModal(parts) }, 'Apply profile to all ▾'),
        h('button', { class: 'btn', onClick: async () => { await api('POST', `robots/${r.id}/slice_all`); toast('Re-slicing all parts'); await refreshRobot(); } }, 'Re-slice all'),
        h('button', { class: 'btn primary', onClick: () => go('optimizer') }, 'Optimize →'))));
    const drop = h('div', { class: 'drop' }, 'Drop STL, OBJ or PLY files here — one part per file (multi-body files are split). Drop a Bambu Studio or PrusaSlicer .3mf project to import every object with its own walls/infill settings.');
    m.append(drop); setupDrop(m, drop);
    const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', { class: 'num' }, 'Qty'), h('th', null, 'Filament'), h('th', null, 'Orientation'), h('th', null, 'Profile'), h('th', null, 'Role'), h('th', { class: 'num' }, 'Slicer g'), h('th', { class: 'num' }, '× corr.'), h('th', { class: 'num' }, 'Measured'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Print time'), h('th', { class: 'num' }, 'Cost'), h('th', null, 'Status'), h('th'))));
    const tb = h('tbody'); tbl.append(tb);
    let tot = 0, totC = 0, totBest = 0, totTime = 0, totCost = 0;
    for (const { it, p } of parts) {
      const j = p.slice; const g = j && j.status === 'done' ? j.grams : null;
      if (g != null) { tot += g * it.qty; totC += (p.corrected_grams ?? g) * it.qty; } totBest += it.total_grams;
      const ptime = j && j.status === 'done' && j.print_time_s ? j.print_time_s * it.qty : null; if (ptime) totTime += ptime;
      const cost = g != null && p.filament && p.filament.cost_per_kg ? g / 1000 * p.filament.cost_per_kg * it.qty : null; if (cost) totCost += cost;
      const upd = (patch) => api('PUT', `parts/${p.id}`, patch).then(refreshRobot).catch(fail);
      tb.append(h('tr', { class: p.locked ? 'locked' : '' },
        h('td', null, h('a', { href: '#/part/' + p.id, style: { color: 'inherit', fontWeight: 600, textDecoration: 'none' } }, it.description), h('span', { class: 'sub' }, p.mesh ? `${p.mesh.filename} · ${p.mesh.bbox ? p.mesh.bbox.size.map(v => v.toFixed(0)).join('×') + ' mm' : ''} · ${(p.mesh.volume_mm3 / 1000).toFixed(2)} cm³` : h('span', { style: { color: 'var(--warn)' } }, 'no mesh attached'))),
        h('td', { class: 'num' }, it.qty),
        p.locked ? h('td', null, filChip(p.filament)) : h('td', { class: 'ed' }, select(st.filaments.map(f => [f.id, f.name]), p.filament_id, { onChange: e => upd({ filament_id: +e.target.value }) })),
        h('td', null, h('span', { class: 'pill auto' }, (p.orient.mode || 'auto') + (p.orient.label ? ' · ' + p.orient.label : ''), p.locked ? ' 🔒' : '')),
        p.locked ? h('td', null, h('span', { class: 'prof' }, p.profile ? p.profile.string : '—'), ' ', h('span', { class: 'pill lock' }, '🔒')) : h('td', { class: 'ed' }, select(st.profiles.filter(x => !x.nozzle || Math.abs(x.nozzle - (r.nozzle || 0.4)) < 0.01 || x.id === p.profile_id).map(x => [x.id, `${x.name} — ${x.string}`]), p.profile_id, { onChange: e => upd({ profile_id: +e.target.value }) })),
        h('td', { class: 'ed' }, select(ROLES, p.role, { onChange: e => upd({ role: e.target.value }) })),
        h('td', { class: 'num' }, g != null ? fmt(g) : '—'),
        h('td', { class: 'num' }, g != null ? fmt(p.corrected_grams ?? g) : ''),
        h('td', { class: 'num' }, it.measured_grams != null ? fmt(it.measured_grams) : '—'),
        h('td', { class: 'num', style: { fontWeight: 600 } }, fmt(it.total_grams)),
        h('td', { class: 'num' }, ptime ? hms(ptime) : ''),
        h('td', { class: 'num' }, cost ? '$' + cost.toFixed(2) : ''),
        h('td', null, jobPill(j, p)),
        h('td', null, h('button', { class: 'btn icon', onClick: e => partMenu(e.currentTarget, it, p) }, '⋯'))));
    }
    tb.append(h('tr', { class: 'sum' }, h('td', null, 'Printed total'), h('td', { class: 'num' }, parts.reduce((a, x) => a + x.it.qty, 0)), h('td', { colspan: 4 }), h('td', { class: 'num' }, fmt(tot)), h('td', { class: 'num' }, fmt(totC)), h('td'), h('td', { class: 'num' }, fmt(totBest)), h('td', { class: 'num' }, totTime ? hms(totTime) : ''), h('td', { class: 'num' }, totCost ? '$' + totCost.toFixed(2) : ''), h('td', { colspan: 2 })));
    m.append(h('div', { class: 'tw' }, tbl));
    if (!parts.length) m.append(h('p', { class: 'empty' }, 'No printed parts yet. Drop STL files above.'));
    m.append(h('p', { class: 'hint' }, '“× corr.” is the slicer figure times this filament’s scale-derived correction. “Total” uses your measured weight where you have one, otherwise the corrected slicer estimate.'));
  };
  function filChip(f) { return f ? h('span', { class: 'mat' }, h('i', { style: { background: f.color || '#888' } }), f.name) : '—'; }
  function jobPill(j, p) {
    if (!p.mesh) return h('button', { class: 'btn small', onClick: () => attachMeshModal({ id: p.line_item_id, part: p }) }, 'Attach mesh');
    if (!j) return h('span', { class: 'pill auto' }, 'not sliced');
    if (j.status === 'done') return h('span', { class: 'pill ver', title: `sliced with ${(j.slicer_version || '').startsWith('bambu-') ? 'Bambu Studio ' + j.slicer_version.slice(6) : 'PrusaSlicer ' + (j.slicer_version || '')}` }, j.time_s ? `sliced ${secs(j.time_s)}` : 'cached');
    if (j.status === 'running') return h('span', { class: 'pill warn' }, 'slicing…');
    if (j.status === 'queued') return h('span', { class: 'pill warn' }, 'queued');
    if (j.status === 'error') return h('span', { class: 'pill bad', title: j.error }, 'error');
    return h('span', { class: 'pill auto' }, j.status);
  }
  function partMenu(anchor, it, p) {
    menu(anchor, [
      { label: 'Open part detail', onClick: () => go('part', p.id) },
      { label: p.locked ? 'Unlock' : 'Lock (profile + orientation + filament)', onClick: () => api('PUT', `parts/${p.id}`, { locked: !p.locked }).then(refreshRobot).catch(fail) },
      { label: 'Re-slice', onClick: () => api('POST', `parts/${p.id}/slice`, { purpose: 'current', priority: 2 }).then(refreshRobot).catch(fail) },
      { label: 'Add weigh-in…', onClick: () => weighInModal(it) },
      { label: p.mesh ? 'Replace mesh…' : 'Attach mesh…', onClick: () => attachMeshModal(it) },
      { label: 'Make a mirrored copy', onClick: () => api('POST', `parts/${p.id}/mirror_copy`, {}).then(refreshRobot).catch(fail) },
      '-', { label: 'Delete part and line', cls: 'danger', onClick: () => confirmModal(`Delete “${it.description}”?`, async () => { await api('DELETE', `parts/${p.id}`); await refreshRobot(); }) },
    ]);
  }
  function applyProfileModal(parts) {
    const st = S.state, sel = select(st.profiles.map(x => [x.id, `${x.name} — ${x.string}`]), st.settings.default_profile_id);
    const fil = select([['', '(keep filament)'], ...st.filaments.map(f => [f.id, f.name])], '');
    modal('Apply to all unlocked parts', h('div', null, field('Profile', sel), field('Filament', fil), h('p', { class: 'hint' }, `${parts.filter(x => !x.p.locked).length} unlocked parts will be re-sliced.`)),
      [{ label: 'Cancel' }, { label: 'Apply', cls: 'primary', onClick: async () => { for (const { p } of parts) if (!p.locked) { const patch = { profile_id: +sel.value }; if (fil.value) patch.filament_id = +fil.value; await api('PUT', `parts/${p.id}`, patch); } await refreshRobot(); } }]);
  }
  function pickFiles() {
    const inp = h('input', { type: 'file', multiple: true, accept: '.stl,.obj,.3mf,.ply' });
    inp.addEventListener('change', () => uploadFiles([...inp.files])); inp.click();
  }
  function setupDrop(area, drop) {
    const on = e => { e.preventDefault(); drop.classList.add('over'); }, off = () => drop.classList.remove('over');
    area.addEventListener('dragover', on); area.addEventListener('dragleave', off);
    area.addEventListener('drop', e => { e.preventDefault(); off(); uploadFiles([...e.dataTransfer.files]); });
  }
  async function uploadFiles(files) {
    if (!S.robotId) return toast('Choose a robot first', true);
    for (const f of files) {
      try {
        toast(`Uploading ${f.name}…`);
        if (/\.3mf$/i.test(f.name)) {
          const r = await api('POST', `robots/${S.robotId}/import3mf`, await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } });
          toast(`${f.name}: ${r.created} part${r.created === 1 ? '' : 's'} imported with their slicer settings`);
          continue;
        }
        const res = await api('POST', 'meshes?split=1', await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } });
        for (const mesh of res.meshes) {
          const name = res.meshes.length > 1 ? mesh.filename.replace(/\.stl$/i, '') : f.name.replace(/\.(stl|obj|3mf|ply)$/i, '');
          let scale = 1.0;
          if (mesh.units_scale_guess && mesh.units_scale_guess !== 1.0) { if (confirm(`${f.name} is only ${mesh.bbox.size.map(v => v.toFixed(1)).join('×')} mm — does it use inches? OK to scale ×25.4.`)) scale = 25.4; }
          await api('POST', `robots/${S.robotId}/parts`, { name, mesh_id: mesh.id, scale });
        }
      } catch (e) { fail(e); }
    }
    await refreshRobot(); await loadState();
  }

  // ---------------------------------------------------------------- part detail
  let viewer = null;
  V.part = async function (m) {
    const r = S.robot; if (!r) return needRobot(m);
    let pid = S.param ? +S.param : null;
    const all = r.sections.flatMap(s => s.items.filter(i => i.part));
    if (!pid) { if (!all.length) { m.append(h('div', { class: 'empty' }, 'No printed parts yet.')); return; } pid = all[0].part.id; }
    const it = all.find(i => i.part.id === pid); if (!it) { m.append(h('div', { class: 'empty' }, 'Part not found.')); return; }
    const p = await api('GET', `parts/${pid}`); const st = S.state;
    const upd = (patch) => api('PUT', `parts/${p.id}`, patch).then(async () => { await refreshRobot(); await renderMain(); }).catch(fail);
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, it.description, p.locked && h('span', { class: 'pill lock', style: { marginLeft: '8px' } }, '🔒 locked')),
      h('p', null, p.mesh ? `${p.mesh.filename} · ${p.mesh.triangles.toLocaleString()} triangles · ${p.mesh.watertight ? 'watertight' : 'not watertight'} · ${(p.mesh.volume_mm3 / 1000).toFixed(2)} cm³ · ${p.mesh.bbox.size.map(v => v.toFixed(0)).join(' × ')} mm${p.scale !== 1 ? ` · scale ${p.scale}` : ''}${p.mirror ? ' · mirrored' : ''}` : 'No mesh attached yet')),
      h('div', { class: 'tb' },
        h('select', { onChange: e => go('part', e.target.value) }, ...all.map(x => h('option', { value: x.part.id, selected: x.part.id === pid }, x.description))),
        h('button', { class: 'btn', onClick: () => attachMeshModal(it) }, p.mesh ? 'Replace mesh' : 'Attach mesh'),
        h('button', { class: 'btn', onClick: () => api('POST', `parts/${p.id}/mirror_copy`, {}).then(refreshRobot).then(() => toast('Mirrored copy created')).catch(fail) }, 'Mirror copy'),
        h('button', { class: 'btn', onClick: () => targetWeightModal(p, it) }, 'Target weight…'),
        h('button', { class: 'btn' + (p.locked ? ' primary' : ''), onClick: () => upd({ locked: !p.locked }) }, p.locked ? 'Unlock' : 'Lock'))));

    const left = h('div'), right = h('div');
    m.append(h('div', { class: 'cols' }, left, right));
    // viewer
    const canvas = h('canvas', { class: 'viewer' });
    const selInfo = h('span', { class: 'hint', style: { margin: 0 } });
    const layBtn = h('button', { class: 'btn small primary', disabled: true, onClick: async () => { if (!viewer?.selection) return; await upd({ orient: undefined }); } }, 'Lay selected face on bed');
    layBtn.onclick = async () => { if (!viewer?.selection) return; try { await api('POST', `parts/${p.id}/lay_on_face`, { normal: viewer.selection.normal }); await refreshRobot(); render(); } catch (e) { fail(e); } };
    const pickBtn = h('button', { class: 'btn small', 'aria-pressed': 'false', onClick: () => { const on = pickBtn.getAttribute('aria-pressed') !== 'true'; pickBtn.setAttribute('aria-pressed', String(on)); viewer.setPickMode(on); pickBtn.textContent = on ? 'Picking: click a face' : 'Pick a face'; } }, 'Pick a face');
    const presets = h('div', { class: 'seg' }, ...[['auto', 'Auto'], ['imported', 'As imported'], ['Z+', 'Z+ down'], ['Z-', 'Z− down'], ['X+', 'X+ down'], ['X-', 'X− down'], ['Y+', 'Y+ down'], ['Y-', 'Y− down']].map(([k, l]) => h('button', { 'aria-pressed': String((p.orient.mode === 'auto' && k === 'auto') || p.orient.label === k), disabled: p.locked, onClick: async () => { try { if (k === 'auto') await api('POST', `parts/${p.id}/auto_orient`, { apply: true }); else await api('POST', `parts/${p.id}/preset`, { name: k }); await refreshRobot(); render(); } catch (e) { fail(e); } } }, l)));
    const rot = (axis, deg) => h('button', { class: 'btn small', disabled: p.locked, onClick: async () => { try { await api('POST', `parts/${p.id}/rotate`, { axis, degrees: deg }); await refreshRobot(); render(); } catch (e) { fail(e); } } }, `${axis.toUpperCase()} ${deg > 0 ? '+' : ''}${deg}°`);
    const previewCard = h('div', { class: 'card' }, h('h3', null, 'Preview · orientation', h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => viewer && viewer.resetView() }, 'Reset view'))),
      canvas,
      h('div', { class: 'tb', style: { marginTop: '10px' } }, presets),
      h('div', { class: 'tb', style: { marginTop: '8px' } }, rot('x', 90), rot('x', -90), rot('y', 90), rot('y', -90), rot('z', 90), rot('z', 45), h('span', { style: { flex: 1 } }), pickBtn, layBtn),
      h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: '#59a56b' } }), 'face on the bed'), h('span', null, h('i', { style: { background: '#ed7f33' } }), 'selected face'), selInfo),
      h('p', { class: 'hint' }, `Orientation: ${p.orient.mode || 'auto'}${p.orient.label ? ' · ' + p.orient.label : ''}. Drag to orbit, wheel to zoom, right-drag to pan. Changing orientation re-slices the part.`));
    // layer view (model classification)
    const layerImg = h('img', { style: { display: 'block', maxWidth: '100%', maxHeight: '340px', margin: '0 auto', border: '1px solid var(--rule)', borderRadius: '6px', background: 'var(--panel2)', imageRendering: 'pixelated' }, alt: 'layer classification' });
    const layerSlider = h('input', { type: 'range', min: 0, max: 1, value: 0, class: 'slider' });
    const layerLbl = h('div', { class: 'hint', style: { display: 'flex', justifyContent: 'space-between', margin: 0 } });
    const layerCard = h('div', { class: 'card' }, h('h3', null, 'Layer view · model classification'), layerImg, layerSlider, layerLbl,
      h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: '#d95f1b' } }), 'walls'), h('span', null, h('i', { style: { background: '#35526e' } }), 'top/bottom shell'), h('span', null, h('i', { style: { background: '#c5d2de' } }), 'sparse infill'), h('span', null, h('i', { style: { background: '#788ca0' } }), 'too thin for infill'), h('span', { class: 'rng' }, 'geometry model, for orientation sanity — weights come from the slicer')));
    if (p.mesh && p.profile) {
      let gone = false; layerCard.addEventListener('DOMNodeRemoved', () => { gone = true; }, { once: true });
      const fetchInfo = async () => { for (let n = 0; n < 150; n++) { const info = await api('GET', `parts/${p.id}/layers`); if (!info.building) return info; if (gone || !document.body.contains(layerCard)) throw new Error('gone'); await new Promise(r => setTimeout(r, 1500)); } throw new Error('layer model took too long'); };
      fetchInfo().then(info => {
        layerSlider.max = info.n_layers - 1; let cur = Math.floor(info.n_layers / 2); layerSlider.value = cur;
        const show = () => { layerImg.src = `/api/parts/${p.id}/layers?i=${cur}&t=${p.slice ? p.slice.id : 0}`; layerLbl.textContent = ''; layerLbl.append(h('span', null, 'layer 1'), h('span', null, `layer ${cur + 1} of ${info.n_layers} · z = ${((cur + 0.5) * info.layer_height).toFixed(2)} mm · ${info.walls} walls · ${info.top}T/${info.bottom}B effective`), h('span', null, String(info.n_layers))); };
        let tmr = null; layerSlider.addEventListener('input', () => { cur = +layerSlider.value; clearTimeout(tmr); tmr = setTimeout(show, 60); }); show();
      }).catch(() => { layerCard.hidden = true; });
      layerImg.alt = ''; layerLbl.textContent = 'building the layer model (a few seconds the first time)…';
    } else layerCard.hidden = true;
    if (p.slice && p.slice.status === 'error') previewCard.append(h('div', { class: 'callout bad' }, h('b', null, 'This orientation did not slice. '), p.slice.error || 'The slicer failed.', ' ', h('button', { class: 'btn small', style: { marginLeft: '6px' }, onClick: () => api('POST', 'jobs/retry_errors', { part_id: p.id }).then(() => refreshRobot()).then(render).catch(fail) }, 'Try again')));
    left.append(h('div', { class: 'grid2' }, previewCard, layerCard));
    if (p.mesh) {
      setTimeout(async () => {
        viewer = new STLViewer(canvas, { onSelect: s => { selInfo.textContent = `selected face: ${s.area.toFixed(0)} mm² · ${s.triangles} triangles`; layBtn.disabled = false; } });
        const buf = await (await fetch(`/api/meshes/${p.mesh.id}/stl?part=${p.id}&t=${Date.now()}`)).arrayBuffer();
        viewer.load(buf); viewer.setBoxes(p.modifiers || []);
      }, 0);
    } else canvas.replaceWith(h('div', { class: 'drop' }, 'Attach a mesh to preview and slice this part'));

    // orientation sweep + slices table
    const jobs = p.jobs || [];
    const orientJobs = jobs.filter(j => j.purpose === 'orient');
    const sweepRows = h('tbody');
    const cur = p.slice;
    const seen = new Set();
    const curVer = (S.state.slicer && S.state.slicer.slicer) || '';
    const engLabel = v => !v ? '' : v.startsWith('bambu-') ? 'Bambu Studio ' + v.slice(6) : 'PrusaSlicer ' + v.split('+')[0];
    // one row per profile+filament, preferring a result from the active slicer over an older engine's
    const rows = jobs.filter(j => j.purpose !== 'orient' && j.orient_key === (cur ? cur.orient_key : j.orient_key))
      .sort((a, b) => ((b.slicer_version === curVer) - (a.slicer_version === curVer)) || (b.id - a.id))
      .filter(j => { const k = j.profile_hash + j.filament_key; if (seen.has(k)) return false; seen.add(k); return true; });
    rows.sort((a, b) => (a.grams ?? 1e9) - (b.grams ?? 1e9));
    const stale = rows.filter(j => j.status === 'done' && curVer && j.slicer_version !== curVer);
    for (const j of rows) {
      const pr = j.profile_json ? JSON.parse(j.profile_json) : null;
      const isCur = cur && j.cache_key === cur.cache_key;
      const other = j.status === 'done' && curVer && j.slicer_version !== curVer;
      sweepRows.append(h('tr', { class: (isCur ? 'sel ' : '') + (other ? 'dim' : ''), title: other ? `Sliced with ${engLabel(j.slicer_version)} — the active engine is ${engLabel(curVer)}` : '' },
        h('td', null, h('span', { class: 'prof' }, pr ? profString(pr) : '?'), isCur && h('span', { class: 'pill auto', style: { marginLeft: '6px' } }, 'current'), other && h('span', { class: 'pill warn', style: { marginLeft: '6px' } }, engLabel(j.slicer_version).split(' ')[0])),
        h('td', { class: 'num', style: { fontWeight: 600 } }, j.status === 'done' ? fmt(j.grams, 2) : h('span', { class: 'pill ' + (j.status === 'error' ? 'bad' : 'warn'), title: j.error }, j.status)),
        h('td', { class: 'num' }, j.status === 'done' && p.filament ? fmt(j.grams * (p.filament.correction.factor || 1), 2) : ''),
        h('td', { class: 'num', style: { color: cur && cur.grams != null && j.grams != null ? (j.grams > cur.grams ? 'var(--bad)' : 'var(--good)') : '' } }, cur && cur.grams != null && j.grams != null && !isCur ? signed(j.grams - cur.grams, 2) : ''),
        h('td', { class: 'num' }, j.print_time_s ? hms(j.print_time_s) : ''),
        h('td', { class: 'num' }, j.time_s ? secs(j.time_s) : (j.status === 'done' ? 'cached' : '')),
        h('td', null, !isCur && pr && !p.locked && h('button', { class: 'btn small', onClick: () => applyParamsAsProfile(p, pr) }, 'Apply'))));
    }
    left.append(h('div', { class: 'card', style: { marginTop: '12px' } }, h('h3', null, 'Profile sweep · real slices · this orientation', h('div', { class: 'tb' },
      stale.length ? h('button', { class: 'btn small', title: 'Re-run the greyed rows with the active slicer', onClick: async () => { try { for (const j of stale) { const pr = JSON.parse(j.profile_json); await api('POST', `parts/${p.id}/slice`, { params: pr }); } render(); } catch (e) { fail(e); } } }, `Re-slice ${stale.length} old row${stale.length > 1 ? 's' : ''}`) : null,
      h('button', { class: 'btn small', onClick: () => customSliceModal(p) }, '＋ Slice a profile'),
      h('button', { class: 'btn small', onClick: () => exactSweepModal(p) }, 'Exact sweep…'),
      h('button', { class: 'btn small', onClick: async () => { try { await api('POST', `parts/${p.id}/orientation_sweep`, {}); toast('Orientation sweep queued (6 candidates)'); } catch (e) { fail(e); } } }, 'Orientation sweep'))),
      h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Profile'), h('th', { class: 'num' }, 'Slicer g'), h('th', { class: 'num' }, '× corr.'), h('th', { class: 'num' }, 'vs current'), h('th', { class: 'num' }, 'Print time'), h('th', { class: 'num' }, 'Slice'), h('th'))), sweepRows)),
      !rows.length && h('p', { class: 'hint' }, 'No slices yet for this orientation.'),
      orientJobs.length ? h('div', null, h('h3', { style: { marginTop: '14px' } }, 'Orientation sweep · current profile'), h('div', { class: 'tw' }, h('table', null, h('tbody', null, ...orientJobs.filter((j, i, a) => a.findIndex(x => x.orient_key === j.orient_key) === i).sort((a, b) => (a.grams ?? 1e9) - (b.grams ?? 1e9)).map(j => h('tr', null, h('td', { class: 'mono' }, j.orient_key.split('|')[0].replace('q', 'quat ')), h('td', { class: 'num' }, j.status === 'done' ? fmt(j.grams, 2) + ' g' : j.status), h('td', null, j.status === 'done' && !p.locked && h('button', { class: 'btn small', onClick: () => upd({ orient: { mode: 'manual', quat: j.orient_key.split('|')[0].slice(1).split(',').map(Number), label: 'from sweep' } }) }, 'Use')))))))) : null));

    // right column: settings
    const prof = p.profile, params = prof ? prof.params : null;
    right.append(h('div', { class: 'card' }, h('h3', null, 'Print settings'),
      field('Filament', select(st.filaments.map(f => [f.id, `${f.name} · ${f.density}${f.correction.factor ? ' · ×' + f.correction.factor.toFixed(3) : ''}`]), p.filament_id, { disabled: p.locked, onChange: e => upd({ filament_id: +e.target.value }) })),
      field('Profile', select(st.profiles.map(x => [x.id, `${x.name} — ${x.string}`]), p.profile_id, { disabled: p.locked, onChange: e => upd({ profile_id: +e.target.value }) })),
      params && h('div', { class: 'hint' }, `Walls ${params.walls} · top ${params.top} (effective ${prof.effective_shells[0]}) · bottom ${params.bottom} (effective ${prof.effective_shells[1]}) · ${params.infill}% ${params.pattern} · ${params.layer_height} mm · ${params.nozzle} mm nozzle`),
      h('div', { class: 'tb', style: { marginTop: '8px' } }, prof && h('button', { class: 'btn small', onClick: () => editProfileModal(prof) }, prof.builtin ? 'View profile' : 'Edit profile'), h('button', { class: 'btn small', onClick: () => editProfileModal(null, params, (np) => upd({ profile_id: np.id })) }, 'New profile from this…')),
      field('Scale', h('div', { class: 'tb' }, input({ type: 'number', value: p.scale, step: '0.01', disabled: p.locked, style: { width: '90px' }, onChange: e => upd({ scale: parseFloat(e.target.value) || 1 }) }), h('span', { class: 'rng' }, p.mesh ? `98%: ≈${fmt((p.corrected_grams || 0) * 0.98 ** 3)} g · 102%: ≈${fmt((p.corrected_grams || 0) * 1.02 ** 3)} g (cube law)` : ''))),
      field('Role', select(ROLES, p.role, { onChange: e => upd({ role: e.target.value }) })),
      field('Qty', input({ type: 'number', value: it.qty, step: '1', style: { width: '90px' }, onChange: e => api('PUT', `items/${it.id}`, { qty: parseFloat(e.target.value) || 1 }).then(refreshRobot).catch(fail) })),
      cur && cur.status === 'done' && h('p', { class: 'hint' }, `Current slice: ${fmt(cur.grams, 2)} g${p.filament && p.filament.correction.factor ? ` → ${fmt(p.corrected_grams, 2)} g after ${p.filament.name} correction` : ''}${cur.print_time_s ? ` · print time ${hms(cur.print_time_s)}` : ''}${p.filament && p.filament.cost_per_kg ? ` · cost ≈ $${(cur.grams / 1000 * p.filament.cost_per_kg).toFixed(2)}` : ''}`)));
    const c = p.constraints || {};
    const rng = (key, lo, hi, step) => { const a = input({ type: 'number', value: c[key]?.[0] ?? lo, step, style: { width: '70px' } }), b = input({ type: 'number', value: c[key]?.[1] ?? hi, step, style: { width: '70px' } }); const save = () => { const nc = Object.assign({}, p.constraints, { [key]: [parseFloat(a.value), parseFloat(b.value)] }); upd({ constraints: nc }); }; a.addEventListener('change', save); b.addEventListener('change', save); return h('div', { class: 'tb' }, a, '–', b); };
    right.append(h('div', { class: 'card' }, h('h3', null, 'Optimizer rules'),
      field('Lock', h('div', { class: 'seg' }, h('button', { 'aria-pressed': String(!p.locked), onClick: () => upd({ locked: false }) }, 'Free'), h('button', { 'aria-pressed': String(p.locked), onClick: () => upd({ locked: true }) }, 'Locked'))),
      field('Walls', rng('walls', 2, 5, '1')), field('Top layers', rng('top', 3, 5, '1')), field('Bottom layers', rng('bottom', 3, 5, '1')), field('Infill %', rng('infill', 8, 40, '1')),
      h('p', { class: 'hint' }, 'Locked freezes profile, orientation and filament; the optimizer treats the part as fixed weight. Ranges bound what the optimizer may choose.')));
    // modifier regions
    const modsCard = h('div', { class: 'card' }, h('h3', null, 'Modifier regions', h('div', { class: 'tb' }, h('button', { class: 'btn small', disabled: p.locked || !p.mesh, onClick: () => modifierModal(p, null) }, '＋ Box'))));
    if ((p.modifiers || []).length) {
      const tb = h('tbody');
      for (const [i, md] of p.modifiers.entries()) {
        const ov = Object.entries(md.params || {}).filter(([k, v]) => v !== null && v !== '').map(([k, v]) => `${k} ${v}${k === 'infill' ? '%' : ''}`).join(' · ');
        tb.append(h('tr', null, h('td', null, md.name || `box ${i + 1}`, h('span', { class: 'sub' }, `x ${md.min[0]}…${md.max[0]} · y ${md.min[1]}…${md.max[1]} · z ${md.min[2]}…${md.max[2]} mm`)), h('td', { class: 'prof' }, ov || '—'),
          h('td', null, h('button', { class: 'btn icon', disabled: p.locked, onClick: () => modifierModal(p, i) }, '✎'), h('button', { class: 'btn icon', disabled: p.locked, onClick: () => { const mods = p.modifiers.filter((_, j) => j !== i); upd({ modifiers: mods }).then(render); } }, '✕'))));
      }
      modsCard.append(h('div', { class: 'tw' }, h('table', null, tb)));
    }
    modsCard.append(h('p', { class: 'hint' }, 'A box region with its own walls/infill (e.g. 100% around the weapon bolt pattern). Sliced for real as a modifier mesh in the active slicer. Coordinates are in the preview frame: x/y centred on the part, z from the bed.'));
    right.append(modsCard);
    right.append(h('div', { class: 'card' }, h('h3', null, 'Weigh-ins', h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => weighInModal(it) }, '＋ Add'))),
      it.weigh_ins.length ? h('div', { class: 'tw' }, h('table', null, h('tbody', null, ...[...it.weigh_ins].reverse().slice(0, 6).map(w => h('tr', null, h('td', { class: 'mono' }, w.date || ''), h('td', { class: 'num' }, fmt(w.grams, 2) + ' g'), h('td', { class: 'prof' }, w.profile_string || '')))))) : h('p', { class: 'hint' }, 'No weigh-ins yet. Enter the scale reading after printing; it calibrates this filament.'),
      it.needs_reweigh && h('p', { class: 'hint', style: { color: 'var(--warn)' } }, 'Profile, orientation or mesh changed since the last weigh-in.')));
  };
  function modifierModal(p, idx) {
    const md = idx != null ? p.modifiers[idx] : null;
    const bb = p.mesh && p.mesh.bbox ? p.mesh.bbox.size : [50, 50, 20];
    const half = [bb[0] / 2, bb[1] / 2];
    const name = input({ value: md ? md.name : 'dense zone' });
    const mk = v => input({ type: 'number', value: v, step: '0.5', style: { width: '80px' } });
    const x0 = mk(md ? md.min[0] : -half[0]), x1 = mk(md ? md.max[0] : half[0]), y0 = mk(md ? md.min[1] : -half[1]), y1 = mk(md ? md.max[1] : half[1]), z0 = mk(md ? md.min[2] : 0), z1 = mk(md ? md.max[2] : bb[2]);
    const pr = md && md.params || {};
    const walls = input({ type: 'number', value: pr.walls ?? '', placeholder: 'keep', style: { width: '80px' } }), infill = input({ type: 'number', value: pr.infill ?? 100, placeholder: 'keep', style: { width: '80px' } }), top = input({ type: 'number', value: pr.top ?? '', placeholder: 'keep', style: { width: '80px' } }), bottom = input({ type: 'number', value: pr.bottom ?? '', placeholder: 'keep', style: { width: '80px' } });
    const pattern = select([['', '(keep)'], ...PATTERNS], pr.pattern || '', { style: { width: '140px' } });
    const preview = () => { if (viewer) { const boxes = (p.modifiers || []).map((m, i) => Object.assign({}, m, { selected: i === idx })); const cur = { min: [+x0.value, +y0.value, +z0.value], max: [+x1.value, +y1.value, +z1.value], selected: true }; if (idx != null) boxes[idx] = cur; else boxes.push(cur); viewer.setBoxes(boxes); } };
    [x0, x1, y0, y1, z0, z1].forEach(i => i.addEventListener('input', preview)); preview();
    modal(md ? 'Edit modifier region' : 'New modifier region', h('div', null, field('Name', name),
      field('X from – to', h('div', { class: 'tb' }, x0, '–', x1, h('span', { class: 'rng' }, `part spans ${(-half[0]).toFixed(1)} … ${half[0].toFixed(1)}`))),
      field('Y from – to', h('div', { class: 'tb' }, y0, '–', y1, h('span', { class: 'rng' }, `${(-half[1]).toFixed(1)} … ${half[1].toFixed(1)}`))),
      field('Z from – to', h('div', { class: 'tb' }, z0, '–', z1, h('span', { class: 'rng' }, `0 … ${bb[2].toFixed(1)}`))),
      h('p', { class: 'hint' }, 'Overrides inside the box (blank = keep the part profile):'),
      field('Walls', walls), field('Infill %', infill), field('Pattern', pattern), field('Top layers', top), field('Bottom layers', bottom)),
      [{ label: 'Cancel', onClick: () => { if (viewer) viewer.setBoxes(p.modifiers || []); } }, { label: 'Save', cls: 'primary', onClick: async () => {
        const params = {}; if (walls.value !== '') params.walls = +walls.value; if (infill.value !== '') params.infill = +infill.value; if (top.value !== '') params.top = +top.value; if (bottom.value !== '') params.bottom = +bottom.value; if (pattern.value) params.pattern = pattern.value;
        const nm = { name: name.value || 'modifier', min: [+x0.value, +y0.value, +z0.value].map(v => Math.round(v * 100) / 100), max: [+x1.value, +y1.value, +z1.value].map(v => Math.round(v * 100) / 100), params };
        for (let k = 0; k < 3; k++) if (nm.max[k] <= nm.min[k]) { toast('Each max must be greater than its min', true); return false; }
        const mods = [...(p.modifiers || [])]; if (idx != null) mods[idx] = nm; else mods.push(nm);
        await api('PUT', `parts/${p.id}`, { modifiers: mods }); await refreshRobot(); render();
      } }], { onClose: () => { if (viewer) viewer.setBoxes(p.modifiers || []); } });
  }
  function profString(pr) { const inf = pr.infill >= 100 ? '100%' : `${pr.infill}% ${pr.pattern}`; return `${pr.walls}W · ${pr.top}T/${pr.bottom}B · ${inf} · ${pr.layer_height}${pr.nozzle && pr.nozzle !== 0.4 ? ' · ' + pr.nozzle : ''}`; }
  async function applyParamsAsProfile(p, pr) {
    const st = S.state, existing = st.profiles.find(x => x.string === profString(pr) && JSON.stringify(x.params) === JSON.stringify(Object.assign({}, x.params, pr)));
    let prof = existing;
    if (!prof) prof = await api('POST', 'profiles', { name: profString(pr), params: pr, nozzle: pr.nozzle });
    await api('PUT', `parts/${p.id}`, { profile_id: prof.id }); await loadState(); await refreshRobot(); render();
  }
  function paramsForm(params, opts = {}) {
    const P = Object.assign({}, params);
    const f = {};
    const mk = (k, attrs) => f[k] = input(Object.assign({ type: 'number', value: P[k], style: { width: '110px' }, disabled: opts.readonly }, attrs));
    const body = h('div', null,
      field('Wall loops', mk('walls', { step: '1', min: 0 })), field('Top layers', mk('top', { step: '1', min: 0 })), field('Bottom layers', mk('bottom', { step: '1', min: 0 })),
      field('Sparse infill %', mk('infill', { step: '1', min: 0, max: 100 })), field('Pattern', f.pattern = select(PATTERNS, P.pattern, { disabled: opts.readonly, style: { width: '160px' } })),
      field('Layer height', mk('layer_height', { step: '0.02' })), field('Nozzle', f.nozzle = select([[0.4, '0.4 mm'], [0.6, '0.6 mm']], P.nozzle, { disabled: opts.readonly, style: { width: '110px' } })),
      h('details', null, h('summary', { style: { cursor: 'pointer', color: 'var(--ink2)', fontSize: '13px', margin: '8px 0' } }, 'Advanced (Bambu defaults)'),
        field('First layer height', mk('first_layer_height', { step: '0.02' })), field('Top min thickness', mk('top_min_thickness', { step: '0.1' })), field('Bottom min thickness', mk('bottom_min_thickness', { step: '0.1' })),
        field('Infill/wall overlap %', mk('infill_wall_overlap', { step: '1' })), field('Min sparse area mm²', mk('min_sparse_area', { step: '1' })),
        field('One wall on top', f.one_wall_top = h('input', { type: 'checkbox', checked: !!P.one_wall_top, disabled: opts.readonly })),
        field('Thin walls', f.thin_walls = h('input', { type: 'checkbox', checked: !!P.thin_walls, disabled: opts.readonly })),
        field('Gap fill', f.gap_fill = h('input', { type: 'checkbox', checked: P.gap_fill !== false, disabled: opts.readonly })),
        ...['outer', 'inner', 'infill', 'solid', 'top', 'first'].map(k => field(`Line width · ${k}`, f['lw_' + k] = input({ type: 'number', value: P.line_widths[k], step: '0.01', style: { width: '110px' }, disabled: opts.readonly })))));
    // live note about Bambu's "layers or thickness, whichever is more" rule — the usual reason two slicers disagree
    const shellNote = h('div', { class: 'callout', hidden: true });
    body.insertBefore(shellNote, body.children[3]);
    const updNote = () => {
      const lh = parseFloat(f.layer_height.value) || 0.2, t = parseInt(f.top.value) || 0, b = parseInt(f.bottom.value) || 0;
      const tm = parseFloat(f.top_min_thickness.value) || 0, bm = parseFloat(f.bottom_min_thickness.value) || 0;
      const et = Math.max(t, tm > 0 ? Math.ceil(tm / lh - 1e-9) : 0), eb = Math.max(b, bm > 0 ? Math.ceil(bm / lh - 1e-9) : 0);
      const msgs = [];
      if (et !== t) msgs.push(`Top: ${t} layers becomes ${et} because “Top min thickness” is ${tm} mm (Bambu Studio does the same unless its Top shell thickness is 0). Set it to 0 for exactly ${t}.`);
      if (eb !== b) msgs.push(`Bottom: ${b} layers becomes ${eb} because “Bottom min thickness” is ${bm} mm.`);
      shellNote.hidden = !msgs.length; shellNote.textContent = msgs.join(' ');
    };
    for (const k of ['top', 'bottom', 'layer_height', 'top_min_thickness', 'bottom_min_thickness']) f[k].addEventListener('input', updNote);
    updNote();
    const read = () => {
      const out = {};
      for (const k of ['walls', 'top', 'bottom', 'infill', 'layer_height', 'first_layer_height', 'top_min_thickness', 'bottom_min_thickness', 'infill_wall_overlap', 'min_sparse_area']) out[k] = parseFloat(f[k].value);
      out.pattern = f.pattern.value; out.nozzle = parseFloat(f.nozzle.value); out.one_wall_top = f.one_wall_top.checked; out.thin_walls = f.thin_walls.checked; out.gap_fill = f.gap_fill.checked;
      out.line_widths = {}; for (const k of ['outer', 'inner', 'infill', 'solid', 'top', 'first']) out.line_widths[k] = parseFloat(f['lw_' + k].value);
      return out;
    };
    // when nozzle changes, reset line widths to that nozzle's defaults
    f.nozzle.addEventListener('change', () => { const d = f.nozzle.value === '0.6' ? { outer: .62, inner: .62, infill: .62, solid: .62, top: .62, first: .62, lh: .3, tm: .8, top: 3 } : { outer: .42, inner: .45, infill: .45, solid: .42, top: .42, first: .5, lh: .2, tm: 1.0, top: 5 }; for (const k of ['outer', 'inner', 'infill', 'solid', 'top', 'first']) f['lw_' + k].value = d[k]; f.layer_height.value = d.lh; f.first_layer_height.value = d.lh; f.top_min_thickness.value = d.tm; f.top.value = d.top; });
    return { body, read };
  }
  function editProfileModal(prof, baseParams, onCreated) {
    const st = S.state;
    const params = prof ? prof.params : (baseParams || st.profiles[0].params);
    const readonly = prof && prof.builtin;
    const name = input({ value: prof ? prof.name : profString(params), disabled: readonly });
    const { body, read } = paramsForm(params, { readonly });
    const inUse = prof ? S.state.robots.length && '' : '';
    modal(prof ? (readonly ? prof.name : 'Edit profile') : 'New profile', h('div', null, field('Name', name), body, readonly && h('p', { class: 'hint' }, 'Built-in profiles are read-only. Use “New profile from this” to make a copy you can edit.'), prof && !readonly && h('p', { class: 'hint' }, 'Saving re-slices every part that uses this profile.')),
      readonly ? [{ label: 'Close' }, { label: 'Duplicate', cls: 'primary', onClick: async () => { const np = await api('POST', 'profiles', { name: name.value + ' copy', params: read(), nozzle: read().nozzle }); await loadState(); if (onCreated) onCreated(np); render(); } }]
        : [{ label: 'Cancel' }, { label: prof ? 'Save' : 'Create', cls: 'primary', onClick: async () => { const params = read(); let np; if (prof) np = await api('PUT', `profiles/${prof.id}`, { name: name.value, params, nozzle: params.nozzle }); else np = await api('POST', 'profiles', { name: name.value, params, nozzle: params.nozzle }); await loadState(); if (onCreated && !prof) await onCreated(np); if (S.robotId) await refreshRobot(); render(); } }], { width: '560px' });
  }
  function customSliceModal(p) {
    const params = p.profile ? p.profile.params : S.state.profiles[0].params;
    const { body, read } = paramsForm(params);
    modal('Slice this part with a profile', h('div', null, body, h('p', { class: 'hint' }, 'Runs one real slice and adds the row to the sweep table.')), [{ label: 'Cancel' }, { label: 'Slice', cls: 'primary', onClick: async () => { await api('POST', `parts/${p.id}/slice`, { params: read(), purpose: 'sweep', priority: 4 }); toast('Slice queued'); setTimeout(render, 500); } }], { width: '560px' });
  }
  function exactSweepModal(p) {
    const c = p.constraints || {};
    const w = [input({ type: 'number', value: c.walls?.[0] ?? 2, style: { width: '70px' } }), input({ type: 'number', value: c.walls?.[1] ?? 5, style: { width: '70px' } })];
    const tb = [input({ type: 'number', value: c.top?.[0] ?? 3, style: { width: '70px' } }), input({ type: 'number', value: c.top?.[1] ?? 5, style: { width: '70px' } })];
    const inf = [input({ type: 'number', value: c.infill?.[0] ?? 10, style: { width: '70px' } }), input({ type: 'number', value: c.infill?.[1] ?? 40, style: { width: '70px' } }), input({ type: 'number', value: 10, style: { width: '70px' } })];
    const count = h('span', { class: 'hint' });
    const calc = () => { const n = (Math.max(0, +w[1].value - +w[0].value) + 1) * (Math.max(0, +tb[1].value - +tb[0].value) + 1) * (Math.floor(Math.max(0, +inf[1].value - +inf[0].value) / Math.max(1, +inf[2].value)) + 1); count.textContent = `${n} slices ≈ ${(n * 12 / 60 / Math.max(1, S.state.slicer.workers)).toFixed(0)} min with ${S.state.slicer.workers} worker(s)`; };
    [...w, ...tb, ...inf].forEach(i => i.addEventListener('input', calc)); calc();
    modal('Exact sweep', h('div', null, field('Walls', h('div', { class: 'tb' }, w[0], '–', w[1])), field('Top = bottom layers', h('div', { class: 'tb' }, tb[0], '–', tb[1])), field('Infill % (from – to, step)', h('div', { class: 'tb' }, inf[0], '–', inf[1], 'step', inf[2])), count),
      [{ label: 'Cancel' }, { label: 'Queue sweep', cls: 'primary', onClick: async () => {
        const base = p.profile.params; let n = 0;
        for (let W = +w[0].value; W <= +w[1].value; W++) for (let T = +tb[0].value; T <= +tb[1].value; T++) for (let I = +inf[0].value; I <= +inf[1].value; I += Math.max(1, +inf[2].value)) { await api('POST', `parts/${p.id}/slice`, { params: Object.assign({}, base, { walls: W, top: T, bottom: T, infill: I }), purpose: 'sweep', priority: 7 }); n++; }
        toast(`${n} slices queued`); setTimeout(render, 500);
      } }]);
  }
  function targetWeightModal(p, it) {
    const cur = p.slice; const g = input({ type: 'number', step: '0.1', value: cur && cur.grams ? (cur.grams * 0.9).toFixed(1) : '' });
    modal('Target weight for this part', h('div', null, h('p', null, 'Runs the optimizer on this single part: real slices at the corners of its ranges, then a search for wall/shell/infill combinations that land on the target. Results appear in the Optimizer tab.'), field('Target (g)', g)),
      [{ label: 'Cancel' }, { label: 'Run', cls: 'primary', onClick: async () => { const run = await api('POST', `robots/${S.robotId}/optimize`, { mode: 'single', part_id: p.id, target_g: parseFloat(g.value), strategy: 'uniform' }); go('optimizer', run.id); } }]);
  }

  // ---------------------------------------------------------------- optimizer
  V.optimizer = async function (m) {
    const r = S.robot; if (!r) return needRobot(m);
    const runs = await api('GET', `robots/${r.id}/runs`);
    const optRuns = runs.filter(x => x.kind === 'optimize');
    const run = S.param ? (optRuns.find(x => x.id === +S.param) || await api('GET', `runs/${S.param}`)) : optRuns[0];
    const t = r.totals;
    const parts = r.sections.flatMap(s => s.items.filter(i => i.part && i.counted && s.counts));
    const locked = parts.filter(i => i.part.locked), free = parts.filter(i => !i.part.locked && i.part.mesh), noMesh = parts.filter(i => !i.part.locked && !i.part.mesh);
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Optimizer'), h('p', null, 'Finds profile plans that put the robot under its limit. Every plan shown has been re-sliced for real before it appears.'))));
    const left = h('div'), right = h('div'); m.append(h('div', { class: 'cols' }, left, right));
    const strat = { v: (run && run.inputs.strategy) || 'per_role' }, model = { v: (run && run.inputs.model) || 'anchored' }, rank = input({ type: 'range', min: 0, max: 100, value: run ? run.inputs.rank ?? 25 : 25, class: 'slider' });
    const margin = input({ type: 'number', value: r.margin_g, step: '0.1', style: { width: '90px' } }), nplans = input({ type: 'number', value: run ? run.inputs.n_plans || 5 : 5, step: '1', min: 1, max: 12, style: { width: '70px' } });
    const budgetLbl = h('b', { class: 'mono', style: { fontSize: '16px' } });
    const pctLbl = h('span', { class: 'rng' });
    const calcBudget = () => { budgetLbl.textContent = fmt(r.weight_class_g - parseFloat(margin.value || 0) - (t.best_known - t.printed)) + ' g'; pctLbl.textContent = `${((parseFloat(margin.value) || 0) / r.weight_class_g * 100).toFixed(1)}% of class`; }; margin.addEventListener('input', calcBudget); calcBudget();
    const segBtn = (obj, val, label, desc) => h('button', { 'aria-pressed': String(obj.v === val), title: desc, onClick: e => { obj.v = val; [...e.currentTarget.parentNode.children].forEach(b => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); } }, label);
    const status = h('span', { class: 'hint', style: { margin: 0 } });
    left.append(h('div', { class: 'card' }, h('h3', null, 'Target'),
      h('div', { class: 'grid2' },
        h('div', null, field('Class', h('span', null, `${r.class_name || ''} · ${fmt(r.weight_class_g)} g`)), field('Non-printed', h('span', { class: 'mono' }, `${fmt(t.best_known - t.printed)} g `, h('span', { class: 'rng' }, 'best known, from sheet'))), field('Margin', h('div', { class: 'tb' }, margin, pctLbl)), field('Printed budget', budgetLbl)),
        h('div', null,
          field('Strategy', h('div', { class: 'seg' }, segBtn(strat, 'uniform', 'Uniform', 'One profile for all free parts'), segBtn(strat, 'per_role', 'Per role', 'Each role gets its own walls/shells'), segBtn(strat, 'priority', 'Priority fill', 'Minimums first, then spend grams on armor walls'), segBtn(strat, 'trim', 'Trim', 'Smallest change from current profiles'))),
          field('Rank', h('div', null, rank, h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--ink3)' } }, h('span', null, 'prefer walls'), h('span', null, 'prefer infill')))),
          field('Model', h('div', { class: 'seg' }, segBtn(model, 'anchored', 'Anchored (fast)', 'Real slices at range corners, fitted model in between, every shown plan confirmed'), segBtn(model, 'grid', 'Exact grid', 'Real slices on a coarse grid per part; slower, no model'))),
          field('Plans', nplans),
          field('Locked', h('span', null, locked.length ? locked.map(i => h('span', { class: 'pill lock', style: { marginRight: '4px' } }, `${i.description} ${fmt(i.total_grams)} g`)) : h('span', { class: 'rng' }, 'none'))))),
      h('div', { class: 'tb', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', disabled: !free.length, onClick: async () => { try { const rr = await api('POST', `robots/${r.id}/optimize`, { strategy: strat.v, model: model.v, rank: +rank.value, margin_g: parseFloat(margin.value), n_plans: +nplans.value }); go('optimizer', rr.id); } catch (e) { fail(e); } } }, 'Run optimizer'),
        run && (run.status === 'running') && h('button', { class: 'btn', onClick: () => api('POST', `runs/${run.id}/cancel`).then(render) }, 'Cancel'), status,
        noMesh.length ? h('span', { class: 'pill warn' }, `${noMesh.length} printed part${noMesh.length > 1 ? 's' : ''} without mesh count as their sheet weight`) : null,
        !free.length && h('span', { class: 'pill warn' }, 'No unlocked parts with meshes to optimize'))));
    if (!run) { left.append(h('p', { class: 'empty' }, 'No optimizer runs yet for this robot.')); return; }
    const res = run.results || {};
    status.textContent = res.status_text || (run.status === 'running' ? 'running…' : '');
    // results
    const viewSeg = h('div', { class: 'seg', style: { marginLeft: 'auto' } });
    const plansEl = h('div', { class: 'plans' }), paretoEl = h('div', { class: 'card', hidden: true });
    const showP = (p) => { plansEl.hidden = p; paretoEl.hidden = !p; viewSeg.children[0].setAttribute('aria-pressed', String(!p)); viewSeg.children[1].setAttribute('aria-pressed', String(p)); if (p) drawPareto(paretoEl, res, run); };
    viewSeg.append(h('button', { 'aria-pressed': 'true', onClick: () => showP(false) }, 'Plans'), h('button', { 'aria-pressed': 'false', onClick: () => showP(true) }, 'Pareto chart'));
    left.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' } }, h('h3', { style: { margin: 0, fontSize: '12px', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink3)' } }, `Results · run #${run.id} · ${new Date(run.date * 1000).toLocaleString()}`), viewSeg));
    const plans = res.plans || [];
    const selected = { i: 0 };
    const rightDetail = h('div');
    const drawPlans = () => {
      plansEl.textContent = '';
      plans.forEach((pl, i) => {
        const conf = pl.status === 'confirmed';
        plansEl.append(h('div', { class: 'plan' + (i === 0 && conf && pl.fits ? ' best' : '') + (pl.fits === false ? ' infeas' : ''), onClick: () => { selected.i = i; drawDetail(); } },
          h('div', { class: 't' }, h('b', null, pl.name), h('span', { class: 'pill ' + (conf ? (pl.fits ? 'good' : 'bad') : 'warn') }, conf ? (pl.fits ? 'fits' : `${fmt(-pl.slack_g)} g over`) : (pl.status === 'confirming' ? `confirming ${pl.confirmed_n || 0}/${pl.total_n || '?'}` : pl.status))),
          h('div', { class: 'g', style: conf ? null : { color: 'var(--ink3)' } }, fmt(pl.total_g), h('small', null, conf ? `g · ${fmt(pl.slack_g)} g slack` : 'g · model')),
          h('div', { class: 'd' }, ...(pl.summary || []).map(s => h('span', { class: 'prof' }, s)), pl.locked_g ? `Locked ${fmt(pl.locked_g)} g` : null),
          h('div', { class: 'sc' }, 'strength ', ...[0, 1, 2, 3, 4].map(k => h('i', { class: (pl.score || 0) * 5 > k ? 'on' : '' })), conf && h('span', { class: 'pill ver', style: { marginLeft: '6px' } }, 'confirmed')),
          h('div', { class: 'tb' }, h('button', { class: 'btn small' + (i === 0 ? ' primary' : ''), disabled: !conf, onClick: async (e) => { e.stopPropagation(); await api('POST', `runs/${run.id}/apply`, { plan: i }); toast('Plan applied to parts'); await refreshRobot(); await loadState(); render(); } }, 'Apply to parts'))));
      });
      if (res.current) plansEl.append(h('div', { class: 'plan infeas' }, h('div', { class: 't' }, h('b', null, 'Current'), h('span', { class: 'pill ' + (res.current.fits ? 'good' : 'bad') }, res.current.fits ? 'fits' : `${fmt(-res.current.slack_g)} g over`)), h('div', { class: 'g' }, fmt(res.current.total_g), h('small', null, 'g printed')), h('div', { class: 'd' }, 'What is on the sheet now, for comparison.'), h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => go('sheet') }, 'View sheet'))));
      if (!plans.length && run.status !== 'running') plansEl.append(h('p', { class: 'empty' }, res.error || 'No feasible plan found.'));
    };
    const drawDetail = () => {
      rightDetail.textContent = '';
      const pl = plans[selected.i]; if (!pl) return;
      rightDetail.append(h('div', { class: 'card' }, h('h3', null, `${pl.name} · per part`),
        h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, 'Profile'), h('th', { class: 'num' }, 'each'), h('th', { class: 'num' }, 'total'))),
          h('tbody', null, ...(pl.assignments || []).map(a => h('tr', { class: a.locked ? 'locked' : '' }, h('td', null, a.name, a.locked ? ' 🔒' : ''), h('td', { class: 'prof' }, a.profile_string || ''), h('td', { class: 'num' }, a.grams != null ? fmt(a.grams) : h('span', { class: 'pill warn' }, a.status || '…')), h('td', { class: 'num' }, a.grams != null ? fmt(a.grams * a.qty) : ''))),
            h('tr', { class: 'sum' }, h('td', null, 'Total'), h('td'), h('td'), h('td', { class: 'num' }, fmt(pl.total_g)))))),
        pl.model_total_g != null && pl.status === 'confirmed' && h('p', { class: 'hint' }, `Model predicted ${fmt(pl.model_total_g)} g; confirmed ${fmt(pl.total_g)} g (${signed((pl.total_g - pl.model_total_g) / pl.model_total_g * 100)}%).`)));
    };
    drawPlans(); drawDetail();
    left.append(plansEl, paretoEl);
    right.append(rightDetail);
    if (res.why) right.append(h('div', { class: 'card' }, h('h3', null, 'Why not lighter?'), ...res.why.map((w, i) => h('div', { class: 'step' }, h('span', { class: 'n' }, i + 1), h('div', null, h('b', null, w.title), ' ', w.text)))));
    if (res.model_report) right.append(h('div', { class: 'card' }, h('h3', null, 'Model check'), h('p', { class: 'hint', style: { margin: 0 } }, res.model_report)));
    // live refresh while running
    if (run.status === 'running') S.pollRun = run.id; else S.pollRun = null;
  };
  function drawPareto(el, res, run) {
    el.textContent = '';
    const pts = res.pareto || [];
    const c = h('canvas', { width: 820, height: 360, style: { width: '100%', height: 'auto', display: 'block' } });
    el.append(c, h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'shown plans (confirmed)'), h('span', null, h('i', { style: { background: 'var(--hatch)' } }), 'other feasible candidates (model)'), h('span', null, h('i', { style: { background: 'var(--bad)' } }), 'over budget'), h('span', { class: 'rng' }, 'hover a dot for its profiles')));
    if (!pts.length) { el.append(h('p', { class: 'hint' }, 'No candidate cloud stored for this run.')); return; }
    const ctx = c.getContext('2d'), css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const W = c.width, H = c.height, L = 56, R = 20, T = 18, B = 44;
    const xs = pts.map(p => p.total_g), ys = pts.map(p => p.score);
    const bud = res.budget_total_g || res.budget_g; const x0 = Math.min(...xs) - 2, x1 = Math.max(...xs, bud || 0) + 2, y0 = 0, y1 = Math.max(1, ...ys);
    const X = v => L + (v - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = css('--rule2'); ctx.fillStyle = css('--ink3'); ctx.font = '11px ui-monospace,monospace'; ctx.textAlign = 'center';
    const step = Math.max(1, Math.round((x1 - x0) / 8));
    for (let g = Math.ceil(x0); g <= x1; g += step) { ctx.beginPath(); ctx.moveTo(X(g), T); ctx.lineTo(X(g), H - B); ctx.stroke(); ctx.fillText(g + ' g', X(g), H - B + 16); }
    ctx.fillText('total weight of printed parts', (L + W - R) / 2, H - 6);
    ctx.save(); ctx.translate(14, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('strength score (walls-weighted)', 0, 0); ctx.restore();
    if (bud) { ctx.strokeStyle = css('--bad'); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(X(bud), T); ctx.lineTo(X(bud), H - B); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = css('--bad'); ctx.textAlign = 'left'; ctx.fillText('budget ' + fmt(bud) + ' g (printed parts incl. locked)', X(bud) + 5, T + 10); }
    for (const p of pts) { ctx.fillStyle = p.shown ? css('--accent') : (p.fits ? css('--hatch') : css('--bad')); ctx.globalAlpha = p.shown ? 1 : .7; ctx.beginPath(); ctx.arc(X(p.total_g), Y(p.score), p.shown ? 5 : 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.fillStyle = css('--ink'); ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
    for (const p of pts.filter(p => p.shown)) ctx.fillText(p.label || '', X(p.total_g) + 7, Y(p.score) - 6);
    const tip = h('div', { class: 'hint' }); el.append(tip);
    c.addEventListener('mousemove', e => { const r = c.getBoundingClientRect(); const mx = (e.clientX - r.left) * W / r.width, my = (e.clientY - r.top) * H / r.height; let best = null, bd = 100; for (const p of pts) { const d = Math.hypot(X(p.total_g) - mx, Y(p.score) - my); if (d < bd) { bd = d; best = p; } } tip.textContent = best ? `${fmt(best.total_g)} g · score ${best.score.toFixed(2)} · ${best.summary.join(' · ')}` : ''; });
  }

  // ---------------------------------------------------------------- runs
  V.runs = async function (m) {
    const r = S.robot; if (!r) return needRobot(m);
    const runs = await api('GET', `robots/${r.id}/runs`);
    const sel = new Set();
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Runs'), h('p', null, 'Optimizations and weigh-ins with their inputs and results. Tick two optimizer runs to compare them part by part.')),
      h('div', { class: 'tb' }, h('button', { class: 'btn', onClick: () => { const ids = [...sel]; if (ids.length !== 2) return toast('Tick exactly two runs'); diffRuns(runs.find(x => x.id === ids[0]), runs.find(x => x.id === ids[1])); } }, 'Compare selected'))));
    if (!runs.length) return m.append(h('p', { class: 'empty' }, 'No runs yet.'));
    const tb = h('tbody');
    for (const x of runs) {
      const res = x.results || {};
      let total = res.plans && res.plans[0] ? res.plans[res.applied_plan ?? 0].total_g : (x.kind === 'weigh-in' ? x.inputs.grams : null);
      tb.append(h('tr', null, h('td', null, h('input', { type: 'checkbox', onChange: e => { if (e.target.checked) sel.add(x.id); else sel.delete(x.id); } }), ' ', x.name || x.kind), h('td', { class: 'mono' }, new Date(x.date * 1000).toLocaleString()), h('td', null, h('span', { class: 'pill auto' }, x.kind), x.status === 'running' && h('span', { class: 'pill warn', style: { marginLeft: '4px' } }, 'running')),
        h('td', { class: 'num' }, total != null ? fmt(total) : '—'),
        h('td', null, x.kind === 'weigh-in' ? `sheet ${fmt(res.sheet_total)} g · drift ${signed(res.drift)} g` : (res.status_text || '')),
        h('td', null, x.kind === 'optimize' && h('button', { class: 'btn small', onClick: () => go('optimizer', x.id) }, 'Open'), ' ', h('button', { class: 'btn icon', onClick: () => confirmModal('Delete this run?', async () => { await api('DELETE', `runs/${x.id}`); render(); }) }, '✕'))));
    }
    m.append(h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Run'), h('th', null, 'Date'), h('th', null, 'Kind'), h('th', { class: 'num' }, 'Total g'), h('th', null, 'Notes'), h('th'))), tb)));
  };

  function runAssignments(run) {
    const res = run.results || {};
    if (run.kind === 'optimize' && res.plans && res.plans.length) {
      const pl = res.plans[res.applied_plan ?? 0];
      return { label: `run #${run.id} · plan ${(pl.name || '').split(' ')[0]}`, rows: Object.fromEntries((pl.assignments || []).map(a => [a.name, { profile: a.profile_string, grams: a.grams, qty: a.qty }])), total: pl.total_g };
    }
    return { label: run.name || run.kind, rows: {}, total: run.kind === 'weigh-in' ? run.inputs.grams : null };
  }
  function diffRuns(a, b) {
    const A = runAssignments(a), B = runAssignments(b);
    const names = [...new Set([...Object.keys(A.rows), ...Object.keys(B.rows)])];
    const tb = h('tbody');
    for (const n of names) {
      const x = A.rows[n], y = B.rows[n]; const d = x && y && x.grams != null && y.grams != null ? (y.grams - x.grams) * (y.qty || 1) : null;
      tb.append(h('tr', null, h('td', null, n), h('td', { class: 'prof' }, x ? x.profile : '—'), h('td', { class: 'num' }, x && x.grams != null ? fmt(x.grams) : '—'), h('td', { class: 'prof' }, y ? y.profile : '—'), h('td', { class: 'num' }, y && y.grams != null ? fmt(y.grams) : '—'), h('td', { class: 'num', style: { color: d == null ? '' : d > 0 ? 'var(--bad)' : 'var(--good)' } }, d == null ? '' : signed(d))));
    }
    tb.append(h('tr', { class: 'sum' }, h('td', null, 'Total'), h('td'), h('td', { class: 'num' }, A.total != null ? fmt(A.total) : '—'), h('td'), h('td', { class: 'num' }, B.total != null ? fmt(B.total) : '—'), h('td', { class: 'num' }, A.total != null && B.total != null ? signed(B.total - A.total) : '')));
    modal('Compare runs', h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, A.label), h('th', { class: 'num' }, 'g'), h('th', null, B.label), h('th', { class: 'num' }, 'g'), h('th', { class: 'num' }, 'Δ total'))), tb)), [{ label: 'Close' }], { width: '860px' });
  }

  // ---------------------------------------------------------------- events
  V.events = async function (m) {
    const r = S.robot; if (!r) return needRobot(m);
    const evs = await api('GET', `robots/${r.id}/events`);
    const add = (ev) => {
      const d = input({ type: 'date', value: ev ? ev.date : today() }), t = input({ value: ev ? ev.title : '', placeholder: 'Event name' }), pl = input({ value: ev ? ev.placing || '' : '', placeholder: 'e.g. 1st' }), n = h('textarea', null, ev ? ev.notes || '' : '');
      modal(ev ? 'Edit entry' : 'New entry', h('div', null, field('Date', d), field('Event', t), field('Placing', pl), field('Notes', n)), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { if (ev) await api('PUT', `events/${ev.id}`, { date: d.value, title: t.value, placing: pl.value, notes: n.value }); else await api('POST', `robots/${r.id}/events`, { date: d.value, title: t.value, placing: pl.value, notes: n.value }); render(); } }]);
    };
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Event log'), h('p', null, 'Competitions and milestones, with the sheet total snapshotted at each entry.')), h('div', { class: 'tb' }, h('button', { class: 'btn primary', onClick: () => add() }, '＋ Entry'))));
    const card = h('div', { class: 'card' });
    if (!evs.length) card.append(h('p', { class: 'hint' }, 'Nothing logged yet.'));
    for (const ev of evs) card.append(h('div', { class: 'ev' }, h('div', { class: 'd' }, ev.date), h('div', null, h('b', null, ev.title, ev.placing ? ` · ${ev.placing}` : ''), h('span', null, ev.notes || ''), ev.total_snapshot_g != null && h('div', { class: 'rng' }, `sheet total at the time: ${fmt(ev.total_snapshot_g)} g`)),
      h('div', { class: 'tb' }, h('button', { class: 'btn icon', onClick: () => add(ev) }, '✎'), h('button', { class: 'btn icon', onClick: () => confirmModal('Delete this entry?', async () => { await api('DELETE', `events/${ev.id}`); render(); }) }, '✕'))));
    m.append(card);
  };

  // ---------------------------------------------------------------- library
  V.library = async function (m) {
    const comps = await api('GET', 'components');
    const cats = [...new Set(comps.map(c => c.category || 'Other'))].sort();
    S.cache.cats = cats; catDatalist(cats);
    const st = { q: S.cache.libq || '', cat: S.cache.libcat || '' };
    const search = input({ class: 'search', placeholder: 'Search…', value: st.q });
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Component library'), h('p', null, 'Shared across robots. Measured weights here propagate to every robot that uses the part.')),
      h('div', { class: 'tb' }, search, h('button', { class: 'btn primary', onClick: () => compModal() }, '＋ Component'))));
    const tabs = h('div', { class: 'sub-tabs' });
    const tw = h('div', { class: 'tw' });
    const draw = () => {
      tabs.textContent = '';
      for (const [k, l] of [['', `All ${comps.length}`], ...cats.map(c => [c, `${c} ${comps.filter(x => (x.category || 'Other') === c).length}`])]) tabs.append(h('button', { 'aria-pressed': String(st.cat === k), onClick: () => { st.cat = k; S.cache.libcat = k; draw(); } }, l));
      const q = st.q.toLowerCase();
      const rows = comps.filter(c => (!st.cat || (c.category || 'Other') === st.cat) && (!q || (c.name + ' ' + (c.category || '') + ' ' + (c.vendor || '')).toLowerCase().includes(q)));
      tw.textContent = '';
      tw.append(h('table', null, h('thead', null, h('tr', null, h('th', null, 'Component'), h('th', null, 'Category'), h('th', { class: 'num' }, 'Weight g'), h('th', null, 'Source'), h('th', { class: 'num' }, 'Price'), h('th', null, 'Dimensions'), h('th', { class: 'num' }, 'Used'), h('th'))),
        h('tbody', null, ...rows.map(c => h('tr', null,
          h('td', null, c.name, c.link && h('a', { href: c.link, target: '_blank', rel: 'noopener', class: 'src', style: { textTransform: 'none' } }, ' link ↗'), c.notes && h('span', { class: 'sub' }, c.notes)),
          edCell(c.category, v => api('PUT', `components/${c.id}`, { category: v }).then(() => { c.category = v; if (!cats.includes(v)) { cats.push(v); cats.sort(); catDatalist(cats); } }), { list: 'cat-list' }),
          edCell(c.grams, v => api('PUT', `components/${c.id}`, { grams: v, grams_source: 'manual', propagate: true }).then(() => { c.grams = v; }), { type: 'number', cls: 'num', fmt: v => fmt(v, 2) }),
          h('td', null, h('span', { class: 'pill ' + (c.grams_source === 'measured' ? 'mea' : 'auto') }, c.grams_source || 'manual')),
          edCell(c.price, v => api('PUT', `components/${c.id}`, { price: v }).then(() => { c.price = v; }), { type: 'number', cls: 'num', fmt: v => Number(v).toFixed(2), placeholder: '' }),
          h('td', null, c.dimensions || ''), h('td', { class: 'num' }, c.uses || 0),
          h('td', null, h('button', { class: 'btn icon', onClick: e => menu(e.currentTarget, [
            { label: 'Weigh-in (update everywhere)…', onClick: () => { const g = input({ type: 'number', step: '0.01' }); modal(`Weigh ${c.name}`, field('Measured (g)', g), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { await api('POST', `components/${c.id}/weighins`, { grams: parseFloat(g.value), propagate: true }); render(); } }]); } },
            { label: 'Edit…', onClick: () => compModal(c) },
            S.robot && { label: `Add to ${S.robot.name}`, onClick: () => fromLibraryModal() },
            '-', { label: 'Delete', cls: 'danger', onClick: () => confirmModal(`Delete “${c.name}” from the library? Robot lines keep their values.`, async () => { await api('DELETE', `components/${c.id}`); render(); }) }].filter(Boolean)) }, '⋯')))))));
      if (!rows.length) tw.append(h('p', { class: 'empty' }, 'Nothing matches.'));
    };
    search.addEventListener('input', () => { st.q = search.value; S.cache.libq = st.q; draw(); });
    m.append(tabs, tw); draw();
  };
  function catDatalist(cats) {
    let dl = document.getElementById('cat-list');
    if (!dl) { dl = h('datalist', { id: 'cat-list' }); document.body.append(dl); }
    dl.textContent = ''; for (const c of cats || S.cache.cats || []) dl.append(h('option', { value: c }));
    return dl;
  }
  function compModal(c) {
    catDatalist();
    const f = { name: input({ value: c?.name || '' }), category: input({ value: c?.category || '', list: 'cat-list', autocomplete: 'off' }), vendor: input({ value: c?.vendor || '' }), link: input({ value: c?.link || '' }), price: input({ type: 'number', value: c?.price ?? '', step: '0.01' }), dimensions: input({ value: c?.dimensions || '' }), grams: input({ type: 'number', value: c?.grams ?? '', step: '0.01' }), notes: h('textarea', null, c?.notes || '') };
    modal(c ? 'Edit component' : 'New component', h('div', null, field('Name', f.name), field('Category', f.category), field('Vendor', f.vendor), field('Link', f.link), field('Price', f.price), field('Dimensions', f.dimensions), field('Weight (g)', f.grams), field('Notes', f.notes)),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { const body = { name: f.name.value, category: f.category.value || 'Other', vendor: f.vendor.value || null, link: f.link.value || null, price: f.price.value === '' ? null : parseFloat(f.price.value), dimensions: f.dimensions.value || null, grams: f.grams.value === '' ? null : parseFloat(f.grams.value), notes: f.notes.value || null }; if (c) await api('PUT', `components/${c.id}`, Object.assign(body, { propagate: true })); else await api('POST', 'components', body); render(); } }]);
  }

  // ---------------------------------------------------------------- filaments & profiles
  V.filaments = function (m) {
    const st = S.state;
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Filaments & profiles'), h('p', null, 'Densities from Bambu Studio’s filament profiles; corrections from your scale. Profiles are Bambu Studio vocabulary and are mapped to PrusaSlicer when slicing.')),
      h('div', { class: 'tb' }, h('button', { class: 'btn', onClick: () => filModal() }, '＋ Filament'), h('button', { class: 'btn primary', onClick: () => editProfileModal(null) }, '＋ Profile'))));
    const ftb = h('tbody');
    for (const f of st.filaments) {
      ftb.append(h('tr', null, h('td', null, filChip(f), f.builtin && h('span', { class: 'src' }, 'Bambu')), h('td', null, f.material), h('td', { class: 'num' }, f.density), h('td', { class: 'num' }, f.flow), h('td', { class: 'num' }, f.max_vol_speed ?? 12),
        h('td', { class: 'num' }, f.correction.factor ? `×${f.correction.factor.toFixed(3)} ` : '—', f.correction.n ? h('span', { class: 'rng' }, `n=${f.correction.n}${f.correction.spread ? ` ±${(f.correction.spread * 100).toFixed(1)}%` : ''}`) : ''),
        h('td', { class: 'num' }, f.cost_per_kg ? money(f.cost_per_kg) : ''),
        h('td', null, h('button', { class: 'btn icon', onClick: e => menu(e.currentTarget, [{ label: 'Edit…', onClick: () => filModal(f) }, { label: 'Recalculate correction from weigh-ins', onClick: () => api('POST', `filaments/${f.id}/recalc`).then(loadState).then(render).catch(fail) }, { label: 'Reset correction', onClick: () => api('PUT', `filaments/${f.id}`, { reset_correction: true }).then(loadState).then(render).catch(fail) }, '-', { label: 'Delete', cls: 'danger', onClick: () => confirmModal(`Delete filament “${f.name}”?`, async () => { await api('DELETE', `filaments/${f.id}`); await loadState(); render(); }) }]) }, '⋯'))));
    }
    const ptb = h('tbody');
    for (const p of st.profiles) {
      ptb.append(h('tr', null, h('td', null, p.name, p.builtin && h('span', { class: 'src' }, 'built-in')), h('td', null, `${p.nozzle} mm`), h('td', { class: 'prof' }, p.string), h('td', null, p.notes ? h('span', { class: 'rng' }, p.notes) : ''),
        h('td', null, h('button', { class: 'btn icon', onClick: e => menu(e.currentTarget, [{ label: p.builtin ? 'View…' : 'Edit…', onClick: () => editProfileModal(p) }, { label: 'Duplicate…', onClick: () => editProfileModal(null, p.params) }, { label: 'Download PrusaSlicer .ini', onClick: () => window.open(`/api/profiles/${p.id}/prusa.ini?filament=${st.settings.default_filament_id || 1}`) }, { label: 'Download Bambu Studio preset (.json)', onClick: () => window.open(`/api/profiles/${p.id}/bambu.json`) }, '-', !p.builtin && { label: 'Delete', cls: 'danger', onClick: () => confirmModal(`Delete profile “${p.name}”?`, async () => { await api('DELETE', `profiles/${p.id}`); await loadState(); render(); }) }].filter(Boolean)) }, '⋯'))));
    }
    m.append(h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', null, 'Filaments'), h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Filament'), h('th', null, 'Material'), h('th', { class: 'num' }, 'ρ g/cm³'), h('th', { class: 'num' }, 'Flow'), h('th', { class: 'num', title: 'Max volumetric speed (mm³/s) — caps print speed, affects time only' }, 'mm³/s'), h('th', { class: 'num' }, 'Correction'), h('th', { class: 'num' }, '$/kg'), h('th'))), ftb)), h('p', { class: 'hint' }, 'Correction = median of (measured ÷ sliced) over weighed parts using the filament. Shown estimates are slicer × correction.')),
      h('div', { class: 'card' }, h('h3', null, 'Profiles'), h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Nozzle'), h('th', null, 'String'), h('th', null, 'Notes'), h('th'))), ptb)), h('p', { class: 'hint' }, 'Built-in profiles reproduce Bambu Studio’s system defaults (with cubic instead of grid). Bambu’s top-shell thickness rule is applied: 5 layers or 1.0 mm, whichever is more.'),
        h('p', { class: 'hint' }, h('b', null, 'Checking against Bambu Studio: '), 'with identical settings the two slicers agree on weight within about 1% (chassis 78.5 vs 78.9 g; forks 24.3 vs 24.1 g). If Bambu shows less, compare Top shell thickness (Bambu’s 1.0 mm turns 2 top layers into 5 unless set to 0), the filament’s flow ratio (Bambu’s Generic PLA is 0.98, not 1.0) and density. Print time is PrusaSlicer’s estimate with Bambu speeds and limits — expect it to run 5–15% longer than Bambu Studio’s.'))));
  };
  function filModal(f) {
    const x = { name: input({ value: f?.name || '' }), material: input({ value: f?.material || '' }), density: input({ type: 'number', value: f?.density ?? 1.24, step: '0.001' }), flow: input({ type: 'number', value: f?.flow ?? 1.0, step: '0.01' }), color: input({ type: 'color', value: f?.color || '#3b82c4', style: { width: '60px', padding: '2px' } }), cost: input({ type: 'number', value: f?.cost_per_kg ?? '', step: '0.01' }), mvs: input({ type: 'number', value: f?.max_vol_speed ?? 12, step: '0.1' }), notes: h('textarea', null, f?.notes || '') };
    modal(f ? 'Edit filament' : 'New filament', h('div', null, field('Name', x.name), field('Material', x.material), field('Density g/cm³', x.density), field('Flow ratio', x.flow), field('Max volumetric speed mm³/s', h('div', { class: 'tb' }, x.mvs, h('span', { class: 'rng' }, 'from the Bambu filament profile; only affects print time'))), field('Colour', x.color), field('Cost $/kg', x.cost), field('Notes', x.notes), f && h('p', { class: 'hint' }, 'Changing density, flow or volumetric speed re-slices parts that use this filament.')),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { const body = { name: x.name.value, material: x.material.value, density: parseFloat(x.density.value), flow: parseFloat(x.flow.value), max_vol_speed: parseFloat(x.mvs.value) || 12, color: x.color.value, cost_per_kg: x.cost.value === '' ? null : parseFloat(x.cost.value), notes: x.notes.value || null }; if (f) await api('PUT', `filaments/${f.id}`, body); else await api('POST', 'filaments', body); await loadState(); render(); } }]);
  }

  // ---------------------------------------------------------------- calculators
  V.calc = function (m) {
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Calculators'), h('p', null, 'The basics: belt centre distance, weapon tip speed & energy, drive speed, battery. Inputs are remembered in this browser. Cross-checked against the Ember (Level 5 Robotics) calculators.'))));
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('sb.calc') || '{}'); } catch { }
    const persist = () => { try { localStorage.setItem('sb.calc', JSON.stringify(saved)); } catch { } };
    const calcs = [];
    function recalcAll() { calcs.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
    const num = (key, def, attrs) => { const i = input(Object.assign({ type: 'number', value: saved[key] ?? def, step: 'any', style: { width: '110px' }, class: 'w mono' }, attrs)); i.addEventListener('input', () => { saved[key] = i.value === '' ? null : parseFloat(i.value); persist(); recalcAll(); }); return i; };
    const setNum = (i, key, v) => { i.value = v; saved[key] = v; persist(); recalcAll(); };
    const val = i => { const v = parseFloat(i.value); return isNaN(v) ? 0 : v; };
    const out = (label) => { const dd = h('dd', { class: 'mono' }, '—'); return { row: h('div', { class: 'field out' }, h('label', null, label), dd), dd, set(v) { dd.textContent = v; } }; };
    // segmented choice persisted under key
    const seg = (key, options, def, onChange) => {
      const st = { v: saved[key] ?? def };
      const el = h('div', { class: 'seg' });
      const draw = () => { el.textContent = ''; for (const [v, label, title] of options) el.append(h('button', { 'aria-pressed': String(st.v === v), title, onClick: () => { st.v = v; saved[key] = v; persist(); draw(); if (onChange) onChange(v); recalcAll(); } }, label)); };
      draw(); return Object.assign(el, { get: () => st.v });
    };
    const IN = 25.4;
    // unit toggle for a length input: value is always stored in mm; the field shows mm or in
    const lenField = (label, key, defMm) => {
      const unit = { v: saved[key + '.u'] || 'mm' };
      const i = input({ type: 'number', step: 'any', style: { width: '110px' }, class: 'w mono' });
      const show = () => { const mm = saved[key] ?? defMm; i.value = unit.v === 'in' ? +(mm / IN).toFixed(4) : +mm.toFixed(3); };
      i.addEventListener('input', () => { const v = parseFloat(i.value); saved[key] = isNaN(v) ? null : (unit.v === 'in' ? v * IN : v); persist(); recalcAll(); });
      const tog = h('div', { class: 'seg' }); const drawTog = () => { tog.textContent = ''; for (const u of ['mm', 'in']) tog.append(h('button', { 'aria-pressed': String(unit.v === u), onClick: () => { unit.v = u; saved[key + '.u'] = u; persist(); drawTog(); show(); } }, u)); };
      drawTog(); show();
      return { row: field(label, h('div', { class: 'tb' }, i, tog)), mm: () => saved[key] ?? defMm };
    };
    // battery voltage helper: S count × per-cell voltage with Nom / Max / LiHV presets
    const voltBlock = (prefix, defCells) => {
      const cells = num(prefix + '.cells', defCells, { style: { width: '70px' }, min: 1, step: 1 });
      const vpc = num(prefix + '.volt', 3.7, { style: { width: '80px' } });
      const presets = h('div', { class: 'seg' }, ...[[3.7, 'Nom'], [4.2, 'Max'], [4.35, 'LiHV']].map(([v, l]) => h('button', { 'aria-pressed': String(Math.abs(val(vpc) - v) < 0.001), onClick: (e) => { setNum(vpc, prefix + '.volt', v); [...e.currentTarget.parentNode.children].forEach(b => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); } }, l)));
      vpc.addEventListener('input', () => [...presets.children].forEach(b => b.setAttribute('aria-pressed', 'false')));
      const packV = h('span', { class: 'rng' });
      calcs.push(() => { packV.textContent = `= ${(val(cells) * val(vpc)).toFixed(2)} V pack`; });
      return { cells, vpc, rows: [field('Battery', h('div', { class: 'tb' }, cells, h('span', { class: 'rng' }, 'S ×'), vpc, h('span', { class: 'rng' }, 'V/cell'), presets, packV))], volts: () => val(cells) * val(vpc) };
    };

    // ---- 1. belt / chain / gear centre distance
    const bMode = seg('belt.mode', [['teeth', 'Pulley teeth'], ['dia', 'Pitch diameters']], 'teeth', () => drawBelt());
    const bDir = seg('belt.dir', [['cd', 'Have centre distance → belt'], ['len', 'Have belt → centre distance']], 'cd', () => drawBelt());
    const bT1 = num('belt.t1', 16, { step: 1 }), bT2 = num('belt.t2', 40, { step: 1 }), bPitch = num('belt.pitch', 3);
    const bD1 = lenField('Pulley 1 pitch Ø', 'belt.d1', 15.28), bD2 = lenField('Pulley 2 pitch Ø', 'belt.d2', 38.2);
    const bCD = lenField('Centre distance', 'belt.cdmm', 79), bLenT = num('belt.lenT', 100, { step: 1 }), bStretch = num('belt.stretch', 0, { step: 0.001 });
    const oLen = out('Belt pitch length'), oTeeth = out('Belt teeth at this pitch'), oNear = out('Nearest whole-tooth belts'), oCD = out('Centre distance'), oRatio = out('Ratio'), oPD = out('Pitch diameters');
    const beltBody = h('div');
    const beltCalc = () => {
      const p = val(bPitch);
      let d1, d2;
      if (bMode.get() === 'teeth') { d1 = val(bT1) * p / Math.PI; d2 = val(bT2) * p / Math.PI; } else { d1 = bD1.mm(); d2 = bD2.mm(); }
      const lenFor = C => 2 * C + Math.PI / 2 * (d1 + d2) + (d2 - d1) ** 2 / (4 * C);
      const cdFor = L => { const b = L - Math.PI / 2 * (d1 + d2); const disc = b * b - 2 * (d2 - d1) ** 2; return disc < 0 ? NaN : (b + Math.sqrt(disc)) / 4; };  // exact inverse of lenFor
      const ratio = d1 && d2 ? (d2 >= d1 ? `${(d2 / d1).toFixed(2)}:1` : `1:${(d1 / d2).toFixed(2)}`) : '—';
      oRatio.set(ratio); oPD.set(`${d1.toFixed(2)} / ${d2.toFixed(2)} mm (${(d1 / IN).toFixed(3)} / ${(d2 / IN).toFixed(3)} in)`);
      if (bDir.get() === 'cd') {
        const C = bCD.mm(); if (!(C > 0)) { oLen.set('—'); oTeeth.set('—'); oNear.set('—'); return; }
        const L = lenFor(C) / (1 + val(bStretch));
        oLen.set(`${L.toFixed(1)} mm · ${(L / IN).toFixed(2)} in`);
        if (p > 0) {
          const nT = L / p; oTeeth.set(`${nT.toFixed(2)} T`);
          const cands = [...new Set([Math.floor(nT), Math.ceil(nT)])].filter(t => t > 0);
          oNear.set(cands.map(t => `${t}T (${(t * p).toFixed(0)} mm) → C = ${cdFor(t * p * (1 + val(bStretch))).toFixed(2)} mm`).join('   ·   '));
        } else { oTeeth.set('—'); oNear.set('—'); }
      } else {
        const L = (bMode.get() === 'teeth' || p > 0) ? val(bLenT) * p : val(bLenT);
        const C = cdFor(L * (1 + val(bStretch)));
        oLen.set(`${L.toFixed(1)} mm · ${(L / IN).toFixed(2)} in`); oTeeth.set(p > 0 ? `${(L / p).toFixed(0)} T` : '—');
        oCD.set(isNaN(C) ? 'belt too short for these pulleys' : `${C.toFixed(2)} mm · ${(C / IN).toFixed(3)} in`); oNear.set('—');
      }
    };
    calcs.push(beltCalc);
    function drawBelt() {
      beltBody.textContent = '';
      beltBody.append(field('Mode', bMode), field('Solve for', bDir), field('Belt pitch (mm)', h('div', { class: 'tb' }, bPitch, h('span', { class: 'rng' }, 'GT2 = 2 · S3M/HTD 3M = 3 · HTD 5M = 5 · #25 chain = 6.35'))));
      if (bMode.get() === 'teeth') beltBody.append(field('Pulley 1 teeth', bT1), field('Pulley 2 teeth', bT2)); else beltBody.append(bD1.row, bD2.row);
      if (bDir.get() === 'cd') beltBody.append(bCD.row); else beltBody.append(field(bMode.get() === 'teeth' ? 'Belt length (teeth)' : 'Belt length (teeth, or mm if pitch is 0)', bLenT));
      beltBody.append(field('Stretch factor', h('div', { class: 'tb' }, bStretch, h('span', { class: 'rng' }, '0 for timing belts; ~0.02–0.05 for stretched round/urethane belts'))));
      beltBody.append(oPD.row, oRatio.row, oLen.row, oTeeth.row, bDir.get() === 'cd' ? oNear.row : oCD.row);
      recalcAll();
    }
    drawBelt();
    // gears
    const gT1 = num('gear.t1', 12, { step: 1 }), gT2 = num('gear.t2', 36, { step: 1 }), gMod = num('gear.mod', 1), gUnit = seg('gear.unit', [['mod', 'Module (mm)'], ['dp', 'Diametral pitch (1/in)']], 'mod');
    const oGCD = out('Gear centre distance'), oGR = out('Gear ratio');
    calcs.push(() => { const mod = gUnit.get() === 'mod' ? val(gMod) : (val(gMod) ? IN / val(gMod) : 0); const C = mod * (val(gT1) + val(gT2)) / 2; oGCD.set(C ? `${C.toFixed(3)} mm · ${(C / IN).toFixed(4)} in` : '—'); oGR.set(val(gT1) ? `${(val(gT2) / val(gT1)).toFixed(3)}:1` : '—'); });

    // ---- 2. weapon
    const wV = voltBlock('w', 4);
    const wKv = num('w.kv', 1700), wRpmOverride = num('w.rpm', null, { placeholder: 'optional' }), wMp = num('w.mp', 1, { step: 1 }), wWp = num('w.wp', 1, { step: 1 });
    const wDia = lenField('Weapon Ø (tip to tip)', 'w.dia', 63.5), wMass = num('w.mass', 170), wShape = seg('w.shape', [['disk', 'Solid disk', 'I = ½·m·r²'], ['ring', 'Ring / drum shell', 'I = m·r²'], ['bar', 'Bar about centre', 'I = m·L²/12 (L = Ø)'], ['custom', 'Known MOI']], 'disk', () => drawW());
    const wMoiR = lenField('Mass radius (for disk / ring)', 'w.r', 25), wMoiCustom = num('w.moi', 500);
    const oWrpm = out('Weapon RPM (no-load)'), oWtip = out('Tip speed'), oWmoi = out('Moment of inertia'), oWke = out('Stored energy'), oWspark = out('SPARC Sportsman check');
    const wBody = h('div');
    calcs.push(() => {
      const ratio = val(wWp) / Math.max(1e-9, val(wMp));
      const motorRpm = val(wRpmOverride) > 0 ? val(wRpmOverride) : wV.volts() * val(wKv);
      const rpm = motorRpm / ratio; const w = rpm * 2 * Math.PI / 60; const D = wDia.mm() / 1000;
      const tip = Math.PI * D * rpm / 60;
      oWrpm.set(`${rpm.toFixed(0)} rpm${ratio !== 1 ? ` (motor ${motorRpm.toFixed(0)} ÷ ${ratio.toFixed(3)})` : ''}`);
      oWtip.set(`${tip.toFixed(1)} m/s · ${(tip * 2.23694).toFixed(1)} mph · ${(tip * 3.28084).toFixed(1)} ft/s`);
      const mkg = val(wMass) / 1000; let I;
      if (wShape.get() === 'disk') I = 0.5 * mkg * (wMoiR.mm() / 1000) ** 2;
      else if (wShape.get() === 'ring') I = mkg * (wMoiR.mm() / 1000) ** 2;
      else if (wShape.get() === 'bar') I = mkg * D * D / 12;
      else I = val(wMoiCustom) * 1e-7;  // g·cm² → kg·m²
      const ke = 0.5 * I * w * w;
      oWmoi.set(`${(I * 1e7).toFixed(0)} g·cm² · ${(I * 1e3).toFixed(4)} kg·cm²`);
      oWke.set(`${ke.toFixed(0)} J · ${(ke * 0.737562).toFixed(0)} ft·lb`);
      const mph = tip * 2.23694; oWspark.set(mph > 250 ? `⚠ ${mph.toFixed(0)} mph is over the 250 mph SPARC Sportsman spinner limit` : `${mph.toFixed(0)} mph — under the 250 mph Sportsman limit`);
    });
    function drawW() {
      wBody.textContent = '';
      wBody.append(...wV.rows, field('Motor KV (rpm/V)', wKv), field('Motor RPM override', h('div', { class: 'tb' }, wRpmOverride, h('span', { class: 'rng' }, 'if you know the real rpm at this voltage'))), field('Motor pulley teeth', wMp), field('Weapon pulley teeth', wWp), wDia.row, field('Weapon mass (g)', wMass), field('Mass distribution', wShape));
      if (wShape.get() === 'disk' || wShape.get() === 'ring') wBody.append(wMoiR.row);
      if (wShape.get() === 'custom') wBody.append(field('MOI (g·cm²)', h('div', { class: 'tb' }, wMoiCustom, h('span', { class: 'rng' }, 'from CAD: Fusion/Onshape mass properties'))));
      wBody.append(oWrpm.row, oWtip.row, oWmoi.row, oWke.row, oWspark.row);
      recalcAll();
    }
    drawW();

    // ---- 3. drive
    const dV = voltBlock('d', 4);
    const dKv = num('d.kv', 2500), dRpmOverride = num('d.rpm', null, { placeholder: 'optional' }), dGear = num('d.gear', 27), dIp = num('d.ip', 1, { step: 1 }), dOp = num('d.op', 1, { step: 1 });
    const dWheel = lenField('Wheel Ø', 'd.wheel', 50.8), dEff = num('d.eff', 80, { step: 1 }), dArena = num('d.arena', 8);
    const oDrpm = out('Wheel RPM (no-load)'), oDspeed = out('Ground speed (no-load)'), oDload = out('Under load'), oDcross = out('Time to cross arena');
    calcs.push(() => {
      const ratio = val(dGear) * val(dOp) / Math.max(1e-9, val(dIp));
      const motorRpm = val(dRpmOverride) > 0 ? val(dRpmOverride) : dV.volts() * val(dKv);
      const rpm = motorRpm / Math.max(1e-9, ratio); const v = Math.PI * dWheel.mm() / 1000 * rpm / 60;
      oDrpm.set(`${rpm.toFixed(0)} rpm (total ratio ${ratio.toFixed(2)}:1)`);
      oDspeed.set(`${v.toFixed(2)} m/s · ${(v * 2.23694).toFixed(1)} mph · ${(v * 3.28084).toFixed(1)} ft/s`);
      const vl = v * val(dEff) / 100; oDload.set(`${vl.toFixed(2)} m/s · ${(vl * 2.23694).toFixed(1)} mph at ${val(dEff)}%`);
      oDcross.set(vl > 0 ? `${(val(dArena) * 0.3048 / vl).toFixed(2)} s for ${val(dArena)} ft` : '—');
    });

    // ---- 4. battery
    const bV = voltBlock('b', 4);
    const bMah = num('b.mah', 550), bWeap = num('b.weap', 7), bDrive = num('b.drive', 3), bPeak = num('b.peak', 25), bC = num('b.c', 60), bUse = num('b.use', 80, { step: 1 }), bMatch = num('b.match', 3), bNewS = num('b.newS', 3, { step: 1 });
    const oBwh = out('Pack energy'), oBlife = out('Run time at that draw'), oBneed = out('mAh needed for the match'), oBmin = out('Minimum mAh for the peak (C rating)'), oBcont = out('Continuous current this pack allows'), oBequiv = out('Same energy at a different cell count');
    calcs.push(() => {
      const A = val(bWeap) + val(bDrive), Ah = val(bMah) / 1000, use = val(bUse) / 100;
      oBwh.set(`${(Ah * bV.volts()).toFixed(2)} Wh at ${bV.volts().toFixed(2)} V`);
      oBlife.set(A ? `${(Ah * use / A * 60).toFixed(1)} min at ${A.toFixed(1)} A average` : '—');
      oBneed.set(A ? `${(A * val(bMatch) / 60 / Math.max(0.01, use) * 1000).toFixed(0)} mAh for ${val(bMatch)} min at ${A.toFixed(1)} A (${val(bUse)}% usable)` : '—');
      oBmin.set(val(bC) ? `${(val(bPeak) / val(bC) * 1000).toFixed(0)} mAh at ${val(bC)}C` : '—');
      oBcont.set(`${(Ah * val(bC)).toFixed(1)} A`);
      oBequiv.set(val(bNewS) ? `${(val(bMah) * val(bV.cells) / val(bNewS)).toFixed(0)} mAh at ${val(bNewS)}S` : '—');
    });

    // ---- 5. scale factors between classes
    const CLASSES_G = [['150 g', 150], ['1 lb', 453.592], ['3 lb', 1360.78], ['12 lb', 5443.11], ['30 lb', 13607.8], ['250 lb', 113398]];
    const sFrom = num('s.from', 453.592), sTo = num('s.to', 1360.78), sDim = lenField('Dimension to scale', 's.dim', 100);
    const clsBtns = (target, key) => h('div', { class: 'seg' }, ...CLASSES_G.map(([l, g]) => h('button', { onClick: () => setNum(target, key, +g.toFixed(3)) }, l)));
    const oSlin = out('Linear scale factor'), oSarea = out('Area (surface / armor) factor'), oSdim = out('Scaled dimension');
    calcs.push(() => { const k = val(sFrom) > 0 && val(sTo) > 0 ? Math.cbrt(val(sTo) / val(sFrom)) : 0; oSlin.set(k ? `× ${k.toFixed(3)}` : '—'); oSarea.set(k ? `× ${(k * k).toFixed(3)}` : '—'); oSdim.set(k ? `${(sDim.mm() * k).toFixed(2)} mm · ${(sDim.mm() * k / IN).toFixed(3)} in` : '—'); });

    // ---- 6. motor torque
    const tKv = num('t.kv', 1700), tI = num('t.i', 40), tRatio = num('t.ratio', 1), tArm = lenField('Lever arm', 't.arm', 50);
    const oTkt = out('Torque constant Kt'), oTm = out('Motor torque at that current'), oTo = out('Output torque after reduction'), oTf = out('Force at the lever arm');
    calcs.push(() => { const kv = val(tKv); if (!kv) { [oTkt, oTm, oTo, oTf].forEach(o => o.set('—')); return; } const kt = 60 / (2 * Math.PI * kv); const Tm = kt * val(tI); const To = Tm * val(tRatio); const arm = tArm.mm() / 1000; oTkt.set(`${(kt * 1000).toFixed(2)} mN·m/A`); oTm.set(`${Tm.toFixed(3)} N·m · ${(Tm * 10.1972).toFixed(2)} kg·cm · ${(Tm * 141.612).toFixed(1)} oz·in`); oTo.set(`${To.toFixed(3)} N·m · ${(To * 10.1972).toFixed(2)} kg·cm`); oTf.set(arm > 0 ? `${(To / arm).toFixed(1)} N · ${(To / arm * 0.224809).toFixed(1)} lbf · ${(To / arm / 9.80665 * 1000).toFixed(0)} gf` : '—'); });

    m.append(h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', null, 'Belt / chain centre distance'), beltBody, h('p', { class: 'hint' }, 'Pitch Ø = teeth × pitch / π. L = 2C + π/2·(D₁+D₂) + (D₂−D₁)²/(4C); the reverse solves that exactly. Whole-tooth options show the centre distance each real belt needs.'),
        h('h3', { style: { marginTop: '14px' } }, 'Gear pair'), field('Units', gUnit), field('Pinion teeth', gT1), field('Gear teeth', gT2), field('Module / DP', gMod), oGCD.row, oGR.row, h('p', { class: 'hint' }, 'C = module × (N₁+N₂) / 2. Module = 25.4 / DP.')),
      h('div', { class: 'card' }, h('h3', null, 'Weapon tip speed & energy'), wBody, h('p', { class: 'hint' }, 'RPM = cells × V/cell × KV × motor teeth ÷ weapon teeth (no-load). Tip speed = π × Ø × rpm / 60. Energy = ½·I·ω². Solid disk over-estimates most spinners; a real MOI from CAD is best.')),
      h('div', { class: 'card' }, h('h3', null, 'Drive speed'), ...dV.rows, field('Motor KV (rpm/V)', dKv), field('Motor RPM override', dRpmOverride), field('Gearbox ratio (:1)', dGear), field('Motor pulley teeth', dIp), field('Wheel pulley teeth', dOp), dWheel.row, field('Loaded speed (% of no-load)', dEff), field('Arena width (ft)', dArena), oDrpm.row, oDspeed.row, oDload.row, oDcross.row, h('p', { class: 'hint' }, 'Wheel rpm = motor rpm ÷ (gearbox × wheel teeth ÷ motor teeth). Real speed under load is usually 70–85% of no-load.')),
      h('div', { class: 'card' }, h('h3', null, 'Battery'), ...bV.rows, field('Capacity (mAh)', bMah), field('Avg weapon draw (A)', bWeap), field('Avg drive draw (A)', bDrive), field('Peak current (A)', bPeak), field('C rating', bC), field('Usable capacity (%)', bUse), field('Match length (min)', bMatch), field('Compare at (S)', bNewS), oBwh.row, oBlife.row, oBneed.row, oBmin.row, oBcont.row, oBequiv.row, h('p', { class: 'hint' }, 'Run time = usable Ah ÷ average amps. Energy (Wh) = Ah × pack volts; the same Wh at another cell count needs mAh × S₁ ÷ S₂.')),
      h('div', { class: 'card' }, h('h3', null, 'Scale between weight classes'), field('From class (g)', h('div', null, sFrom, clsBtns(sFrom, 's.from'))), field('To class (g)', h('div', null, sTo, clsBtns(sTo, 's.to'))), sDim.row, oSlin.row, oSarea.row, oSdim.row, h('p', { class: 'hint' }, 'Linear factor = ∛(m₂/m₁) — same density and proportions. 150 g → 1 lb is ×1.45; 1 lb → 3 lb is ×1.44.')),
      h('div', { class: 'card' }, h('h3', null, 'Motor torque'), field('Motor KV (rpm/V)', tKv), field('Current (A)', tI), field('Gear reduction (:1)', tRatio), tArm.row, oTkt.row, oTm.row, oTo.row, oTf.row, h('p', { class: 'hint' }, 'Kt = 60 / (2π·KV) N·m per amp. Assumes the motor is not saturated; with sensorless hobby ESCs keep a 2–3× margin.'))));
    recalcAll();
  };

  // ---------------------------------------------------------------- jobs & setup
  V.jobs = async function (m) {
    const st = S.state, j = await api('GET', 'jobs');
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Jobs & setup'), h('p', null, 'The slicer, the queue, the cache, backups.'))));
    const left = h('div'), right = h('div'); m.append(h('div', { class: 'cols' }, left, right));
    // slicer card — two engines, one active
    const inst = st.install || {};
    const eng = st.engines || {}, active = st.settings.slicer_engine || 'bambu';
    const slicerCard = h('div', { class: 'card' }, h('h3', null, 'Slicer engine'));
    const setEngine = async (e) => { await api('PUT', 'settings', { slicer_engine: e }); await loadState(); render(); };
    const engineRow = (key, title, info, blurb, installLabel, pathPlaceholder, pathKey) => {
      const isActive = active === key, ok = !!(info && info.version);
      const installing = inst.status === 'running' && inst.engine === key;
      return h('div', { class: 'engine' + (isActive ? ' active' : '') },
        h('div', { class: 'eh' },
          h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'engine', checked: isActive, onChange: () => setEngine(key) }), h('b', null, title)),
          ok ? h('span', { class: 'pill ver' }, `v${info.version}`) : h('span', { class: 'pill warn' }, 'not installed'),
          isActive && h('span', { class: 'pill auto' }, 'active')),
        h('p', { class: 'hint', style: { margin: '4px 0' } }, blurb),
        ok && h('div', { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all', color: 'var(--ink3)' } }, (info.cmd || []).join(' ')),
        info && info.hint && h('div', { class: 'callout bad' }, info.hint),
        installing && h('div', { class: 'progress' }, h('i', { style: { width: ((inst.progress || 0) * 100) + '%' } })),
        installing && h('p', { class: 'hint' }, inst.message || ''),
        !installing && inst.engine === key && inst.status === 'error' && h('div', { class: 'callout bad' }, inst.message),
        h('div', { class: 'tb', style: { marginTop: '6px' } },
          h('button', { class: 'btn small ' + (ok ? '' : 'primary'), disabled: inst.status === 'running', onClick: async () => { await api('POST', 'slicer/install', { engine: key }); S.installWatch = true; render(); } }, ok ? `Reinstall / update` : installLabel),
          h('button', { class: 'btn small', onClick: () => { const p = input({ value: st.settings[pathKey] || '', placeholder: pathPlaceholder }); modal(`Use an existing ${title}`, h('div', null, field('Path or command', p)), [{ label: 'Cancel' }, { label: 'Use', cls: 'primary', onClick: async () => { const body = {}; body[pathKey] = p.value || null; await api('PUT', 'settings', body); await loadState(); render(); } }], { width: '640px' }); } }, 'Use a different install…')));
    };
    slicerCard.append(
      engineRow('bambu', 'Bambu Studio', eng.bambu, 'Recommended. Slices with Bambu Studio itself using its own printer, process and filament presets, so weights and print times are exactly what Bambu Studio shows. Download ~230–470 MB on first install.', 'Install Bambu Studio', 'path to bambu-studio.exe / BambuStudio.app / AppImage folder, or "flatpak run com.bambulab.BambuStudio"', 'bambu_path'),
      engineRow('prusa', 'PrusaSlicer', eng.prusa, 'Fallback. Bambu settings are translated to a PrusaSlicer config; weights agree with Bambu Studio within about 1%, print time runs ~10% longer. Download ~100–140 MB.', 'Install PrusaSlicer', 'path to prusa-slicer-console.exe / PrusaSlicer.app / AppImage, or "flatpak run com.prusa3d.PrusaSlicer"', 'slicer_path'));
    const dl = h('dl', { class: 'kv', style: { marginTop: '10px' } });
    dl.append(h('dt', null, 'Slicing with'), h('dd', null, st.slicer.slicer_label || h('span', { class: 'pill warn' }, 'nothing — install an engine above')),
      h('dt', null, 'Workers'), h('dd', null, input({ type: 'number', value: st.slicer.workers, min: 1, max: 16, style: { width: '70px' }, onChange: async e => { await api('PUT', 'settings', { workers: +e.target.value }); await loadState(); renderShell(); } })),
      h('dt', null, 'Keep G-code'), h('dd', null, h('input', { type: 'checkbox', checked: !!st.settings.keep_gcode, onChange: e => api('PUT', 'settings', { keep_gcode: e.target.checked }) })));
    slicerCard.append(dl, h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: async () => { await api('POST', 'slicer/refresh'); await loadState(); render(); } }, 'Re-detect installs')),
      h('p', { class: 'hint' }, 'Switching engines keeps old results in the cache; parts re-slice with the new engine as they are touched. Both engines can be installed side by side; nothing is installed system-wide.'));
    left.append(slicerCard);
    // queue
    const qtb = h('tbody');
    for (const x of j.jobs) {
      const pr = x.profile_json ? JSON.parse(x.profile_json) : null;
      qtb.append(h('tr', null, h('td', null, h('span', { class: 'dot ' + x.status }), x.status), h('td', null, x.part_name || `part #${x.part_id}`), h('td', { class: 'prof' }, pr ? profString(pr) : ''), h('td', null, x.purpose || ''), h('td', { class: 'num' }, x.status === 'running' ? secs((Date.now() / 1000) - x.started) : (x.time_s != null ? secs(x.time_s) : '')), h('td', { class: 'num' }, x.grams != null ? fmt(x.grams, 2) + ' g' : (x.error ? h('span', { class: 'err', title: x.error }, x.error.slice(0, 60)) : ''))));
    }
    left.append(h('div', { class: 'card' }, h('h3', null, `Queue · ${j.state.running} running · ${j.state.queued} queued`, h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => api('POST', 'jobs/cancel', {}).then(render) }, 'Cancel queued'), h('button', { class: 'btn small', onClick: () => api('POST', 'jobs/retry_errors', {}).then(render) }, 'Retry errors'))),
      h('div', { class: 'tw', style: { maxHeight: '420px', overflow: 'auto' } }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Part'), h('th', null, 'Profile'), h('th', null, 'Purpose'), h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Result'))), qtb)), !j.jobs.length && h('p', { class: 'hint' }, 'No jobs yet.')));
    // right: cache, printers, data
    right.append(h('div', { class: 'card' }, h('h3', null, 'Cache'), h('dl', { class: 'kv' }, h('dt', null, 'Slices cached'), h('dd', null, j.cache.done), h('dt', null, 'Slicer time spent'), h('dd', null, secs(j.cache.time_s))), h('div', { class: 'tb', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onClick: () => confirmModal('Clear all cached slice results? Parts will re-slice as needed.', async () => { await api('POST', 'jobs/clear_cache', {}); render(); }, 'Clear') }, 'Clear cache'))));
    right.append(h('div', { class: 'card' }, h('h3', null, 'Printers', h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => printerModal() }, '＋'))), h('div', { class: 'tw' }, h('table', null, h('tbody', null, ...st.printers.map(p => h('tr', null, h('td', null, h('b', null, p.name)), h('td', null, p.nozzles.join(' · ') + ' mm'), h('td', { class: 'rng' }, `${p.bed.x} × ${p.bed.y} × ${p.bed.z}`), h('td', null, h('button', { class: 'btn icon', onClick: () => printerModal(p) }, '✎'))))))),
      h('div', { class: 'field', style: { marginTop: '8px' } }, h('label', null, 'Default printer'), select(st.printers.map(p => [p.id, p.name]), st.settings.default_printer_id, { onChange: e => api('PUT', 'settings', { default_printer_id: +e.target.value }) })),
      h('div', { class: 'field' }, h('label', null, 'Default filament'), select(st.filaments.map(f => [f.id, f.name]), st.settings.default_filament_id, { onChange: e => api('PUT', 'settings', { default_filament_id: +e.target.value }) })),
      h('div', { class: 'field' }, h('label', null, 'Default profile'), select(st.profiles.map(p => [p.id, p.name]), st.settings.default_profile_id, { onChange: e => api('PUT', 'settings', { default_profile_id: +e.target.value }) }))));
    right.append(h('div', { class: 'card' }, h('h3', null, 'Data'), h('dl', { class: 'kv' }, h('dt', null, 'Location'), h('dd', { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all', textAlign: 'left' } }, st.root + '/data'), h('dt', null, 'Version'), h('dd', null, st.version)),
      h('div', { class: 'tb', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onClick: async () => { const r = await api('POST', 'backup'); toast('Backup written: ' + r.file); } }, 'Back up now'), S.robot && h('button', { class: 'btn small', onClick: () => window.open(`/api/robots/${S.robotId}/export/archive`) }, 'Export robot archive'), h('button', { class: 'btn small', onClick: importArchive }, 'Import robot archive'))));
  };
  function printerModal(p) {
    const name = input({ value: p?.name || '' }), noz = input({ value: p ? p.nozzles.join(', ') : '0.4, 0.6' }), bx = input({ type: 'number', value: p?.bed.x ?? 256, style: { width: '80px' } }), by = input({ type: 'number', value: p?.bed.y ?? 256, style: { width: '80px' } }), bz = input({ type: 'number', value: p?.bed.z ?? 256, style: { width: '80px' } });
    modal(p ? 'Edit printer' : 'New printer', h('div', null, field('Name', name), field('Nozzles (mm)', noz), field('Bed X × Y × Z', h('div', { class: 'tb' }, bx, '×', by, '×', bz))),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { const body = { name: name.value, nozzles: noz.value.split(/[,\s]+/).filter(Boolean).map(Number), bed: { x: +bx.value, y: +by.value, z: +bz.value } }; if (p) await api('PUT', `printers/${p.id}`, body); else await api('POST', 'printers', body); await loadState(); render(); } }]);
  }

  // ------------------------------------------------------------ render loop
  async function refreshRobot(rerender = true) { if (S.robotId) await loadRobot(S.robotId); renderShell(); if (rerender && ['sheet', 'parts'].includes(S.view)) await renderMain(); }
  let rendering = false;
  async function renderMain() {
    const m = $('#main'); m.textContent = '';
    const fn = V[S.view] || V.home;
    try { await fn(m); } catch (e) { m.append(h('div', { class: 'empty' }, 'Something went wrong: ' + e.message)); console.error(e); }
  }
  async function render() { renderShell(); await renderMain(); }
  function connectSSE() {
    const es = new EventSource('/api/stream'); S.es = es;
    let timer = null;
    es.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'queue') { S.state.slicer = Object.assign(S.state.slicer, d); renderShell(); }
      if (d.type === 'install') { S.state.install = d; if (S.view === 'jobs') { clearTimeout(timer); timer = setTimeout(render, 150); } if (d.status === 'done') { loadState().then(render); toast(d.message); } if (d.status === 'error') toast(d.message, true); }
      if (d.type === 'job' || d.type === 'line_item') {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (S.robotId) await loadRobot(S.robotId);
          renderShell();
          if (['sheet', 'parts', 'part', 'jobs'].includes(S.view) || (S.view === 'optimizer' && S.pollRun)) renderMain();
        }, 400);
      }
    };
    es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
  }
  window.addEventListener('hashchange', () => { route(); render(); });
  (async function init() {
    try {
      await loadState(); route();
      const saved = +localStorage.getItem('sb.robot');
      const rid = S.state.robots.find(r => r.id === saved && r.status === 'active') ? saved : (S.state.robots.find(r => r.status === 'active') || {}).id;
      if (rid) await loadRobot(rid);
      if (!S.state.slicer.slicer && S.view === 'home') { toast('No slicer installed yet — open Jobs & setup and install Bambu Studio.', true); }
      await render(); connectSSE();
    } catch (e) { document.body.append(h('div', { class: 'empty' }, 'Could not reach the SliceBudget service: ' + e.message)); }
  })();
  window.SB = { S, api, render, go };
})();
