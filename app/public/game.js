'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const CELL = 24;
  const SKINS = [
    ['#39ff14', '#00b300'], ['#00f0ff', '#0077b6'], ['#ffe600', '#e69500'], ['#ff2fb3', '#a0007a'],
    ['#ff6a00', '#a63c00'], ['#a259ff', '#5a1bb8'], ['#ff3b3b', '#9b0f0f'], ['#ffffff', '#8a8a9a'],
  ];
  const cv = $('game'), ctx = cv.getContext('2d');
  let cols = 40, rows = 28;
  let ws = null, myId = null, state = { p: [], f: [] }, skin = +localStorage.skin || 0, particles = [], shake = 0;
  let prevById = {}, lastTick = 0, tickMs = 110;
  let crashTimer = null, reconnTimer = null, lastPlayersKey = '', lastTopKey = '';
  let boardCv = null, spikesCv = null;

  function buildBoard() {
    const W = cols * CELL, H = rows * CELL;
    boardCv = document.createElement('canvas'); boardCv.width = W; boardCv.height = H;
    const b = boardCv.getContext('2d');
    const g = b.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#12084d'); g.addColorStop(1, '#070225');
    b.fillStyle = g; b.fillRect(0, 0, W, H);
    b.strokeStyle = 'rgba(0,240,255,.10)'; b.lineWidth = 1;
    b.beginPath();
    for (let x = 0; x <= cols; x++) { b.moveTo(x * CELL + .5, 0); b.lineTo(x * CELL + .5, H); }
    for (let y = 0; y <= rows; y++) { b.moveTo(0, y * CELL + .5); b.lineTo(W, y * CELL + .5); }
    b.stroke();

    spikesCv = document.createElement('canvas'); spikesCv.width = W; spikesCv.height = H;
    const s = spikesCv.getContext('2d');
    s.fillStyle = '#111'; s.strokeStyle = '#ff2fb3'; s.lineWidth = 1.5;
    s.shadowColor = '#ff2fb3'; s.shadowBlur = 8;
    const sp = 12, n = Math.floor(W / sp), m = Math.floor(H / sp);
    s.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * sp;
      s.moveTo(x, 0); s.lineTo(x + sp / 2, 8); s.lineTo(x + sp, 0);
      s.moveTo(x, H); s.lineTo(x + sp / 2, H - 8); s.lineTo(x + sp, H);
    }
    for (let i = 0; i < m; i++) {
      const y = i * sp;
      s.moveTo(0, y); s.lineTo(8, y + sp / 2); s.lineTo(0, y + sp);
      s.moveTo(W, y); s.lineTo(W - 8, y + sp / 2); s.lineTo(W, y + sp);
    }
    s.fill(); s.stroke();
  }
  buildBoard();

  /* ----------------------------- Fondo animado ----------------------------- */
  const bg = $('bg'), bctx = bg.getContext('2d');
  const shapes = Array.from({ length: 28 }, () => ({
    x: Math.random(), y: Math.random(), s: 20 + Math.random() * 70, v: .01 + Math.random() * .03,
    r: Math.random() * 6, t: Math.floor(Math.random() * 3), c: SKINS[Math.floor(Math.random() * 8)][0],
  }));
  let bgGrad = null;
  function sizeBg() {
    bg.width = innerWidth; bg.height = innerHeight;
    bgGrad = bctx.createLinearGradient(0, 0, 0, bg.height);
    bgGrad.addColorStop(0, '#2b0a85'); bgGrad.addColorStop(1, '#0d0330');
  }
  sizeBg(); addEventListener('resize', sizeBg);
  function drawBg(t) {
    const w = bg.width, h = bg.height;
    bctx.fillStyle = bgGrad; bctx.fillRect(0, 0, w, h);
    bctx.globalAlpha = .14;
    for (const s of shapes) {
      const x = ((s.x - t * s.v / 1000 / 8) % 1 + 1) % 1 * (w + 200) - 100, y = s.y * h;
      bctx.save(); bctx.translate(x, y); bctx.rotate(s.r + t / 4000 * (s.t + 1) * .5);
      bctx.fillStyle = s.c; bctx.strokeStyle = '#fff'; bctx.lineWidth = 3;
      bctx.beginPath();
      if (s.t === 0) bctx.rect(-s.s / 2, -s.s / 2, s.s, s.s);
      else if (s.t === 1) { bctx.moveTo(0, -s.s / 2); bctx.lineTo(s.s / 2, s.s / 2); bctx.lineTo(-s.s / 2, s.s / 2); bctx.closePath(); }
      else bctx.arc(0, 0, s.s / 2, 0, 7);
      bctx.fill(); bctx.stroke(); bctx.restore();
    }
    bctx.globalAlpha = 1;
    // suelo estilo Geometry Dash
    const gh = 70, off = -(t / 8) % 60;
    bctx.fillStyle = '#0a1a66'; bctx.fillRect(0, h - gh, w, gh);
    bctx.strokeStyle = 'rgba(0,240,255,.35)'; bctx.lineWidth = 2;
    for (let x = off; x < w; x += 60) { bctx.beginPath(); bctx.moveTo(x, h - gh); bctx.lineTo(x, h); bctx.stroke(); }
    bctx.fillStyle = 'rgba(0,240,255,.35)'; bctx.fillRect(0, h - gh - 4, w, 12);
    bctx.fillStyle = '#fff'; bctx.fillRect(0, h - gh, w, 4);
  }

  /* ------------------------------ Dibujo de cubos ------------------------------ */
  function cube(c, x, y, size, k, dir, head) {
    const [main, dark] = SKINS[k];
    const g = c.createLinearGradient(x, y, x, y + size);
    g.addColorStop(0, main); g.addColorStop(1, dark);
    c.fillStyle = g; c.fillRect(x, y, size, size);
    c.strokeStyle = '#000'; c.lineWidth = 2.5; c.strokeRect(x + 1, y + 1, size - 2, size - 2);
    c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1.5; c.strokeRect(x + 3.5, y + 3.5, size - 7, size - 7);
    if (!head) return;
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir] || [1, 0];
    const cx = x + size / 2 + d[0] * size * .08, cy = y + size / 2 + d[1] * size * .08;
    const px = -d[1], py = d[0], e = size * .2, r = size * .16;
    for (const s of [-1, 1]) {
      const ex = cx + px * e * s + d[0] * size * .06, ey = cy + py * e * s + d[1] * size * .06;
      c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1.8;
      c.beginPath(); c.arc(ex, ey, r, 0, 7); c.fill(); c.stroke();
      c.fillStyle = '#000'; c.beginPath(); c.arc(ex + d[0] * r * .45, ey + d[1] * r * .45, r * .5, 0, 7); c.fill();
    }
    // boca
    c.fillStyle = '#000';
    const mx = cx - d[0] * size * .22, my = cy - d[1] * size * .22;
    c.save(); c.translate(mx, my); c.fillRect(-size * .16 * Math.abs(py) - size * .04 * Math.abs(px), -size * .16 * Math.abs(px) - size * .04 * Math.abs(py),
      size * (.32 * Math.abs(py) + .08 * Math.abs(px)), size * (.32 * Math.abs(px) + .08 * Math.abs(py))); c.restore();
  }

  function burst(gx, gy, color, n, power) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, v = (1 + Math.random() * 4) * power;
      particles.push({ x: (gx + .5) * CELL, y: (gy + .5) * CELL, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, s: 3 + Math.random() * 7, c: color, r: Math.random() * 6 });
    }
  }

  /* --------------------------------- Render --------------------------------- */
  function render(t) {
    drawBg(t);
    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake); shake *= .86; if (shake < .5) shake = 0; }
    ctx.drawImage(boardCv, 0, 0);

    // comida
    for (const [fx, fy, ft] of state.f) {
      const cx = (fx + .5) * CELL, cy = (fy + .5) * CELL, pul = Math.sin(t / 220 + fx + fy);
      if (ft) { // moneda de usuario
        const sx = Math.abs(Math.cos(t / 260 + fx));
        ctx.save(); ctx.translate(cx, cy); ctx.scale(Math.max(.15, sx), 1);
        ctx.shadowColor = '#ffd000'; ctx.shadowBlur = 18;
        const cg = ctx.createRadialGradient(0, -2, 1, 0, 0, 11); cg.addColorStop(0, '#fff6a8'); cg.addColorStop(1, '#e6a800');
        ctx.fillStyle = cg; ctx.strokeStyle = '#7a4d00'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 10, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#7a4d00'; ctx.fillRect(-2, -5, 4, 10); ctx.restore();
      } else { // orbe de salto
        ctx.save(); ctx.shadowColor = '#ffe600'; ctx.shadowBlur = 16;
        ctx.strokeStyle = 'rgba(255,230,0,.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 9 + pul * 1.8, 0, 7); ctx.stroke();
        const og = ctx.createRadialGradient(cx, cy, 0, cx, cy, 7); og.addColorStop(0, '#fff'); og.addColorStop(1, '#ffe600');
        ctx.fillStyle = og; ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, 7); ctx.fill(); ctx.restore();
      }
    }

    // serpientes
    for (const p of state.p) {
      if (!p.a) continue;
      ctx.save();
      const prev = prevById[p.id];
      const al = Math.min(1, (performance.now() - lastTick) / tickMs);
      const pos = (i) => {
        const c = p.b[i], o = prev && prev[Math.min(i, prev.length - 1)];
        if (!o || Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) > 2) return c;
        return [o[0] + (c[0] - o[0]) * al, o[1] + (c[1] - o[1]) * al];
      };
      for (let i = p.b.length - 1; i >= 0; i--) {
        const [bx, by] = pos(i);
        const sz = i === 0 ? CELL : CELL - 3 - Math.min(4, i * .15);
        const o = (CELL - sz) / 2;
        if (i === 0) { ctx.shadowColor = SKINS[p.k][0]; ctx.shadowBlur = p.id === myId ? 14 : 6; }
        cube(ctx, bx * CELL + o, by * CELL + o, sz, p.k, p.d, i === 0);
        if (i === 0) ctx.shadowBlur = 0;
      }
      ctx.restore();
      const [hx, hy] = pos(0);
      ctx.font = '700 12px Rubik'; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = '#000';
      ctx.strokeText(p.n, hx * CELL + CELL / 2, hy * CELL - 6);
      ctx.fillStyle = p.id === myId ? '#00f0ff' : '#fff'; ctx.fillText(p.n, hx * CELL + CELL / 2, hy * CELL - 6);
    }

    // partículas
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i]; q.x += q.vx; q.y += q.vy; q.vy += .08; q.life -= .025; q.r += .2;
      if (q.life <= 0) { particles.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = q.life; ctx.translate(q.x, q.y); ctx.rotate(q.r);
      ctx.fillStyle = q.c; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.fillRect(-q.s / 2, -q.s / 2, q.s, q.s); ctx.strokeRect(-q.s / 2, -q.s / 2, q.s, q.s); ctx.restore();
    }

    // pinchos en los bordes (las paredes matan)
    ctx.drawImage(spikesCv, 0, 0);
    ctx.restore();
    requestAnimationFrame(render);
  }

  /* --------------------------------- Red --------------------------------- */
  function closeWs() {
    clearTimeout(reconnTimer);
    clearTimeout(crashTimer);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch {}
      ws = null;
    }
    myId = null;
  }

  function connect() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    closeWs();
    const name = user ? user.username : 'Cube';
    const room = ($('roomInput').value.trim() || 'arena').toLowerCase().replace(/\s+/g, '-');
    localStorage.skin = skin; localStorage.room = room;
    showConn('Conectando…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'join', token: localStorage.token, skin }));
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') {
        clearTimeout(crashTimer);
        myId = m.id;
        if (cols !== m.cols || rows !== m.rows) { cols = m.cols; rows = m.rows; buildBoard(); }
        tickMs = m.tick;
        $('roomLabel').textContent = m.room; $('nodeLabel').textContent = m.instance.slice(-8);
        hide('menu'); hide('conn'); hide('crash');
      } else if (m.type === 's') onState(m);
      else if (m.type === 'dead') onDead(m);
      else if (m.type === 'error') {
        closeWs();
        if (m.code === 'auth') { logoutLocal(); return; }
        showConn(m.msg);
        setTimeout(() => { hide('conn'); show('menu'); }, 1800);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      myId = null;
      hide('crash');
      showConn('Conexión perdida — reconectando…');
      reconnTimer = setTimeout(connect, 1500);
    };
  }

  function leaveRoom() {
    closeWs();
    state = { p: [], f: [] };
    prevById = {};
    lastPlayersKey = '';
    $('players').innerHTML = '';
    hide('crash'); hide('conn'); show('menu');
    refreshProfile();
    $('roomInput').focus();
    $('roomInput').select();
  }

  function onState(m) {
    prevById = {};
    for (const q of state.p) if (q.a) prevById[q.id] = q.b;
    lastTick = performance.now();
    state = m;
    for (const e of m.ev) {
      const p = m.p.find((q) => q.id === e.id), col = p ? SKINS[p.k][0] : '#fff';
      if (e.e === 'eat') burst(e.x, e.y, e.t ? '#ffd000' : '#ffe600', e.t ? 18 : 9, 1);
      if (e.e === 'death') { burst(e.x, e.y, col, 40, 1.6); burst(e.x, e.y, '#fff', 12, 1.2); if (e.id === myId) shake = 22; }
    }
    const me = m.p.find((p) => p.id === myId);
    if (me) {
      $('scoreLabel').textContent = me.s;
      $('progressBar').style.width = Math.min(100, (me.b.length / 40) * 100) + '%';
    }
    const list = [...m.p].sort((a, b) => b.s - a.s);
    const pKey = `${myId}|` + list.map((p) => `${p.id}:${p.n}:${p.k}:${p.a}:${p.s}`).join('|');
    if (pKey !== lastPlayersKey) {
      lastPlayersKey = pKey;
      $('players').innerHTML = list.map((p) =>
        `<li class="${p.id === myId ? 'me' : ''} ${p.a ? '' : 'dead'}"><i class="sw" style="background:${SKINS[p.k][0]}"></i><span class="nm">${esc(p.n)}</span><span class="sc">${p.s}</span></li>`).join('');
    }
  }

  function onDead(m) {
    $('crashScore').textContent = m.score; $('crashLen').textContent = m.length;
    $('crashWhy').textContent = m.why === 'wall' ? 'Te estrellaste contra los pinchos' : m.why === 'self' ? 'Te mordiste a ti mismo' : 'Chocaste con ' + m.why.replace('crash:', '');
    clearTimeout(crashTimer);
    crashTimer = setTimeout(() => show('crash'), 500);
    setTimeout(loadTop, 650);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const show = (id) => $(id).classList.remove('hidden'), hide = (id) => $(id).classList.add('hidden');
  function showConn(msg) { $('connMsg').textContent = msg; show('conn'); }

  async function loadTop() {
    try {
      const r = await fetch('/api/top'); const d = await r.json();
      const tKey = d.top.map((t) => `${t.name}:${t.score}`).join('|') || 'empty';
      if (tKey !== lastTopKey) {
        lastTopKey = tKey;
        $('top').innerHTML = d.top.length ? d.top.map((t) =>
          `<li><span class="nm">${esc(t.name)}</span><span class="sc">${t.score}</span></li>`).join('') : '<li class="empty">Sé el primero en el ranking</li>';
      }
    } catch {
      if (lastTopKey !== 'err') {
        lastTopKey = 'err';
        $('top').innerHTML = '<li class="empty">Ranking no disponible</li>';
      }
    }
  }

  /* -------------------------------- Controles -------------------------------- */
  const KEYS = { ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' };
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') {
      if (e.key === 'Enter') $(e.target.id === 'roomInput' ? 'playBtn' : 'authBtn').click();
      return;
    }
    if (!$('auth').classList.contains('hidden')) return;
    if (!$('menu').classList.contains('hidden')) {
      if (e.key === 'Enter') { e.preventDefault(); $('playBtn').click(); }
      return;
    }
    if (KEYS[e.key]) { e.preventDefault(); ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'dir', dir: KEYS[e.key] })); }
    if ((e.key === ' ' || e.key === 'Enter') && !$('crash').classList.contains('hidden')) { e.preventDefault(); $('respawnBtn').click(); }
    if (e.key === 'Escape') { e.preventDefault(); leaveRoom(); }
  });
  // swipe táctil
  let t0 = null;
  cv.addEventListener('touchstart', (e) => { t0 = e.touches[0]; }, { passive: true });
  cv.addEventListener('touchend', (e) => {
    if (!t0) return; const t1 = e.changedTouches[0], dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'dir', dir }));
  });

  $('respawnBtn').onclick = () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    clearTimeout(crashTimer);
    hide('crash');
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'respawn' }));
    else connect();
  };
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 1800);
  }
  const inGame = () => ws && ws.readyState === 1 && myId;
  function restart() {
    if (!inGame()) return;
    clearTimeout(crashTimer); hide('crash'); hide('help');
    ws.send(JSON.stringify({ type: 'respawn' }));
  }
  function toggleHelp() { $('help').classList.contains('hidden') ? show('help') : hide('help'); }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  }
  function copyInvite() {
    const room = $('roomLabel').textContent;
    const url = `${location.origin}/?room=${encodeURIComponent(room === '—' ? $('roomInput').value : room)}`;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(() => toast('🔗 Enlace copiado'), () => prompt('Copia el enlace:', url));
  }
  $('btnRestart').onclick = (e) => { e.currentTarget.blur(); restart(); };
  $('btnHelp').onclick = (e) => { e.currentTarget.blur(); toggleHelp(); };
  $('btnCopy').onclick = (e) => { e.currentTarget.blur(); copyInvite(); };
  $('btnFull').onclick = (e) => { e.currentTarget.blur(); toggleFull(); };
  $('btnExit').onclick = (e) => { e.currentTarget.blur(); leaveRoom(); };
  $('helpClose').onclick = () => hide('help');
  $('menuHelpBtn').onclick = () => show('help');
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || !$('menu').classList.contains('hidden')) return;
    const k = e.key.toLowerCase();
    if (k === 'r') restart();
    else if (k === 'h') toggleHelp();
    else if (k === 'f') toggleFull();
  });
  $('menuBtn').onclick = leaveRoom;
  $('chipRoom').onclick = leaveRoom;
  $('playBtn').onclick = connect;

  /* ---------------------------------- Menú ---------------------------------- */
  const pv = $('preview').getContext('2d');
  function drawPreview() { pv.clearRect(0, 0, 96, 96); cube(pv, 8, 8, 80, skin, 'right', true); }
  $('skins').innerHTML = SKINS.map((s, i) => `<div class="skin" data-i="${i}" style="background:linear-gradient(${s[0]},${s[1]})"></div>`).join('');
  $('skins').onclick = (e) => {
    const i = e.target.dataset.i; if (i === undefined) return;
    skin = +i; sync();
  };
  function sync() { document.querySelectorAll('.skin').forEach((d) => d.classList.toggle('sel', +d.dataset.i === skin)); drawPreview(); }
  $('roomInput').value = new URLSearchParams(location.search).get('room') || localStorage.room || 'arena';
  sync(); loadTop(); setInterval(loadTop, 8000);

  /* ------------------------------ Cuentas ------------------------------ */
  let user = null, authMode = 'login';
  function setMode(mode) {
    authMode = mode;
    $('tabLogin').classList.toggle('sel', mode === 'login');
    $('tabRegister').classList.toggle('sel', mode === 'register');
    $('authTitle').textContent = { login: '🔐 Iniciar sesión', register: '✨ Crear cuenta', recover: '🔑 Recuperar contraseña' }[mode];
    $('authBtn').textContent = { login: 'ENTRAR', register: 'CREAR Y JUGAR', recover: 'CAMBIAR CONTRASEÑA' }[mode];
    $('passInput').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('passLabel').textContent = mode === 'recover' ? 'Nueva contraseña' : 'Contraseña';
    $('codeRow').classList.toggle('on', mode === 'recover');
    $('emailRow').classList.toggle('on', mode === 'register');
    $('sendCodeBtn').classList.toggle('on', mode === 'recover');
    $('userLabel').textContent = mode === 'recover' ? 'Usuario o correo' : 'Usuario';
    $('userInput').maxLength = mode === 'recover' ? 100 : 12;
    $('userInput').placeholder = mode === 'recover' ? 'tu usuario o tu correo' : '3-12 letras, números o _';
    $('authErr').style.color = '';
    $('forgotBtn').textContent = mode === 'recover' ? '← Volver a iniciar sesión' : '¿Olvidaste tu contraseña?';
    $('authErr').textContent = '';
  }
  $('forgotBtn').onclick = () => setMode(authMode === 'recover' ? 'login' : 'recover');
  function showProfile() {
    $('profName').textContent = user.username;
    $('profMail').textContent = user.email ? '✉️ ' + user.email : '⚠️ Sin correo asociado';
    $('emailBtn').textContent = user.email ? '📧 CAMBIAR CORREO' : '📧 ASOCIAR CORREO';
    $('stGames').textContent = user.games; $('stBest').textContent = user.bestScore; $('stTotal').textContent = user.totalScore;
  }
  function setUser(u) {
    user = u; showProfile();
    skin = u.skin % SKINS.length; sync();
    hide('auth'); show('menu');
  }
  $('sendCodeBtn').onclick = async () => {
    const ident = $('userInput').value.trim();
    if (!ident) { $('authErr').textContent = 'Escribe tu usuario o correo'; return; }
    $('sendCodeBtn').disabled = true;
    try {
      const r = await fetch('/api/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ident }) });
      const d = await r.json();
      $('authErr').style.color = r.ok ? '#8affb0' : '';
      $('authErr').textContent = r.ok ? d.message + ' (válido 15 min)' : d.error;
    } catch { $('authErr').textContent = 'No se pudo conectar con el servidor'; }
    finally { $('sendCodeBtn').disabled = false; }
  };
  $('emailBtn').onclick = async () => {
    const email = prompt('Escribe tu correo electrónico:', user && user.email || '');
    if (!email) return;
    const password = prompt('Confirma con tu contraseña actual:');
    if (!password) return;
    try {
      const r = await fetch('/api/email', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.token },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json();
      if (r.ok) { user.email = d.email; showProfile(); toast('✅ Correo guardado'); } else toast(d.error || 'Error');
    } catch { toast('No se pudo conectar'); }
  };
  function logoutLocal() {
    user = null; delete localStorage.token;
    hide('menu'); hide('conn'); hide('crash'); show('auth');
    $('passInput').value = ''; $('authErr').textContent = ''; setMode('login');
    $('userInput').focus();
  }
  async function submitAuth() {
    const username = $('userInput').value.trim(), password = $('passInput').value;
    const code = $('codeInput').value.trim(), email = $('emailInput').value.trim();
    if (!username || !password || (authMode === 'recover' && !code) || (authMode === 'register' && !email)) { $('authErr').textContent = 'Completa todos los campos'; return; }
    $('authBtn').disabled = true; $('authErr').textContent = '';
    try {
      const r = await fetch({ login: '/api/login', register: '/api/register', recover: '/api/recover' }[authMode], {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, code, email }),
      });
      const d = await r.json();
      if (!r.ok) { $('authErr').textContent = d.error || 'Error'; return; }
      localStorage.token = d.token; $('passInput').value = ''; $('codeInput').value = '';
      setUser(d.user);
      if (authMode === 'recover') { setMode('login'); toast('✅ Contraseña cambiada'); }
    } catch { $('authErr').textContent = 'No se pudo conectar con el servidor'; }
    finally { $('authBtn').disabled = false; }
  }
  async function refreshProfile() {
    if (!localStorage.token) return;
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.token } });
      if (r.ok) { const d = await r.json(); user = d.user; showProfile(); }
    } catch {}
  }
  $('tabLogin').onclick = () => setMode('login');
  $('tabRegister').onclick = () => setMode('register');
  $('authBtn').onclick = submitAuth;
  $('logoutBtn').onclick = () => {
    fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.token } }).catch(() => {});
    closeWs(); logoutLocal();
  };
  (async () => {
    if (!localStorage.token) return;
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.token } });
      if (r.ok) setUser((await r.json()).user); else delete localStorage.token;
    } catch {}
  })();
  requestAnimationFrame(render);
})();
