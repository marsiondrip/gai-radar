// ГАИ РАДАР — сервер мини-приложения (by mrsndrp)
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- настройки (через переменные окружения) ----------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const DEV = process.env.DEV === '1';             // без Telegram, только для теста
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// ключ, которым «затуманиваются» Telegram id (по умолчанию берём токен бота)
const SECRET = process.env.SECRET || BOT_TOKEN || 'dev-secret';

const CITY = { lat: 52.9586, lng: 55.9300, radius: 18000 }; // Мелеуз, радиус зоны в метрах
const TTL_MIN = { post: 120, patrol: 120, fuel: 240 };      // сколько живёт точка без подтверждений
const GONE_TO_REMOVE = 3;     // сколько «уехали / не так» нужно, чтобы убрать точку
const COOLDOWN_SEC = 90;      // антиспам: одна новая точка раз в 90 секунд
const MERGE_M = 70;           // отчёт по АЗС ближе 70 м обновляет уже стоящую точку
const MAX_PHOTO = 4 * 1024 * 1024;
const FUEL_KEYS = ['92', '95', '100', 'dt', 'gas'];
const CHAT_KEEP_MS = 48 * 3600 * 1000;
const CHAT_MAX = 300;

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'posts.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');

let posts = [];
try { posts = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { posts = []; }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(posts));

let chat = { seq: 0, messages: [], bans: [] };
try { chat = { ...chat, ...JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')) }; } catch { /* пусто */ }
const saveChat = () => fs.writeFileSync(CHAT_FILE, JSON.stringify(chat));

// ---------- анонимность ----------
// Telegram id нигде не хранится и не отдаётся: только необратимый хеш.
const anon = id => crypto.createHmac('sha256', SECRET).update(String(id)).digest('hex').slice(0, 24);

const ADJ = ['Тихий', 'Быстрый', 'Хитрый', 'Серый', 'Ночной', 'Смелый', 'Шустрый', 'Рыжий',
  'Мудрый', 'Лихой', 'Ловкий', 'Бодрый', 'Зоркий', 'Хмурый', 'Весёлый', 'Дерзкий'];
const ANI = ['Лис', 'Енот', 'Волк', 'Ёж', 'Барсук', 'Кот', 'Сокол', 'Филин',
  'Бобр', 'Тигр', 'Медведь', 'Орёл', 'Заяц', 'Олень', 'Хорёк', 'Ворон'];
function nick(uid) {
  const b = Buffer.from(uid, 'hex');
  return { name: `${ADJ[b[0] % 16]} ${ANI[b[1] % 16]} ${10 + (b[2] % 90)}`, hue: Math.round((b[3] / 255) * 360) };
}

// ---------- проверка подписи Telegram initData ----------
function checkInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

function auth(req, res, next) {
  let raw = null;
  const user = checkInitData(req.get('X-Init-Data'));
  if (user) raw = String(user.id);
  else if (DEV) raw = req.get('X-Dev-User') || '1';
  if (!raw) return res.status(401).json({ error: 'Открой приложение через Telegram' });
  req.user = { id: anon(raw), admin: ADMIN_IDS.includes(raw) };
  next();
}

function notBanned(req, res, next) {
  if (chat.bans.includes(req.user.id)) return res.status(403).json({ error: 'Доступ закрыт' });
  next();
}

// ---------- утилиты ----------
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function dropPhoto(name) {
  if (name) fs.rm(path.join(DATA_DIR, 'uploads', name), { force: true }, () => {});
}
function removePost(p) {
  dropPhoto(p.photo);
  posts = posts.filter(x => x.id !== p.id);
}

function cleanup() {
  const now = Date.now();
  for (const p of [...posts]) {
    const gone = Object.values(p.votes).filter(v => v.v === 'gone').length;
    const ttl = (TTL_MIN[p.type] || 120) * 60000;
    if (now - p.lastActivity > ttl || gone >= GONE_TO_REMOVE) removePost(p);
  }
  save();
  const before = chat.messages.length;
  chat.messages = chat.messages.filter(m => now - m.t < CHAT_KEEP_MS);
  if (chat.messages.length !== before) saveChat();
}
setInterval(cleanup, 60000);

function view(p, uid, admin) {
  const vals = Object.values(p.votes);
  return {
    id: p.id, type: p.type, lat: p.lat, lng: p.lng,
    comment: p.comment, photo: p.photo ? `/uploads/${p.photo}` : null,
    createdAt: p.createdAt, lastActivity: p.lastActivity,
    fuel: p.fuel || null, queue: p.queue ?? null,
    stands: vals.filter(v => v.v === 'stands').length,
    gone: vals.filter(v => v.v === 'gone').length,
    myVote: p.votes[uid]?.v || null,
    mine: p.authorId === uid,
    canDelete: p.authorId === uid || !!admin,
  };
}

function parseFuel(raw) {
  let o = {};
  try { o = JSON.parse(raw || '{}'); } catch { o = {}; }
  const fuel = {};
  for (const k of FUEL_KEYS) if (o[k] === 'yes' || o[k] === 'no') fuel[k] = o[k];
  return fuel;
}

function readPhoto(file) {
  if (!file) return {};
  const b = file.buffer;
  const isJpg = b[0] === 0xff && b[1] === 0xd8;
  const isPng = b[0] === 0x89 && b[1] === 0x50;
  if (!isJpg && !isPng) return { error: 'Фото должно быть JPG или PNG' };
  return { buf: b, ext: isPng ? '.png' : '.jpg' };
}
function writePhoto(ph) {
  const name = crypto.randomUUID() + ph.ext;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), ph.buf);
  return name;
}

// ---------- API ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO, files: 1 },
});

app.get('/api/config', (_req, res) => res.json({ city: CITY, ttlMin: TTL_MIN.post, fuelTtlMin: TTL_MIN.fuel }));

app.get('/api/posts', auth, (req, res) => {
  res.json(posts.map(p => view(p, req.user.id, req.user.admin)));
});

const lastPost = new Map();

app.post('/api/posts', auth, notBanned, upload.single('photo'), (req, res) => {
  const { id: uid, admin } = req.user;
  const type = ['post', 'patrol', 'fuel'].includes(req.body.type) ? req.body.type : 'post';
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  const comment = String(req.body.comment || '').trim().slice(0, 200);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Нет координат' });
  if (dist(lat, lng, CITY.lat, CITY.lng) > CITY.radius)
    return res.status(400).json({ error: 'Здесь пока soon… Работает только Мелеуз' });

  const last = lastPost.get(uid) || 0;
  if (Date.now() - last < COOLDOWN_SEC * 1000)
    return res.status(429).json({ error: 'Подожди чуть-чуть перед новой точкой' });

  let fuel = null, queue = null;
  if (type === 'fuel') {
    fuel = parseFuel(req.body.fuel);
    const q = String(req.body.queue ?? '');
    queue = ['0', '1', '2', '3'].includes(q) ? Number(q) : null;
    if (!Object.keys(fuel).length && queue === null)
      return res.status(400).json({ error: 'Отметь бензин или очередь' });
  }

  const ph = readPhoto(req.file);
  if (ph.error) return res.status(400).json({ error: ph.error });

  const now = Date.now();

  // отчёт по АЗС рядом с уже стоящей — обновляем её, а не плодим дубли
  if (type === 'fuel') {
    const near = posts.find(p => p.type === 'fuel' && dist(lat, lng, p.lat, p.lng) <= MERGE_M);
    if (near) {
      near.fuel = fuel;
      near.queue = queue;
      if (comment) near.comment = comment;
      if (ph.buf) { dropPhoto(near.photo); near.photo = writePhoto(ph); }
      near.votes = { [uid]: { v: 'stands', t: now } };
      near.lastActivity = now;
      lastPost.set(uid, now);
      save();
      return res.json({ ...view(near, uid, admin), merged: true });
    }
  }

  const p = {
    id: crypto.randomUUID(), type, lat, lng, comment,
    photo: ph.buf ? writePhoto(ph) : null,
    fuel, queue,
    createdAt: now, lastActivity: now, authorId: uid,
    votes: { [uid]: { v: 'stands', t: now } },
  };
  posts.push(p);
  lastPost.set(uid, now);
  save();
  res.json(view(p, uid, admin));
});

app.post('/api/posts/:id/vote', auth, notBanned, (req, res) => {
  const p = posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Точка уже исчезла' });
  const v = req.body.v === 'gone' ? 'gone' : req.body.v === 'stands' ? 'stands' : null;
  if (!v) return res.status(400).json({ error: 'bad vote' });
  p.votes[req.user.id] = { v, t: Date.now() };
  if (v === 'stands') p.lastActivity = Date.now(); // подтверждение продлевает жизнь точки
  const gone = Object.values(p.votes).filter(x => x.v === 'gone').length;
  if (gone >= GONE_TO_REMOVE) { removePost(p); save(); return res.json({ removed: true }); }
  save();
  res.json(view(p, req.user.id, req.user.admin));
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const p = posts.find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: true });
  if (p.authorId !== req.user.id && !req.user.admin) return res.status(403).json({ error: 'Нельзя' });
  removePost(p); save();
  res.json({ ok: true });
});

// ---------- анонимный чат ----------
const chatView = (m, uid, admin) => {
  const k = nick(m.uid);
  return { n: m.n, t: m.t, nick: k.name, hue: k.hue, text: m.text, mine: m.uid === uid, canDelete: m.uid === uid || !!admin };
};
const chatTimes = new Map();

app.get('/api/chat', auth, (req, res) => {
  const after = Number(req.query.after) || 0;
  const list = chat.messages.filter(m => m.n > after).slice(-100);
  const me = nick(req.user.id);
  res.json({
    me: { nick: me.name, hue: me.hue, admin: req.user.admin },
    seq: chat.seq,
    messages: list.map(m => chatView(m, req.user.id, req.user.admin)),
  });
});

app.post('/api/chat', auth, notBanned, (req, res) => {
  const { id: uid, admin } = req.user;
  const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  if (!admin && /(https?:\/\/|t\.me|www\.|@\w{4,})/i.test(text))
    return res.status(400).json({ error: 'Ссылки и @имена в чате нельзя' });

  const now = Date.now();
  const times = (chatTimes.get(uid) || []).filter(t => now - t < 60000);
  if (times.length && now - times[times.length - 1] < 1500) return res.status(429).json({ error: 'Не так быстро' });
  if (times.length >= 12) return res.status(429).json({ error: 'Слишком много сообщений, подожди минуту' });
  const lastMine = [...chat.messages].reverse().find(m => m.uid === uid);
  if (lastMine && lastMine.text === text && now - lastMine.t < 15000)
    return res.status(429).json({ error: 'Это уже отправлено' });

  times.push(now);
  chatTimes.set(uid, times);
  const m = { n: ++chat.seq, t: now, uid, text };
  chat.messages.push(m);
  if (chat.messages.length > CHAT_MAX) chat.messages.shift();
  saveChat();
  res.json(chatView(m, uid, admin));
});

app.delete('/api/chat/:n', auth, (req, res) => {
  const n = Number(req.params.n);
  const m = chat.messages.find(x => x.n === n);
  if (!m) return res.json({ ok: true });
  if (m.uid !== req.user.id && !req.user.admin) return res.status(403).json({ error: 'Нельзя' });
  chat.messages = chat.messages.filter(x => x.n !== n);
  saveChat();
  res.json({ ok: true });
});

// админ: удалить сообщение + забанить автора (его сообщения и точки тоже убираются)
app.post('/api/chat/:n/ban', auth, (req, res) => {
  if (!req.user.admin) return res.status(403).json({ error: 'Нельзя' });
  const n = Number(req.params.n);
  const m = chat.messages.find(x => x.n === n);
  if (!m) return res.status(404).json({ error: 'Сообщения уже нет' });
  const uid = m.uid;
  if (uid === req.user.id) return res.status(400).json({ error: 'Себя банить не нужно' });
  if (!chat.bans.includes(uid)) chat.bans.push(uid);
  chat.messages = chat.messages.filter(x => x.uid !== uid);
  for (const p of posts.filter(x => x.authorId === uid)) removePost(p);
  save(); saveChat();
  res.json({ ok: true });
});

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '1h' }));

// страницы лежат рядом с server.js; отдаём только эти три файла (data/ и server.js наружу не торчат)
const sendPage = f => (_req, res) => res.sendFile(path.join(__dirname, f));
app.get(['/', '/index.html'], sendPage('index.html'));
app.get('/style.css', sendPage('style.css'));
app.get('/app.js', sendPage('app.js'));

app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Фото слишком большое' : 'Ошибка сервера';
  res.status(400).json({ error: msg });
});

app.listen(PORT, () => console.log(`ГАИ РАДАР на порту ${PORT}${DEV ? ' (DEV)' : ''}`));

// ---------- мини-бот: /start с кнопкой открытия ----------
if (BOT_TOKEN && WEBAPP_URL) {
  const api = (m, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

  (async () => {
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'РАДАР', web_app: { url: WEBAPP_URL } } });
    let offset = 0;
    for (;;) {
      try {
        const r = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          const m = u.message;
          if (m?.text?.startsWith('/start')) {
            await api('sendMessage', {
              chat_id: m.chat.id,
              text: '📡 ГАИ РАДАР — посты, патрули и заправки на карте Мелеуза',
              reply_markup: { inline_keyboard: [[{ text: 'Открыть радар', web_app: { url: WEBAPP_URL } }]] },
            });
          }
        }
      } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}
