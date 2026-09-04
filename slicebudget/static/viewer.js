/* Minimal WebGL STL viewer: orbit, zoom, pan, bed grid, face picking, coplanar-face highlight. */
(function () {
  const VS = `attribute vec3 p; attribute vec3 n; attribute float h;
    uniform mat4 mvp; uniform mat4 mv; varying vec3 vn; varying float vh;
    void main(){ gl_Position = mvp * vec4(p,1.0); vn = mat3(mv) * n; vh = h; }`;
  const FS = `precision mediump float; varying vec3 vn; varying float vh; uniform vec3 base; uniform vec3 hl; uniform vec3 bed;
    void main(){ vec3 nn = normalize(vn); float d = max(dot(nn, normalize(vec3(0.3,0.5,1.0))),0.0);
      float d2 = max(dot(nn, normalize(vec3(-0.6,-0.2,0.4))),0.0)*0.35;
      vec3 c = vh > 1.5 ? bed : (vh > 0.5 ? hl : base);
      gl_FragColor = vec4(c * (0.35 + 0.6*d + d2), 1.0); }`;
  const LVS = `attribute vec3 p; attribute vec3 c; uniform mat4 mvp; varying vec3 vc; void main(){ gl_Position = mvp*vec4(p,1.0); vc=c; }`;
  const LFS = `precision mediump float; varying vec3 vc; void main(){ gl_FragColor = vec4(vc,1.0); }`;

  function mat4mul(a, b) { const o = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[j * 4 + k]; o[j * 4 + i] = s; } return o; }
  function persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); const o = new Float32Array(16); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o; }
  function lookAt(eye, c, up) {
    const z = norm(sub(eye, c)), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function invert4(m) { // general 4x4 inverse
    const inv = new Float32Array(16), a = m;
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12]; det = det ? 1 / det : 0;
    for (let i = 0; i < 16; i++) inv[i] *= det; return inv;
  }

  function parseSTL(buf) {
    const dv = new DataView(buf);
    let n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    if (buf.byteLength === 84 + n * 50) {
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true); }
      return pos;
    }
    const txt = new TextDecoder().decode(buf); const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g; const arr = []; let m;
    while ((m = re.exec(txt))) arr.push(+m[1], +m[2], +m[3]);
    return new Float32Array(arr);
  }

  function Viewer(canvas, opts) {
    this.canvas = canvas; this.opts = opts || {};
    const gl = this.gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false });
    if (!gl) { canvas.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'WebGL is not available in this browser.' })); return; }
    this.prog = this._prog(VS, FS); this.lprog = this._prog(LVS, LFS);
    this.pos = null; this.nrm = null; this.hl = null; this.n = 0; this.bbox = null;
    this.theta = -0.7; this.phi = 1.0; this.dist = 200; this.target = [0, 0, 0];
    this.pickMode = false; this.selection = null;
    this._events();
    this._lines = null;
    const ro = new ResizeObserver(() => this.render()); ro.observe(canvas);
  }
  Viewer.prototype._prog = function (vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); gl.attachShader(p, sh); }
    gl.linkProgram(p); return p;
  };
  Viewer.prototype.load = function (buf) {
    const pos = parseSTL(buf); this.n = pos.length / 3; this.pos = pos;
    const nrm = new Float32Array(pos.length), fn = new Float32Array(this.n);
    for (let i = 0; i < this.n; i += 3) {
      const a = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], b = [pos[i * 3 + 3], pos[i * 3 + 4], pos[i * 3 + 5]], c = [pos[i * 3 + 6], pos[i * 3 + 7], pos[i * 3 + 8]];
      const nn = norm(cross(sub(b, a), sub(c, a)));
      for (let k = 0; k < 3; k++) { nrm[(i + k) * 3] = nn[0]; nrm[(i + k) * 3 + 1] = nn[1]; nrm[(i + k) * 3 + 2] = nn[2]; }
      fn[i] = nn[0]; fn[i + 1] = nn[1]; fn[i + 2] = nn[2];
    }
    this.nrm = nrm; this.faceN = fn; this.hl = new Float32Array(this.n);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
    this.bbox = { lo, hi };
    this.markBedFace();
    this.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    this.dist = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2.2 + 10;
    this._upload(); this.render();
  };
  Viewer.prototype.markBedFace = function () {
    // triangles lying on the bed (z ≈ min, normal down) are tinted
    const lo = this.bbox.lo, pos = this.pos, hl = this.hl;
    for (let t = 0; t < this.n / 3; t++) {
      const zmax = Math.max(pos[t * 9 + 2], pos[t * 9 + 5], pos[t * 9 + 8]);
      const down = this.faceN[t * 3 + 2] < -0.95;
      const v = (down && zmax < lo[2] + 0.3) ? 2 : (hl[t * 3] === 1 ? 1 : 0);
      hl[t * 3] = hl[t * 3 + 1] = hl[t * 3 + 2] = v;
    }
  };
  Viewer.prototype._upload = function () {
    const gl = this.gl;
    const mk = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    this.bPos = mk(this.pos); this.bNrm = mk(this.nrm); this.bHl = mk(this.hl);
    // bed grid + axes
    const L = []; const C = []; const g = 10, ext = Math.max(200, Math.ceil(Math.max(this.bbox.hi[0] - this.bbox.lo[0], this.bbox.hi[1] - this.bbox.lo[1]) / 50) * 50 + 50);
    const cx = (this.bbox.lo[0] + this.bbox.hi[0]) / 2, cy = (this.bbox.lo[1] + this.bbox.hi[1]) / 2, z0 = this.bbox.lo[2];
    const gc = getComputedStyle(document.documentElement).getPropertyValue('--rule').trim() || '#ccc';
    const col = hexToRgb(gc);
    for (let x = -ext / 2; x <= ext / 2; x += g) { L.push(cx + x, cy - ext / 2, z0, cx + x, cy + ext / 2, z0); C.push(...col, ...col); }
    for (let y = -ext / 2; y <= ext / 2; y += g) { L.push(cx - ext / 2, cy + y, z0, cx + ext / 2, cy + y, z0); C.push(...col, ...col); }
    const ax = 30, o = [cx - ext / 2, cy - ext / 2, z0];
    L.push(...o, o[0] + ax, o[1], o[2]); C.push(0.76, 0.27, 0.23, 0.76, 0.27, 0.23);
    L.push(...o, o[0], o[1] + ax, o[2]); C.push(0.25, 0.56, 0.31, 0.25, 0.56, 0.31);
    L.push(...o, o[0], o[1], o[2] + ax); C.push(0.23, 0.44, 0.76, 0.23, 0.44, 0.76);
    this.nLines = L.length / 3; this.bL = mk(new Float32Array(L)); this.bLC = mk(new Float32Array(C));
  };
  Viewer.prototype._mats = function () {
    const c = this.canvas, asp = c.clientWidth / Math.max(1, c.clientHeight);
    const eye = add(this.target, [this.dist * Math.cos(this.phi) * Math.cos(this.theta), this.dist * Math.cos(this.phi) * Math.sin(this.theta), this.dist * Math.sin(this.phi)]);
    const mv = lookAt(eye, this.target, [0, 0, 1]);
    const pr = persp(0.8, asp, this.dist * 0.02, this.dist * 20);
    return { mv, pr, mvp: mat4mul(pr, mv), eye };
  };
  Viewer.prototype.render = function () {
    const gl = this.gl, c = this.canvas;
    const w = c.clientWidth * (window.devicePixelRatio || 1), h = c.clientHeight * (window.devicePixelRatio || 1);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    const bg = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue('--panel2').trim() || '#f5f6f3');
    gl.clearColor(bg[0], bg[1], bg[2], 1); gl.enable(gl.DEPTH_TEST); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.pos) return;
    const { mv, mvp } = this._mats();
    gl.useProgram(this.lprog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lprog, 'mvp'), false, mvp);
    this._attr(this.lprog, 'p', this.bL, 3); this._attr(this.lprog, 'c', this.bLC, 3);
    gl.drawArrays(gl.LINES, 0, this.nLines);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mvp'), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mv'), false, mv);
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'base'), [0.62, 0.68, 0.75]);
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'hl'), [0.93, 0.5, 0.2]);
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'bed'), [0.35, 0.65, 0.42]);
    this._attr(this.prog, 'p', this.bPos, 3); this._attr(this.prog, 'n', this.bNrm, 3); this._attr(this.prog, 'h', this.bHl, 1);
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
  };
  Viewer.prototype._attr = function (prog, name, buf, size) {
    const gl = this.gl, loc = gl.getAttribLocation(prog, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  Viewer.prototype._events = function () {
    const c = this.canvas; let drag = null;
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, b: e.button, moved: 0 }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.b === 2 || e.shiftKey) { // pan
        const { mv } = this._mats(); const s = this.dist / c.clientHeight * 1.2;
        const right = [mv[0], mv[4], mv[8]], up = [mv[1], mv[5], mv[9]];
        this.target = add(this.target, add(scale(right, -dx * s), scale(up, dy * s)));
      } else { this.theta -= dx * 0.01; this.phi = Math.max(-1.5, Math.min(1.5, this.phi + dy * 0.01)); }
      this.render();
    });
    c.addEventListener('pointerup', e => {
      if (drag && drag.moved < 4 && drag.b === 0 && this.pickMode) this.pick(e);
      drag = null;
    });
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => { e.preventDefault(); this.dist *= Math.exp(e.deltaY * 0.001); this.render(); }, { passive: false });
  };
  Viewer.prototype.pick = function (e) {
    if (!this.pos) return;
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = 1 - ((e.clientY - r.top) / r.height) * 2;
    const { mvp, eye } = this._mats(); const inv = invert4(mvp);
    const un = (px, py, pz) => { const v = [inv[0] * px + inv[4] * py + inv[8] * pz + inv[12], inv[1] * px + inv[5] * py + inv[9] * pz + inv[13], inv[2] * px + inv[6] * py + inv[10] * pz + inv[14], inv[3] * px + inv[7] * py + inv[11] * pz + inv[15]]; return [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; };
    const p0 = un(x, y, -1), p1 = un(x, y, 1), d = norm(sub(p1, p0));
    let best = -1, bt = Infinity; const P = this.pos;
    for (let t = 0; t < this.n / 3; t++) {
      const a = [P[t * 9], P[t * 9 + 1], P[t * 9 + 2]], b = [P[t * 9 + 3], P[t * 9 + 4], P[t * 9 + 5]], c = [P[t * 9 + 6], P[t * 9 + 7], P[t * 9 + 8]];
      const e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h); if (Math.abs(det) < 1e-9) continue;
      const f = 1 / det, s = sub(p0, a), u = f * dot(s, h); if (u < 0 || u > 1) continue;
      const q = cross(s, e1), v = f * dot(d, q); if (v < 0 || u + v > 1) continue;
      const tt = f * dot(e2, q); if (tt > 1e-6 && tt < bt) { bt = tt; best = t; }
    }
    if (best < 0) return;
    this.selectFace(best);
  };
  Viewer.prototype.selectFace = function (t0) {
    // grow coplanar connected region from triangle t0
    const P = this.pos, N = this.faceN, n0 = [N[t0 * 3], N[t0 * 3 + 1], N[t0 * 3 + 2]];
    if (!this._adj) this._buildAdj();
    const seen = new Uint8Array(this.n / 3), stack = [t0]; seen[t0] = 1; const region = [];
    while (stack.length) {
      const t = stack.pop(); region.push(t);
      for (const nb of this._adj[t]) if (!seen[nb]) { const nn = [N[nb * 3], N[nb * 3 + 1], N[nb * 3 + 2]]; if (dot(nn, n0) > 0.985) { seen[nb] = 1; stack.push(nb); } }
    }
    let area = 0;
    for (let t = 0; t < this.n / 3; t++) { const v = this.hl[t * 3] === 2 ? 2 : 0; this.hl[t * 3] = this.hl[t * 3 + 1] = this.hl[t * 3 + 2] = v; }
    for (const t of region) {
      this.hl[t * 3] = this.hl[t * 3 + 1] = this.hl[t * 3 + 2] = 1;
      const a = [P[t * 9], P[t * 9 + 1], P[t * 9 + 2]], b = [P[t * 9 + 3], P[t * 9 + 4], P[t * 9 + 5]], c = [P[t * 9 + 6], P[t * 9 + 7], P[t * 9 + 8]];
      const cr = cross(sub(b, a), sub(c, a)); area += Math.hypot(cr[0], cr[1], cr[2]) / 2;
    }
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.bHl); gl.bufferData(gl.ARRAY_BUFFER, this.hl, gl.STATIC_DRAW);
    this.selection = { normal: n0, area, triangles: region.length };
    this.render();
    if (this.opts.onSelect) this.opts.onSelect(this.selection);
  };
  Viewer.prototype._buildAdj = function () {
    const P = this.pos, T = this.n / 3, key = (i) => Math.round(P[i] * 100) + ',' + Math.round(P[i + 1] * 100) + ',' + Math.round(P[i + 2] * 100);
    const vmap = new Map();
    for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) { const kk = key(t * 9 + k * 3); let l = vmap.get(kk); if (!l) { l = []; vmap.set(kk, l); } l.push(t); }
    const adj = new Array(T);
    for (let t = 0; t < T; t++) { const s = new Set(); for (let k = 0; k < 3; k++) for (const o of vmap.get(key(t * 9 + k * 3))) if (o !== t) s.add(o); adj[t] = [...s]; }
    this._adj = adj;
  };
  Viewer.prototype.clearSelection = function () {
    if (!this.pos) return;
    for (let t = 0; t < this.n / 3; t++) { const v = this.hl[t * 3] === 2 ? 2 : 0; this.hl[t * 3] = this.hl[t * 3 + 1] = this.hl[t * 3 + 2] = v; }
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.bHl); gl.bufferData(gl.ARRAY_BUFFER, this.hl, gl.STATIC_DRAW); this.selection = null; this.render();
  };
  Viewer.prototype.setPickMode = function (on) { this.pickMode = on; this.canvas.classList.toggle('pick', on); };
  Viewer.prototype.resetView = function () { if (!this.bbox) return; const { lo, hi } = this.bbox; this.theta = -0.7; this.phi = 1.0; this.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]; this.dist = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2.2 + 10; this.render(); };

  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); if (isNaN(n)) return [0.8, 0.8, 0.8]; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  window.STLViewer = Viewer;
})();
