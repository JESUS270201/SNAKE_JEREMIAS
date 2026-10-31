'use strict';
/**
 * SNAKE DASH - servidor autoritativo multijugador.
 *  - Express sirve el cliente y la API REST (/api/top, /health).
 *  - ws maneja el juego en tiempo real. Cada "sala" vive en UNA sola réplica;
 *    el balanceador (nginx / ingress) enruta por ?room= (hash consistente),
 *    de modo que las salas se reparten entre las réplicas.
 *  - PostgreSQL guarda el Top 10 de forma persistente y compartida.
 */
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const INSTANCE = process.env.HOSTNAME || os.hostname();
const COLS = 40;
const ROWS = 28;
const TICK_MS = 110;
const MAX_PLAYERS = 12;
const COLORS = 8;

/* ------------------------------ Base de datos ------------------------------ */
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'snake',
  password: process.env.PGPASSWORD || 'snake',
  database: process.env.PGDATABASE || 'snake',
  max: 10,
});
pool.on('error', (e) => console.error('[pg] error en cliente inactivo:', e.message));

let dbReady = false;
async function initDb() {
  for (let i = 1; ; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scores (
          id         SERIAL PRIMARY KEY,
          name       VARCHAR(16) NOT NULL,
          score      INTEGER NOT NULL,
          length     INTEGER NOT NULL DEFAULT 0,
          room       VARCHAR(24) NOT NULL,
          instance   VARCHAR(64) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC);
        ALTER TABLE scores ADD COLUMN IF NOT EXISTS user_id INTEGER;
        CREATE TABLE IF NOT EXISTS users (
          id          SERIAL PRIMARY KEY,
          username    VARCHAR(16) NOT NULL,
          pass_salt   VARCHAR(64) NOT NULL,
          pass_hash   VARCHAR(256) NOT NULL,
          skin        INTEGER NOT NULL DEFAULT 0,
          games       INTEGER NOT NULL DEFAULT 0,
          total_score INTEGER NOT NULL DEFAULT 0,
          best_score  INTEGER NOT NULL DEFAULT 0,
          best_len    INTEGER NOT NULL DEFAULT 3,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_login  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));
        ALTER TABLE users ADD COLUMN IF NOT EXISTS rec_salt VARCHAR(64);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS rec_hash VARCHAR(256);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100);
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
        CREATE TABLE IF NOT EXISTS password_resets (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          code_hash  VARCHAR(256) NOT NULL,
          salt       VARCHAR(64) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          attempts   INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token      VARCHAR(64) PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
      dbReady = true;
      console.log('[pg] base de datos lista');
      return;
    } catch (e) {
      console.log(`[pg] esperando base de datos (intento ${i}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function saveScore(p, room) {
  if (!dbReady || p.score <= 0) return;
  try {
    await pool.query(
      'INSERT INTO scores (name, score, length, room, instance, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [p.name, p.score, p.maxLen, room, INSTANCE, p.userId || null]
    );
    if (p.userId) {
      await pool.query(
        `UPDATE users SET games = games + 1, total_score = total_score + $2,
           best_score = GREATEST(best_score, $2), best_len = GREATEST(best_len, $3) WHERE id = $1`,
        [p.userId, p.score, p.maxLen]
      );
    }
  } catch (e) {
    console.error('[pg] no se pudo guardar el score:', e.message);
  }
}

async function topTen() {
  const { rows } = await pool.query(
    'SELECT name, score, length, room, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT 10'
  );
  return rows;
}

/* ---------------------------------- HTTP ---------------------------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------ Cuentas de usuario ------------------------------ */
const hashPass = (pass, salt) =>
  new Promise((res, rej) => crypto.scrypt(pass, salt, 64, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
const publicUser = (u) => ({
  username: u.username, email: u.email || null, skin: u.skin, games: u.games, totalScore: u.total_score,
  bestScore: u.best_score, bestLen: u.best_len, createdAt: u.created_at,
});
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, userId]);
  return token;
}
async function userByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 64) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.created_at > now() - interval '30 days'`, [token]);
  return rows[0] || null;
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

// freno simple contra fuerza bruta (por IP)
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); attempts.set(ip, a);
  return a.length > 15;
}
setInterval(() => attempts.clear(), 300000).unref();

const validName = (s) => typeof s === 'string' && /^[A-Za-z0-9_]{3,12}$/.test(s);
const validPass = (s) => typeof s === 'string' && s.length >= 4 && s.length <= 64;
const validEmail = (s) => typeof s === 'string' && s.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
async function findByIdent(ident) {
  const id = ident.trim();
  const q = id.includes('@') ? 'lower(email) = lower($1)' : 'lower(username) = lower($1)';
  return (await pool.query(`SELECT * FROM users WHERE ${q}`, [id])).rows[0] || null;
}

/* Envío de correo: SMTP_HOST/PORT/USER/PASS/MAIL_FROM. Sin SMTP_PASS el código solo se imprime en el log. */
const transporter = process.env.SMTP_HOST && process.env.SMTP_PASS ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;
async function sendMail(to, subject, text) {
  if (!transporter) { console.log(`[mail] SMTP no configurado. Para ${to}: ${subject}\n${text}`); return; }
  await transporter.sendMail({ from: process.env.MAIL_FROM || 'Snake Dash <no-reply@snakedash.local>', to, subject, text });
}

const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

app.post('/api/recover', async (req, res) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Demasiados intentos, espera un minuto' });
    const { username: ident, code, password } = req.body || {};
    const bad = () => res.status(401).json({ error: 'Datos o código incorrectos' });
    if (typeof ident !== 'string' || ident.length > 100) return bad();
    if (!validPass(password)) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    const u = await findByIdent(ident);
    if (!u) return bad();
    const digits = String(code || '').replace(/\s/g, '');
    let ok = false;
    if (/^\d{6}$/.test(digits)) { // código enviado al correo
      const r = (await pool.query('SELECT * FROM password_resets WHERE user_id = $1', [u.id])).rows[0];
      if (r && r.expires_at > new Date() && r.attempts < 5) {
        ok = safeEq(await hashPass(digits, r.salt), r.code_hash);
        if (!ok) await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = $1', [u.id]);
      }
    }
    if (!ok) return bad();
    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [u.id]);
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE users SET pass_salt = $2, pass_hash = $3 WHERE id = $1', [u.id, salt, await hashPass(password, salt)]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]); // cierra todas las sesiones previas
    res.json({ token: await newSession(u.id), user: publicUser(u) });
  } catch (e) { console.error('[auth]', e.message); res.status(503).json({ error: 'Servicio no disponible' }); }
});

/* Correo: envía un código de 6 dígitos (válido 15 min). La respuesta es siempre la misma
   para no revelar qué correos están registrados. */
app.post('/api/forgot', async (req, res) => {
  const generic = { ok: true, message: 'Si la cuenta tiene un correo asociado, te enviamos un código.' };
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Demasiados intentos, espera un minuto' });
    if (!transporter) return res.status(503).json({ error: 'El envío de correos no está configurado en el servidor' });
    const { username: ident } = req.body || {};
    if (typeof ident !== 'string' || ident.length > 100) return res.json(generic);
    const u = await findByIdent(ident);
    if (!u || !u.email) return res.json(generic);
    const prev = (await pool.query('SELECT created_at FROM password_resets WHERE user_id = $1', [u.id])).rows[0];
    if (prev && Date.now() - new Date(prev.created_at).getTime() < 60000) return res.json(generic);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO password_resets (user_id, code_hash, salt, expires_at, attempts, created_at)
       VALUES ($1,$2,$3, now() + interval '15 minutes', 0, now())
       ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, salt = EXCLUDED.salt,
         expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
      [u.id, await hashPass(code, salt), salt]);
    sendMail(u.email, 'Snake Dash - código para recuperar tu contraseña',
      `Hola ${u.username},\n\nTu código de recuperación es: ${code}\n\nEs válido por 15 minutos. Si no lo pediste, ignora este mensaje.`)
      .catch((e) => console.error('[mail] error al enviar:', e.message));
    res.json(generic);
  } catch (e) { console.error('[auth]', e.message); res.status(503).json({ error: 'Servicio no disponible' }); }
});

// asociar / cambiar el correo de la cuenta (exige sesión + contraseña actual)
app.post('/api/email', async (req, res) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Demasiados intentos, espera un minuto' });
    const u = await userByToken(bearer(req));
    if (!u) return res.status(401).json({ error: 'Sesión inválida' });
    const { password, email } = req.body || {};
    if (!validPass(password) || !safeEq(await hashPass(password, u.pass_salt), u.pass_hash))
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Correo no válido' });
    try {
      await pool.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, email.trim()]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso' });
      throw e;
    }
    res.json({ email: email.trim() });
  } catch (e) { console.error('[auth]', e.message); res.status(503).json({ error: 'Servicio no disponible' }); }
});

app.post('/api/register', async (req, res) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Demasiados intentos, espera un minuto' });
    const { username, password, email } = req.body || {};
    if (!validName(username)) return res.status(400).json({ error: 'Usuario: 3-12 letras, números o _' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Escribe un correo válido' });
    if (!validPass(password)) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPass(password, salt);
    let u;
    try {
      u = (await pool.query(
        'INSERT INTO users (username, email, pass_salt, pass_hash) VALUES ($1,$2,$3,$4) RETURNING *', [username, email.trim(), salt, hash])).rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: /email/.test(e.constraint || '') ? 'Ese correo ya está registrado' : 'Ese usuario ya existe' });
      throw e;
    }
    res.json({ token: await newSession(u.id), user: publicUser(u) });
  } catch (e) { console.error('[auth]', e.message); res.status(503).json({ error: 'Servicio no disponible' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Demasiados intentos, espera un minuto' });
    const { username, password } = req.body || {};
    if (!validName(username) || !validPass(password)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const u = (await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username])).rows[0];
    if (!u) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const hash = await hashPass(password, u.pass_salt);
    const ok = hash.length === u.pass_hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.pass_hash));
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);
    res.json({ token: await newSession(u.id), user: publicUser(u) });
  } catch (e) { console.error('[auth]', e.message); res.status(503).json({ error: 'Servicio no disponible' }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const u = await userByToken(bearer(req));
    if (!u) return res.status(401).json({ error: 'Sesión inválida' });
    res.json({ user: publicUser(u) });
  } catch { res.status(503).json({ error: 'Servicio no disponible' }); }
});

app.post('/api/logout', async (req, res) => {
  try { await pool.query('DELETE FROM sessions WHERE token = $1', [bearer(req)]); } catch {}
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, db: dbReady, instance: INSTANCE }));
app.get('/api/info', (_req, res) =>
  res.json({ instance: INSTANCE, rooms: rooms.size, players: totalPlayers(), cols: COLS, rows: ROWS })
);
app.get('/api/top', async (_req, res) => {
  try {
    res.json({ instance: INSTANCE, top: await topTen() });
  } catch (e) {
    res.status(503).json({ error: 'db_unavailable', top: [] });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

/* --------------------------------- Juego --------------------------------- */
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const rooms = new Map();
let nextId = 1;

const totalPlayers = () => [...rooms.values()].reduce((n, r) => n + r.players.size, 0);
const rnd = (n) => Math.floor(Math.random() * n);
const clean = (s, max) => String(s || '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, max);

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.food = [];
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.events = [];
    this.fillFood();
  }

  occupied() {
    const s = new Set();
    for (const p of this.players.values()) if (p.alive) for (const c of p.body) s.add(c.y * COLS + c.x);
    for (const f of this.food) s.add(f.y * COLS + f.x);
    return s;
  }

  freeCell(margin = 0) {
    const occ = this.occupied();
    for (let i = 0; i < 300; i++) {
      const x = margin + rnd(COLS - margin * 2);
      const y = margin + rnd(ROWS - margin * 2);
      if (!occ.has(y * COLS + x)) return { x, y };
    }
    return null;
  }

  fillFood() {
    const want = Math.max(3, Math.ceil(this.players.size * 1.5));
    while (this.food.length < want) {
      const c = this.freeCell();
      if (!c) break;
      this.food.push({ ...c, t: Math.random() < 0.12 ? 1 : 0 }); // 1 = moneda dorada
    }
  }

  add(ws, name, skin, userId) {
    const p = {
      id: nextId++, ws, name: name || 'Cube', skin: skin % COLORS, userId,
      body: [], dir: 'right', queue: [], alive: false, score: 0, maxLen: 0, deaths: 0,
    };
    this.players.set(p.id, p);
    this.spawn(p);
    return p;
  }

  spawn(p) {
    const c = this.freeCell(6) || { x: 10, y: 10 };
    const dir = c.x < COLS / 2 ? 'right' : 'left';
    const d = DIRS[dir];
    p.dir = dir; p.queue = [];
    p.body = [0, 1, 2].map((i) => ({ x: c.x - d[0] * i, y: c.y - d[1] * i }));
    p.alive = true; p.score = 0; p.maxLen = 3;
    this.fillFood();
  }

  kill(p, why) {
    p.alive = false; p.deaths++;
    this.events.push({ e: 'death', id: p.id, why, x: p.body[0].x, y: p.body[0].y });
    // el cuerpo del jugador caído se convierte en orbes
    p.body.forEach((c, i) => {
      if (i % 3 === 1 && this.food.length < 60) this.food.push({ x: c.x, y: c.y, t: 0 });
    });
    saveScore(p, this.code);
    send(p.ws, { type: 'dead', score: p.score, length: p.maxLen, why });
  }

  tick() {
    const alive = [...this.players.values()].filter((p) => p.alive);
    // mover
    for (const p of alive) {
      if (p.queue.length) p.dir = p.queue.shift();
      const d = DIRS[p.dir];
      p.body.unshift({ x: p.body[0].x + d[0], y: p.body[0].y + d[1] });
      const h = p.body[0];
      const fi = this.food.findIndex((f) => f.x === h.x && f.y === h.y);
      if (fi >= 0) {
        const f = this.food.splice(fi, 1)[0];
        p.score += f.t ? 30 : 10;
        this.events.push({ e: 'eat', id: p.id, x: h.x, y: h.y, t: f.t });
      } else p.body.pop();
      if (p.body.length > p.maxLen) p.maxLen = p.body.length;
    }
    // colisiones
    const dead = [];
    for (const p of alive) {
      const h = p.body[0];
      if (h.x < 0 || h.y < 0 || h.x >= COLS || h.y >= ROWS) { dead.push([p, 'wall']); continue; }
      for (const o of alive) {
        const start = o === p ? 1 : 0;
        let hit = false;
        for (let i = start; i < o.body.length; i++) {
          if (o.body[i].x === h.x && o.body[i].y === h.y) { hit = true; break; }
        }
        if (hit) { dead.push([p, o === p ? 'self' : 'crash:' + o.name]); break; }
      }
    }
    for (const [p, why] of dead) {
      if (p.body[0].x < 0 || p.body[0].y < 0 || p.body[0].x >= COLS || p.body[0].y >= ROWS) p.body.shift();
      if (!p.body.length) p.body.push({ x: 0, y: 0 });
      this.kill(p, why);
    }
    this.fillFood();
    this.broadcast();
  }

  broadcast() {
    const msg = JSON.stringify({
      type: 's',
      f: this.food.map((f) => [f.x, f.y, f.t]),
      p: [...this.players.values()].map((p) => ({
        id: p.id, n: p.name, k: p.skin, a: p.alive ? 1 : 0, s: p.score, d: p.dir,
        b: p.alive ? p.body.map((c) => [c.x, c.y]) : [],
      })),
      ev: this.events,
    });
    this.events = [];
    for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
  }

  remove(p) {
    this.players.delete(p.id);
    if (p.alive) saveScore(p, this.code);
    if (!this.players.size) { clearInterval(this.timer); rooms.delete(this.code); }
  }
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const code = clean(url.searchParams.get('room'), 24).toLowerCase().replace(/ /g, '-') || 'arena';
  let room = rooms.get(code);
  if (!room) { room = new Room(code); rooms.set(code, room); }
  if (room.players.size >= MAX_PLAYERS) {
    send(ws, { type: 'error', msg: 'Sala llena' });
    return ws.close();
  }
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  let joining = false;
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join' && !me && !joining) {
      joining = true;
      let u = null;
      try { u = await userByToken(m.token); } catch {}
      if (!u) { send(ws, { type: 'error', code: 'auth', msg: 'Inicia sesión para jugar' }); return ws.close(); }
      if (ws.readyState !== 1) return;
      if (room.players.size >= MAX_PLAYERS) { send(ws, { type: 'error', msg: 'Sala llena' }); return ws.close(); }
      const skin = (parseInt(m.skin, 10) || 0) % COLORS;
      pool.query('UPDATE users SET skin = $2 WHERE id = $1', [u.id, skin]).catch(() => {});
      me = room.add(ws, u.username, skin, u.id);
      send(ws, { type: 'welcome', id: me.id, room: room.code, instance: INSTANCE, cols: COLS, rows: ROWS, tick: TICK_MS });
    } else if (!me) return;
    else if (m.type === 'dir' && DIRS[m.dir] && me.alive) {
      const last = me.queue.length ? me.queue[me.queue.length - 1] : me.dir;
      if (m.dir !== last && m.dir !== OPP[last] && me.queue.length < 3) me.queue.push(m.dir);
    } else if (m.type === 'respawn') {
      if (me.alive) { saveScore(me, room.code); me.maxLen = 3; }
      room.spawn(me);
    }
  });
  ws.on('close', () => {
    if (me) room.remove(me);
    else if (!room.players.size) { clearInterval(room.timer); if (rooms.get(room.code) === room) rooms.delete(room.code); }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

initDb();
server.listen(PORT, () => console.log(`[snake-dash] ${INSTANCE} escuchando en :${PORT}`));

const shutdown = () => {
  console.log('apagando...');
  wss.clients.forEach((c) => c.close(1001));
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
