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
        CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC);`);
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
      'INSERT INTO scores (name, score, length, room, instance) VALUES ($1,$2,$3,$4,$5)',
      [p.name, p.score, p.maxLen, room, INSTANCE]
    );
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
app.use(express.static(path.join(__dirname, 'public')));

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

  add(ws, name, skin) {
    const p = {
      id: nextId++, ws, name: name || 'Cube', skin: skin % COLORS,
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

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join' && !me) {
      me = room.add(ws, clean(m.name, 12) || 'Cube', parseInt(m.skin, 10) || 0);
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
  ws.on('close', () => me && room.remove(me));
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
