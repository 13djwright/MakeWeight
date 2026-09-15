// Screenshot + recording rig for the README media.
// node rig.js shot <route> <out.png> [opts-json]      opts: {w,h,dpr,actions:[...],boxes:{name:selector},clip:selector,full}
// node rig.js rec  <route> <out.webm> <steps-json>    steps: [{move:sel|[x,y]},{click:sel},{type:[sel,text]},{wait:ms},{eval:js},{hover:sel},{wheel:[sel,dy]},{drag:[sel,dx,dy]}]
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8790/';

const CURSOR_CSS = `
#__cur{position:fixed;left:0;top:0;width:22px;height:30px;pointer-events:none;z-index:2147483647;transform:translate(-3px,-2px);transition:left .0s,top .0s;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
#__cur.click::after{content:"";position:absolute;left:-14px;top:-14px;width:40px;height:40px;border-radius:50%;border:3px solid #D95F1B;animation:__rip .45s ease-out forwards}
@keyframes __rip{from{transform:scale(.3);opacity:.9}to{transform:scale(1.2);opacity:0}}`;
const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 30"><path d="M3 2 L3 24 L8.5 18.5 L12.5 27 L16 25.5 L12 17 L19.5 17 Z" fill="#fff" stroke="#222" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

async function injectCursor(pg) {
  await pg.addStyleTag({ content: CURSOR_CSS });
  await pg.evaluate((svg) => { const d = document.createElement('div'); d.id = '__cur'; d.innerHTML = svg; document.body.appendChild(d); }, CURSOR_SVG);
}
let cur = { x: 700, y: 400 };
let REC = null;   // {dir, frames:[{file,dur}], pg}
async function snap(dur = 80) {
  if (!REC) return;
  const file = `${REC.dir}/f${String(REC.frames.length).padStart(4, '0')}.png`;
  await REC.pg.screenshot({ path: file });
  REC.frames.push({ file, dur });
}
async function hold(ms) { if (REC) await snap(ms); else await REC_pg_wait(ms); }
let REC_pg_wait = async () => {};
async function glide(pg, x, y, ms = 420) {
  const steps = Math.max(8, Math.round(ms / 16)); const sx = cur.x, sy = cur.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t;   // ease in-out
    const px = sx + (x - sx) * e, py = sy + (y - sy) * e;
    await pg.mouse.move(px, py);
    await pg.evaluate(([px, py]) => { const c = document.getElementById('__cur'); if (c) { c.style.left = px + 'px'; c.style.top = py + 'px'; } }, [px, py]);
    if (REC) { if (i % 3 === 0 || i === steps) await snap(50); } else await pg.waitForTimeout(16);
  }
  cur = { x, y };
}
async function center(pg, sel) {
  const el = typeof sel === 'string' ? await pg.waitForSelector(sel, { timeout: 8000 }) : null;
  if (!el) return sel;
  await el.scrollIntoViewIfNeeded();
  const bb = await el.boundingBox(); return [bb.x + bb.width / 2, bb.y + bb.height / 2];
}
async function clickAt(pg, sel, opts = {}) {
  const [x, y] = await center(pg, sel);
  await glide(pg, x, y, opts.ms || 300);
  await pg.evaluate(() => { const c = document.getElementById('__cur'); if (c) { c.classList.remove('click'); void c.offsetWidth; c.classList.add('click'); } });
  await pg.mouse.down(); await pg.waitForTimeout(70); await pg.mouse.up();
  if (REC) { await snap(110); await pg.waitForTimeout(opts.settle ?? 180); await snap(Math.min(opts.after ?? 220, 900)); } else await pg.waitForTimeout(opts.after ?? 350);
}
async function runSteps(pg, steps) {
  for (const s of steps) {
    if (s.wait) { await pg.waitForTimeout(REC ? Math.min(s.wait, 2500) : s.wait); if (REC) await snap(Math.min(s.wait, 600)); }
    if (s.move) { const [x, y] = await center(pg, s.move); await glide(pg, x, y, s.ms || 500); }
    if (s.click) await clickAt(pg, s.click, s);
    if (s.hover) { const [x, y] = await center(pg, s.hover); await glide(pg, x, y, s.ms || 350); await pg.waitForTimeout(200); if (REC) await snap(s.after ?? 350); else await pg.waitForTimeout(s.after ?? 500); }
    if (s.type) { const [sel, text] = s.type; await clickAt(pg, sel, { after: 150 }); for (const ch of text) { await pg.keyboard.type(ch); if (REC) await snap(55); else await pg.waitForTimeout(s.delay ?? 55); } await pg.waitForTimeout(300); if (REC) await snap(s.after ?? 250); else await pg.waitForTimeout(s.after ?? 300); }
    if (s.key) { await pg.keyboard.press(s.key); await pg.waitForTimeout(250); if (REC) await snap(s.after ?? 300); else await pg.waitForTimeout(s.after ?? 300); }
    if (s.select) { const [sel, value] = s.select; await clickAt(pg, sel, { after: 150 }); await pg.selectOption(sel, value); await pg.waitForTimeout(300); if (REC) await snap(s.after ?? 400); else await pg.waitForTimeout(s.after ?? 400); }
    if (s.eval) { const r = await pg.evaluate(s.eval); if (r !== undefined) console.log(JSON.stringify(r)); }
    if (s.wheel) { const [sel, dy] = s.wheel; const [x, y] = await center(pg, sel); await glide(pg, x, y, 300); const n = s.steps || 6; for (let i = 0; i < n; i++) { await pg.mouse.wheel(0, dy / n); await pg.waitForTimeout(40); if (REC) await snap(60); } await pg.waitForTimeout(200); if (REC) await snap(s.after ?? 400); }
    if (s.drag) { const [sel, dx, dy] = s.drag; const [x, y] = await center(pg, sel); await glide(pg, x, y, 400); await pg.mouse.down(); const n = s.steps || 30; for (let i = 1; i <= n; i++) { await pg.mouse.move(x + dx * i / n, y + dy * i / n); await pg.evaluate(([px, py]) => { const c = document.getElementById('__cur'); if (c) { c.style.left = px + 'px'; c.style.top = py + 'px'; } }, [x + dx * i / n, y + dy * i / n]); if (REC) { if (i % 2 === 0) await snap(40); } else await pg.waitForTimeout(s.dt || 20); } await pg.mouse.up(); cur = { x: x + dx, y: y + dy }; await pg.waitForTimeout(200); if (REC) await snap(s.after ?? 300); else await pg.waitForTimeout(s.after ?? 400); }
    if (s.slider) { const [sel, value] = s.slider; const el = await pg.$(sel); const bb = await el.boundingBox(); const min = +(await el.getAttribute('min') || 0), max = +(await el.getAttribute('max') || 100); const x = bb.x + 8 + (bb.width - 16) * (value - min) / (max - min); await glide(pg, x, bb.y + bb.height / 2, 400); await el.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, value); await pg.waitForTimeout(s.after ?? 300); }
    if (s.sliderSweep) { const [sel, from, to, n] = s.sliderSweep; const el = await pg.$(sel); const bb = await el.boundingBox(); const min = +(await el.getAttribute('min') || 0), max = +(await el.getAttribute('max') || 100); for (let i = 0; i <= n; i++) { const v = from + (to - from) * i / n; const x = bb.x + 8 + (bb.width - 16) * (v - min) / (max - min); await pg.mouse.move(x, bb.y + bb.height / 2); await pg.evaluate(([px, py]) => { const c = document.getElementById('__cur'); if (c) { c.style.left = px + 'px'; c.style.top = py + 'px'; } }, [x, bb.y + bb.height / 2]); await el.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await pg.waitForTimeout(30); if (REC) await snap(s.dt || 45); } cur = { x: bb.x + bb.width, y: bb.y }; if (REC) await snap(s.after ?? 350); }
    if (s.drop) {   // drop files onto a drop zone: {drop:[sel, [paths]]}
      const [sel, paths] = s.drop; const [x, y] = await center(pg, sel); await glide(pg, x, y, 600);
      const files = paths.map(p => ({ name: p.split('/').pop(), b64: fs.readFileSync(p).toString('base64') }));
      await pg.evaluate(async ({ sel, files }) => {
        const dt = new DataTransfer();
        for (const f of files) { const bin = atob(f.b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); dt.items.add(new File([arr], f.name, { type: 'model/stl' })); }
        const el = document.querySelector(sel);
        for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, { sel, files });
      await pg.waitForTimeout(600); if (REC) await snap(s.after ?? 800);
    }
    if (s.scroll) { const el = await pg.waitForSelector(s.scroll, { timeout: 8000 }); await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'smooth' })); for (let i = 0; i < 6; i++) { await pg.waitForTimeout(80); if (REC) await snap(50); } if (REC) await snap(s.after ?? 350); }
    if (s.goto) { await pg.evaluate((r) => { location.hash = r; }, s.goto); await pg.waitForTimeout(900); if (REC) await snap(s.after ?? 500); }
    if (s.pause) { if (REC) await snap(s.pause); else await pg.waitForTimeout(s.pause); }
    if (s.hold) await snap(s.hold);
  }
}

(async () => {
  const [mode, route, out, optsJson] = process.argv.slice(2);
  const opts = optsJson ? JSON.parse(optsJson) : {};
  const w = opts.w || 1440, h = opts.h || 900;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: opts.dpr || (mode === 'rec' ? 1 : 2), colorScheme: 'light' });
  await ctx.addInitScript((id) => { try { localStorage.setItem('sb.robot', String(id)); } catch (e) {} }, opts.robot || process.env.ROBOT || 1);
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(BASE + route); await pg.waitForTimeout(opts.settle || 1600);
  if (mode === 'rec') { await injectCursor(pg); await glide(pg, w * 0.55, h * 0.5, 10); const dir = out.replace(/\.[a-z]+$/, '') + '_frames'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); REC = { dir, frames: [], pg }; await pg.waitForTimeout(400); await snap(600); }
  if (mode === 'shot') {
    if (opts.actions) await runSteps(pg, opts.actions);
    await pg.waitForTimeout(400);
    const boxes = {};
    for (const [name, sel] of Object.entries(opts.boxes || {})) { const el = await pg.$(sel); if (el) { const bb = await el.boundingBox(); if (bb) boxes[name] = bb; } }
    if (opts.clip) { const el = await pg.$(opts.clip); await el.screenshot({ path: out }); } else await pg.screenshot({ path: out, fullPage: !!opts.full });
    fs.writeFileSync(out.replace(/\.png$/, '.boxes.json'), JSON.stringify(boxes));
  } else {
    await runSteps(pg, JSON.parse(optsJson || '[]'));
    await snap(1100);
    // ffmpeg concat list with per-frame durations
    const list = REC.frames.map(f => `file '${require('path').basename(f.file)}'\nduration ${(f.dur / 1000).toFixed(3)}`).join('\n') + `\nfile '${require('path').basename(REC.frames[REC.frames.length - 1].file)}'\n`;
    fs.writeFileSync(REC.dir + '/list.txt', list);
    console.log('frames', REC.frames.length, 'total', (REC.frames.reduce((a, f) => a + f.dur, 0) / 1000).toFixed(1) + 's', 'list', REC.dir + '/list.txt');
  }
  console.log('errors:', JSON.stringify(errs));
  await b.close();
})();
