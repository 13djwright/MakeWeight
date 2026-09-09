/* MakeWeight — make weight, with the numbers to prove it
   Copyright (C) 2026 Devin Wright (13djwright)
   SPDX-License-Identifier: GPL-3.0-or-later  (GNU GPL v3 or later; see the LICENSE file) */
/* MakeWeight UI — vanilla JS single page app. (Brand strings come from /api/state .app / brand.json.) */
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
  const dayStr = (t) => !t ? '' : typeof t === 'string' ? t : new Date(t * 1000).toLocaleDateString();   // weigh-ins store YYYY-MM-DD; runs store epoch seconds

  // ------------------------------------------------------------ weight distribution bar + tooltip
  // One segment per counted section, left to right; printed grams inside a section are drawn in the accent colour, the
  // rest in slate (each section a little lighter than the one before). Black line = class limit, dashed line = limit −
  // margin. Hovering shows a legend with every section's grams and share instead of the browser's plain title text.
  let TIP = null;
  function tipEl() { if (!TIP) { TIP = h('div', { class: 'tip', role: 'tooltip', hidden: true }); document.body.append(TIP); } return TIP; }
  function showTip(content, x, y) { const t = tipEl(); t.textContent = ''; t.append(content); t.hidden = false; moveTip(x, y); }
  function moveTip(x, y) { const t = tipEl(); const w = t.offsetWidth, hgt = t.offsetHeight; const left = Math.min(x + 14, window.innerWidth - w - 8), top = y + 18 + hgt > window.innerHeight ? y - hgt - 10 : y + 18; t.style.left = left + 'px'; t.style.top = top + 'px'; }
  function hideTip() { if (TIP) TIP.hidden = true; }
  function budgetBar(o) {
    // o: { segments: [{name, grams, printed}], limit, margin, total, name, mini }
    const segs = (o.segments || []).filter(s => s.grams > 0);
    const span = Math.max(o.total || 0, o.limit) * 1.04;
    const bar = h('div', { class: 'bar' + (o.mini ? ' mini' : ''), tabindex: '0', 'aria-label': `${fmt(o.total)} g of ${fmt(o.limit)} g` });
    let x = 0; const shades = [0.9, 0.7, 0.55, 0.42, 0.34, 0.28];
    const rows = [];
    segs.forEach((sg, i) => {
      const other = sg.grams - (sg.printed || 0), color = `rgba(var(--slate-rgb), ${shades[i % shades.length]})`;
      if (other > 0) { bar.append(h('i', { dataset: { i }, style: { left: x + '%', width: other / span * 100 + '%', background: color } })); x += other / span * 100; }
      if (sg.printed > 0) { bar.append(h('i', { dataset: { i }, style: { left: x + '%', width: sg.printed / span * 100 + '%', background: 'var(--accent)' } })); x += sg.printed / span * 100; }
      rows.push({ i, sg, color });
    });
    if (o.margin) bar.append(h('i', { class: 'mrg', style: { left: (o.limit - o.margin) / span * 100 + '%' } }));
    bar.append(h('i', { class: 'lim', style: { left: o.limit / span * 100 + '%' } }));
    const legend = () => {
      const over = (o.total || 0) - o.limit;
      const el = h('div', { class: 'tipbody' },
        h('div', { class: 'tt' }, o.name ? `${o.name} · ` : '', h('b', null, `${fmt(o.total)} g`), ` of ${fmt(o.limit)} g`, h('span', { class: 'pill ' + (over > 0 ? 'bad' : 'good'), style: { marginLeft: '8px' } }, over > 0 ? `${fmt(over)} g over` : `${fmt(-over)} g under`)),
        h('table', { class: 'nores' }, h('tbody', null,
          ...rows.map(r => h('tr', { dataset: { i: r.i } }, h('td', null, h('i', { class: 'sw', style: { background: r.color } }), r.sg.printed > 0 && h('i', { class: 'sw', style: { background: 'var(--accent)' } })), h('td', null, r.sg.name), h('td', { class: 'num' }, fmt(r.sg.grams), ' g'), h('td', { class: 'num rng' }, o.total ? Math.round(r.sg.grams / o.total * 100) + '%' : ''), h('td', { class: 'rng' }, r.sg.printed > 0 ? `${fmt(r.sg.printed)} g printed` : ''))),
          h('tr', { class: 'sum' }, h('td'), h('td', null, 'Total'), h('td', { class: 'num' }, fmt(o.total), ' g'), h('td', { class: 'num rng' }, '100%'), h('td')))),
        h('div', { class: 'keys' }, h('span', null, h('i', { class: 'sw', style: { background: 'var(--accent)' } }), 'printed parts'), h('span', null, h('i', { class: 'sw', style: { background: `rgba(var(--slate-rgb), .7)` } }), 'everything else'), h('span', null, h('i', { class: 'sw line' }), `class limit ${fmt(o.limit)} g`), o.margin ? h('span', null, h('i', { class: 'sw dash' }), `limit − margin ${fmt(o.limit - o.margin)} g`) : null));
      return el;
    };
    const hl = i => { if (!TIP) return; TIP.querySelectorAll('tr').forEach(tr => tr.classList.toggle('on', tr.dataset.i === String(i))); };
    bar.addEventListener('mouseenter', e => { showTip(legend(), e.clientX, e.clientY); });
    bar.addEventListener('mousemove', e => { moveTip(e.clientX, e.clientY); hl(e.target.dataset ? e.target.dataset.i : null); });
    bar.addEventListener('mouseleave', hideTip);
    bar.addEventListener('focus', () => { const r = bar.getBoundingClientRect(); showTip(legend(), r.left, r.bottom - 10); });
    bar.addEventListener('blur', hideTip);
    return bar;
  }
  const today = () => new Date().toISOString().slice(0, 10);
  const secs = s => s == null ? '—' : s < 60 ? s.toFixed(1) + ' s' : (s / 60).toFixed(1) + ' min';
  const hms = s => { if (s == null) return '—'; const hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60); return hh ? `${hh}h ${mm}m` : `${mm}m`; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(method, path, body, raw) {
    const opts = { method, headers: {} };
    if (body instanceof ArrayBuffer || body instanceof Blob) { opts.body = body; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    if (raw && raw.headers) Object.assign(opts.headers, raw.headers);
    if (raw && raw.label) opts.headers['X-Undo-Label'] = encodeURIComponent(raw.label);
    if (opts.headers['X-Undo-Label'] && /[^\x00-\xff]/.test(opts.headers['X-Undo-Label'])) opts.headers['X-Undo-Label'] = encodeURIComponent(opts.headers['X-Undo-Label']);
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
    const opener = document.activeElement;
    const onKey = e => {
      if (root.lastElementChild !== bg) return;                       // only the topmost dialog reacts
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && buttons && opts.enterSubmits !== false && bg.contains(e.target)) { const prim = bg.querySelector('footer .btn.primary'); if (prim) { e.preventDefault(); prim.click(); } }
      else if (e.key === 'Tab') {                                       // keep focus inside the dialog
        const f = [...bg.querySelectorAll('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex="0"]')].filter(x => x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    const close = () => {
      bg.remove(); document.removeEventListener('keydown', onKey, true); if (opts.onClose) opts.onClose(); if (opener && opener.focus && document.body.contains(opener)) opener.focus();
      // a refresh that arrived while this dialog was open (its own Save, a slice landing) was held back — run it now
      if (S.renderPending && !document.querySelector('.modal-bg')) { S.renderPending = false; softRender().catch(console.error); }
    };
    const dlg = h('div', { class: 'modal', style: opts.width ? { width: opts.width, maxWidth: '96vw' } : null, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
      h('header', null, h('h2', null, title), h('button', { class: 'btn icon x', onClick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'body' }, body),
      buttons && h('footer', null, ...buttons.map(b => h('button', { class: 'btn ' + (b.cls || ''), onClick: async () => { try { const r = await b.onClick?.(close); if (r !== false && !b.keep) close(); } catch (e) { fail(e); } } }, b.label))));
    const bg = h('div', { class: 'modal-bg', onClick: e => { if (e.target === bg && !opts.sticky) close(); } }, dlg);
    root.append(bg);
    document.addEventListener('keydown', onKey, true);
    const first = bg.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),footer button:not(.x)');
    setTimeout(() => { if (!opts.noFocus && first) first.focus(); else dlg.focus(); }, 30);
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
    const m = h('div', { class: 'menu', role: 'menu', style: { top: (r.bottom + window.scrollY + 4) + 'px', left: Math.min(r.left, window.innerWidth - 230) + 'px' } });
    const close = () => { m.remove(); document.removeEventListener('keydown', onKey, true); anchor.setAttribute('aria-expanded', 'false'); };
    for (const it of items) {
      if (it === '-') { m.append(h('hr')); continue; }
      m.append(h('button', { class: it.cls || '', role: 'menuitem', onClick: () => { close(); it.onClick(); } }, it.label));
    }
    const onKey = e => {
      const btns = [...m.querySelectorAll('button')]; const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-haspopup', 'menu'); anchor.setAttribute('aria-expanded', 'true');
    document.body.append(m);
    const first = m.querySelector('button'); if (first) first.focus();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  }
  // editable cell: click to edit, Enter/blur saves
  function edCell(value, onSave, opts = {}) {
    // Inline-editable cell. Affordances: text cursor + pencil on hover, focusable (Tab) and Enter/F2 to edit.
    // While editing, the cell keeps its exact width so the rest of the table never shifts.
    const td = h('td', { class: 'ed ' + (opts.cls || ''), title: opts.title || 'Click to edit', tabindex: '0', role: 'button', 'aria-label': opts.label || 'Edit value' });
    const show = () => { td.textContent = ''; td.classList.remove('editing'); td.append(opts.render ? opts.render(value) : (value == null || value === '' ? (opts.placeholder || '—') : (opts.fmt ? opts.fmt(value) : value))); };
    show();
    const edit = () => {
      if (td.querySelector('input,select')) return;
      const w = td.getBoundingClientRect().width;              // the table is fixed-layout, so the column cannot move; size the input to the cell
      const cs = getComputedStyle(td);
      const inner = Math.max(24, w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2);
      td.classList.add('editing');
      let inp;
      if (opts.options) { inp = select(opts.options, value); }
      else { inp = h('input', { type: opts.type || 'text', value: value == null ? '' : value, class: opts.type === 'number' ? 'num' : '', step: opts.step || 'any', inputmode: opts.type === 'number' ? 'decimal' : undefined }); if (opts.list) inp.setAttribute('list', opts.list); }
      inp.style.width = inner + 'px'; inp.style.minWidth = '0'; inp.style.boxSizing = 'border-box';
      let closed = false;
      const done = async (save) => {
        if (closed) return; closed = true;
        if (!save) { show(); td.focus(); return; }
        let v = inp.value;
        if (opts.type === 'number') v = v === '' ? null : parseFloat(v);
        if (v === value || (v === '' && value == null) || (opts.type === 'number' && v !== null && isNaN(v))) { show(); return; }
        try { value = v; show(); await onSave(v); } catch (e) { fail(e); }
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Tab') { done(true); } e.stopPropagation(); });
      inp.addEventListener('blur', () => done(true));
      if (inp.tagName === 'SELECT') inp.addEventListener('change', () => done(true));
      td.textContent = ''; td.append(inp); inp.focus(); if (inp.select) inp.select();
    };
    td.addEventListener('click', edit);
    td.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === 'F2' || e.key === ' ') && !td.querySelector('input,select')) { e.preventDefault(); edit(); } });
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
  new MutationObserver(() => { if (makeSortable._t) return; makeSortable._t = requestAnimationFrame(() => { makeSortable._t = 0; makeSortable(document.body); makeResizable(document.body); }); }).observe(document.body, { childList: true, subtree: true });

  // ------------------------------------------------------------ resizable columns
  // Every table with a header gets a drag grip on each column edge. On first layout the browser's automatic widths are
  // frozen into a <colgroup> (table-layout: fixed), so editing a cell or a value changing never reflows the other
  // columns. One "fill" column (the widest text column) absorbs the difference so the table keeps filling its card; when
  // the columns add up to more than the card the table grows and scrolls sideways. Widths are saved per table in the
  // shared settings, so they travel with the data to every computer. Double-click a grip to fit the column to its
  // content; right-click a header for fit-all / reset.
  const COLW = { data: null, timer: 0, MIN: 36 };
  const colData = () => COLW.data || (COLW.data = Object.assign({}, (S.state && S.state.settings && S.state.settings.col_widths) || {}));
  const colKey = tbl => tbl.dataset.tkey || tableKey(tbl);
  function saveColW() { clearTimeout(COLW.timer); COLW.timer = setTimeout(() => api('PUT', 'settings', { col_widths: colData() }).catch(() => { }), 500); }
  function colgroupOf(tbl, n) {
    let cg = tbl.querySelector(':scope > colgroup');
    if (!cg) { cg = h('colgroup'); tbl.prepend(cg); }
    while (cg.children.length < n) cg.append(h('col'));
    while (cg.children.length > n) cg.lastChild.remove();
    return cg;
  }
  function pickFill(ths, w) {
    // a text column (not numeric, not blank): the first one that is nearly as wide as the widest, else the widest of all
    const text = []; ths.forEach((th, i) => { if (!th.classList.contains('num') && th.textContent.trim()) text.push(i); });
    if (text.length) { const mx = Math.max(...text.map(i => w[i])); return text.find(i => w[i] >= 0.8 * mx); }
    let best = 0; w.forEach((x, i) => { if (x > w[best]) best = i; }); return best;
  }
  function layoutCols(tbl) {
    // apply tbl._cw (= {w:[px], f:fill}) — the fill column takes whatever the card has left
    const cw = tbl._cw; if (!cw) return;
    const n = cw.w.length, cg = colgroupOf(tbl, n);
    const wrap = tbl.closest('.tw') || tbl.parentElement;
    const avail = wrap ? wrap.clientWidth : tbl.clientWidth;
    let others = 0; cw.w.forEach((x, i) => { if (i !== cw.f) others += x; });
    const fill = Math.max(cw.w[cw.f], avail - others);       // w[f] is the fill column's minimum (see snapshotCols)
    const widths = cw.w.map((x, i) => i === cw.f ? fill : x);
    widths.forEach((x, i) => { cg.children[i].style.width = x + 'px'; });
    tbl.style.tableLayout = 'fixed'; tbl.style.width = widths.reduce((a, b) => a + b, 0) + 'px'; tbl.classList.add('fixed');
  }
  function snapshotCols(tbl, ths) {
    const exact = ths.map(th => th.getBoundingClientRect().width);
    if (!exact.every(x => x > 0)) return null;
    const f = pickFill(ths, exact);
    const w = exact.map(x => Math.ceil(x));                       // never round down: a fraction short turns a header into an ellipsis
    // a table that fits its card: the fill column may give up room (down to 140 px) when other columns grow, and takes any
    // spare room (layoutCols hands it exactly what is left, so the rounding above never makes the table overflow);
    // a table already wider than its card keeps every natural width and scrolls sideways
    const wrap = tbl.closest('.tw') || tbl.parentElement, avail = wrap ? wrap.clientWidth : 0;
    if (avail && exact.reduce((a, b) => a + b, 0) <= avail + 1) w[f] = Math.min(w[f], 140);
    return { w, f };
  }
  function makeResizable(root) {
    for (const tbl of root.querySelectorAll('table')) {
      if (tbl.dataset.resizable || !tbl.tHead || !tbl.tHead.rows.length || tbl.closest('.nores')) continue;
      if (tbl.closest('.modal') && !tbl.dataset.tkey) continue;
      if (!tbl.isConnected || !tbl.getBoundingClientRect().width) continue;         // not laid out yet: try again on the next pass
      const ths = [...tbl.tHead.rows[0].children];
      if (ths.length < 2 || ths.some(t => t.colSpan > 1)) continue;
      const key = colKey(tbl), saved = colData()[key];
      let cw = saved && saved.w && saved.w.length === ths.length ? { w: saved.w.map(x => Math.max(COLW.MIN, +x || COLW.MIN)), f: saved.f ?? pickFill(ths, saved.w) } : snapshotCols(tbl, ths);
      if (!cw) continue;
      tbl.dataset.resizable = '1'; tbl._cw = cw; tbl.dataset.ckey = key;
      layoutCols(tbl);
      const persist = () => { colData()[key] = { w: tbl._cw.w.slice(), f: tbl._cw.f, n: ths.length }; saveColW(); };
      ths.forEach((th, i) => {
        const grip = h('div', { class: 'colgrip', title: 'Drag to resize · double-click to fit' });
        th.append(grip);
        grip.addEventListener('click', e => e.stopPropagation());
        grip.addEventListener('dblclick', e => { e.stopPropagation(); fitCol(tbl, i); persist(); });
        grip.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const start = e.clientX, cw0 = tbl._cw, w0 = cw0.w.slice(), live = [...tbl.querySelectorAll(':scope > colgroup > col')].map(c => parseFloat(c.style.width) || 0);
          const f = cw0.f, j = i === f ? (i + 1 < ths.length ? i + 1 : i - 1) : -1;      // dragging the fill column trades width with its neighbour
          grip.classList.add('drag'); document.body.classList.add('col-dragging');
          grip.setPointerCapture(e.pointerId);
          const move = ev => {
            const d = ev.clientX - start;
            const w = w0.slice();
            if (i === f) { const nw = Math.max(COLW.MIN, live[i] + d); const dd = nw - live[i]; w[i] = nw; if (j >= 0) w[j] = Math.max(COLW.MIN, w0[j] - dd); }
            else w[i] = Math.max(COLW.MIN, w0[i] + d);
            tbl._cw = { w, f }; layoutCols(tbl);
          };
          const up = () => { grip.removeEventListener('pointermove', move); grip.classList.remove('drag'); document.body.classList.remove('col-dragging'); persist(); fitTables(); };
          grip.addEventListener('pointermove', move);
          grip.addEventListener('pointerup', up, { once: true }); grip.addEventListener('pointercancel', up, { once: true });
        });
      });
      tbl.tHead.addEventListener('contextmenu', e => {
        e.preventDefault();
        menu(e.target.closest('th') || e.target, [
          { label: 'Fit all columns to content', onClick: () => { ths.forEach((_, i) => fitCol(tbl, i)); persist(); fitTables(); } },
          { label: 'Reset column widths', onClick: () => { delete colData()[key]; saveColW(); render(); } },
        ]);
      });
    }
  }
  function fitCol(tbl, i) {
    // widest content in the column (cells are nowrap, so scrollWidth is the natural width), within reason
    let w = COLW.MIN;
    for (const row of tbl.rows) { const c = row.children[i]; if (!c || c.colSpan > 1) continue; w = Math.max(w, c.scrollWidth + 2); }
    tbl._cw.w[i] = Math.min(520, w); layoutCols(tbl);
  }
  function relayoutCols() { for (const tbl of document.querySelectorAll('table[data-resizable]')) if (tbl._cw) layoutCols(tbl); }

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

  // ------------------------------------------------------------ appearance (theme + colours)
  const THEME_VARS = [['accent', 'Accent', 'Buttons, links, card titles, the printed-parts bar'], ['bg', 'Page background', ''], ['panel', 'Cards & inputs', ''], ['panel2', 'Table headers & hover', ''], ['ink', 'Text', ''], ['rule', 'Borders', ''], ['good', 'Under / measured', ''], ['bad', 'Over / errors', '']];
  function hexToHsl(hex) { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex); if (!m) return null; let [r, g, b] = m.slice(1).map(x => parseInt(x, 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return [h * 360, s * 100, l * 100]; }
  function hsl(h, s, l) { return `hsl(${h.toFixed(0)} ${Math.max(0, Math.min(100, s)).toFixed(0)}% ${Math.max(0, Math.min(100, l)).toFixed(0)}%)`; }
  function applyAppearance(a) {
    a = a || {};
    const root = document.documentElement;
    if (a.theme === 'light' || a.theme === 'dark') root.setAttribute('data-theme', a.theme); else root.removeAttribute('data-theme');
    // clear then set the overrides
    for (const [k] of THEME_VARS) for (const v of ['--' + k, '--' + k + '-ink', '--' + k + '-soft', '--focus', '--sel', '--rule2', '--ink2', '--ink3']) root.style.removeProperty(v);
    const dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    for (const [k, v] of Object.entries(a.colors || {})) {
      if (!/^#[\da-f]{6}$/i.test(v)) continue;
      root.style.setProperty('--' + k, v);
      const c = hexToHsl(v); if (!c) continue; const [h, sat, l] = c;
      if (k === 'accent') { root.style.setProperty('--accent-ink', hsl(h, sat, dark ? Math.min(85, l + 12) : Math.max(20, l - 12))); root.style.setProperty('--accent-soft', hsl(h, Math.min(90, sat), dark ? 18 : 92)); root.style.setProperty('--focus', v); root.style.setProperty('--sel', hsl(h, Math.min(60, sat), dark ? 15 : 96)); }
      if (k === 'ink') { root.style.setProperty('--ink2', hsl(h, sat, dark ? l - 18 : l + 22)); root.style.setProperty('--ink3', hsl(h, sat, dark ? l - 36 : l + 42)); }
      if (k === 'rule') root.style.setProperty('--rule2', hsl(h, sat, dark ? l - 4 : l + 5));
      if (k === 'good' || k === 'bad') root.style.setProperty('--' + k + '-soft', hsl(h, Math.min(70, sat), dark ? 18 : 92));
    }
  }
  function loadAppearance() { try { return JSON.parse(localStorage.getItem('sb.appearance') || 'null') || (S.state && S.state.settings && S.state.settings.appearance) || {}; } catch { return {}; } }
  function saveAppearance(a) { try { localStorage.setItem('sb.appearance', JSON.stringify(a)); } catch { } api('PUT', 'settings', { appearance: a }).catch(() => { }); }
  function appearanceModal() {
    const a = Object.assign({ theme: 'system', colors: {} }, loadAppearance());
    const themeSeg = h('div', { class: 'seg' });
    let rows = [];
    const drawSeg = () => { themeSeg.textContent = ''; for (const [v, l] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) themeSeg.append(h('button', { 'aria-pressed': String(a.theme === v), onClick: () => { a.theme = v; drawSeg(); applyAppearance(a); saveAppearance(a); rows.forEach((r, i) => { const k = THEME_VARS[i][0]; if (!a.colors[k]) r.querySelector('input').value = toHex(current(k)); }); } }, l)); };
    drawSeg();
    const current = k => getComputedStyle(document.documentElement).getPropertyValue('--' + k).trim();
    const toHex = c => { if (/^#[\da-f]{6}$/i.test(c)) return c; const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c); if (!m) { const el = document.createElement('i'); el.style.color = c; document.body.append(el); const rgb = getComputedStyle(el).color; el.remove(); const mm = /(\d+),\s*(\d+),\s*(\d+)/.exec(rgb); return mm ? '#' + mm.slice(1).map(x => (+x).toString(16).padStart(2, '0')).join('') : '#888888'; } return '#' + m.slice(1).map(x => (+x).toString(16).padStart(2, '0')).join(''); };
    rows = THEME_VARS.map(([k, label, desc]) => {
      const pick = h('input', { type: 'color', value: toHex(a.colors[k] || current(k)), style: { width: '44px', height: '28px', padding: '2px' } });
      const reset = h('button', { class: 'btn small', disabled: !a.colors[k], onClick: () => { delete a.colors[k]; applyAppearance(a); saveAppearance(a); pick.value = toHex(current(k)); reset.disabled = true; } }, 'Reset');
      pick.addEventListener('input', () => { a.colors[k] = pick.value; applyAppearance(a); reset.disabled = false; });
      pick.addEventListener('change', () => saveAppearance(a));
      return field(label, h('div', { class: 'tb' }, pick, h('span', { class: 'rng' }, desc), reset));
    });
    modal('Appearance', h('div', null, field('Theme', themeSeg), h('p', { class: 'hint' }, 'Colours update live as you pick them; related shades (hover, borders, soft backgrounds) follow automatically. Saved for this browser and on the server.'), ...rows,
      h('div', { class: 'tb', style: { marginTop: '10px' } }, h('button', { class: 'btn small', onClick: () => { a.colors = {}; applyAppearance(a); saveAppearance(a); rows.forEach((r, i) => { r.querySelector('input').value = toHex(current(THEME_VARS[i][0])); r.querySelector('button').disabled = true; }); } }, 'Reset all colours'))),
      [{ label: 'Done', cls: 'primary' }], { width: '520px' });
  }

  // ------------------------------------------------------------ undo / redo
  async function doUndo(kind) {
    try {
      const r = await api('POST', kind);
      S.state.undo = { undo: r.undo, redo: r.redo };
      if (r.done) toast(`${kind === 'undo' ? 'Undid' : 'Redid'}: ${r.done}`);
      await loadState(); if (S.robotId) await loadRobot(S.robotId).catch(() => { S.robotId = null; S.robot = null; });
      await render();
    } catch (e) { fail(e); }
  }
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey; if (!mod || e.altKey) return;
    const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) return;  // let the browser undo text inside a field
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); doUndo(e.shiftKey ? 'redo' : 'undo'); }
    else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); doUndo('redo'); }
  });
  function toastUndo(msg) {
    // an action toast with an inline Undo button (used after one-click deletes)
    const el = h('div', { class: 'toast action' }, h('span', null, msg), h('button', { class: 'btn small', onClick: () => { el.remove(); doUndo('undo'); } }, 'Undo'));
    $('#toasts').append(el); setTimeout(() => el.remove(), 8000);
  }

  // ------------------------------------------------------------ shell
  function renderShell() {
    const st = S.state, r = S.robot;
    if (!st) return;                         // an SSE event or timer can fire before the first /api/state has arrived
    // robot switcher
    const sw = $('#robot-switch'); sw.textContent = '';
    const sel = select([['', '— choose a robot —'], ...st.robots.filter(x => x.status === 'active').map(x => [x.id, x.name])], S.robotId || '', { onChange: async e => { const id = +e.target.value; if (!id) return; await loadRobot(id); if (['home', 'library', 'filaments', 'jobs'].includes(S.view)) go('sheet'); else render(); } });
    sw.append(sel);
    if (r && r.queue) sw.append(h('span', { class: 'dirty' }, `● ${r.queue} slice${r.queue > 1 ? 's' : ''} in queue`));
    // budget bar
    const b = $('#budget'); b.textContent = '';
    if (r) {
      const t = r.totals, cls = r.weight_class_g, over = t.over_under;
      const segs = r.sections.filter(s => s.counts).map(s => ({ name: s.name, grams: s.items.filter(i => i.in_total).reduce((a, i) => a + i.total_grams, 0), printed: s.items.filter(i => i.in_total && i.part).reduce((a, i) => a + i.total_grams, 0) }));
      const bar = budgetBar({ segments: segs, limit: cls, margin: r.margin_g, total: t.best_known, name: r.configs && r.configs.length ? cfgName(r, r.active_config) : r.name });
      b.append(h('div', { class: 'lbl' }, `${r.class_name || 'class'} · limit `, h('b', null, fmt(cls, 1) + ' g'), ' · margin ', h('b', null, fmt(r.margin_g, 1) + ' g')), bar,
        h('div', { class: 'status ' + (over > 0 ? 'over' : 'under') }, over > 0 ? `${fmt(over)} g over` : `${fmt(-over)} g under`));
    }
    // top actions
    const ta = $('#top-actions'); ta.textContent = '';
    const u = st.undo || { undo: [], redo: [] };
    const lastU = u.undo[u.undo.length - 1], lastR = u.redo[u.redo.length - 1];
    ta.append(h('div', { class: 'seg undo' },
      h('button', { disabled: !lastU, title: lastU ? `Undo ${lastU.label} (Ctrl/⌘+Z)` : 'Nothing to undo', 'aria-label': 'Undo', onClick: () => doUndo('undo') }, '↶ Undo'),
      h('button', { disabled: !lastR, title: lastR ? `Redo ${lastR.label} (Ctrl/⌘+Shift+Z)` : 'Nothing to redo', 'aria-label': 'Redo', onClick: () => doUndo('redo') }, '↷ Redo')));
    if (r) ta.append(h('button', { class: 'btn ghost', onClick: e => exportMenu(e.currentTarget) }, 'Export ▾'));
    ta.append(h('button', { class: 'btn ghost icon', title: 'Appearance: theme and colours', 'aria-label': 'Appearance', onClick: () => appearanceModal() }, '◐'));
    ta.append(h('span', { class: 'hint', style: { margin: 0 }, title: 'Every edit is saved to the local database immediately' }, 'Saved ✓'));
    // nav
    const nav = $('#nav'); nav.textContent = '';
    const item = (id, label, badge, badgeCls) => h('button', { class: 'nav', role: 'tab', 'aria-selected': String(S.view === id), onClick: () => go(id) }, label, badge != null && h('span', { class: 'k ' + (badgeCls || '') }, badge));
    nav.append(item('home', 'All robots', st.robots.length));
    if (r) {
      nav.append(h('div', { class: 'sec' }, 'This robot'));
      const nParts = r.sections.reduce((a, s) => a + s.items.filter(i => i.part).length, 0);
      nav.append(item('sheet', 'Weight sheet', r.totals.flags || null, 'warn'), item('parts', 'Printed parts', nParts), item('part', 'Part detail'), item('optimizer', 'Optimizer'), item('runs', 'Runs'), item('events', 'Competition log'));
    }
    nav.append(h('div', { class: 'sec' }, 'Library'), item('library', 'Components'), item('filaments', 'Filaments & profiles'));
    nav.append(h('div', { class: 'sec' }, 'Tool'), item('calc', 'Calculators'), item('jobs', 'Jobs & setup', st.slicer.slicer ? null : '!', 'warn'));
    const q = st.slicer;
    const slicerLine = q.slicer
      ? h('span', null, h('b', null, (q.slicer_label || q.slicer).split('+')[0]), h('br'), `${q.workers} worker${q.workers > 1 ? 's' : ''} · ${q.running} running · ${q.queued} queued`)
      : h('span', null, h('b', { style: { color: 'var(--warn)' } }, 'No slicer installed'), h('br'), 'Open Jobs & setup');
    const versionLine = h('div', { style: { marginTop: '6px' } }, `${st.app ? st.app.name : ''} ${st.version}`,
      S.updateAvail ? h('a', { href: '#/jobs', class: 'pill ok', style: { marginLeft: '6px', textDecoration: 'none' }, title: 'A newer version is on GitHub — open Jobs & setup to install it' }, `↑ ${S.updateAvail} available`) : null);
    const a = st.app || {};
    const legalLine = a.author ? h('div', { style: { marginTop: '4px' } }, `© ${a.copyright_year || ''} ${a.author}`, h('br'),
      h('a', { href: a.repo_url || '#', target: '_blank', rel: 'noopener', style: { color: 'inherit' }, title: 'Free software under the GNU GPL v3 or later — source, license and issues on GitHub' }, `${a.license || 'GPL-3.0-or-later'} · source ↗`)) : null;
    nav.append(h('div', { class: 'foot' }, slicerLine, versionLine, legalLine));
  }
  // Quietly ask GitHub whether a newer release exists: shortly after the page opens and then every hour while it stays
  // open, but never more than once per 6 hours across tabs/restarts (only when an update source is configured).
  async function autoUpdateCheck() {
    try {
      const st = S.state; if (!st || !st.update_repo) return;
      const vt = v => (String(v || '').match(/\d+/g) || ['0']).slice(0, 3).map(Number), newer = (a, b) => { const x = vt(a), y = vt(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
      const last = +localStorage.getItem('sb.updateCheck') || 0;
      // the remembered answer only counts if it was given for the version running now (updating 0.12 → 0.13.2 within the
      // 6-hour window must not keep announcing the 0.13.0 that the old version saw) and is actually newer than it
      if (Date.now() - last < 6 * 3600e3 && localStorage.getItem('sb.updateFor') === st.version) { const v = localStorage.getItem('sb.updateAvail'); if (v && newer(v, st.version)) { S.updateAvail = v; renderShell(); } return; }
      localStorage.setItem('sb.updateCheck', String(Date.now())); localStorage.setItem('sb.updateFor', st.version);
      const r = await api('POST', 'update/check?quiet=1');
      if (r.error) return;
      localStorage.setItem('sb.updateAvail', r.newer && newer(r.version, st.version) ? r.version : '');
      if (r.newer && newer(r.version, st.version)) { S.updateAvail = r.version; renderShell(); toast(`${st.app.name} ${r.version} is available — Jobs & setup → Update.`); }
    } catch (e) { /* offline or no repo: stay quiet */ }
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
      { label: 'Bambu Studio project (.3mf — one plate per part, settings on each object)', onClick: dl('bambu3mf') },
      '-',
      { label: 'Robot archive (.makeweight.zip)', onClick: dl('archive') },
    ]);
  }

  // ------------------------------------------------------------ views
  const V = {};

  V.home = function (m) {
    const st = S.state;
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Robots'), h('p', null, 'Each robot has its own weight sheet, printed parts, runs and competition log. The library is shared.')),
      h('div', { class: 'tb' }, h('button', { class: 'btn', onClick: importArchive }, 'Import archive…'), h('button', { class: 'btn primary', onClick: newRobotModal }, '＋ New robot…'))));
    const grid = h('div', { class: 'robots' });
    const active = st.robots.filter(r => r.status === 'active'), archived = st.robots.filter(r => r.status !== 'active');
    for (const r of active) grid.append(robotCard(r));
    grid.append(h('button', { class: 'rcard new', onClick: newRobotModal }, '＋ New robot…'));
    m.append(grid);
    if (archived.length) {
      m.append(h('h3', { style: { marginTop: '24px', fontSize: '12px', color: 'var(--ink3)', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Archived'));
      const g2 = h('div', { class: 'robots' }); for (const r of archived) g2.append(robotCard(r)); m.append(g2);
    }
  };
  function robotCard(r) {
    const t = r.totals, over = t.over_under, cls = r.weight_class_g;
    const miniBar = (best, sections, name) => budgetBar({ segments: sections || [], limit: cls, margin: r.margin_g, total: best, name, mini: true });
    const ouPill = (ou) => h('span', { class: 'pill ' + (ou > 0 ? 'bad' : 'good') }, ou > 0 ? `${fmt(ou)} g over` : `${fmt(-ou)} g under`);
    const cfgs = r.configs || [];
    const meta = [];
    meta.push(`${r.lines} line${r.lines === 1 ? '' : 's'}`);
    meta.push(`${r.printed_parts} printed part${r.printed_parts === 1 ? '' : 's'}${r.printed_parts ? ` · ${r.parts_with_mesh} with mesh` : ''}${r.parts_locked ? ` · ${r.parts_locked} locked` : ''}`);
    meta.push(`${Math.round(t.measured_fraction * 100)}% of mass measured · ${r.measured_lines} weighed`);
    if (r.price_total) meta.push(money(r.price_total) + ' in parts');
    const warn = [];
    if (t.flags) warn.push(h('span', { class: 'pill warn' }, `${t.flags} need re-weigh`));
    if (r.slice_errors) warn.push(h('span', { class: 'pill bad' }, `${r.slice_errors} slice error${r.slice_errors === 1 ? '' : 's'}`));
    if (r.printed_parts && r.parts_with_mesh < r.printed_parts) warn.push(h('span', { class: 'pill warn' }, `${r.printed_parts - r.parts_with_mesh} without mesh`));
    return h('div', { class: 'rcard' + (r.status === 'active' ? '' : ' archived'), role: 'button', tabindex: '0', onClick: async () => { await loadRobot(r.id); go('sheet'); }, onKeydown: async e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); await loadRobot(r.id); go('sheet'); } } },
      h('div', { class: 't' }, h('b', null, r.name), h('span', { class: 'cls' }, r.class_name ? `${r.class_name} · ${fmt(cls, 0)} g` : `${fmt(cls, 0)} g`)),
      cfgs.length ? h('div', { class: 'cfgs' }, ...cfgs.map(c => h('div', { class: 'cfgrow' + (c.active ? ' active' : ''), title: `${c.name}: ${fmt(c.best_known)} g best known, ${fmt(c.printed)} g printed${c.active ? ' · selected on the sheet' : ''}` },
          h('span', { class: 'n' }, c.name), h('span', { class: 'g mono' }, fmt(c.best_known), h('small', null, ' g')), ouPill(c.over_under), miniBar(c.best_known, c.sections, c.name))))
        : h('div', null, h('div', { class: 'g' }, fmt(t.best_known), h('small', null, ' g best known'), ' ', ouPill(over)), miniBar(t.best_known, r.sections_summary, r.name)),
      h('div', { class: 'meta' }, ...meta.map(x => h('span', null, x))),
      warn.length ? h('div', { class: 'meta' }, ...warn) : null,
      h('div', { class: 'meta foot' }, h('span', null, `Printed ${fmt(t.printed)} g · budget ${fmt(t.printed_budget)} g`), h('span', null, r.status === 'active' ? `updated ${dayStr(r.updated)}` : 'archived'), r.last_weigh_in && h('span', null, `last weigh-in ${dayStr(r.last_weigh_in)}`), r.last_optimize && h('span', null, `last optimizer run ${dayStr(r.last_optimize)}`)),
      h('div', { class: 'acts' }, h('button', { class: 'btn small', onClick: async e => { e.stopPropagation(); await loadRobot(r.id); go('sheet'); } }, 'Weight sheet'), h('button', { class: 'btn small', onClick: async e => { e.stopPropagation(); await loadRobot(r.id); go('parts'); } }, 'Printed parts'), h('button', { class: 'btn small', onClick: async e => { e.stopPropagation(); await loadRobot(r.id); go('optimizer'); } }, 'Optimizer')));
  }
  function newRobotModal(src) {
    const st = S.state;
    const name = input({ placeholder: 'e.g. Antweight v3', value: src ? src.name + ' v2' : '' });
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
    const inp = h('input', { type: 'file', accept: '.zip,.makeweight' });
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
        h('button', { class: 'btn', onClick: () => addLineModal() }, '＋ Line…'),
        h('button', { class: 'btn', onClick: () => fromLibraryModal() }, '＋ From library…'),
        h('button', { class: 'btn', onClick: () => addSectionModal() }, '＋ Section…'),
        h('button', { class: 'btn', onClick: robotWeighInModal }, 'Weigh-in…'),
        h('button', { class: 'btn', onClick: e => robotMenu(e.currentTarget) }, 'Robot ▾'),
        h('button', { class: 'btn primary', onClick: () => go('optimizer') }, 'Fix weight →'))));
    m.append(configBar(r));
    const over = t.over_under;
    m.append(h('div', { class: 'hdr' },
      stat('Best known', fmt(t.best_known), 'g', h('div', null, h('div', { class: 'sbar' }, h('i', { style: { width: (t.measured_fraction * 100) + '%', background: 'var(--good)' } }), h('i', { style: { flex: 1, background: 'var(--slate-soft)' } })), h('div', { class: 'hint', style: { marginTop: '4px' } }, `${Math.round(t.measured_fraction * 100)}% of mass measured`))),
      stat('Estimated only', fmt(t.estimated_only), 'g', h('div', { class: 'hint' }, 'if every line used its estimate')),
      stat('Over / under limit', signed(over), 'g', h('div', { class: 'hint' }, `${signed(t.over_under_margin)} g including ${fmt(r.margin_g)} g margin`), over > 0 ? 'over' : 'under'),
      stat('Printed parts', fmt(t.printed), `g · ${t.best_known ? Math.round(t.printed / t.best_known * 100) : 0}%`, h('div', { class: 'hint' }, `budget for printed parts: ${fmt(t.printed_budget)} g`)),
      stat('Flags', String(t.flags), '', h('div', { class: 'hint' }, 'need re-weigh'))));

    const tbl = h('table', { class: 'sheet', dataset: { tkey: 'sheet2' } }, h('thead', null, h('tr', null, h('th', { class: 'grip nosort' }, ''), h('th', { class: 'num qty' }, 'Qty'), h('th', null, 'Description'), h('th', null, 'Purpose / notes'), h('th', { class: 'num' }, 'Estimated'), h('th', { class: 'num' }, 'Measured'), h('th', { class: 'num' }, 'Best'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Price'), h('th', null, 'Status'), h('th', null, ''), h('th', null, ''))));
    const tb = h('tbody'); tbl.append(tb);
    for (const s of r.sections) {
      tb.append(h('tr', { class: 'sec-h', dataset: { key: 's' + s.id, sid: s.id } }, h('td', { class: 'grip' }, h('span', { class: 'dragh', title: 'Drag to move this section' }, '⋮⋮')), h('td', { colspan: 6 }, s.name, !s.counts && h('span', { class: 'off' }, 'not counted toward weigh-in')),
        h('td', { class: 'num' }, s.counts ? fmt(s.subtotal) : `(${fmt(s.subtotal)})`), h('td', { colspan: 3 }),
        h('td', null, h('button', { class: 'btn icon', title: 'Section menu', onClick: e => sectionMenu(e.currentTarget, s) }, '⋯'))));
      for (const it of s.items) tb.append(lineRow(it, s));
      tb.append(newLineRow(s));
    }
    tb.append(h('tr', { class: 'sum', dataset: { key: 'sum' } }, h('td'), h('td'), h('td', null, 'Weigh-in total'), h('td'), h('td', { class: 'num' }, fmt(t.estimated_only)), h('td'), h('td'), h('td', { class: 'num' }, fmt(t.best_known)), h('td', { class: 'num' }, money(r.sections.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.price || 0) * (i.qty || 0), 0), 0))), h('td', { colspan: 3 })));
    m.append(h('div', { class: 'tw' }, tbl));
    enableSheetDrag(tbl, r);
    m.append(h('p', { class: 'hint' }, 'Drag the ⋮⋮ handle to move a line (also into another section) or a whole section. Greyed-out lines are not in the weight total: they are excluded by hand (“not in total” — click the pill to include), not part of the selected configuration (click the pill to change), or in a section that does not count. Cells with a text cursor (and a ✎ on hover) edit in place — Enter saves, Esc cancels; buttons ending in “…” open a dialog. Red dot = needs re-weigh (set automatically when a profile, mesh or library weight changes after a measurement). Grey rows are excluded from the total (e.g. an assembly line supersedes them).'));
  };
  // ---- drag to rearrange: lines within/between sections, and whole sections. Native HTML5 drag from the ⋮⋮ handle; a
  // marker row shows where the drop lands; the new order is sent in one request (one undo step).
  function enableSheetDrag(tbl, r) {
    const tb = tbl.tBodies[0]; if (!tb) return;
    const marker = h('tr', { class: 'dropmark nosort' }, h('td', { colspan: 99 }));
    let dragging = null, block = null;      // block: the section's rows when a section header is dragged
    const rowsOf = secRow => { const out = [secRow]; for (let n = secRow.nextElementSibling; n && !n.classList.contains('sec-h') && !n.classList.contains('sum'); n = n.nextElementSibling) out.push(n); return out; };
    tb.addEventListener('mousedown', e => { const g = e.target.closest('.dragh'); if (!g) return; const tr = g.closest('tr'); tr.draggable = true; dragging = tr; });
    tb.addEventListener('dragstart', e => {
      if (!dragging) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragging.dataset.key);
      block = dragging.classList.contains('sec-h') ? rowsOf(dragging) : [dragging];
      setTimeout(() => block.forEach(x => x.classList.add('dragging')), 0);
    });
    tb.addEventListener('dragover', e => {
      if (!dragging) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const tr = e.target.closest('tr'); if (!tr || tr === marker || block.includes(tr)) return;
      const rect = tr.getBoundingClientRect(), lower = e.clientY > rect.top + rect.height / 2;
      if (dragging.classList.contains('sec-h')) {
        // sections only land on section boundaries: before the hovered section, or after the last one
        let target = tr.classList.contains('sec-h') ? tr : null;
        if (!target) { let n = tr; while (n && !n.classList.contains('sec-h')) n = n.previousElementSibling; target = lower ? (n ? rowsOf(n).at(-1).nextElementSibling : null) : n; }
        else if (lower) target = rowsOf(tr).at(-1).nextElementSibling;
        if (target) tb.insertBefore(marker, target); else tb.insertBefore(marker, tb.querySelector('tr.sum'));
        return;
      }
      if (tr.classList.contains('sum')) { tb.insertBefore(marker, tr); return; }
      if (tr.classList.contains('sec-h')) { if (lower || !tr.previousElementSibling) tb.insertBefore(marker, tr.nextElementSibling); else tb.insertBefore(marker, tr); return; }
      if (tr.classList.contains('new-row') && lower) { tb.insertBefore(marker, tr.nextElementSibling); return; }
      tb.insertBefore(marker, lower ? tr.nextElementSibling : tr);
    });
    tb.addEventListener('dragleave', e => { if (!tb.contains(e.relatedTarget)) marker.remove(); });
    const end = () => { marker.remove(); if (block) block.forEach(x => x.classList.remove('dragging')); if (dragging) dragging.draggable = false; dragging = null; block = null; };
    tb.addEventListener('dragend', end);
    tb.addEventListener('drop', async e => {
      e.preventDefault();
      if (!dragging || !marker.parentNode) { end(); return; }
      const moving = block.slice();
      for (const x of moving) tb.insertBefore(x, marker);
      marker.remove();
      // read the new order back from the DOM
      const items = [], sections = []; let sec = null, ord = 0, sord = 0;
      for (const row of tb.rows) {
        if (row.classList.contains('sec-h')) { sec = +row.dataset.sid; sections.push({ id: sec, ord: sord++ }); ord = 0; continue; }
        if (row.dataset.iid && sec != null) items.push({ id: +row.dataset.iid, section_id: sec, ord: ord++ });
      }
      // only what changed
      const before = {}; (S.robot || r).sections.forEach((s, si) => { s.items.forEach((it, i) => { before['i' + it.id] = `${s.id}/${i}`; }); before['s' + s.id] = String(si); });
      const body = { items: items.filter(x => before['i' + x.id] !== `${x.section_id}/${x.ord}`), sections: sections.filter(x => before['s' + x.id] !== String(x.ord)) };
      end();
      if (!body.items.length && !body.sections.length) return;
      try { await api('POST', `robots/${S.robotId || r.id}/reorder`, body, { label: 'rearrange lines' }); await refreshRobot(); } catch (err) { fail(err); }
    });
  }
  // ---- configurations (loadouts): the same robot with different armour / weapon for different opponents
  const cfgName = (r, id) => ((r.configs || []).find(c => c.id === id) || {}).name || '?';
  async function setActiveConfig(id) { await api('PUT', `robots/${S.robotId}`, { active_config: id }, { label: 'switch configuration' }); await refreshRobot(); }
  function configBar(r) {
    const cfgs = r.configs || [];
    const bar = h('div', { class: 'cfgbar' });
    if (!cfgs.length) {
      bar.append(h('span', { class: 'rng' }, 'One configuration. '), h('button', { class: 'btn small', title: 'Set up loadouts — e.g. “standard” and “vs horizontal spinner” with a wedge — and pick which lines belong to which', onClick: () => configsModal(r) }, 'Configurations…'));
      return bar;
    }
    const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Configuration' });
    for (const c of cfgs) seg.append(h('button', { role: 'tab', 'aria-pressed': String(c.id === r.active_config), 'aria-selected': String(c.id === r.active_config), onClick: () => c.id !== r.active_config && setActiveConfig(c.id).catch(fail) }, c.name));
    const nOut = r.sections.reduce((a, s) => a + s.items.filter(i => !i.in_config).length, 0);
    bar.append(h('span', { class: 'rng' }, 'Configuration'), seg,
      ...(nOut ? [h('span', { class: 'rng' }, `${nOut} line${nOut === 1 ? '' : 's'} not in this one (greyed out)`)] : []),
      h('button', { class: 'btn small', style: { marginLeft: 'auto' }, onClick: () => configsModal(r) }, 'Configurations…'));
    return bar;
  }
  function configsModal(r) {
    let cfgs = (r.configs || []).map(c => ({ ...c }));
    const list = h('div');
    const draw = () => {
      list.textContent = '';
      if (!cfgs.length) list.append(h('p', { class: 'hint' }, 'No configurations yet. Add two — the first one becomes what every line is in today; then mark the lines that belong to only one of them.'));
      for (const c of cfgs) {
        const name = input({ value: c.name, placeholder: 'e.g. vs horizontal spinner' }); name.addEventListener('input', () => { c.name = name.value; });
        list.append(h('div', { class: 'tb', style: { marginBottom: '6px' } }, name,
          h('button', { class: 'btn small', title: 'Copy: every line in this configuration is also in the copy', onClick: () => { cfgs.push({ name: c.name + ' copy', _copyOf: c.id }); draw(); } }, 'Duplicate'),
          h('button', { class: 'btn icon del', title: 'Remove this configuration (lines only in it stay on the sheet, marked “in no configuration”)', onClick: () => { cfgs = cfgs.filter(x => x !== c); draw(); } }, '✕')));
      }
      list.append(h('button', { class: 'btn small', onClick: () => { cfgs.push({ name: cfgs.length ? '' : 'Standard' }); draw(); if (!cfgs.length || cfgs.length === 1) cfgs.push({ name: '' }); draw(); const ins = list.querySelectorAll('input'); if (ins.length) ins[ins.length - 1].focus(); } }, '＋ Add configuration'));
    };
    draw();
    modal('Configurations', h('div', null,
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'A configuration is a loadout of the same robot — standard, vs horizontal spinner with a wedge, vs flipper… Shared lines are in every configuration; use a line’s ⋯ menu to put it in only some of them. The weight total, the budget bar and the optimizer follow the configuration selected on the sheet.'),
      list),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        const clean = cfgs.filter(c => (c.name || '').trim());
        if (clean.length === 1) { toast('Add at least two configurations (or none)', true); return false; }
        const res = await api('PUT', `robots/${S.robotId}`, { configs: clean.map(c => ({ id: c.id, name: c.name.trim() })) }, { label: 'edit configurations' });
        // duplicates: copy the source configuration's membership onto the new id
        const copies = clean.filter(c => c._copyOf);
        if (copies.length) {
          const byName = Object.fromEntries((res.configs || []).map(c => [c.name, c.id]));
          for (const cp of copies) {
            const newId = byName[cp.name.trim()]; if (!newId) continue;
            for (const s of res.sections) for (const it of s.items) if (Array.isArray(it.configs) && it.configs.includes(cp._copyOf) && !it.configs.includes(newId)) await api('PUT', `items/${it.id}`, { configs: [...it.configs, newId] });
          }
        }
        await refreshRobot(); await loadState();
      } }], { width: '560px' });
  }
  function itemConfigsModal(it) {
    const r = S.robot, cfgs = r.configs || [];
    if (!cfgs.length) return configsModal(r);
    const all = h('input', { type: 'radio', name: 'cfgmode', checked: it.configs === null });
    const some = h('input', { type: 'radio', name: 'cfgmode', checked: it.configs !== null });
    const boxes = cfgs.map(c => ({ c, box: h('input', { type: 'checkbox', checked: Array.isArray(it.configs) ? it.configs.includes(c.id) : true }) }));
    const sync = () => boxes.forEach(b => { b.box.disabled = all.checked; });
    all.addEventListener('change', sync); some.addEventListener('change', sync); sync();
    modal(`Configurations · ${it.description}`, h('div', null,
      field('', h('label', null, all, ' In every configuration (shared part)')),
      field('', h('label', null, some, ' Only in:')),
      h('div', { style: { marginLeft: '24px' } }, ...boxes.map(b => h('label', { style: { display: 'block', margin: '4px 0' } }, b.box, ' ', b.c.name)))),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        const configs = all.checked ? null : boxes.filter(b => b.box.checked).map(b => b.c.id);
        await api('PUT', `items/${it.id}`, { configs }, { label: `configurations of “${it.description}”` });
        await refreshRobot();
      } }]);
  }
  function cfgChip(it, r) {
    // which loadouts a line belongs to, when it is not simply shared; click = edit
    if (it.configs === null || !(r.configs || []).length) return null;
    const names = it.configs.map(id => cfgName(r, id));
    const txt = !names.length ? 'in no configuration' : names.length === r.configs.length ? 'every configuration' : names.join(' · ');
    return h('button', { class: 'pill cfg ' + (it.in_config ? 'ok' : 'warn'), title: (it.in_config ? 'In this configuration. ' : 'Not in the selected configuration — not counted. ') + 'Click to change which configurations this line is in', onClick: e => { e.stopPropagation(); itemConfigsModal(it); } }, txt);
  }
  function stat(label, value, unit, extra, cls) { return h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value, unit && h('small', null, unit)), extra); }
  function needRobot(m) { m.append(h('div', { class: 'empty' }, 'Choose a robot first.', h('br'), h('button', { class: 'btn primary', style: { marginTop: '10px' }, onClick: () => go('home') }, 'All robots'))); }

  function lineRow(it, s) {
    const upd = (patch) => api('PUT', `items/${it.id}`, patch).then(refreshRobot);
    const p = it.part;
    const r = S.robot;
    const tr = h('tr', { class: (!it.in_total && s.counts ? 'dim ' : '') + (p && p.locked ? 'locked' : ''), dataset: { key: 'i' + it.id, iid: it.id } });
    tr.append(h('td', { class: 'grip' }, h('span', { class: 'dragh', title: 'Drag to move this line' }, '⋮⋮')));
    tr.append(edCell(it.qty, v => upd({ qty: v }), { type: 'number', cls: 'num qty', fmt: v => Number(v) % 1 ? v : String(v) }));
    // description
    const descCell = edCell(it.description, v => upd({ description: v }), { render: v => h('span', null, v || h('i', { style: { color: 'var(--ink3)' } }, 'untitled'), p && p.locked && h('span', { class: 'pill lock', style: { marginLeft: '6px' } }, '🔒'),
      !it.counted && h('button', { class: 'pill cfg warn', title: 'Excluded from the total by hand — click to include it again', onClick: e => { e.stopPropagation(); upd({ counted: true }).catch(fail); } }, 'not in total'), cfgChip(it, r), p && h('span', { class: 'sub' }, p.mesh ? `${p.mesh.filename} · ${p.filament ? p.filament.name : ''}` : 'printed part · no mesh attached', p.role ? ` · ${p.role}` : '')) });
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
    tr.append(h('td', { class: 'num ed dlg', title: 'Add a weigh-in…', onClick: () => weighInModal(it) }, it.measured_grams != null ? fmt(it.measured_grams) : h('span', { style: { color: 'var(--ink3)' } }, '—'), it.weigh_ins.length > 1 && h('span', { class: 'src' }, `×${it.weigh_ins.length}`)));
    tr.append(h('td', { class: 'num' }, fmt(it.best_grams)));
    tr.append(h('td', { class: 'num', style: { fontWeight: 600 } }, fmt(it.total_grams)));
    tr.append(edCell(it.price, v => upd({ price: v }), { type: 'number', cls: 'num', fmt: v => Number(v).toFixed(2), placeholder: '' }));
    tr.append(h('td', null, select(STATUSES, it.status || '', { class: 'bare', 'aria-label': 'Status', title: 'Status', onChange: e => { e.target.blur(); upd({ status: e.target.value || null }).catch(fail); } })));
    tr.append(h('td', null, h('span', { class: 'flag ' + (it.needs_reweigh ? '' : (it.measured_grams != null ? 'ok' : 'none')), title: it.needs_reweigh ? 'Needs re-weigh: changed since it was measured' : (it.measured_grams != null ? 'Measured' : 'Not measured') })));
    tr.append(h('td', { class: 'acts' },
      h('button', { class: 'btn icon', title: 'More actions for this line', 'aria-label': 'Line menu', onClick: e => lineMenu(e.currentTarget, it, s) }, '⋯'),
      h('button', { class: 'btn icon del', title: 'Delete line (undo with Ctrl/⌘+Z)', 'aria-label': 'Delete line', onClick: async () => { try { await api('DELETE', `items/${it.id}`); await refreshRobot(); toastUndo(`Deleted “${it.description || 'line'}”`); } catch (e) { fail(e); } } }, '✕')));
    return tr;
  }
  // the always-present empty row at the end of a section: type a description, press Enter (or Tab) and it becomes a line
  function newLineRow(s) {
    const qty = h('input', { type: 'number', value: 1, min: 0, step: 'any', class: 'num ghost-in', 'aria-label': `Quantity for a new line in ${s.name}` });
    const desc = h('input', { type: 'text', placeholder: `Add a line to ${s.name}…`, class: 'ghost-in', 'aria-label': `New line in ${s.name}` });
    const est = h('input', { type: 'number', placeholder: 'g', step: 'any', class: 'num ghost-in', 'aria-label': 'Estimated grams' });
    let busy = false;
    const commit = async (focusNext) => {
      const d = desc.value.trim(); if (!d || busy) return; busy = true;
      try {
        await api('POST', `sections/${s.id}/items`, { description: d, qty: parseFloat(qty.value) || 1, est_grams: est.value === '' ? null : parseFloat(est.value) }, { label: `add “${d}”` });
        S.cache.focusNewLine = focusNext ? s.id : null;
        await refreshRobot();
      } catch (e) { busy = false; fail(e); }
    };
    for (const inp of [qty, desc, est]) {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { desc.value = ''; est.value = ''; qty.value = 1; inp.blur(); } });
    }
    desc.addEventListener('blur', () => setTimeout(() => { if (!tr.contains(document.activeElement)) commit(false); }, 120));
    est.addEventListener('blur', () => setTimeout(() => { if (!tr.contains(document.activeElement)) commit(false); }, 120));
    const tr = h('tr', { class: 'new-row nosort', dataset: { key: 'n' + s.id, sid: s.id } },
      h('td', { class: 'grip' }), h('td', { class: 'num qty' }, qty), h('td', null, desc), h('td', { class: 'wrap' }), h('td', { class: 'num' }, est),
      h('td', { colspan: 6, class: 'rng' }, 'Enter adds the line · more fields via ⋯ after adding'),
      h('td', { class: 'acts' }, h('button', { class: 'btn icon', title: 'Add with all fields…', 'aria-label': 'Add a line with all fields', onClick: () => addLineModal(s.id) }, '⋯')));
    if (S.cache.focusNewLine === s.id) { S.cache.focusNewLine = null; setTimeout(() => desc.focus(), 30); }
    return tr;
  }
  function lineMenu(anchor, it, s) {
    const r = S.robot, items = [];
    if (it.part) items.push({ label: 'Open part detail', onClick: () => go('part', it.part.id) });
    else items.push({ label: 'Attach a mesh (make this a printed part)…', onClick: () => attachMeshModal(it) });
    items.push({ label: 'Add weigh-in…', onClick: () => weighInModal(it) });
    if (it.weigh_ins.length) items.push({ label: 'Weigh-in history…', onClick: () => weighHistoryModal(it) });
    items.push({ label: it.counted ? 'Exclude from total (keep on sheet)' : 'Include in total', onClick: () => api('PUT', `items/${it.id}`, { counted: !it.counted }).then(refreshRobot).catch(fail) });
    if ((r.configs || []).length) {
      const act = r.active_config, inAct = it.configs === null || (it.configs || []).includes(act);
      items.push({ label: 'Configurations…', onClick: () => itemConfigsModal(it) });
      if (it.configs === null) items.push({ label: `Only in “${cfgName(r, act)}”`, onClick: () => api('PUT', `items/${it.id}`, { configs: [act] }).then(refreshRobot).catch(fail) });
      else if (!inAct) items.push({ label: `Add to “${cfgName(r, act)}”`, onClick: () => api('PUT', `items/${it.id}`, { configs: [...it.configs, act] }).then(refreshRobot).catch(fail) });
      else items.push({ label: 'In every configuration', onClick: () => api('PUT', `items/${it.id}`, { configs: null }).then(refreshRobot).catch(fail) });
    } else items.push({ label: 'Configurations (loadouts)…', onClick: () => configsModal(r) });
    items.push({ label: it.to_buy ? 'Unmark “to buy”' : 'Mark “to buy”', onClick: () => api('PUT', `items/${it.id}`, { to_buy: !it.to_buy }).then(refreshRobot).catch(fail) });
    if (it.needs_reweigh) items.push({ label: 'Clear re-weigh flag', onClick: () => api('PUT', `items/${it.id}`, { needs_reweigh: 0 }).then(refreshRobot).catch(fail) });
    items.push({ label: 'Edit link / dimensions / notes…', onClick: () => editLineModal(it) });
    items.push('-');
    items.push({ label: 'Move to section ▸', onClick: () => modal('Move to section', select(r.sections.map(x => [x.id, x.name]), s.id, { id: 'mv-sec' }), [{ label: 'Cancel' }, { label: 'Move', cls: 'primary', onClick: async () => { await api('POST', `items/${it.id}/move`, { section_id: +$('#mv-sec').value }); await refreshRobot(); } }]) });
    if (!it.part) items.push({ label: 'Save to library as component', onClick: async () => { await api('POST', 'components', { name: it.description, category: s.name, link: it.link, price: it.price, dimensions: it.dimensions, grams: it.measured_grams ?? it.est_grams, grams_source: it.measured_grams != null ? 'measured' : 'manual' }); toast('Added to library'); } });
    items.push('-', { label: 'Delete line', cls: 'danger', onClick: async () => { try { await api('DELETE', `items/${it.id}`); await refreshRobot(); toastUndo(`Deleted “${it.description || 'line'}”`); } catch (e) { fail(e); } } });
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
    const p = it.part, st = S.state;
    // printed parts: say which profile the print on the scale was really sliced with — it may not be the one on the sheet
    let prof = null, setPart = null, profHint = null;
    if (p) {
      const cur = p.profile ? p.profile.id : null;
      prof = select(st.profiles.map(x => [x.id, `${x.name} — ${x.string}${x.id === cur ? '  (on the sheet now)' : ''}`]), cur, { class: 'w' });
      setPart = h('input', { type: 'checkbox', checked: true });
      const setRow = field('', h('label', null, setPart, ' also make it the part’s profile on the sheet (that is what was printed)'));
      profHint = h('p', { class: 'hint' });
      const upd = () => { const same = String(prof.value) === String(cur); setRow.hidden = same; profHint.textContent = same ? (p.slice && p.slice.grams != null ? `Slicer says ${fmt(p.slice.grams, 2)} g for this profile. The weigh-in feeds the ${p.filament ? p.filament.name : ''} correction factor.` : '') : `Recorded against that profile instead of the sheet’s; if it has not been sliced yet, it is queued now so the correction factor can use it.`; };
      prof.addEventListener('change', upd); upd();
      var profRows = [field('Printed with', prof), setRow, profHint];
    }
    modal(`Weigh-in · ${it.description}`, h('div', null, field('Measured (g)', g), field('Date', d), field('Note', note), ...(profRows || []), lib && field('Update library', h('label', null, lib, ' also update the library component')),
      it.weigh_ins.length ? h('p', { class: 'hint' }, `${it.weigh_ins.length} earlier weigh-in${it.weigh_ins.length > 1 ? 's' : ''} · `, h('a', { href: '#', onClick: e => { e.preventDefault(); weighHistoryModal(it); } }, 'history…')) : null),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        if (g.value === '') return false;
        const body = { grams: parseFloat(g.value), date: d.value, note: note.value || null, update_library: lib ? lib.checked : false };
        if (prof) { body.profile_id = +prof.value; body.set_part_profile = setPart.checked; }
        await api('POST', `items/${it.id}/weighins`, body); await refreshRobot(); await loadState();
      } }], { width: p ? '620px' : undefined });
  }
  function weighHistoryModal(it) {
    // every field of every weigh-in is editable in place; the filament correction is recomputed after each change
    const st = S.state, p = it.part;
    const reload = async () => { await refreshRobot(); await loadState(); const fresh = S.robot.sections.flatMap(s => s.items).find(x => x.id === it.id); it = fresh || it; draw(); };
    const save = async (w, patch) => { try { await api('PUT', `weighins/${w.id}`, patch); await reload(); } catch (e) { fail(e); } };
    const wrap = h('div', { class: 'tw' });
    const draw = () => {
      wrap.textContent = '';
      const tbl = h('table', { class: 'nores' }, h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num' }, 'Grams'), p && h('th', null, 'Printed with'), p && h('th', { class: 'num', title: 'What the slicer said for that profile (uncorrected)' }, 'Sliced'), p && h('th', { class: 'num', title: 'measured ÷ sliced' }, 'Ratio'), h('th', null, 'Note'), h('th'))));
      const tb = h('tbody'); tbl.append(tb);
      for (const w of [...it.weigh_ins].reverse()) {
        const tr = h('tr');
        tr.append(edCell(w.date || '', v => save(w, { date: v }), { type: 'date', cls: 'mono' }));
        tr.append(edCell(w.grams, v => save(w, { grams: v }), { type: 'number', cls: 'num', fmt: v => fmt(v, 2), step: '0.01' }));
        if (p) {
          const opts = [['', w.profile_string ? `(as recorded: ${w.profile_string})` : '(not recorded)'], ...st.profiles.map(x => [x.id, `${x.name} — ${x.string}`])];
          tr.append(h('td', null, select(opts, w.profile_id || '', { class: 'bare', style: { maxWidth: '260px' }, title: 'The profile this print was sliced with', onChange: e => save(w, { profile_id: e.target.value ? +e.target.value : null }) })));
          tr.append(h('td', { class: 'num' }, w.sliced_grams != null ? fmt(w.sliced_grams, 2) : h('span', { class: 'rng', title: w.profile_id ? 'not sliced yet — queued' : 'no profile recorded' }, w.profile_id ? 'slicing…' : '—')));
          tr.append(h('td', { class: 'num' }, w.sliced_grams ? (w.grams / w.sliced_grams).toFixed(3) : ''));
        }
        tr.append(edCell(w.note || '', v => save(w, { note: v }), { placeholder: '', cls: 'wrap' }));
        tr.append(h('td', { class: 'acts' }, h('button', { class: 'btn icon del', title: 'Delete this weigh-in', onClick: async () => { try { await api('DELETE', `weighins/${w.id}`); await reload(); } catch (e) { fail(e); } } }, '✕')));
        tb.append(tr);
      }
      if (!it.weigh_ins.length) tb.append(h('tr', null, h('td', { colspan: 7, class: 'rng' }, 'No weigh-ins.')));
      wrap.append(tbl);
    };
    draw();
    modal(`Weigh-ins · ${it.description}`, h('div', null, wrap,
      h('p', { class: 'hint' }, 'The newest weigh-in is the line’s measured weight. Click a date, weight or note to edit it; change “Printed with” when a print was sliced with another profile than the sheet showed — the filament correction factor uses the slice of the profile named here.')),
      [{ label: '＋ Add weigh-in…', onClick: () => { weighInModal(it); } }, { label: 'Close' }], { width: p ? '900px' : '640px' });
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
      for (const c of comps.filter(c => !q || (c.name + ' ' + (c.category || '') + ' ' + (c.part_number || '') + ' ' + fastenerSpecText(c.specs)).toLowerCase().includes(q)).slice(0, 200)) {
        tb.append(h('tr', { class: chosen === c ? 'sel' : '', style: { cursor: 'pointer' }, onClick: () => { chosen = c; draw(); } }, h('td', null, c.name, h('span', { class: 'sub' }, [c.category, c.part_number, c.kind === 'fastener' ? fastenerSpecText(c.specs) : ''].filter(Boolean).join(' · '))), h('td', { class: 'num' }, fmt(c.grams, 2)), h('td', null, h('span', { class: 'pill ' + (c.grams_source === 'measured' ? 'mea' : c.grams_source === 'estimated' ? 'est' : 'auto') }, c.grams_source || '')), h('td', { class: 'num' }, money(c.price))));
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
        await refreshRobot(); if (S.view === 'part') await renderMain(); toast('Mesh attached; slicing…');
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
      h('div', { class: 'tb' }, h('button', { class: 'btn', title: 'STL, OBJ, PLY or a 3MF project — one file per part, or your whole robot in one file. Every body can become a new part, replace an existing part’s mesh, or be skipped.', onClick: () => pickFiles() }, '＋ Add / update parts from files…'),
        h('button', { class: 'btn', onClick: () => applyProfileModal(parts) }, 'Apply profile to all ▾'),
        h('button', { class: 'btn', onClick: async () => { await api('POST', `robots/${r.id}/slice_all`); toast('Re-slicing all parts'); await refreshRobot(); } }, 'Re-slice all'),
        h('button', { class: 'btn primary', onClick: () => go('optimizer') }, 'Optimize →'))));
    const drop = h('div', { class: 'drop' }, 'Drop STL, OBJ, PLY or 3MF files here — one part per file, or your whole robot exported as one file. A dialog lets you say, body by body, what becomes a new part, what replaces an existing part’s mesh, and what to skip. Objects from a Bambu Studio or PrusaSlicer .3mf bring their own walls/infill settings.');
    m.append(drop); setupDrop(m, drop);
    const tbl = h('table', { dataset: { tkey: 'parts' } }, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', { class: 'num' }, 'Qty'), h('th', null, 'Filament'), h('th', null, 'Orientation'), h('th', null, 'Profile'), h('th', null, 'Role'), h('th', { class: 'num' }, 'Slicer g'), h('th', { class: 'num' }, '× corr.'), h('th', { class: 'num' }, 'Measured'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Print time'), h('th', { class: 'num' }, 'Cost'), h('th', null, 'Status'), h('th'))));
    const tb = h('tbody'); tbl.append(tb);
    let tot = 0, totC = 0, totBest = 0, totTime = 0, totCost = 0;
    for (const { it, p } of parts) {
      const j = p.slice; const g = j && j.status === 'done' ? j.grams : null;
      if (g != null) { tot += g * it.qty; totC += (p.corrected_grams ?? g) * it.qty; } totBest += it.total_grams;
      const ptime = j && j.status === 'done' && j.print_time_s ? j.print_time_s * it.qty : null; if (ptime) totTime += ptime;
      const cost = g != null && p.filament && p.filament.cost_per_kg ? g / 1000 * p.filament.cost_per_kg * it.qty : null; if (cost) totCost += cost;
      const upd = (patch) => api('PUT', `parts/${p.id}`, patch).then(refreshRobot).catch(fail);
      tb.append(h('tr', { class: p.locked ? 'locked' : '', dataset: { key: 'p' + p.id } },
        h('td', null, h('div', { class: 'partcell' }, p.mesh ? h('img', { class: 'thumb sm', src: `/api/meshes/${p.mesh.id}/thumb.png`, alt: '', loading: 'lazy' }) : null, h('div', null, h('a', { href: '#/part/' + p.id, style: { color: 'inherit', fontWeight: 600, textDecoration: 'none' } }, it.description), h('span', { class: 'sub' }, p.mesh ? `${p.mesh.filename} · ${p.mesh.bbox ? p.mesh.bbox.size.map(v => v.toFixed(0)).join('×') + ' mm' : ''} · ${(p.mesh.volume_mm3 / 1000).toFixed(2)} cm³` : h('span', { style: { color: 'var(--warn)' } }, 'no mesh attached'))))),
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
        h('td', { class: 'acts' }, h('button', { class: 'btn icon', title: 'More actions', 'aria-label': 'Part menu', onClick: e => partMenu(e.currentTarget, it, p) }, '⋯'),
          h('button', { class: 'btn icon del', title: 'Delete part and its sheet line (undo with Ctrl/⌘+Z)', 'aria-label': 'Delete part', onClick: async () => { try { await api('DELETE', `parts/${p.id}`); await refreshRobot(); toastUndo(`Deleted “${it.description}”`); } catch (e) { fail(e); } } }, '✕'))));
    }
    tb.append(h('tr', { class: 'sum', dataset: { key: 'sum' } }, h('td', null, 'Printed total'), h('td', { class: 'num' }, parts.reduce((a, x) => a + x.it.qty, 0)), h('td', { colspan: 4 }), h('td', { class: 'num' }, fmt(tot)), h('td', { class: 'num' }, fmt(totC)), h('td'), h('td', { class: 'num' }, fmt(totBest)), h('td', { class: 'num' }, totTime ? hms(totTime) : ''), h('td', { class: 'num' }, totCost ? '$' + totCost.toFixed(2) : ''), h('td', { colspan: 2 })));
    m.append(h('div', { class: 'tw' }, tbl));
    if (!parts.length) m.append(h('p', { class: 'empty' }, 'No printed parts yet. Drop STL files above.'));
    m.append(h('p', { class: 'hint' }, '“× corr.” is the slicer figure times this filament’s scale-derived correction. “Total” uses your measured weight where you have one, otherwise the corrected slicer estimate.'));
  };
  function filChip(f) { return f ? h('span', { class: 'mat' }, h('i', { style: { background: f.color || '#888' } }), f.name) : '—'; }
  function jobPill(j, p) {
    if (!p.mesh) return h('button', { class: 'btn small', onClick: () => attachMeshModal({ id: p.line_item_id, part: p }) }, 'Attach mesh…');
    if (!j) return h('span', { class: 'pill auto' }, 'not sliced');
    if (j.status === 'done') return h('span', { class: 'pill ver', title: `sliced with ${(j.slicer_version || '').startsWith('bambu-') ? 'Bambu Studio ' + j.slicer_version.slice(6) : 'PrusaSlicer ' + (j.slicer_version || '')}` }, j.time_s ? `sliced ${secs(j.time_s)}` : 'cached');
    if (j.status === 'running') return h('span', { class: 'pill warn' }, 'slicing…');
    if (j.status === 'queued') return h('span', { class: 'pill warn' }, 'queued');
    if (j.status === 'error') return h('span', { class: 'pill bad', title: j.error }, 'error');
    return h('span', { class: 'pill auto' }, j.status);
  }
  function renameModal(it) {
    const name = input({ value: it.description || '' });
    modal('Rename part', field('Name', name), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
      const v = name.value.trim(); if (!v) return false;
      await api('PUT', `items/${it.id}`, { description: v }, { label: `rename “${it.description}”` });
      await refreshRobot(); if (S.view === 'part') await renderMain();
    } }]);
    setTimeout(() => { name.focus(); name.select(); }, 30);
  }
  function partMenu(anchor, it, p) {
    menu(anchor, [
      { label: 'Open part detail', onClick: () => go('part', p.id) },
      { label: 'Rename…', onClick: () => renameModal(it) },
      { label: p.locked ? 'Unlock' : 'Lock (profile + orientation + filament)', onClick: () => api('PUT', `parts/${p.id}`, { locked: !p.locked }).then(refreshRobot).catch(fail) },
      { label: 'Re-slice', onClick: () => api('POST', `parts/${p.id}/slice`, { purpose: 'current', priority: 2 }).then(refreshRobot).catch(fail) },
      { label: 'Add weigh-in…', onClick: () => weighInModal(it) },
      { label: p.mesh ? 'Replace mesh…' : 'Attach mesh…', onClick: () => attachMeshModal(it) },
      { label: 'Make a mirrored copy', onClick: () => api('POST', `parts/${p.id}/mirror_copy`, {}).then(refreshRobot).catch(fail) },
      '-', { label: 'Delete part and line', cls: 'danger', onClick: async () => { try { await api('DELETE', `parts/${p.id}`); await refreshRobot(); toastUndo(`Deleted “${it.description}”`); } catch (e) { fail(e); } } },
    ]);
  }
  function applyProfileModal(parts) {
    const st = S.state, sel = select(st.profiles.map(x => [x.id, `${x.name} — ${x.string}`]), st.settings.default_profile_id);
    const fil = select([['', '(keep filament)'], ...st.filaments.map(f => [f.id, f.name])], '');
    modal('Apply to all unlocked parts', h('div', null, field('Profile', sel), field('Filament', fil), h('p', { class: 'hint' }, `${parts.filter(x => !x.p.locked).length} unlocked parts will be re-sliced.`)),
      [{ label: 'Cancel' }, { label: 'Apply', cls: 'primary', onClick: async () => { for (const { p } of parts) if (!p.locked) { const patch = { profile_id: +sel.value }; if (fil.value) patch.filament_id = +fil.value; await api('PUT', `parts/${p.id}`, patch); } await refreshRobot(); } }]);
  }
  function pickFiles(opts = {}) {
    const inp = h('input', { type: 'file', multiple: true, accept: '.stl,.obj,.3mf,.ply' });
    inp.addEventListener('change', () => uploadFiles([...inp.files], opts)); inp.click();
  }
  function setupDrop(area, drop) {
    const on = e => { e.preventDefault(); drop.classList.add('over'); }, off = () => drop.classList.remove('over');
    area.addEventListener('dragover', on); area.addEventListener('dragleave', off);
    area.addEventListener('drop', e => { e.preventDefault(); off(); uploadFiles([...e.dataTransfer.files]); });
  }
  // Files dropped on Printed parts or chosen with "Add / update parts from files…". Every body — one per file, one per
  // connected solid of a multi-body STL, one per object of a 3MF — goes through the same dialog: new part, replace an
  // existing part's mesh, or skip, with the likely matches pre-selected. 3MF objects bring their slicer settings along
  // for new parts.
  async function uploadFiles(files, opts = {}) {
    if (!S.robotId) return toast('Choose a robot first', true);
    const bodies = [];   // meshes to assign
    for (const f of files) {
      try {
        toast(`Uploading ${f.name}…`);
        const res = await api('POST', 'meshes?split=1', await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } });
        const many = res.meshes.length > 1;
        for (const mesh of res.meshes) {
          const name = mesh.body_name || (many ? mesh.filename.replace(/\.stl$/i, '') : f.name.replace(/\.(stl|obj|3mf|ply)$/i, ''));
          bodies.push({ mesh, name, file: f.name, many });
        }
      } catch (e) { fail(e); }
    }
    if (!bodies.length) { await refreshRobot(); await loadState(); return; }
    return assignMeshesModal(bodies);
  }
  async function assignMeshesModal(bodies) {
    let matches = { matches: [], parts: [] };
    try { matches = await api('POST', `robots/${S.robotId}/mesh_matches`, { mesh_ids: bodies.map(b => b.mesh.id) }); } catch (e) { fail(e); }
    const sug = Object.fromEntries(matches.matches.map(m => [m.mesh_id, m.suggested]));
    const parts = (S.robot || { sections: [] }).sections.flatMap(s => s.items.filter(i => i.part).map(i => ({ id: i.part.id, description: i.description, mesh: i.part.mesh })));
    // one real 3D viewer for the whole dialog: click any picture to load that mesh into it (drag to orbit, wheel to zoom)
    const canvas = h('canvas', { class: 'inspect', width: 600, height: 300 });
    const inspectLbl = h('span', { class: 'sub' }, 'Click a picture to inspect it here — drag to orbit, wheel to zoom, right-drag to pan');
    let inspector = null;
    const inspect = async (mid, title, el) => {
      if (!mid) return;
      try {
        if (!inspector) inspector = new STLViewer(canvas, {});
        inspectLbl.textContent = `Loading ${title}…`;
        const buf = await (await fetch(`/api/meshes/${mid}/stl?lod=1`)).arrayBuffer();
        inspector.load(buf); inspectLbl.textContent = title;
        document.querySelectorAll('.modal .thumb.active').forEach(x => x.classList.remove('active')); if (el) el.classList.add('active');
      } catch (e) { inspectLbl.textContent = 'Could not load that mesh: ' + e.message; }
    };
    const thumb = (mid, title) => {
      if (!mid) return h('div', { class: 'thumb empty' }, 'no mesh');
      const img = h('img', { class: 'thumb clickable', src: `/api/meshes/${mid}/thumb.png`, alt: title || '', title: (title || '') + ' — click to inspect', loading: 'lazy' });
      img.addEventListener('click', () => inspect(mid, title, img));
      return img;
    };
    const cm3 = m => m ? (m.volume_mm3 / 1000).toFixed(1) + ' cm³' : 'no mesh yet';
    const counter = h('span', { class: 'rng' });
    const rows = bodies.map(b => {
      const sg = sug[b.mesh.id];
      const imp = b.mesh.import;   // 3MF object: its slicer settings
      const sel = h('select', { class: 'assign', 'aria-label': `Assign ${b.name}` },
        h('option', { value: 'new' }, `＋ New part “${b.name}”${imp ? ` · ${imp.profile_string}` : ''}`),
        ...parts.map(pt => h('option', { value: String(pt.id) }, `Replace mesh of: ${pt.description} · ${cm3(pt.mesh)}`)));
      const row = { b, sel, skip: false };
      sel.value = sg && sg.why !== 'identical file' ? String(sg.part_id) : 'new';
      if (sg && sg.why === 'identical file') row.skip = true;
      const why = sg ? h('span', { class: 'pill ' + (sg.score >= 0.9 ? 'good' : 'warn'), title: sg.why }, sg.why === 'identical file' ? 'unchanged' : sg.score >= 0.9 ? 'match' : 'likely') : h('span', { class: 'pill auto' }, 'new');
      // right-hand picture: what the chosen part looks like today, so a wrong guess is obvious before Apply
      const target = h('div', { class: 'thumbcell' });
      const drawTarget = () => {
        target.textContent = '';
        if (row.skip) { target.append(h('span', { class: 'sub' }, 'skipped — nothing happens to this body')); return; }
        const pt = parts.find(x => String(x.id) === sel.value);
        if (pt) target.append(thumb(pt.mesh && pt.mesh.id, pt.description), h('span', { class: 'sub' }, pt.description, ' · ', cm3(pt.mesh)));
        else target.append(h('span', { class: 'sub' }, 'becomes a new part', imp ? h('span', { class: 'sub' }, `profile from the 3MF: ${imp.profile_string}`) : null));
      };
      const skipBtn = h('button', { class: 'btn small skip', 'aria-pressed': 'false', title: 'Leave this body out (one click; click again to include it)' }, 'Skip');
      const tr = h('tr');
      const sync = () => { tr.classList.toggle('skipped', row.skip); skipBtn.setAttribute('aria-pressed', String(row.skip)); skipBtn.textContent = row.skip ? 'Skipped' : 'Skip'; sel.disabled = row.skip; drawTarget(); count(); };
      skipBtn.addEventListener('click', () => { row.skip = !row.skip; sync(); });
      sel.addEventListener('change', () => { count(); drawTarget(); });
      row.sync = sync;
      tr.append(
        h('td', { class: 'thumbcell' }, thumb(b.mesh.id, b.name), h('b', null, b.name), h('span', { class: 'sub' }, `${b.mesh.bbox ? b.mesh.bbox.size.map(v => v.toFixed(0)).join(' × ') + ' mm · ' : ''}${cm3(b.mesh)}${b.many ? '' : ` · ${b.file}`}`)),
        h('td', null, why),
        h('td', { class: 'assigncell' }, sel),
        h('td', null, skipBtn),
        h('td', null, target));
      row.tr = tr;
      return row;
    });
    const count = () => {
      let n = 0, r = 0, k = 0; const used = {};
      for (const x of rows) { if (x.skip) k++; else if (x.sel.value === 'new') n++; else { r++; used[x.sel.value] = (used[x.sel.value] || 0) + 1; } }
      const dup = Object.values(used).some(v => v > 1);
      counter.textContent = `${n} new · ${r} replaced · ${k} skipped${dup ? ' — two bodies point at the same part' : ''}`;
      counter.classList.toggle('bad', dup);
    };
    rows.forEach(r => r.sync());
    const tbl = h('table', { class: 'assign-tbl nores' }, h('colgroup', null, h('col', { style: { width: '24%' } }), h('col', { style: { width: '8%' } }), h('col', { style: { width: '38%' } }), h('col', { style: { width: '8%' } }), h('col', { style: { width: '22%' } })),
      h('thead', null, h('tr', null, h('th', null, 'Body from the file'), h('th', null, 'Guess'), h('th', null, 'Assign to'), h('th', null, ''), h('th', null, 'That part today'))), h('tbody', null, ...rows.map(r => r.tr)));
    const has3mf = bodies.some(b => b.mesh.import);
    modal(`Assign ${bodies.length} bod${bodies.length === 1 ? 'y' : 'ies'} to parts`, h('div', null,
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Each body can become a new part, replace an existing part’s mesh (orientation, profile, filament, modifiers and history stay; the part re-slices), or be skipped. Guesses come from matching volume and size against the parts’ current meshes' + (bodies.some(b => b.mesh.body_name) ? ', and object names from the 3MF' : '') + '.' + (has3mf ? ' New parts from a 3MF start with the slicer settings and filament the object had in the project.' : '')),
      h('div', { class: 'inspector' }, canvas, inspectLbl),
      h('div', { class: 'tb', style: { justifyContent: 'flex-end', marginBottom: '6px' } }, counter, h('button', { class: 'btn small', onClick: () => { rows.forEach(r => { r.skip = true; r.sync(); }); } }, 'Skip all'), h('button', { class: 'btn small', onClick: () => { rows.forEach(r => { r.skip = false; r.sync(); }); } }, 'Include all')),
      h('div', { class: 'tw' }, tbl)),
      [{ label: 'Cancel' }, { label: 'Apply', cls: 'primary', onClick: async () => {
        let replaced = 0, created = 0, skipped = 0;
        const used = new Set();
        for (const r of rows) {
          if (r.skip) { skipped++; continue; }
          const v = r.sel.value;
          if (v === 'new') {
            const body = { name: r.b.name, mesh_id: r.b.mesh.id };
            if (r.b.mesh.units_scale_guess && r.b.mesh.units_scale_guess !== 1.0 && confirm(`${r.b.name} is only ${r.b.mesh.bbox.size.map(x => x.toFixed(1)).join('×')} mm — does it use inches? OK to scale ×25.4.`)) body.scale = 25.4;
            if (r.b.mesh.import) { body.params = r.b.mesh.import.params; body.profile_note = `Imported from ${r.b.file}`; if (r.b.mesh.import.filament_id) body.filament_id = r.b.mesh.import.filament_id; body.orient = { mode: 'preset', quat: [0, 0, 0, 1], label: 'imported' }; body.auto_orient = false; }
            await api('POST', `robots/${S.robotId}/parts`, body); created++; continue;
          }
          if (used.has(v)) { toast(`Two bodies point at the same part — only the first was applied`, true); skipped++; continue; }
          used.add(v);
          await api('PUT', `parts/${v}`, { mesh_id: r.b.mesh.id, force: true }, { label: 'replace mesh' }); replaced++;
        }
        await refreshRobot(); await loadState();
        if (S.view === 'part') await renderMain();
        toast(`${replaced} mesh${replaced === 1 ? '' : 'es'} replaced · ${created} new part${created === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}${replaced ? ' — re-slicing' : ''}`);
      } }], { width: 'min(1240px, 96vw)' });
    setTimeout(() => { const first = document.querySelector('.modal .thumb.clickable'); if (first) first.click(); }, 50);
  }

  // ---------------------------------------------------------------- part detail
  let viewer = null;
  V.part = async function (m) {
    let r = S.robot;
    let pid = S.param ? +S.param : null;
    // a part link may point at another robot (bookmark, back button): switch to that robot first
    if (pid && (!r || !r.sections.some(s => s.items.some(i => i.part && i.part.id === pid)))) {
      try { const p0 = await api('GET', `parts/${pid}`); if (p0.robot_id && p0.robot_id !== S.robotId) { await loadRobot(p0.robot_id); renderShell(); r = S.robot; } } catch { /* falls through to 'not found' */ }
    }
    if (!r) return needRobot(m);
    const all = r.sections.flatMap(s => s.items.filter(i => i.part));
    if (!pid) { if (!all.length) { m.append(h('div', { class: 'empty' }, 'No printed parts yet.')); return; } pid = all[0].part.id; }
    const it = all.find(i => i.part.id === pid); if (!it) { m.append(h('div', { class: 'empty' }, 'Part not found. ', h('button', { class: 'btn small', onClick: () => go('parts') }, 'Printed parts'))); return; }
    const p = await api('GET', `parts/${pid}`); const st = S.state;
    const upd = (patch) => api('PUT', `parts/${p.id}`, patch).then(async () => { await refreshRobot(); await renderMain(); }).catch(fail);
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, it.description, h('button', { class: 'btn icon', title: 'Rename part', 'aria-label': 'Rename part', style: { marginLeft: '6px', verticalAlign: 'middle' }, onClick: () => renameModal(it) }, '✎'), p.locked && h('span', { class: 'pill lock', style: { marginLeft: '8px' } }, '🔒 locked')),
      h('p', null, p.mesh ? `${p.mesh.filename} · ${p.mesh.triangles.toLocaleString()} triangles · ${(p.mesh.volume_mm3 / 1000).toFixed(2)} cm³ · ${p.mesh.bbox.size.map(v => v.toFixed(0)).join(' × ')} mm${p.scale !== 1 ? ` · scale ${p.scale}` : ''}${p.mirror ? ' · mirrored' : ''}` : 'No mesh attached yet')),
      h('div', { class: 'tb' },
        h('select', { onChange: e => go('part', e.target.value) }, ...all.map(x => h('option', { value: x.part.id, selected: x.part.id === pid }, x.description))),
        h('button', { class: 'btn', onClick: () => attachMeshModal(it) }, p.mesh ? 'Replace mesh…' : 'Attach mesh…'),
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
        const buf = await (await fetch(`/api/meshes/${p.mesh.id}/stl?part=${p.id}&lod=1&t=${Date.now()}`)).arrayBuffer();
        viewer.load(buf); viewer.setBoxes(p.modifiers || []);
      }, 0);
    } else canvas.replaceWith(h('div', { class: 'drop' }, 'Attach a mesh to preview and slice this part'));

    // orientation sweep + slices table
    const buildSweep = (p) => {
      const jobs = p.jobs || [];
      const orientJobs = jobs.filter(j => j.purpose === 'orient');
      const cur = p.slice;
      const curVer = (S.state.slicer && S.state.slicer.slicer) || '';
      const engLabel = v => !v ? '' : v.startsWith('bambu-') ? 'Bambu Studio ' + v.slice(6) : 'PrusaSlicer ' + v.split('+')[0];
      // one row per exact result (profile + filament + engine); newest wins for identical cache keys
      const seen = new Set();
      const all = jobs.filter(j => j.purpose !== 'orient' && j.orient_key === (cur ? cur.orient_key : j.orient_key))
        .sort((a, b) => b.id - a.id).filter(j => { if (seen.has(j.cache_key)) return false; seen.add(j.cache_key); return true; })
        .map(j => { const pr = j.profile_json ? JSON.parse(j.profile_json) : {}; return { j, pr, prof: j.profile_name || 'custom', fil: j.filament_name || '—', eng: engLabel(j.slicer_version).split(' ')[0] || '—' }; });
      // ---- filters (remembered per part)
      const F = S.cache.sweepF = S.cache.sweepF || {}; const f = F[p.id] = F[p.id] || {};
      const cols = [['prof', 'Profile', r => r.prof], ['walls', 'Walls', r => r.pr.walls], ['top', 'Top', r => r.pr.top], ['bottom', 'Bottom', r => r.pr.bottom], ['infill', 'Infill %', r => r.pr.infill], ['pattern', 'Pattern', r => r.pr.pattern], ['fil', 'Filament', r => r.fil], ['eng', 'Engine', r => r.eng]];
      const distinct = get => [...new Set(all.map(get).filter(v => v !== undefined && v !== null))].sort((x, y) => typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
      const rows = all.filter(r => cols.every(([k, , get]) => f[k] == null || f[k] === '' || String(get(r)) === String(f[k])));
      const active = cols.filter(([k]) => f[k] != null && f[k] !== '').length;
      const filterBar = h('div', { class: 'filters' },
        ...cols.map(([k, label, get]) => { const vals = distinct(get); if (vals.length < 2 && !f[k]) return null; return h('label', { class: 'flt' }, h('span', null, label), select([['', 'Any'], ...vals.map(v => [v, String(v)])], f[k] ?? '', { onChange: e => { f[k] = e.target.value; redrawSweep(); } })); }),
        active ? h('button', { class: 'btn small', onClick: () => { F[p.id] = {}; redrawSweep(); } }, `Clear filters (${active})`) : null,
        h('span', { class: 'rng', style: { marginLeft: 'auto' } }, `${rows.length} of ${all.length} result${all.length === 1 ? '' : 's'}`));
      // ---- selection for batch delete
      const sel = S.cache.sweepSel = S.cache.sweepSel || new Set();
      const deletable = r => !(cur && r.j.cache_key === cur.cache_key) && r.j.status !== 'running' && r.j.status !== 'queued';
      const delRows = async (ids) => { if (!ids.length) return; try { await api('POST', 'jobs/delete', { ids }); ids.forEach(i => sel.delete(i)); toast(`Removed ${ids.length} result${ids.length > 1 ? 's' : ''}`); await S.partRefresh(true); } catch (e) { fail(e); } };
      const selVisible = rows.filter(r => sel.has(r.j.id));
      const master = h('input', { type: 'checkbox', title: 'Select all shown', checked: rows.length > 0 && rows.filter(deletable).every(r => sel.has(r.j.id)), onChange: e => { for (const r of rows) if (deletable(r)) { if (e.target.checked) sel.add(r.j.id); else sel.delete(r.j.id); } redrawSweep(); } });
      const stale = rows.filter(r => r.j.status === 'done' && curVer && r.j.slicer_version !== curVer);
      const sweepRows = h('tbody');
      for (const r of rows) {
        const { j, pr } = r;
        const isCur = cur && j.cache_key === cur.cache_key, other = j.status === 'done' && curVer && j.slicer_version !== curVer;
        sweepRows.append(h('tr', { class: (isCur ? 'sel ' : '') + (other ? 'dim' : ''), title: other ? `Sliced with ${engLabel(j.slicer_version)}; the active engine is ${engLabel(curVer)}` : '' },
          h('td', null, h('input', { type: 'checkbox', checked: sel.has(j.id), disabled: !deletable(r), title: isCur ? 'The current result cannot be removed' : '', onChange: e => { if (e.target.checked) sel.add(j.id); else sel.delete(j.id); redrawSweep(); } })),
          h('td', null, r.prof === 'custom' ? h('span', { class: 'rng' }, 'custom') : r.prof, isCur && h('span', { class: 'pill auto', style: { marginLeft: '6px' } }, 'current')),
          h('td', { class: 'prof' }, profString(pr)),
          h('td', null, r.fil),
          h('td', null, h('span', { class: 'pill ' + (other ? 'warn' : 'ver') }, r.eng)),
          h('td', { class: 'num', style: { fontWeight: 600 } }, j.status === 'done' ? fmt(j.grams, 2) : h('span', { class: 'pill ' + (j.status === 'error' ? 'bad' : 'warn'), title: j.error }, j.status)),
          h('td', { class: 'num' }, j.status === 'done' && p.filament ? fmt(j.grams * (p.filament.correction.factor || 1), 2) : ''),
          h('td', { class: 'num', style: { color: cur && cur.grams != null && j.grams != null ? (j.grams > cur.grams ? 'var(--bad)' : 'var(--good)') : '' } }, cur && cur.grams != null && j.grams != null && !isCur ? signed(j.grams - cur.grams, 2) : ''),
          h('td', { class: 'num' }, j.print_time_s ? hms(j.print_time_s) : ''),
          h('td', { class: 'num' }, j.time_s ? secs(j.time_s) : (j.status === 'done' ? 'cached' : '')),
          h('td', { class: 'acts' }, !isCur && !p.locked && h('button', { class: 'btn small', title: 'Make this the part’s profile (creates or reuses a matching profile)', onClick: () => applyParamsAsProfile(p, pr) }, 'Apply'),
            deletable(r) && h('button', { class: 'btn icon del', title: 'Remove this result', 'aria-label': 'Remove result', onClick: () => delRows([j.id]) }, '✕'))));
      }
      return h('div', { class: 'card sweep', style: { marginTop: '12px' } }, h('h3', null, 'Slice results · this orientation', h('div', { class: 'tb' },
        selVisible.length ? h('button', { class: 'btn small', onClick: () => delRows(selVisible.map(r => r.j.id)) }, `Remove selected (${selVisible.length})`) : null,
        rows.filter(deletable).length && (active || rows.length > 1) ? h('button', { class: 'btn small', onClick: () => confirmModal(`Remove the ${rows.filter(deletable).length} results shown (the current one stays)?`, () => delRows(rows.filter(deletable).map(r => r.j.id)), 'Remove') }, 'Remove all shown…') : null,
        stale.length ? h('button', { class: 'btn small', title: 'Re-run the greyed rows with the active slicer and this part’s filament', onClick: async () => { try { for (const r of stale) await api('POST', `parts/${p.id}/slice`, { params: r.pr }); render(); } catch (e) { fail(e); } } }, `Re-slice ${stale.length} old row${stale.length > 1 ? 's' : ''}`) : null,
        h('button', { class: 'btn small', onClick: () => customSliceModal(p) }, '＋ Slice a profile…'),
        h('button', { class: 'btn small', onClick: () => exactSweepModal(p) }, 'Exact sweep…'),
        h('button', { class: 'btn small', onClick: async () => { try { await api('POST', `parts/${p.id}/orientation_sweep`, {}); toast('Orientation sweep queued (6 candidates)'); } catch (e) { fail(e); } } }, 'Orientation sweep'))),
        all.length > 1 ? filterBar : null,
        h('div', { class: 'tw' }, h('table', { dataset: { tkey: 'sweep' } }, h('thead', null, h('tr', null, h('th', { class: 'nosort' }, master), h('th', null, 'Profile'), h('th', null, 'Settings'), h('th', null, 'Filament'), h('th', null, 'Engine'), h('th', { class: 'num' }, 'Slicer g'), h('th', { class: 'num' }, '× corr.'), h('th', { class: 'num' }, 'vs current'), h('th', { class: 'num' }, 'Print time'), h('th', { class: 'num' }, 'Slice'), h('th', { class: 'nosort' }))), sweepRows)),
        !rows.length && h('p', { class: 'hint' }, all.length ? 'No results match these filters.' : 'No slices yet for this orientation.'),
        h('p', { class: 'hint' }, 'Every row is a real slice. “Settings” is walls · top/bottom layers · infill · layer height. Grey rows came from a different slicer engine. Remove rows you no longer need; the current result cannot be removed.'),
        orientJobs.length ? h('div', null, h('h3', { style: { marginTop: '14px' } }, 'Orientation sweep · current profile'), h('div', { class: 'tw' }, h('table', null, h('tbody', null, ...orientJobs.filter((j, i, a) => a.findIndex(x => x.orient_key === j.orient_key) === i).sort((a, b) => (a.grams ?? 1e9) - (b.grams ?? 1e9)).map(j => h('tr', null, h('td', { class: 'mono' }, j.orient_key.split('|')[0].replace('q', 'quat ')), h('td', { class: 'num' }, j.status === 'done' ? fmt(j.grams, 2) + ' g' : j.status), h('td', null, j.status === 'done' && !p.locked && h('button', { class: 'btn small', onClick: () => upd({ orient: { mode: 'manual', quat: j.orient_key.split('|')[0].slice(1).split(',').map(Number), label: 'from sweep' } }) }, 'Use')))))))) : null);
    };
    const redrawSweep = () => { const nc = buildSweep(lastP); sweepCard.replaceWith(nc); sweepCard = nc; };
    let lastP = p;
    let sweepCard = buildSweep(p);
    left.append(sweepCard);
    const cur = p.slice;
    // background refresh while slices land: swap only the sweep card and the header status, never the viewer
    S.partRefresh = async (force = false) => {
      const p2 = await api('GET', `parts/${pid}`);
      if (S.view !== 'part' || !document.body.contains(sweepCard)) return;
      // a new/replaced mesh or the current slice finishing changes the header, viewer, layer view and settings hint:
      // rebuild the whole page (unless the user is mid-edit or has a dialog open — then wait for the next event)
      const sig = x => `${x.mesh ? `${x.mesh.id}:${x.scale}:${x.mirror}` : ''}|${x.slice ? `${x.slice.id}:${x.slice.status === 'done'}` : ''}`;
      if (sig(p2) !== sig(lastP) || S.partFullPending) {
        if (!document.querySelector('#main input:focus, #main select:focus, #main textarea:focus, #main .editing, .modal-bg')) { S.partFullPending = false; await renderMain(); return; }
        clearTimeout(S.partFullTimer);
        S.partFullTimer = setTimeout(() => { if (S.partFullPending && S.view === 'part' && S.partRefresh) S.partRefresh().catch(() => {}); }, 2500);
        S.partFullPending = true;
      }
      lastP = p2;
      const nc = buildSweep(p2);
      if ((force || !busy(sweepCard)) && sweepCard.outerHTML !== nc.outerHTML) { sweepCard.replaceWith(nc); sweepCard = nc; }
      const oldCall = previewCard.querySelector('.callout.bad'); const err = p2.slice && p2.slice.status === 'error';
      if (oldCall && !err) oldCall.remove();
      else if (!oldCall && err) previewCard.append(h('div', { class: 'callout bad' }, h('b', null, 'This orientation did not slice. '), p2.slice.error || 'The slicer failed.'));
    };

    // right column: settings
    const prof = p.profile, params = prof ? prof.params : null;
    right.append(h('div', { class: 'card' }, h('h3', null, 'Print settings'),
      field('Filament', select(st.filaments.map(f => [f.id, `${f.name} · ${f.density}${f.correction.factor ? ' · ×' + f.correction.factor.toFixed(3) : ''}`]), p.filament_id, { disabled: p.locked, onChange: e => upd({ filament_id: +e.target.value }) })),
      field('Profile', select(st.profiles.map(x => [x.id, `${x.name} — ${x.string}`]), p.profile_id, { disabled: p.locked, onChange: e => upd({ profile_id: +e.target.value }) })),
      params && h('div', { class: 'hint' }, `Walls ${params.walls} · top ${params.top} (effective ${prof.effective_shells[0]}) · bottom ${params.bottom} (effective ${prof.effective_shells[1]}) · ${params.infill}% ${params.pattern} · ${params.layer_height} mm · ${params.nozzle} mm nozzle`),
      h('div', { class: 'tb', style: { marginTop: '8px' } }, prof && h('button', { class: 'btn small', onClick: () => editProfileModal(prof) }, prof.builtin ? 'View profile…' : 'Edit profile…'), h('button', { class: 'btn small', onClick: () => editProfileModal(null, params, (np) => upd({ profile_id: np.id })) }, 'New profile from this…')),
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
    const modsCard = h('div', { class: 'card' }, h('h3', null, 'Modifier regions', h('div', { class: 'tb' }, h('button', { class: 'btn small', disabled: p.locked || !p.mesh, onClick: () => modifierModal(p, null) }, '＋ Box…'))));
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
    right.append(h('div', { class: 'card' }, h('h3', null, 'Weigh-ins', h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => weighInModal(it) }, '＋ Add…'))),
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
      field('Min top shell (mm)', h('div', { class: 'tb' }, mk('top_min_thickness', { step: '0.1', min: 0 }), h('span', { class: 'rng' }, '0 = the layer count is exact. Bambu Studio’s stock profiles use 1.0 (= 5 layers at 0.2 mm).'))),
      field('Min bottom shell (mm)', h('div', { class: 'tb' }, mk('bottom_min_thickness', { step: '0.1', min: 0 }), h('span', { class: 'rng' }, '0 = exact'))),
      field('Sparse infill %', mk('infill', { step: '1', min: 0, max: 100 })), field('Pattern', f.pattern = select(PATTERNS, P.pattern, { disabled: opts.readonly, style: { width: '160px' } })),
      field('Layer height', mk('layer_height', { step: '0.02' })), field('Nozzle', f.nozzle = select([[0.4, '0.4 mm'], [0.6, '0.6 mm']], P.nozzle, { disabled: opts.readonly, style: { width: '110px' } })),
      h('details', null, h('summary', { style: { cursor: 'pointer', color: 'var(--ink2)', fontSize: '13px', margin: '8px 0' } }, 'Advanced (Bambu defaults)'),
        field('First layer height', mk('first_layer_height', { step: '0.02' })),
        field('Infill/wall overlap %', mk('infill_wall_overlap', { step: '1' })), field('Min sparse area mm²', mk('min_sparse_area', { step: '1' })),
        field('One wall on top', f.one_wall_top = h('input', { type: 'checkbox', checked: !!P.one_wall_top, disabled: opts.readonly })),
        field('Thin walls', f.thin_walls = h('input', { type: 'checkbox', checked: !!P.thin_walls, disabled: opts.readonly })),
        field('Gap fill', f.gap_fill = h('input', { type: 'checkbox', checked: P.gap_fill !== false, disabled: opts.readonly })),
        ...['outer', 'inner', 'infill', 'solid', 'top', 'first'].map(k => field(`Line width · ${k}`, f['lw_' + k] = input({ type: 'number', value: P.line_widths[k], step: '0.01', style: { width: '110px' }, disabled: opts.readonly })))));
    // live note about Bambu's "layers or thickness, whichever is more" rule — the usual reason two slicers disagree
    const shellNote = h('div', { class: 'callout', hidden: true });
    body.insertBefore(shellNote, body.children[5]);
    const updNote = () => {
      const lh = parseFloat(f.layer_height.value) || 0.2, t = parseInt(f.top.value) || 0, b = parseInt(f.bottom.value) || 0;
      const tm = parseFloat(f.top_min_thickness.value) || 0, bm = parseFloat(f.bottom_min_thickness.value) || 0;
      const et = Math.max(t, tm > 0 ? Math.ceil(tm / lh - 1e-9) : 0), eb = Math.max(b, bm > 0 ? Math.ceil(bm / lh - 1e-9) : 0);
      const msgs = [];
      if (et !== t) msgs.push(`Top: ${t} layers becomes ${et} because “Top min thickness” is ${tm} mm (Bambu Studio does the same unless its Top shell thickness is 0). Set it to 0 for exactly ${t}.`);
      if (eb !== b) msgs.push(`Bottom: ${b} layers becomes ${eb} because “Bottom min thickness” is ${bm} mm.`);
      const inf = parseFloat(f.infill.value) || 0, pat = f.pattern.value;
      if (inf >= 100 && !['rectilinear', 'alignedrectilinear', 'monotonic', 'monotonicline', 'concentric', 'zig-zag'].includes(pat)) msgs.push(`100% infill is printed as solid rectilinear lines — “${pat}” only exists below 100% (Bambu Studio refuses it at 100%), so the slicer is given rectilinear.`);
      shellNote.hidden = !msgs.length; shellNote.textContent = msgs.join(' ');
    };
    for (const k of ['top', 'bottom', 'layer_height', 'top_min_thickness', 'bottom_min_thickness', 'infill', 'pattern']) f[k].addEventListener('input', updNote);
    f.pattern.addEventListener('change', updNote);
    updNote();
    const read = () => {
      const out = {};
      for (const k of ['walls', 'top', 'bottom', 'infill', 'layer_height', 'first_layer_height', 'top_min_thickness', 'bottom_min_thickness', 'infill_wall_overlap', 'min_sparse_area']) out[k] = parseFloat(f[k].value);
      out.pattern = f.pattern.value; out.nozzle = parseFloat(f.nozzle.value); out.one_wall_top = f.one_wall_top.checked; out.thin_walls = f.thin_walls.checked; out.gap_fill = f.gap_fill.checked;
      out.line_widths = {}; for (const k of ['outer', 'inner', 'infill', 'solid', 'top', 'first']) out.line_widths[k] = parseFloat(f['lw_' + k].value);
      return out;
    };
    // when nozzle changes, reset line widths to that nozzle's defaults
    f.nozzle.addEventListener('change', () => { const d = f.nozzle.value === '0.6' ? { outer: .62, inner: .62, infill: .62, solid: .62, top: .62, first: .62, lh: .3, tm: 0, top: 3 } : { outer: .42, inner: .45, infill: .45, solid: .42, top: .42, first: .5, lh: .2, tm: 0, top: 5 }; for (const k of ['outer', 'inner', 'infill', 'solid', 'top', 'first']) f['lw_' + k].value = d[k]; f.layer_height.value = d.lh; f.first_layer_height.value = d.lh; f.top_min_thickness.value = d.tm; f.top.value = d.top; });
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
    // every configuration counts here (the optimizer must make weight in all of them), not just the one selected on the sheet
    const parts = r.sections.flatMap(s => s.counts ? s.items.filter(i => i.part && i.counted && (i.configs === null || i.configs.length)) : []);
    const locked = parts.filter(i => i.part.locked), free = parts.filter(i => !i.part.locked && i.part.mesh), noMesh = parts.filter(i => !i.part.locked && !i.part.mesh);
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Optimizer'), h('p', null, 'Finds profile plans that put the robot under its limit. Every plan shown has been re-sliced for real before it appears.'))));
    const left = h('div'), right = h('div'); m.append(h('div', { class: 'cols' }, left, right));
    const strat = { v: (run && run.inputs.strategy) || 'per_role' }, model = { v: (run && run.inputs.model) || 'anchored' }, rank = input({ type: 'range', min: 0, max: 100, value: run ? run.inputs.rank ?? 25 : 25, class: 'slider' });
    const margin = input({ type: 'number', value: r.margin_g, step: '0.1', style: { width: '90px' } }), nplans = input({ type: 'number', value: run ? run.inputs.n_plans || 5 : 5, step: '1', min: 1, max: 12, style: { width: '70px' } });
    const budgetLbl = h('b', { class: 'mono', style: { fontSize: '16px' } });
    const pctLbl = h('span', { class: 'rng' });
    const calcBudget = () => { budgetLbl.textContent = fmt(r.weight_class_g - parseFloat(margin.value || 0) - (t.best_known - t.printed)) + ' g'; pctLbl.textContent = `${((parseFloat(margin.value) || 0) / r.weight_class_g * 100).toFixed(1)}% of class`; }; margin.addEventListener('input', calcBudget); calcBudget();
    // strategies and models, in plain words — the description under each control follows the selection
    const roles = [...new Set(free.map(i => i.part.role || 'structure'))];
    const nW = i => { const c = (i.part.constraints || {}).walls || [2, 5]; return c[1] - c[0] + 1; }, nS = i => { const ct = (i.part.constraints || {}).top || [3, 5], cb = (i.part.constraints || {}).bottom || [3, 5]; return Math.max(ct[1], cb[1]) - Math.min(ct[0], cb[0]) + 1; };
    const gridSlices = free.reduce((n, i) => n + nW(i) * nS(i) * 3, 0), anchorSlices = free.length * 8;
    const STRATS = {
      uniform: ['Uniform', 'One profile for all free parts', 'Every free part gets the same walls, shells and infill. Simple and predictable; strong and weak parts are treated alike.'],
      per_role: ['Per role', 'Each role gets its own walls/shells', `Parts are grouped by the role set in Part detail (armor, weapon, structure, internal, cosmetic). Each group gets its own walls and shells; infill is solved so the robot lands on the budget, with armor and weapon parts denser than internals and cosmetics.${roles.length < 2 ? ` Right now all ${free.length} free part${free.length === 1 ? '' : 's'} have the role “${roles[0] || 'structure'}”, so this behaves like Uniform — set roles in Part detail, or use Priority fill, which tunes each part on its own.` : ''}`],
      priority: ['Priority fill', 'Minimums first, then spend grams on armor walls', 'Starts every free part at the minimum of its ranges, then spends the leftover grams one step at a time — walls on armor first, then weapon, structure, internals, cosmetics; then shells; then infill — until the budget is used. Parts end up different from each other even when they share a role.'],
      trim: ['Trim', 'Smallest change from current profiles', 'Starts from the profiles the parts have today and removes grams until the robot makes weight: infill first on cosmetic and internal parts, then shells, then walls, working up to armor last. Use it when the current settings are close and you want to change as little as possible.'],
    };
    const MODELS = {
      anchored: ['Anchored (fast)', 'Real slices at range corners, fitted model in between, every shown plan confirmed', `Slices each part for real at the corners of its ranges (about ${anchorSlices} slices), fits a model of how its weight moves with walls, shells and infill, searches thousands of combinations with that model, then re-slices every plan it shows for real — the grams on the cards are confirmed, not predicted. If a confirmation misses the model by more than 1.5 %, the model is refitted and the search repeated.`],
      grid: ['Exact grid', 'Real slices on a coarse grid per part; slower, no model', `Slices every walls × shells combination of every part for real at three infill levels (about ${gridSlices} slices here) and only interpolates between infill levels. Slower, but nothing is modelled — use it when Anchored keeps missing on an unusual shape.`],
    };
    const stratDesc = h('p', { class: 'hint', style: { margin: '6px 0 0' } }), modelDesc = h('p', { class: 'hint', style: { margin: '6px 0 0' } });
    const descFor = () => { stratDesc.textContent = STRATS[strat.v][2]; modelDesc.textContent = MODELS[model.v][2]; };
    const segBtn = (obj, val, label, desc) => h('button', { 'aria-pressed': String(obj.v === val), title: desc, onClick: e => { obj.v = val; [...e.currentTarget.parentNode.children].forEach(b => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); descFor(); } }, label);
    descFor();
    const status = h('span', { class: 'hint', style: { margin: 0 } });
    const cfgs = r.configs || [];
    left.append(h('div', { class: 'card' }, h('h3', null, 'Target'),
      h('div', { class: 'grid2' },
        h('div', null, field('Class', h('span', null, `${r.class_name || ''} · ${fmt(r.weight_class_g)} g`)), field('Non-printed', h('span', { class: 'mono' }, `${fmt(t.best_known - t.printed)} g `, h('span', { class: 'rng' }, cfgs.length > 1 ? 'best known, selected configuration' : 'best known, from sheet'))), field('Margin', h('div', { class: 'tb' }, margin, pctLbl)), field('Printed budget', h('div', null, budgetLbl, cfgs.length > 1 && h('div', { class: 'rng' }, 'for the selected configuration — each one gets its own budget'))),
          field('Locked', h('span', null, locked.length ? locked.map(i => h('span', { class: 'pill lock', style: { marginRight: '4px' } }, `${i.description} ${fmt(i.total_grams)} g`)) : h('span', { class: 'rng' }, 'none')))),
        h('div', null,
          field('Plans', h('div', { class: 'tb' }, nplans, h('span', { class: 'rng' }, 'how many different plans to show'))),
          field('Free parts', h('span', null, `${free.length} unlocked with a mesh`, roles.length > 1 ? h('span', { class: 'rng' }, ` · roles: ${roles.join(', ')}`) : h('span', { class: 'rng' }, ` · all “${roles[0] || 'structure'}”`))))),
      h('div', { class: 'optopts' },
        field('Strategy', h('div', null, h('div', { class: 'seg' }, ...Object.entries(STRATS).map(([k, v]) => segBtn(strat, k, v[0], v[1]))), stratDesc)),
        field('Rank', h('div', null, h('div', { class: 'tb' }, h('span', { class: 'rng' }, 'prefer walls'), rank, h('span', { class: 'rng' }, 'prefer infill')), h('p', { class: 'hint', style: { margin: '4px 0 0' } }, 'When several plans fit, this decides which count as “stronger”: grams spent on walls and shells, or grams spent on infill.'))),
        field('Model', h('div', null, h('div', { class: 'seg' }, ...Object.entries(MODELS).map(([k, v]) => segBtn(model, k, v[0], v[1]))), modelDesc))),
      cfgs.length > 1 && h('p', { class: 'hint', style: { marginTop: '10px' } }, h('b', null, `${cfgs.length} configurations. `), 'Every plan must make weight in all of them. A part shared by every configuration is printed once, so it gets one profile everywhere; parts that are only in some configurations may be sliced differently.'),
      h('div', { class: 'tb', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', disabled: !free.length, onClick: async () => { try { const rr = await api('POST', `robots/${r.id}/optimize`, { strategy: strat.v, model: model.v, rank: +rank.value, margin_g: parseFloat(margin.value), n_plans: +nplans.value }); go('optimizer', rr.id); } catch (e) { fail(e); } } }, 'Run optimizer'),
        run && (run.status === 'running') && h('button', { class: 'btn', onClick: () => api('POST', `runs/${run.id}/cancel`).then(render) }, 'Cancel'), status,
        noMesh.length ? h('span', { class: 'pill warn' }, `${noMesh.length} printed part${noMesh.length > 1 ? 's' : ''} without mesh count as their sheet weight`) : null,
        !free.length && h('span', { class: 'pill warn' }, 'No unlocked parts with meshes to optimize'))));
    const howCard = h('details', { class: 'card how' }, h('summary', null, 'How the optimizer works'),
      ...[['Budget', 'Class limit − margin − everything that is not a free printed part (non-printed lines, locked parts, parts without a mesh) = the grams the free parts may weigh. With configurations, each one gets its own budget and the plan must fit the tightest.'],
        ['Ranges', 'Each part’s walls / top / bottom / infill ranges (Part detail → Optimizer rules) bound what the optimizer may choose. Lock a part to keep it exactly as it is.'],
        ['Search', 'The strategy decides how settings are spread across parts; the model decides how weights are predicted while searching (see the descriptions above).'],
        ['Confirm', 'Every plan on a card has been re-sliced for real; “fits” and the grams are slicer numbers, corrected by the filament’s correction factor if one is set.'],
        ['Apply', 'Apply to parts writes the plan’s profile onto each part (creating profiles as needed) and flags weighed lines for a re-weigh.']].map(([t, x]) => h('div', { class: 'step' }, h('div', null, h('b', null, t), ' ', x))));
    if (!run) { left.append(h('p', { class: 'empty' }, 'No optimizer runs yet for this robot.')); right.append(howCard); return; }
    const res = run.results || {};
    status.textContent = res.status_text || (run.status === 'running' ? 'running…' : '');
    // results
    const viewSeg = h('div', { class: 'seg', style: { marginLeft: 'auto' } });
    const plansEl = h('div', { class: 'plans' }), paretoEl = h('div', { class: 'card', hidden: true });
    const showP = (p) => { plansEl.hidden = p; paretoEl.hidden = !p; viewSeg.children[0].setAttribute('aria-pressed', String(!p)); viewSeg.children[1].setAttribute('aria-pressed', String(p)); if (p) drawPareto(paretoEl, res, run); };
    viewSeg.append(h('button', { 'aria-pressed': 'true', onClick: () => showP(false) }, 'Plans'), h('button', { 'aria-pressed': 'false', onClick: () => showP(true) }, 'Pareto chart'));
    left.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' } }, h('h3', { style: { margin: 0, fontSize: '12px', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink3)' } }, `Results · run #${run.id} · ${new Date(run.date * 1000).toLocaleString()}`), viewSeg));
    if (res.config_note) left.append(h('p', { class: 'hint', style: { margin: '6px 0 0' } }, res.config_note));
    const plans = res.plans || [];
    const multi = !!res.multi_config;
    if (S.planSel == null || S.planSelRun !== run.id) { S.planSel = 0; S.planSelRun = run.id; }
    const selected = { get i() { return Math.min(S.planSel, Math.max(0, plans.length - 1)); }, set i(v) { S.planSel = v; } };
    const perConfig = (pl) => multi && pl.per_config ? h('div', { class: 'd cfgs' }, ...pl.per_config.map(pc => h('span', { class: 'pill ' + (pc.fits ? 'good' : 'bad'), title: `${pc.name}: ${fmt(pc.total_g)} g printed, ${pc.fits ? fmt(pc.slack_g) + ' g slack' : fmt(-pc.slack_g) + ' g over'}` }, `${pc.name} ${fmt(pc.total_g)} g`))) : null;
    const detailFor = (pl) => {
      const el = h('div', { class: 'card plandetail' }, h('h3', null, `${pl.name} · per part`),
        h('div', { class: 'tw' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Part'), multi && h('th', null, 'Configurations'), h('th', null, 'Profile'), h('th', { class: 'num' }, 'each'), h('th', { class: 'num' }, 'total'))),
          h('tbody', null, ...(pl.assignments || []).map(a => h('tr', { class: a.locked ? 'locked' : '' }, h('td', null, a.name, a.locked ? ' 🔒' : ''), multi && h('td', null, a.configs ? a.configs.map(n => h('span', { class: 'pill cfg', style: { marginRight: '4px' } }, n)) : h('span', { class: 'rng' }, 'all')), h('td', { class: 'prof' }, a.profile_string || ''), h('td', { class: 'num' }, a.grams != null ? fmt(a.grams) : h('span', { class: 'pill warn' }, a.status || '…')), h('td', { class: 'num' }, a.grams != null ? fmt(a.grams * a.qty) : ''))),
            ...(multi && pl.per_config ? pl.per_config.map(pc => h('tr', { class: 'sum' }, h('td', null, `Total · ${pc.name}`), h('td'), h('td', null, h('span', { class: 'pill ' + (pc.fits ? 'good' : 'bad') }, pc.fits ? `fits · ${fmt(pc.slack_g)} g slack` : `${fmt(-pc.slack_g)} g over`)), h('td'), h('td', { class: 'num' }, fmt(pc.total_g)))) : [h('tr', { class: 'sum' }, h('td', null, 'Total'), h('td'), h('td'), h('td', { class: 'num' }, fmt(pl.total_g)))])))),
        pl.model_total_g != null && pl.status === 'confirmed' && h('p', { class: 'hint' }, `Model predicted ${fmt(pl.model_total_g)} g; confirmed ${fmt(pl.total_g)} g (${signed((pl.total_g - pl.model_total_g) / pl.model_total_g * 100)}%).`));
      return el;
    };
    const drawPlans = () => {
      plansEl.textContent = '';
      plans.forEach((pl, i) => {
        const conf = pl.status === 'confirmed', sel = i === selected.i;
        plansEl.append(h('div', { class: 'plan' + (i === 0 && conf && pl.fits ? ' best' : '') + (pl.fits === false ? ' infeas' : '') + (sel ? ' sel' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(sel), onClick: () => { selected.i = i; drawPlans(); }, onKeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected.i = i; drawPlans(); } } },
          h('div', { class: 't' }, h('b', null, pl.name), h('span', { class: 'pill ' + (conf ? (pl.fits ? 'good' : 'bad') : 'warn') }, conf ? (pl.fits ? 'fits' : `${fmt(-pl.slack_g)} g over${pl.worst_config ? ' · ' + pl.worst_config : ''}`) : (pl.status === 'confirming' ? `confirming ${pl.confirmed_n || 0}/${pl.total_n || '?'}` : pl.status))),
          h('div', { class: 'g', style: conf ? null : { color: 'var(--ink3)' } }, fmt(pl.total_g), h('small', null, conf ? `g${multi ? ' heaviest configuration' : ''} · ${fmt(pl.slack_g)} g slack${pl.worst_config ? ' in ' + pl.worst_config : ''}` : 'g · model')),
          perConfig(pl),
          h('div', { class: 'd' }, ...(pl.summary || []).map(s => h('span', { class: 'prof' }, s)), pl.locked_g ? `Locked ${fmt(pl.locked_g)} g` : null),
          h('div', { class: 'sc' }, 'strength ', ...[0, 1, 2, 3, 4].map(k => h('i', { class: (pl.score || 0) * 5 > k ? 'on' : '' })), conf && h('span', { class: 'pill ver', style: { marginLeft: '6px' } }, 'confirmed')),
          h('div', { class: 'tb' }, h('button', { class: 'btn small' + (i === 0 ? ' primary' : ''), disabled: !conf, onClick: async (e) => { e.stopPropagation(); await api('POST', `runs/${run.id}/apply`, { plan: i }); toast('Plan applied to parts'); await refreshRobot(); await loadState(); render(); } }, 'Apply to parts'), sel && h('span', { class: 'rng', style: { marginLeft: '8px' } }, 'selected · details below'))));
        if (sel) plansEl.append(detailFor(pl));
      });
      if (res.current) plansEl.append(h('div', { class: 'plan infeas' }, h('div', { class: 't' }, h('b', null, 'Current'), h('span', { class: 'pill ' + (res.current.fits ? 'good' : 'bad') }, res.current.fits ? 'fits' : `${fmt(-res.current.slack_g)} g over${res.current.worst_config ? ' · ' + res.current.worst_config : ''}`)), h('div', { class: 'g' }, fmt(res.current.total_g), h('small', null, multi ? 'g printed, heaviest configuration' : 'g printed')), perConfig(res.current), h('div', { class: 'd' }, 'What is on the sheet now, for comparison.'), h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => go('sheet') }, 'View sheet'))));
      if (!plans.length && run.status !== 'running') plansEl.append(h('p', { class: 'empty' }, res.error || 'No feasible plan found.'));
    };
    drawPlans();
    left.append(plansEl, paretoEl);
    if (res.why) right.append(h('div', { class: 'card' }, h('h3', null, 'Why not lighter?'), ...res.why.map((w, i) => h('div', { class: 'step' }, h('span', { class: 'n' }, i + 1), h('div', null, h('b', null, w.title), ' ', w.text)))));
    if (res.model_report) right.append(h('div', { class: 'card' }, h('h3', null, 'Model check'), h('p', { class: 'hint', style: { margin: 0 } }, res.model_report)));
    right.append(howCard);
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
    m.append(h('div', { class: 'tw' }, h('table', { dataset: { tkey: 'runs' } }, h('thead', null, h('tr', null, h('th', null, 'Run'), h('th', null, 'Date'), h('th', null, 'Kind'), h('th', { class: 'num' }, 'Total g'), h('th', null, 'Notes'), h('th'))), tb)));
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
      const d = input({ type: 'date', value: ev ? ev.date : today() }), t = input({ value: ev ? ev.title : '', placeholder: 'e.g. Robot Ruckus 2026' }), pl = input({ value: ev ? ev.placing || '' : '', placeholder: 'e.g. 1st' }), n = h('textarea', null, ev ? ev.notes || '' : '');
      modal(ev ? 'Edit competition' : 'New competition', h('div', null, field('Date', d), field('Competition', t), field('Placing', pl), field('Notes', n)), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { if (ev) await api('PUT', `events/${ev.id}`, { date: d.value, title: t.value, placing: pl.value, notes: n.value }); else await api('POST', `robots/${r.id}/events`, { date: d.value, title: t.value, placing: pl.value, notes: n.value }); render(); } }]);
    };
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Competition log'), h('p', null, 'Competitions and milestones for this robot, with the sheet total snapshotted at each entry — what it weighed at each event, how it placed, what you changed.')), h('div', { class: 'tb' }, h('button', { class: 'btn primary', onClick: () => add() }, '＋ Competition…'))));
    const card = h('div', { class: 'card' });
    if (!evs.length) card.append(h('p', { class: 'hint' }, 'Nothing logged yet.'));
    for (const ev of evs) card.append(h('div', { class: 'ev' }, h('div', { class: 'd' }, ev.date), h('div', null, h('b', null, ev.title, ev.placing ? ` · ${ev.placing}` : ''), h('span', null, ev.notes || ''), ev.total_snapshot_g != null && h('div', { class: 'rng' }, `sheet total at the time: ${fmt(ev.total_snapshot_g)} g`)),
      h('div', { class: 'tb' }, h('button', { class: 'btn icon', onClick: () => add(ev) }, '✎'), h('button', { class: 'btn icon', onClick: () => confirmModal('Delete this entry?', async () => { await api('DELETE', `events/${ev.id}`); render(); }) }, '✕'))));
    m.append(card);
  };

  // ---------------------------------------------------------------- library
  // ---------------------------------------------------------------- fasteners: specs, labels, weight estimates
  // A component can be "generic" (name + weight) or a "fastener" with McMaster-style structured attributes. The label is
  // built from the attributes so every screw is named the same way, and the weight can be estimated from the geometry
  // when the scale is not at hand (marked "estimated" until a weigh-in replaces it).
  const FT = {
    types: [['screw', 'Screw / bolt'], ['nut', 'Nut'], ['washer', 'Washer'], ['standoff', 'Standoff / spacer'], ['insert', 'Threaded insert'], ['other', 'Other hardware']],
    screwTypes: ['machine screw', 'thread-forming (Plastite)', 'self-tapping', 'wood screw', 'sheet-metal screw', 'shoulder bolt'],
    heads: ['socket head', 'low-profile socket head', 'button head', 'flat head (countersunk)', 'pan head', 'hex head', 'cheese head', 'set screw', 'shoulder', 'thumb', 'wafer head'],
    drives: ['hex (Allen)', 'Torx', 'Phillips', 'slotted', 'external hex', 'none'],
    materials: ['alloy steel', '18-8 stainless steel', '316 stainless steel', 'grade 5 titanium', 'aluminum', 'brass', 'nylon', 'zinc-plated steel', 'grade 8 steel'],
    finishes: ['black oxide', 'plain', 'zinc plated', 'passivated', 'anodized', 'nickel plated'],
    nutTypes: ['hex nut', 'nylon-insert lock nut', 'thin hex nut', 'flange nut', 'square nut', 'wing nut', 'cap nut', 'heat-set insert'],
    washerTypes: ['flat washer', 'split lock washer', 'fender washer', 'wave washer', 'thin flat washer'],
    metric: ['M1.6', 'M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'],
    imperial: ['#2-56', '#4-40', '#6-32', '#8-32', '#10-24', '#10-32', '1/4"-20', '1/4"-28', '5/16"-18', '3/8"-16'],
    density: { 'alloy steel': 7.85, '18-8 stainless steel': 7.9, '316 stainless steel': 8.0, 'grade 8 steel': 7.85, 'zinc-plated steel': 7.85, 'grade 5 titanium': 4.43, 'aluminum': 2.7, 'brass': 8.5, 'nylon': 1.15 },
  };
  // major diameter in mm for a thread string ("M3", "M3x0.5", "#6-32", '1/4"-20', "1/4-20")
  function threadDia(t) {
    if (!t) return null; t = String(t).trim();
    let m = t.match(/^M\s*(\d+(?:\.\d+)?)/i); if (m) return parseFloat(m[1]);
    m = t.match(/^#\s*(\d+)/); if (m) { const n = +m[1]; return (0.060 + 0.013 * n) * 25.4; }
    m = t.match(/^(\d+)\s*\/\s*(\d+)/); if (m) return (+m[1] / +m[2]) * 25.4;
    m = t.match(/^(\d*\.\d+)\s*"?/); if (m) return parseFloat(m[1]) * 25.4;
    return null;
  }
  const lenMm = sp => sp.length == null || sp.length === '' ? null : (+sp.length) * (sp.length_unit === 'in' ? 25.4 : 1);
  // 0.625 → 5/8", 1.25 → 1-1/4" (nearest 1/64), the way fasteners are sold
  function fracIn(v) { v = +v; if (!isFinite(v)) return ''; const whole = Math.floor(v); let n = Math.round((v - whole) * 64), d = 64; if (n === 64) return `${whole + 1}"`; while (n && n % 2 === 0) { n /= 2; d /= 2; } const f = n ? `${n}/${d}` : ''; return `${whole && f ? whole + '-' : whole || !f ? whole : ''}${f}"`; }
  // typed length: "5/16", "1-1/4", "1 1/4", "3/8\"", ".375", "12" → number (in the current unit); null when unreadable
  function parseLen(str) {
    const t = String(str || '').trim().replace(/["″]/g, '').replace(/\s*(in|mm)$/i, '');
    if (!t) return null;
    let m = t.match(/^(\d+)[\s-]+(\d+)\s*\/\s*(\d+)$/); if (m) return +m[1] + (+m[2] / +m[3]);
    m = t.match(/^(\d+)\s*\/\s*(\d+)$/); if (m && +m[2]) return +m[1] / +m[2];
    m = t.match(/^(\d*\.?\d+)$/); if (m) return parseFloat(m[1]);
    return null;
  }
  const lenTxt = sp => sp.length == null || sp.length === '' ? '' : (sp.length_unit === 'in' ? fracIn(sp.length) : `${sp.length} mm`);
  function fastenerLabel(sp) {
    if (!sp || !sp.thread) return '';
    const th = sp.thread || '', mat = [sp.material, sp.finish].filter(Boolean).join(' ');
    const tail = mat ? `, ${mat}` : '';
    switch (sp.type) {
      case 'nut': return `${th} ${sp.nut_type || 'nut'}${tail}`.trim();
      case 'washer': return `${th} ${sp.washer_type || 'washer'}${sp.od ? ` ${sp.od} mm OD` : ''}${tail}`.trim();
      case 'standoff': return `${th} × ${lenTxt(sp)} ${sp.shape || 'hex'} standoff${sp.gender ? ` (${sp.gender})` : ''}${tail}`.trim();
      case 'insert': return `${th} ${sp.nut_type || 'threaded insert'}${sp.length ? ` × ${lenTxt(sp)}` : ''}${tail}`.trim();
      case 'other': return `${th}${sp.length ? ` × ${lenTxt(sp)}` : ''} ${sp.head || ''}${tail}`.trim();
      default: { const drv = sp.drive && sp.drive !== 'none' && !/hex \(Allen\)/.test(sp.drive) ? ` ${sp.drive}` : ''; const st = sp.screw_type && sp.screw_type !== 'machine screw' ? sp.screw_type : ''; const kindTxt = sp.head ? `${sp.head}${st ? ' ' + st : ''}` : (st ? `${st} screw` : 'screw'); return `${th} × ${lenTxt(sp)} ${kindTxt}${drv}${sp.thread_type === 'partial' ? ', partially threaded' : ''}${tail}`.trim(); }
    }
  }
  function fastenerSpecText(sp) {
    if (!sp) return '';
    const bits = [];
    if (sp.thread) bits.push(sp.thread + (sp.pitch ? ` × ${sp.pitch}` : ''));
    if (sp.length !== '' && sp.length != null) bits.push(lenTxt(sp));
    if (sp.type === 'nut') bits.push(sp.nut_type || 'nut'); else if (sp.type === 'washer') bits.push(sp.washer_type || 'washer'); else if (sp.type === 'standoff') bits.push('standoff'); else if (sp.type === 'insert') bits.push('insert'); else if (sp.head) bits.push(sp.head);
    if (sp.screw_type && sp.screw_type !== 'machine screw') bits.push(sp.screw_type);
    if (sp.drive && sp.drive !== 'none' && sp.type === 'screw') bits.push(sp.drive);
    if (sp.material) bits.push(sp.material); if (sp.finish) bits.push(sp.finish); if (sp.grade) bits.push(sp.grade);
    if (sp.head_dia) bits.push(`head ⌀${sp.head_dia}`); if (sp.head_height) bits.push(`head h ${sp.head_height}`);
    if (sp.od) bits.push(`OD ${sp.od}`); if (sp.thickness) bits.push(`t ${sp.thickness}`); if (sp.across_flats) bits.push(`${sp.across_flats} mm AF`);
    return bits.join(' · ');
  }
  // Rough mass from geometry: thread shank as a cylinder at ~82 % of the major diameter's area (thread relief), head from
  // ISO 4762 / 7380 / 10642 style proportions, nuts as a hex prism minus the bore, washers as an annulus. ±15 % is typical.
  function fastenerEstimate(sp) {
    const d = threadDia(sp.thread); if (!d) return null;
    const rho = FT.density[sp.material] || 7.85, L = lenMm(sp);
    const cyl = (dia, hgt) => Math.PI * (dia / 2) ** 2 * hgt;
    let v = 0;
    if (sp.type === 'screw' || sp.type === 'other' || sp.type === 'standoff') {
      if (L == null) return null;
      if (sp.type === 'standoff') {
        const af = +sp.across_flats || 1.7 * d + 0.5; const area = sp.shape === 'round' ? Math.PI * (af / 2) ** 2 : 0.866 * af * af;
        v = area * L - cyl(d * 0.85, L) * (sp.gender === 'female-female' || !sp.gender ? 1 : 0.5);
        if (sp.gender === 'male-female' || sp.gender === 'male-male') v += cyl(d, (sp.gender === 'male-male' ? 2 : 1) * 1.5 * d) * 0.82;
        return Math.max(0.01, v * rho / 1000);
      }
      v = cyl(d, L) * 0.86;
      const head = (sp.head || 'socket head').toLowerCase();
      let dk = +sp.head_dia || 0, k = +sp.head_height || 0, solid = 1;
      if (/set screw/.test(head)) { dk = 0; k = 0; v -= cyl(d * 0.5, Math.min(L, d)); }
      else if (/low-profile/.test(head)) { dk = dk || 1.5 * d + 1; k = k || 0.6 * d; solid = 0.7; }
      else if (/socket|cheese|shoulder/.test(head)) { dk = dk || 1.5 * d + 1; k = k || d; solid = 0.78; }
      else if (/button/.test(head)) { dk = dk || 1.75 * d + 0.5; k = k || 0.55 * d; solid = 0.6; }
      else if (/flat|countersunk/.test(head)) { dk = dk || 2.2 * d; k = k || 0.6 * d; solid = 0.45; }
      else if (/pan|wafer|thumb/.test(head)) { dk = dk || 2 * d; k = k || 0.6 * d; solid = 0.7; }
      else if (/hex/.test(head)) { dk = dk || 1.7 * d; k = k || 0.7 * d; solid = 0.85; }
      else { dk = dk || 1.5 * d + 1; k = k || d; solid = 0.78; }
      v += cyl(dk, k) * solid;
    } else if (sp.type === 'nut' || sp.type === 'insert') {
      const af = +sp.across_flats || (1.6 * d + 0.9), m = +sp.thickness || (/lock|nylon/.test(sp.nut_type || '') ? 1.0 * d : /thin/.test(sp.nut_type || '') ? 0.5 * d : 0.8 * d);
      v = (0.866 * af * af - cyl(d * 0.85, 1)) * m;
      if (/nylon/.test(sp.nut_type || '')) v *= 0.9;
      if (sp.type === 'insert') { const od = +sp.od || 1.6 * d; v = (cyl(od, L || 1.5 * d) - cyl(d * 0.85, L || 1.5 * d)) * 0.95; }
    } else if (sp.type === 'washer') {
      const od = +sp.od || 2.2 * d, id = +sp.id || d + 0.3, t = +sp.thickness || Math.max(0.3, 0.2 * d);
      v = (cyl(od, t) - cyl(id, t)) * (/split|wave/.test(sp.washer_type || '') ? 0.8 : 1);
    }
    return v > 0 ? v * rho / 1000 : null;
  }
  // "M3x12", "M3 × 12 mm", "#6-32 x 3/8"", "3/8" 6-32 Screw" → {thread, length, length_unit}; used when an old plain
  // component is switched to a fastener so the specs start filled in
  function parseFastenerName(name) {
    const out = {}; const n = String(name || '');
    let m = n.match(/\bM\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
    if (m) { out.thread = 'M' + m[1]; out.length = parseFloat(m[2]); out.length_unit = 'mm'; }
    else { m = n.match(/\bM\s*(\d+(?:\.\d+)?)\b/i); if (m) out.thread = 'M' + m[1]; }
    const frac = str => { const f = str.match(/(?:(\d+)-)?(\d+)\s*\/\s*(\d+)/); if (f) return (+f[1] || 0) + +f[2] / +f[3]; const d = str.match(/(\d*\.\d+|\d+)/); return d ? parseFloat(d[1]) : null; };
    m = n.match(/#\s*(\d+)\s*-\s*(\d+)/); if (m) out.thread = `#${m[1]}-${m[2]}`;
    if (!out.thread) { m = n.match(/(\d+\s*\/\s*\d+)"?\s*-\s*(\d+)/); if (m) out.thread = `${m[1].replace(/\s/g, '')}"-${m[2]}`; }
    if (!out.thread) { m = n.match(/\b(\d{1,2})-(\d{2})\b/); if (m && +m[1] <= 12) out.thread = `#${m[1]}-${m[2]}`; }
    if (!out.thread) { m = n.match(/#\s*(\d{1,2})\b/); if (m) out.thread = `#${m[1]}`; }
    m = n.match(/(\d+(?:-\d+)?\s*\/\s*\d+|\d*\.\d+|\d+)\s*(?:"|″|in\b)?\s*(?:long|length|lg)\b/i);
    if (m) { const L = frac(m[1]); if (L) { out.length = L; out.length_unit = /mm/.test(m[0]) ? 'mm' : 'in'; } }
    m = out.length == null && (n.match(/[x×]\s*(\d+\s*\/\s*\d+|\d*\.\d+|\d+)\s*(in\b|"|″)/i) || n.match(/(\d+(?:-\d+)?\s*\/\s*\d+|\d*\.\d+)\s*(in\b|"|″|-?inch)/i));
    if (m) { const L = frac(m[1]); if (L) { out.length = L; out.length_unit = 'in'; } }
    else if (out.length == null) { m = n.match(/[x×]\s*(\d+(?:\.\d+)?)\s*(mm)?\b/i); if (m && out.thread) { out.length = parseFloat(m[1]); out.length_unit = 'mm'; } }
    if (/washer/i.test(n)) out.type = 'washer'; else if (/nut\b/i.test(n)) out.type = 'nut'; else if (/standoff|spacer/i.test(n)) out.type = 'standoff'; else if (/insert/i.test(n)) out.type = 'insert';
    if (/socket/i.test(n)) out.head = 'socket head'; else if (/button/i.test(n)) out.head = 'button head'; else if (/flat head|countersunk/i.test(n)) out.head = 'flat head (countersunk)'; else if (/pan/i.test(n)) out.head = 'pan head'; else if (/hex head/i.test(n)) out.head = 'hex head';
    if (/plastite|thread.?forming/i.test(n)) out.screw_type = 'thread-forming (Plastite)'; else if (/self.?tapping/i.test(n)) out.screw_type = 'self-tapping'; else if (/shoulder/i.test(n)) { out.screw_type = 'shoulder bolt'; out.head = out.head || 'socket head'; }
    if (/stainless/i.test(n)) out.material = '18-8 stainless steel'; else if (/titanium|\bTi\b/i.test(n)) out.material = 'grade 5 titanium'; else if (/alumin/i.test(n)) out.material = 'aluminum'; else if (/nylon/i.test(n)) out.material = 'nylon';
    return out;
  }
  const specSort = c => { const sp = c.specs || {}; return [threadDia(sp.thread) || 0, lenMm(sp) || 0]; };

  V.library = async function (m) {
    const comps = await api('GET', 'components');
    const cats = [...new Set(comps.map(c => c.category || 'Other'))].sort();
    S.cache.cats = cats; catDatalist(cats);
    const st = { q: S.cache.libq || '', cat: S.cache.libcat || '' };
    const search = input({ class: 'search', placeholder: 'Search name, specs, part number…', value: st.q });
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Component library'), h('p', null, 'Shared across robots. Measured weights here propagate to every robot that uses the part. Fasteners carry McMaster-style specs, get a consistent label from them, and can be duplicated to make the next length in one step.')),
      h('div', { class: 'tb' }, search, h('button', { class: 'btn', onClick: () => compModal({ kind: 'fastener', specs: { type: 'screw', length_unit: 'mm', head: 'socket head', drive: 'hex (Allen)', material: 'alloy steel', finish: 'black oxide' }, category: 'Fasteners' }, { isNew: true }) }, '＋ Fastener…'), h('button', { class: 'btn primary', onClick: () => compModal() }, '＋ Component…'), h('button', { class: 'btn icon', title: 'More', onClick: e => menu(e.currentTarget, [{ label: 'Convert plain components to fasteners…', onClick: () => convertFastenersModal(comps) }]) }, '⋯'))));
    const tabs = h('div', { class: 'sub-tabs' });
    const tw = h('div', { class: 'tw' });
    const srcPill = c => h('span', { class: 'pill ' + (c.grams_source === 'measured' ? 'mea' : c.grams_source === 'estimated' ? 'est' : 'auto'), title: c.grams_source === 'estimated' ? 'Estimated from the specs — weigh a few to replace it' : '' }, c.grams_source || 'manual');
    const draw = () => {
      tabs.textContent = '';
      for (const [k, l] of [['', `All ${comps.length}`], ...cats.map(c => [c, `${c} ${comps.filter(x => (x.category || 'Other') === c).length}`])]) tabs.append(h('button', { 'aria-pressed': String(st.cat === k), onClick: () => { st.cat = k; S.cache.libcat = k; draw(); } }, l));
      const q = st.q.toLowerCase();
      let rows = comps.filter(c => (!st.cat || (c.category || 'Other') === st.cat) && (!q || (c.name + ' ' + (c.category || '') + ' ' + (c.vendor || '') + ' ' + (c.part_number || '') + ' ' + fastenerSpecText(c.specs) + ' ' + (c.notes || '')).toLowerCase().includes(q)));
      // fasteners in thread-then-length order within their category, everything else by name
      rows = rows.slice().sort((a, b) => (a.category || 'Other').localeCompare(b.category || 'Other') || ((a.kind === 'fastener') && (b.kind === 'fastener') ? (specSort(a)[0] - specSort(b)[0] || specSort(a)[1] - specSort(b)[1]) : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      tw.textContent = '';
      const anyF = rows.some(c => c.kind === 'fastener');
      tw.append(h('table', { class: 'libtbl', dataset: { tkey: anyF ? 'lib-components-f' : 'lib-components' } }, h('thead', null, h('tr', null, h('th', null, 'Component'), h('th', null, 'Category'), anyF && h('th', null, 'Specs'), h('th', { class: 'num' }, 'Weight g'), h('th', null, 'Source'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Used'), h('th', { class: 'nosort' }))),
        h('tbody', null, ...rows.map(c => h('tr', null,
          h('td', { class: 'wrap cname' }, c.name, c.link && h('a', { href: c.link, target: '_blank', rel: 'noopener', class: 'src', style: { textTransform: 'none' } }, ' link ↗'),
            (c.vendor || c.part_number || c.dimensions) && h('span', { class: 'sub' }, [c.vendor, c.part_number && h('span', { class: 'mono' }, c.part_number), c.dimensions].filter(Boolean).flatMap((x, i) => i ? [' · ', x] : [x])), c.notes && h('span', { class: 'sub' }, c.notes)),
          edCell(c.category, v => api('PUT', `components/${c.id}`, { category: v }).then(() => { c.category = v; if (!cats.includes(v)) { cats.push(v); cats.sort(); catDatalist(cats); } }), { list: 'cat-list' }),
          anyF && h('td', { class: 'wrap specs', dataset: { sort: String(specSort(c)[0] * 1000 + specSort(c)[1]) } }, c.kind === 'fastener' ? fastenerSpecText(c.specs) : ''),
          edCell(c.grams, v => api('PUT', `components/${c.id}`, { grams: v, grams_source: 'manual', propagate: true }).then(() => { c.grams = v; c.grams_source = 'manual'; draw(); }), { type: 'number', cls: 'num', fmt: v => fmt(v, 2) }),
          h('td', null, srcPill(c)),
          edCell(c.price, v => api('PUT', `components/${c.id}`, { price: v }).then(() => { c.price = v; }), { type: 'number', cls: 'num', fmt: v => Number(v).toFixed(2), placeholder: '' }),
          h('td', { class: 'num' }, c.uses || 0),
          h('td', { class: 'acts' },
            h('button', { class: 'btn icon', title: 'Duplicate — same specs, change the length or weight and save as a new component', 'aria-label': 'Duplicate', onClick: () => compModal(c, { duplicate: true }) }, '⧉'),
            h('button', { class: 'btn icon', onClick: e => menu(e.currentTarget, [
            { label: 'Weigh-in (update everywhere)…', onClick: () => { const g = input({ type: 'number', step: '0.01' }); modal(`Weigh ${c.name}`, field('Measured (g)', g), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { await api('POST', `components/${c.id}/weighins`, { grams: parseFloat(g.value), propagate: true }); render(); } }]); } },
            { label: 'Edit…', onClick: () => compModal(c) },
            { label: 'Duplicate…', onClick: () => compModal(c, { duplicate: true }) },
            c.kind === 'fastener' && c.specs && { label: 'Estimate weight from specs', onClick: async () => { const g = fastenerEstimate(c.specs); if (g == null) return toast('Need at least a thread size and length', true); await api('PUT', `components/${c.id}`, { grams: +g.toFixed(3), grams_source: 'estimated', propagate: true }); render(); } },
            S.robot && { label: `Add to ${S.robot.name}`, onClick: () => fromLibraryModal() },
            '-', { label: 'Delete', cls: 'danger', onClick: () => confirmModal(`Delete “${c.name}” from the library? Robot lines keep their values.`, async () => { await api('DELETE', `components/${c.id}`); render(); }) }].filter(Boolean)) }, '⋯'),
            h('button', { class: 'btn icon del', title: c.uses ? `Delete from the library (used on ${c.uses} robot line${c.uses === 1 ? '' : 's'} — those keep their values; undo with Ctrl/⌘+Z)` : 'Delete from the library (undo with Ctrl/⌘+Z)', 'aria-label': 'Delete component', onClick: async () => { try { await api('DELETE', `components/${c.id}`); const i = comps.indexOf(c); if (i >= 0) comps.splice(i, 1); draw(); toastUndo(`Deleted “${c.name}”`); } catch (e) { fail(e); } } }, '✕')))))));
      if (!rows.length) tw.append(h('p', { class: 'empty' }, 'Nothing matches.'));
    };
    search.addEventListener('input', () => { st.q = search.value; S.cache.libq = st.q; draw(); });
    m.append(tabs, tw); draw();
  };
  // One-off helper for libraries built before fasteners existed: every plain component whose name parses as a fastener
  // is listed with the specs it would get; tick the ones to convert (and whether to rename them to the standard label).
  async function convertFastenersModal(comps) {
    const cands = comps.filter(c => c.kind !== 'fastener').map(c => ({ c, sp: parseFastenerName(c.name) })).filter(x => x.sp.thread);
    if (!cands.length) return toast('No plain components with a fastener-looking name (M3x12, #6-32 x 3/8"…) were found.');
    for (const x of cands) { x.sp.type = x.sp.type || 'screw'; x.sp.length_unit = x.sp.length_unit || (/^M/.test(x.sp.thread) ? 'mm' : 'in'); x.on = true; x.rename = true; }
    const rows = cands.map(x => {
      const on = h('input', { type: 'checkbox', checked: true, onChange: e => { x.on = e.target.checked; } });
      const rn = h('input', { type: 'checkbox', checked: true, onChange: e => { x.rename = e.target.checked; } });
      const lbl = fastenerLabel(x.sp);
      return h('tr', null, h('td', null, on), h('td', null, x.c.name, h('span', { class: 'sub' }, x.c.category || '')), h('td', { class: 'specs' }, fastenerSpecText(x.sp)), h('td', null, h('label', { class: 'tb', style: { gap: '6px' } }, rn, h('span', { class: 'prof' }, lbl || '—'))));
    });
    modal('Convert plain components to fasteners', h('div', null,
      h('p', { class: 'hint', style: { marginTop: 0 } }, `${cands.length} component${cands.length === 1 ? '' : 's'} have a name that reads as a fastener. Converting keeps the weight, price, link and notes and adds the parsed specs (thread, length, head, material) — open one afterwards to fill in what the name did not say. Tick “rename” to use the standard label; untick to keep your wording.`),
      h('div', { class: 'tw', style: { maxHeight: '55vh', overflow: 'auto' } }, h('table', { class: 'nores' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Component'), h('th', null, 'Parsed specs'), h('th', null, 'Rename to'))), h('tbody', null, ...rows)))),
      [{ label: 'Cancel' }, { label: 'Convert ticked', cls: 'primary', onClick: async () => {
        let n = 0;
        for (const x of cands) {
          if (!x.on) continue;
          const body = { kind: 'fastener', specs: x.sp, category: x.c.category || 'Fasteners' };
          if (x.rename && fastenerLabel(x.sp)) body.name = fastenerLabel(x.sp);
          await api('PUT', `components/${x.c.id}`, body); n++;
        }
        toast(`${n} component${n === 1 ? '' : 's'} converted`); render();
      } }], { width: 'min(1100px, 96vw)' });
  }
  function catDatalist(cats) {
    let dl = document.getElementById('cat-list');
    if (!dl) { dl = h('datalist', { id: 'cat-list' }); document.body.append(dl); }
    dl.textContent = ''; for (const c of cats || S.cache.cats || []) dl.append(h('option', { value: c }));
    return dl;
  }
  function optList(id, values) {
    let dl = document.getElementById(id);
    if (!dl) { dl = h('datalist', { id }); document.body.append(dl); }
    dl.textContent = ''; for (const v of values) dl.append(h('option', { value: v }));
    return id;
  }
  // c: existing component (edit), or a template; opts.duplicate saves a copy, opts.isNew saves a new one from a template
  function compModal(c, opts = {}) {
    catDatalist();
    const isEdit = !!(c && c.id && !opts.duplicate);
    const kind = { v: (c && c.kind) || 'generic' };
    const sp = Object.assign({ type: 'screw', length_unit: 'mm' }, (c && c.specs) || {});
    const f = { name: input({ value: c?.name || '' }), category: input({ value: c?.category || '', list: 'cat-list', autocomplete: 'off' }), vendor: input({ value: c?.vendor || '', list: optList('vendor-list', ['McMaster-Carr', 'Bolt Depot', 'Amazon', 'AliExpress', 'Fingertech', 'Repeat Robotics', 'Just Cuz Robotics', 'Pololu', 'ServoCity']), autocomplete: 'off' }), part_number: input({ value: c?.part_number || '', placeholder: 'e.g. 91290A115', class: 'mono' }), link: input({ value: c?.link || '' }), price: input({ type: 'number', value: c?.price ?? '', step: '0.01', placeholder: 'each' }), dimensions: input({ value: c?.dimensions || '' }), grams: input({ type: 'number', value: c?.grams ?? '', step: '0.001' }), notes: h('textarea', null, c?.notes || '') };
    let gramsSource = c?.grams_source || 'manual';
    f.grams.addEventListener('input', () => { gramsSource = 'manual'; srcLbl.textContent = ''; });
    const srcLbl = h('span', { class: 'rng' }, c?.grams_source === 'estimated' ? 'estimated from specs' : c?.grams_source === 'measured' ? 'measured' : '');
    // --- fastener form
    const auto = h('input', { type: 'checkbox', checked: !c?.name || (c.kind === 'fastener' && fastenerLabel(c.specs) === c.name) });
    const preview = h('span', { class: 'prof' });
    const sf = {};
    const mk = (key, attrs = {}, list) => { const el = input(Object.assign({ value: sp[key] ?? '' }, attrs, list ? { list: optList('fl-' + key, list), autocomplete: 'off' } : {})); el.addEventListener('input', () => { sp[key] = el.type === 'number' ? (el.value === '' ? '' : parseFloat(el.value)) : el.value; sync(); }); sf[key] = el; return el; };
    const typeSel = select(FT.types, sp.type, { onChange: e => { sp.type = e.target.value; drawSpecs(); sync(); } });
    // length as text so inches can be typed the way they are sold (5/16, 1-1/4); shown back as a fraction on blur
    const lenShown = () => sp.length == null || sp.length === '' ? '' : (sp.length_unit === 'in' ? fracIn(sp.length).replace('"', '') : String(sp.length));
    const lenInput = () => { const el = input({ value: lenShown(), inputmode: 'decimal', placeholder: sp.length_unit === 'in' ? '5/16' : '12', style: { width: '90px' } }); el.addEventListener('input', () => { const v = parseLen(el.value); sp.length = v == null ? '' : v; el.classList.toggle('bad', !!el.value.trim() && v == null); sync(); }); el.addEventListener('blur', () => { if (sp.length !== '' && sp.length != null) el.value = lenShown(); }); sf.length = el; return el; };
    const unitSel = select([['mm', 'mm'], ['in', 'inch']], sp.length_unit || 'mm', { style: { width: '80px' }, onChange: e => { sp.length_unit = e.target.value; drawSpecs(); sync(); } });
    const specBox = h('div', { class: 'specform' });
    const estBtn = h('button', { class: 'btn small', title: 'Rough mass from the thread size, length, head style and material (±15 %). Marked “estimated” until you weigh one.', onClick: () => { const g = fastenerEstimate(sp); if (g == null) return toast('Need at least a thread size (and a length for screws)', true); f.grams.value = g.toFixed(3); gramsSource = 'estimated'; srcLbl.textContent = 'estimated from specs'; } }, 'Estimate from specs');
    const drawSpecs = () => {
      specBox.textContent = '';
      const t = sp.type;
      const threads = sp.thread && /^#|\/|"/.test(sp.thread) ? FT.imperial : sp.thread ? FT.metric : [...FT.metric, ...FT.imperial];
      specBox.append(field('Type', typeSel), field('Thread', h('div', { class: 'tb' }, mk('thread', { placeholder: 'M3, #6-32, 1/4"-20', style: { width: '130px' } }, [...FT.metric, ...FT.imperial]), h('span', { class: 'rng' }, 'pitch'), mk('pitch', { placeholder: 'mm or TPI', style: { width: '90px' } }))));
      if (t !== 'nut' && t !== 'washer') specBox.append(field('Length', h('div', { class: 'tb' }, lenInput(), unitSel, h('span', { class: 'rng' }, sp.length_unit === 'in' ? 'fractions welcome: 5/16, 1-1/4' : ''), t === 'screw' && h('label', { class: 'rng' }, select([['full', 'fully threaded'], ['partial', 'partially threaded']], sp.thread_type || 'full', { style: { width: 'auto' }, onChange: e => { sp.thread_type = e.target.value; sync(); } })))));
      if (t === 'screw' || t === 'other') specBox.append(field('Screw type', mk('screw_type', { placeholder: 'machine screw, thread-forming (Plastite)…' }, FT.screwTypes)), field('Head', mk('head', { placeholder: 'socket head, button head…' }, FT.heads)), field('Drive', mk('drive', { placeholder: 'hex (Allen), Torx…' }, FT.drives)), field('Head size', h('div', { class: 'tb' }, h('span', { class: 'rng' }, '⌀'), mk('head_dia', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), h('span', { class: 'rng' }, 'height'), mk('head_height', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), h('span', { class: 'rng' }, 'optional — improves the estimate'))));
      if (t === 'nut' || t === 'insert') specBox.append(field('Nut type', mk('nut_type', { placeholder: 'hex nut, nylon-insert lock nut…' }, FT.nutTypes)), field('Size', h('div', { class: 'tb' }, h('span', { class: 'rng' }, 'across flats'), mk('across_flats', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), h('span', { class: 'rng' }, 'thickness'), mk('thickness', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), t === 'insert' && h('span', { class: 'rng' }, 'OD'), t === 'insert' && mk('od', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }))));
      if (t === 'washer') specBox.append(field('Washer type', mk('washer_type', { placeholder: 'flat washer, split lock…' }, FT.washerTypes)), field('Size', h('div', { class: 'tb' }, h('span', { class: 'rng' }, 'OD'), mk('od', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), h('span', { class: 'rng' }, 'ID'), mk('id', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), h('span', { class: 'rng' }, 'thickness'), mk('thickness', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }))));
      if (t === 'standoff') specBox.append(field('Shape', h('div', { class: 'tb' }, select([['hex', 'hex'], ['round', 'round']], sp.shape || 'hex', { style: { width: 'auto' }, onChange: e => { sp.shape = e.target.value; sync(); } }), h('span', { class: 'rng' }, 'across flats / ⌀'), mk('across_flats', { type: 'number', step: 'any', style: { width: '80px' }, placeholder: 'mm' }), select([['female-female', 'female–female'], ['male-female', 'male–female'], ['male-male', 'male–male']], sp.gender || 'female-female', { style: { width: 'auto' }, onChange: e => { sp.gender = e.target.value; sync(); } }))));
      specBox.append(field('Material', mk('material', { placeholder: 'alloy steel, 18-8 stainless…' }, FT.materials)), field('Finish', mk('finish', { placeholder: 'black oxide, plain…' }, FT.finishes)), field('Grade / class', mk('grade', { placeholder: '12.9, A2-70, grade 8…', style: { width: '160px' } })));
      specBox.append(field('Weight', h('div', { class: 'tb' }, estBtn, srcLbl)));
    };
    const sync = () => { preview.textContent = fastenerLabel(sp) || '—'; if (auto.checked) f.name.value = fastenerLabel(sp); };
    auto.addEventListener('change', sync);
    const fastBox = h('div', { hidden: kind.v !== 'fastener' }, specBox, field('Label', h('div', null, h('label', { class: 'tb' }, auto, h('span', null, 'name it from the specs: '), preview), h('p', { class: 'hint', style: { margin: '2px 0 0' } }, 'Untick to type your own name below.'))));
    const kindSeg = h('div', { class: 'seg' }, ...[['generic', 'Component'], ['fastener', 'Fastener']].map(([k, l]) => h('button', { 'aria-pressed': String(kind.v === k), onClick: e => { kind.v = k; [...e.currentTarget.parentNode.children].forEach(b => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); fastBox.hidden = k !== 'fastener'; if (k === 'fastener') { if (!f.category.value) f.category.value = 'Fasteners'; if (!sp.thread && f.name.value) { Object.assign(sp, parseFastenerName(f.name.value)); drawSpecs(); auto.checked = false; } sync(); } } }, l)));
    drawSpecs(); if (kind.v === 'fastener') sync();
    const title = isEdit ? 'Edit component' : opts.duplicate ? `Duplicate “${c.name}”` : 'New component';
    modal(title, h('div', { class: 'cdlg' },
      opts.duplicate && h('p', { class: 'hint', style: { marginTop: 0 } }, 'A copy with the same details. Change what differs — usually the length and the weight — and save it as a new component.'),
      field('Kind', kindSeg),
      fastBox,
      field('Name', f.name), field('Category', f.category),
      h('div', { class: 'grid2' }, h('div', null, field('Vendor', f.vendor), field('Part number', f.part_number), field('Link', f.link)), h('div', null, field('Price (each)', f.price), field('Weight (g)', f.grams), field('Dimensions', f.dimensions))),
      field('Notes', f.notes)),
      [{ label: 'Cancel' }, { label: isEdit ? 'Save' : 'Create', cls: 'primary', onClick: async () => {
        if (!f.name.value.trim()) { toast('Give it a name', true); return false; }
        const body = { name: f.name.value.trim(), category: f.category.value || 'Other', vendor: f.vendor.value || null, part_number: f.part_number.value || null, link: f.link.value || null, price: f.price.value === '' ? null : parseFloat(f.price.value), dimensions: f.dimensions.value || null, grams: f.grams.value === '' ? null : parseFloat(f.grams.value), grams_source: f.grams.value === '' ? 'manual' : gramsSource, notes: f.notes.value || null, kind: kind.v, specs: kind.v === 'fastener' ? sp : null };
        if (opts.duplicate && c.grams_source === 'measured' && body.grams === c.grams && kind.v === 'fastener' && lenMm(sp) !== lenMm(c.specs || {})) body.grams_source = 'manual';   // a different length is not the measured one
        if (isEdit) await api('PUT', `components/${c.id}`, Object.assign(body, { propagate: true })); else await api('POST', 'components', body);
        render();
      } }], { width: '760px' });
    if (opts.duplicate && sf.length) setTimeout(() => { sf.length.focus(); sf.length.select(); }, 60);
  }

  // ---------------------------------------------------------------- filaments & profiles
  function importFilaments() {
    const inp = h('input', { type: 'file', accept: '.json,.3mf', multiple: true });
    inp.addEventListener('change', async () => {
      let made = 0, kept = 0;
      for (const f of inp.files) {
        try {
          const r = await api('POST', 'filaments/import', await f.arrayBuffer(), { headers: { 'X-Filename': encodeURIComponent(f.name) } });
          made += r.created.length; kept += r.reused.length;
        } catch (e) { fail(e); }
      }
      await loadState(); renderMain();
      toast(`${made} filament${made === 1 ? '' : 's'} imported${kept ? ` · ${kept} already in the library` : ''}`);
    });
    inp.click();
  }
  V.filaments = function (m) {
    const st = S.state;
    m.append(h('div', { class: 'head' }, h('div', null, h('h1', null, 'Filaments & profiles'), h('p', null, 'Densities from Bambu Studio’s filament profiles; corrections from your scale. Profiles are Bambu Studio vocabulary and are mapped to PrusaSlicer when slicing.')),
      h('div', { class: 'tb' }, h('button', { class: 'btn', onClick: () => filModal() }, '＋ Filament…'),
        h('button', { class: 'btn', title: 'Pick a filament preset exported from Bambu Studio (.json) or any Bambu Studio project (.3mf): density, flow ratio and max volumetric speed are taken from it', onClick: () => importFilaments() }, 'Import from Bambu Studio…'),
        h('button', { class: 'btn primary', onClick: () => editProfileModal(null) }, '＋ Profile…'))));
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
      h('div', { class: 'card' }, h('h3', null, 'Filaments'), h('div', { class: 'tw' }, h('table', { dataset: { tkey: 'lib-filaments' } }, h('thead', null, h('tr', null, h('th', null, 'Filament'), h('th', null, 'Material'), h('th', { class: 'num' }, 'ρ g/cm³'), h('th', { class: 'num' }, 'Flow'), h('th', { class: 'num', title: 'Max volumetric speed (mm³/s) — caps print speed, affects time only' }, 'mm³/s'), h('th', { class: 'num' }, 'Correction'), h('th', { class: 'num' }, '$/kg'), h('th'))), ftb)), h('p', { class: 'hint' }, 'Correction = median of (measured ÷ sliced) over weighed parts using the filament. Shown estimates are slicer × correction.')),
      h('div', { class: 'card' }, h('h3', null, 'Profiles'), h('div', { class: 'tw' }, h('table', { dataset: { tkey: 'lib-profiles' } }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Nozzle'), h('th', null, 'String'), h('th', null, 'Notes'), h('th'))), ptb)), h('p', { class: 'hint' }, 'Built-in profiles reproduce Bambu Studio’s system defaults (with cubic instead of grid). Layer counts are exact (min shell thickness 0); set a min shell thickness on a profile if you want Bambu Studio’s “1.0 mm or N layers, whichever is more” behaviour.'),
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
      qtb.append(h('tr', { dataset: { key: 'j' + x.id } }, h('td', null, h('span', { class: 'dot ' + x.status }), x.status), h('td', null, x.part_name || `part #${x.part_id}`), h('td', { class: 'prof' }, pr ? profString(pr) : ''), h('td', null, x.purpose || ''), h('td', { class: 'num' }, x.status === 'running' ? secs((Date.now() / 1000) - x.started) : (x.time_s != null ? secs(x.time_s) : '')), h('td', { class: 'num' }, x.grams != null ? fmt(x.grams, 2) + ' g' : (x.error ? h('span', { class: 'err', title: x.error }, x.error.slice(0, 60)) : ''))));
    }
    left.append(h('div', { class: 'card' }, h('h3', null, `Queue · ${j.state.running} running · ${j.state.queued} queued`, h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => api('POST', 'jobs/cancel', {}).then(render) }, 'Cancel queued'), h('button', { class: 'btn small', onClick: () => api('POST', 'jobs/retry_errors', {}).then(render) }, 'Retry errors'))),
      h('div', { class: 'tw', style: { maxHeight: '420px', overflow: 'auto' } }, h('table', { dataset: { tkey: 'jobs' } }, h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Part'), h('th', null, 'Profile'), h('th', null, 'Purpose'), h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Result'))), qtb)), !j.jobs.length && h('p', { class: 'hint' }, 'No jobs yet.')));
    // right: cache, printers, data
    right.append(h('div', { class: 'card' }, h('h3', null, 'Cache'), h('dl', { class: 'kv' }, h('dt', null, 'Slices cached'), h('dd', null, j.cache.done), h('dt', null, 'Slicer time spent'), h('dd', null, secs(j.cache.time_s))), h('div', { class: 'tb', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onClick: () => confirmModal('Clear all cached slice results? Parts will re-slice as needed.', async () => { await api('POST', 'jobs/clear_cache', {}); render(); }, 'Clear') }, 'Clear cache'))));
    right.append(h('div', { class: 'card' }, h('h3', null, 'Printers', h('div', { class: 'tb' }, h('button', { class: 'btn small', onClick: () => printerModal(), title: 'Add a printer…', 'aria-label': 'Add a printer' }, '＋'))), h('div', { class: 'tw' }, h('table', null, h('tbody', null, ...st.printers.map(p => h('tr', null, h('td', null, h('b', null, p.name)), h('td', null, p.nozzles.join(' · ') + ' mm'), h('td', { class: 'rng' }, `${p.bed.x} × ${p.bed.y} × ${p.bed.z}`), h('td', null, h('button', { class: 'btn icon', onClick: () => printerModal(p) }, '✎'))))))),
      h('div', { class: 'field', style: { marginTop: '8px' } }, h('label', null, 'Default printer'), select(st.printers.map(p => [p.id, p.name]), st.settings.default_printer_id, { onChange: e => api('PUT', 'settings', { default_printer_id: +e.target.value }) })),
      h('div', { class: 'field' }, h('label', null, 'Default filament'), select(st.filaments.map(f => [f.id, f.name]), st.settings.default_filament_id, { onChange: e => api('PUT', 'settings', { default_filament_id: +e.target.value }) })),
      h('div', { class: 'field' }, h('label', null, 'Default profile'), select(st.profiles.map(p => [p.id, p.name]), st.settings.default_profile_id, { onChange: e => api('PUT', 'settings', { default_profile_id: +e.target.value }) }))));
    right.append(h('div', { class: 'card' }, h('h3', null, 'Data & updates'), h('dl', { class: 'kv' },
        h('dt', null, 'Your data'), h('dd', { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all', textAlign: 'left' } }, st.root + '/data'),
        h('dt', null, 'App'), h('dd', { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all', textAlign: 'left' } }, st.install_dir || ''),
        h('dt', null, 'Version'), h('dd', null, st.version, st.portable ? h('span', { class: 'pill auto', style: { marginLeft: '6px' } }, 'portable') : null)),
      h('p', { class: 'hint' }, st.portable ? 'Portable mode: data lives inside the app folder (portable.txt is present).' : 'Data lives in your user folder, separate from the app, so any version finds it. Update from here, or unzip a new version anywhere and start it.'),
      dataLocationPanel(st),
      updatePanel(st),
      h('div', { class: 'tb', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onClick: async () => { const r = await api('POST', 'backup'); toast('Backup written: ' + r.file); } }, 'Back up now'), S.robot && h('button', { class: 'btn small', onClick: () => window.open(`/api/robots/${S.robotId}/export/archive`) }, 'Export robot archive'), h('button', { class: 'btn small', onClick: importArchive }, 'Import robot archive'))));
    // diagnostics: the log, live, and a bundle to send along with a bug report
    const logPre = h('pre', { class: 'log' }, 'loading…');
    const lvl = select([['all', 'Everything'], ['warn', 'Warnings & errors']], S.cache.loglvl || 'all', { style: { width: '170px' } });
    const drawLog = async () => {
      try {
        const r = await api('GET', 'log?n=400');
        let lines = r.lines || [];
        if (lvl.value === 'warn') lines = lines.filter(l => / (WARN|ERROR|CRITICAL)\S* /.test(l));
        logPre.textContent = lines.slice(-250).map(l => l.replace(' makeweight:', '').replace(/ Thread-\d+ \(process_request_thread\)/, ' http')).join('\n') || '(empty)';
        logPre.scrollTop = logPre.scrollHeight;
        logPre.dataset.file = r.file || '';
      } catch (e) { logPre.textContent = 'could not load the log: ' + e.message; }
    };
    lvl.addEventListener('change', () => { S.cache.loglvl = lvl.value; drawLog(); });
    const diag = h('div', { class: 'card' }, h('h3', null, 'Diagnostics', h('div', { class: 'tb' }, lvl,
        h('button', { class: 'btn small', onClick: drawLog }, 'Refresh'),
        h('button', { class: 'btn small', onClick: async () => { try { await navigator.clipboard.writeText(logPre.textContent); toast('Log copied'); } catch { toast('Select the text and copy it manually', true); } } }, 'Copy'),
        h('button', { class: 'btn small primary', onClick: () => window.open('/api/diagnostics') }, 'Download diagnostics bundle'))),
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Installs, every slicer run, job failures and server errors are recorded here. If something fails, download the bundle (log + environment facts, no robot data) and send it along with the bug report.'),
      logPre,
      h('p', { class: 'hint' }, 'Full log file: ', h('span', { class: 'mono', style: { fontSize: '11px' } }, (st.root || '') + '/data/logs/' + (st.app ? st.app.slug : 'makeweight') + '.log')));
    left.append(diag);
    drawLog();
    if (S.logTimer) clearInterval(S.logTimer);
    S.logTimer = setInterval(() => { if (S.view === 'jobs' && document.body.contains(logPre)) drawLog(); else { clearInterval(S.logTimer); S.logTimer = null; } }, 4000);
  };
  function updatePanel(st) {
    const box = h('div', { class: 'upd' });
    const repoIn = input({ value: st.settings.update_repo || '', placeholder: 'owner/repository on GitHub', style: { width: '260px' } });
    repoIn.addEventListener('change', async () => { await api('PUT', 'settings', { update_repo: repoIn.value.trim() || null }); toast('Update source saved'); });
    const status = h('div', { class: 'hint', style: { margin: '6px 0 0' } });
    const prog = h('div', { class: 'progress', hidden: true }, h('i'));
    const result = h('div');
    const draw = (u) => {
      result.textContent = '';
      if (u && u.latest) {
        const L = u.latest;
        result.append(h('div', { class: 'callout' + (L.newer ? '' : ''), style: { marginTop: '8px' } },
          h('b', null, L.newer ? `Version ${L.version} is available` : `You have the latest version (${L.version})`), L.published ? h('span', { class: 'rng' }, ` · released ${new Date(L.published).toLocaleDateString()}`) : null,
          L.notes ? h('pre', { class: 'log', style: { maxHeight: '160px', marginTop: '6px' } }, L.notes) : null,
          h('div', { class: 'tb', style: { marginTop: '8px' } },
            L.newer && !u.portable ? h('button', { class: 'btn small primary', onClick: async () => { try { await api('POST', 'update/start'); } catch (e) { fail(e); } } }, `Update to ${L.version} now`) : null,
            L.html_url ? h('a', { href: L.html_url, target: '_blank', rel: 'noopener', class: 'btn small' }, 'Release page ↗') : null)));
      }
      if (u && u.old_versions && u.old_versions.length) result.append(h('p', { class: 'hint' }, `Older versions still on disk (safe to delete): ${u.old_versions.join(', ')}`));
    };
    const check = async () => {
      status.textContent = 'Checking GitHub…';
      try { await api('POST', 'update/check'); const u = await api('GET', 'update/status'); status.textContent = ''; draw(u); }
      catch (e) { status.textContent = e.message; }
    };
    box.append(h('div', { class: 'tb', style: { marginTop: '6px' } }, h('span', { class: 'rng' }, 'Update source'), repoIn, h('button', { class: 'btn small', onClick: check }, 'Check for updates')), status, prog, result);
    api('GET', 'update/status').then(u => { if (u.state && u.state.status === 'running') { prog.hidden = false; prog.firstChild.style.width = (u.state.progress * 100) + '%'; status.textContent = u.state.message; } draw(u); }).catch(() => { });
    S.updateWatch = (d) => {
      if (!document.body.contains(box)) { S.updateWatch = null; return; }
      prog.hidden = d.status !== 'running'; prog.firstChild.style.width = ((d.progress || 0) * 100) + '%'; status.textContent = d.message || '';
      if (d.status === 'done') waitForNewVersion();
    };
    return box;
  }
  // ---- shared data folder (the same robots/filaments/profiles on every computer, through a cloud drive)
  function dataLocationPanel(st) {
    const d = st.data || {};
    const box = h('div', { class: 'callout', style: { marginTop: '10px' } });
    box.append(h('b', null, d.shared ? 'Shared data folder' : 'Data on this computer only'), ' ',
      h('span', { class: 'mono', style: { fontSize: '11px', wordBreak: 'break-all' } }, d.root || st.root));
    if (d.unreachable) box.append(h('p', { class: 'hint', style: { color: 'var(--bad)' } }, `⚠ The shared folder ${d.unreachable} was not reachable when the app started (cloud drive not signed in or not mounted?). You are looking at this computer's own copy until it is back — restart the app once it is.`));
    if (d.lock_conflict) box.append(h('p', { class: 'hint', style: { color: 'var(--bad)' } }, `⚠ ${d.lock_conflict.host} also had MakeWeight open (last seen ${Math.round((Date.now() / 1000 - d.lock_conflict.heartbeat) / 60)} min ago). Two computers editing at the same time through a cloud drive can corrupt the database — close it on one of them.`));
    box.append(h('p', { class: 'hint' }, d.shared
      ? 'Robots, filaments, profiles and weigh-ins are read from and written to this folder; the slicer install and caches stay on this computer. Close the app on one computer and let the cloud drive finish syncing before opening it on another.'
      : 'To use the same data on more than one computer, move it into a folder your cloud drive syncs (iCloud Drive, OneDrive, Dropbox, Google Drive) and point the other computers at the same folder.'));
    box.append(h('div', { class: 'tb' },
      h('button', { class: 'btn small', onClick: () => shareDataModal(st) }, d.shared ? 'Change shared folder…' : 'Use a shared folder…'),
      d.shared ? h('button', { class: 'btn small', onClick: () => confirmModal('Stop sharing? The data is copied back to this computer and the app restarts. The shared folder is left as it is for the other computers.', async () => { await relocate({ mode: 'local', copy_back: true }); }, 'Stop sharing') }, 'Stop sharing') : null));
    return box;
  }
  async function relocate(body) {
    const r = await api('POST', 'data/relocate', body);
    if (r.needs_choice) return r;
    toast('Data folder changed — restarting…');
    waitForNewVersion(true);
    return r;
  }
  function shareDataModal(st) {
    const d = st.data || {};
    const sep = (p) => p.includes('\\') ? '\\' : '/';
    const path = input({ value: d.shared ? d.root : '', placeholder: 'full path of a folder inside your cloud drive', style: { width: '100%' } });
    const sugg = h('div', { class: 'tb', style: { flexWrap: 'wrap', marginTop: '6px' } });
    for (const c of d.cloud_folders || []) sugg.append(h('button', { class: 'btn small', title: c.path, onClick: () => { browseTo(c.path); } }, c.label));
    const status = h('p', { class: 'hint' });
    // folder picker: the browser cannot hand us a real path, so the app lists folders itself; ✓ marks one holding MakeWeight data
    const list = h('div', { class: 'fbrowse' }), crumbs = h('div', { class: 'tb', style: { flexWrap: 'wrap', gap: '4px' } });
    const found = h('div');
    let cur = null;
    const browseTo = async (p) => {
      try {
        const r = await api('GET', 'data/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
        cur = r; path.value = r.data_folder || r.path;
        crumbs.textContent = ''; list.textContent = '';
        crumbs.append(h('button', { class: 'btn small', disabled: !r.parent, title: 'Up one level', onClick: () => browseTo(r.parent) }, '↑ Up'), h('span', { class: 'mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, r.path), ...(r.has_data ? [h('span', { class: 'pill good' }, 'holds MakeWeight data')] : []));
        if (!r.dirs.length) list.append(h('div', { class: 'row rng' }, 'No subfolders'));
        for (const x of r.dirs) list.append(h('button', { class: 'row' + (x.has_data ? ' has' : ''), onClick: () => browseTo(x.path) }, h('span', { class: 'ic' }, x.has_data ? '✓' : '▸'), x.name, x.has_data ? h('span', { class: 'pill good', style: { marginLeft: 'auto' } }, 'MakeWeight data') : null));
      } catch (e) { status.textContent = e.message; }
    };
    path.addEventListener('change', () => browseTo(path.value.trim()));
    path.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); browseTo(path.value.trim()); } });
    const go = async (mode, extra = {}) => {
      status.textContent = 'Working…';
      try {
        const r = await relocate({ mode, path: path.value.trim(), ...extra });
        if (r && r.needs_choice) {
          status.textContent = '';
          confirmModal(r.message, () => go('adopt'), 'Use the data already there');
          const alt = h('button', { class: 'btn small danger', onClick: () => { document.querySelectorAll('.modal-bg').forEach(m => m.remove()); go('move', { overwrite: true }); } }, 'Replace it with this computer’s data');
          setTimeout(() => { const f = document.querySelector('.modal footer'); if (f) f.prepend(alt); }, 30);
          return false;
        }
      } catch (e) { status.textContent = e.message; return false; }
    };
    modal('Share data between computers', h('div', null,
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Pick a folder that your cloud drive syncs. On the first computer choose “Move my data there”; on every other computer point at the same folder and choose “Use the data already there”. The folder is the one that contains the app’s data folder (choosing the data folder itself works too). Each computer keeps its own slicer install and caches.'),
      field('Folder', path),
      (d.cloud_folders || []).length ? h('div', null, h('span', { class: 'rng' }, 'Cloud drives on this computer — click to open:'), sugg) : h('p', { class: 'hint' }, 'No cloud-drive folder was detected automatically; type the path of one (it must already be syncing).'),
      found,
      h('div', { class: 'fpick' }, crumbs, list),
      status),
      [{ label: 'Cancel' }, { label: 'Use the data already there', onClick: () => go('adopt') }, { label: 'Move my data there', cls: 'primary', onClick: () => go('move') }], { width: '720px', enterSubmits: false });
    browseTo(d.shared ? d.root : ((d.cloud_folders || [])[0] || {}).path || '');
    // look through the cloud drives for folders that already hold MakeWeight data (another computer's "Move my data there")
    api('GET', 'data/browse?scan=1').then(r => {
      if (!r.found || !r.found.length) return;
      found.append(h('div', { class: 'hint', style: { margin: '6px 0 0' } }, 'MakeWeight data found in your cloud drives: '), ...r.found.map(f => h('button', { class: 'btn small', style: { margin: '4px 4px 0 0' }, title: f, onClick: () => browseTo(f) }, '✓ ' + f.split(/[\\/]/).slice(-2).join(sep(f)))));
    }).catch(() => { });
  }
  async function waitForNewVersion(sameVersion) {
    const was = S.state.version, wasRoot = (S.state.data || {}).root;
    if (!sameVersion) toast('Updating — the new version is starting, this page will reload.');
    let sawDown = false;
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        if (r.status === 503) { sawDown = true; continue; }
        if (r.ok) { const j = await r.json(); if ((j.version && j.version !== was) || (sameVersion && (sawDown || (j.data && j.data.root !== wasRoot)))) { location.reload(); return; } }
      } catch { sawDown = true; }
    }
    toast('The new version did not come back on this address — check the window that opened.', true);
  }
  function printerModal(p) {
    const name = input({ value: p?.name || '' }), noz = input({ value: p ? p.nozzles.join(', ') : '0.4, 0.6' }), bx = input({ type: 'number', value: p?.bed.x ?? 256, style: { width: '80px' } }), by = input({ type: 'number', value: p?.bed.y ?? 256, style: { width: '80px' } }), bz = input({ type: 'number', value: p?.bed.z ?? 256, style: { width: '80px' } });
    modal(p ? 'Edit printer' : 'New printer', h('div', null, field('Name', name), field('Nozzles (mm)', noz), field('Bed X × Y × Z', h('div', { class: 'tb' }, bx, '×', by, '×', bz))),
      [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => { const body = { name: name.value, nozzles: noz.value.split(/[,\s]+/).filter(Boolean).map(Number), bed: { x: +bx.value, y: +by.value, z: +bz.value } }; if (p) await api('PUT', `printers/${p.id}`, body); else await api('POST', 'printers', body); await loadState(); render(); } }]);
  }

  // ------------------------------------------------------------ render loop
  async function refreshRobot(rerender = true) { if (S.robotId) await loadRobot(S.robotId); renderShell(); if (rerender && ['sheet', 'parts'].includes(S.view)) await softRender(); }
  let rendering = false;
  async function renderMain() {
    const m = $('#main'); const sy = window.scrollY, st = m.scrollTop;
    S.partRefresh = null; S.partFullPending = false;
    m.textContent = '';
    const fn = V[S.view] || V.home;
    try { await fn(m); } catch (e) { m.append(h('div', { class: 'empty' }, 'Something went wrong: ' + e.message)); console.error(e); }
    requestAnimationFrame(() => { window.scrollTo(0, sy); m.scrollTop = st; fitTables(); });
  }
  // Tables keep sticky column headers as long as they fit their card; one that is wider scrolls sideways instead.
  function fitTables() {
    relayoutCols();
    for (const w of document.querySelectorAll('#main .tw')) {
      w.classList.remove('wide');
      if (w.scrollWidth > w.clientWidth + 1) w.classList.add('wide');
    }
  }
  window.addEventListener('resize', () => { clearTimeout(S.fitTimer); S.fitTimer = setTimeout(fitTables, 150); });
  // Background refresh (slice results landing while you work): re-render into a detached tree and patch only what
  // changed, keeping scroll position, open menus and any cell you are editing.
  // "busy" = the user is typing in it; a focused button (e.g. the one that just opened a dialog) must not pin stale content
  const busy = el => !!el.querySelector('.editing, input:focus, select:focus, textarea:focus');
  function patchRows(oldTb, newTb) {
    const oldMap = new Map([...oldTb.children].filter(r => r.dataset.key).map(r => [r.dataset.key, r]));
    let prev = null;
    for (const nr of [...newTb.children]) {
      const k = nr.dataset.key; const or = k ? oldMap.get(k) : null;
      let node = nr;
      if (or) { node = (busy(or) || or.outerHTML === nr.outerHTML) ? or : nr; oldMap.delete(k); if (node === nr) or.replaceWith(nr); }
      const want = prev ? prev.nextSibling : oldTb.firstChild;
      if (want !== node) oldTb.insertBefore(node, want);
      prev = node;
    }
    for (const r of oldMap.values()) r.remove();
    let tail = prev ? prev.nextSibling : oldTb.firstChild;
    while (tail) { const nx = tail.nextSibling; if (!tail.dataset.key) tail.remove(); tail = nx; }
  }
  function morph(oldRoot, newRoot) {
    const olds = [...oldRoot.children], news = [...newRoot.children];
    for (let i = 0; i < news.length; i++) {
      const n = news[i], o = olds[i];
      if (!o) { oldRoot.append(n); continue; }
      const ot = o.querySelector(':scope > table > tbody'), nt = n.querySelector(':scope > table > tbody');
      if (ot && nt && o.tagName === n.tagName && o.className === n.className) { patchRows(ot, nt); continue; }
      if (o.tagName === n.tagName && o.className === n.className && o.outerHTML === n.outerHTML) continue;
      if (busy(o)) continue;
      o.replaceWith(n);
    }
    for (let i = news.length; i < olds.length; i++) olds[i].remove();
  }
  async function softRender() {
    if (S.view === 'part' && S.partRefresh) { try { await S.partRefresh(); return; } catch (e) { console.error(e); } }
    if (!['sheet', 'parts', 'jobs', 'library', 'optimizer'].includes(S.view)) return renderMain();
    if (document.querySelector('.modal-bg')) { S.renderPending = true; return; }   // never yank the page under a dialog — redraw when it closes
    const tmp = h('div');
    try { await (V[S.view] || V.home)(tmp); } catch (e) { console.error(e); return; }
    morph($('#main'), tmp);
    fitTables();
  }
  async function render() { renderShell(); await renderMain(); }
  function connectSSE() {
    const es = new EventSource('/api/stream'); S.es = es;
    let timer = null;
    es.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'queue') { S.state.slicer = Object.assign(S.state.slicer, d); renderShell(); }
      if (d.type === 'install') { S.state.install = d; if (S.view === 'jobs') { clearTimeout(timer); timer = setTimeout(render, 150); } if (d.status === 'done') { loadState().then(render); toast(d.message); } if (d.status === 'error') toast(d.message, true); }
      if (d.type === 'update') { if (S.updateWatch) S.updateWatch(d); else if (d.status === 'done') waitForNewVersion(); }
      if (d.type === 'undo') { if (S.state) { S.state.undo = { undo: d.undo, redo: d.redo }; renderShell(); } }
      if (d.type === 'robot') { clearTimeout(timer); timer = setTimeout(async () => { await loadState(); if (S.robotId) await loadRobot(S.robotId).catch(() => {}); render(); }, 200); }
      if (d.type === 'job' || d.type === 'line_item') {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (S.robotId) await loadRobot(S.robotId);
          renderShell();
          if (['sheet', 'parts', 'part', 'jobs'].includes(S.view) || (S.view === 'optimizer' && S.pollRun)) softRender();
        }, 400);
      }
    };
    es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
  }
  window.addEventListener('hashchange', () => { route(); render(); });
  (async function init() {
    try {
      for (let n = 0; ; n++) {  // the service may still be starting
        try { await loadState(); if (S.state && S.state.robots) break; } catch (e) { if (n >= 20) throw e; }
        await new Promise(r => setTimeout(r, 500));
      }
      route();
      applyAppearance(loadAppearance());
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(loadAppearance()));
      const saved = +localStorage.getItem('sb.robot');
      const rid = S.state.robots.find(r => r.id === saved && r.status === 'active') ? saved : (S.state.robots.find(r => r.status === 'active') || {}).id;
      if (rid) await loadRobot(rid);
      if (!S.state.slicer.slicer && S.view === 'home') { toast('No slicer installed yet — open Jobs & setup and install Bambu Studio.', true); }
      await render(); connectSSE(); setTimeout(autoUpdateCheck, 3000); setInterval(autoUpdateCheck, 3600e3);
    } catch (e) { document.body.append(h('div', { class: 'empty' }, 'Could not reach the ' + document.title + ' service: ' + e.message)); }
  })();
  window.SB = { S, api, render, go };
})();
