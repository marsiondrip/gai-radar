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
const WEBAPP_URL = process.env.WEBAPP_URL || ''; // https://твой-домен
const DEV = process.env.DEV === '1';             // без Telegram, только для теста
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const CITY = { lat: 52.9586, lng: 55.9300, radius: 18000 }; // Мелеуз, радиус зоны в метрах
const TTL_MIN = 120;          // точка живёт 2 часа без подтверждений
const GONE_TO_REMOVE = 3;     // сколько «уехали» нужно, чтобы убрать точку
const COOLDOWN_SEC = 120;     // антиспам: одна новая точка раз в 2 минуты
const MAX_PHOTO = 4 * 1024 * 1024;

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'posts.json');

let posts = [];
try { posts = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { posts = []; }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(posts));

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
  const user = checkInitData(req.get('X-Init-Data'));
  if (user) { req.user = { id: String(user.id) }; return next(); }
  if (DEV) { req.user = { id: req.get('X-Dev-User') || '1' }; return next(); }
  res.status(401).json({ error: 'Открой приложение через Telegram' });
}

// ---------- утилиты ----------
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function removePost(p) {
  if (p.photo) fs.rm(path.join(DATA_DIR, 'uploads', p.photo), { force: true }, () => {});
  posts = posts.filter(x => x.id !== p.id);
}

function cleanup() {
  const now = Date.now();
  for (const p of [...posts]) {
    const gone = Object.values(p.votes).filter(v => v.v === 'gone').length;
    if (now - p.lastActivity > TTL_MIN * 60000 || gone >= GONE_TO_REMOVE) removePost(p);
  }
  save();
}
setInterval(cleanup, 60000);

function view(p, uid) {
  const vals = Object.values(p.votes);
  return {
    id: p.id, type: p.type, lat: p.lat, lng: p.lng,
    comment: p.comment, photo: p.photo ? `/uploads/${p.photo}` : null,
    createdAt: p.createdAt, lastActivity: p.lastActivity,
    stands: vals.filter(v => v.v === 'stands').length,
    gone: vals.filter(v => v.v === 'gone').length,
    myVote: p.votes[uid]?.v || null,
    mine: p.authorId === uid,
  };
}

// ---------- API ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO, files: 1 },
});

app.get('/api/config', (_req, res) => res.json({ city: CITY, ttlMin: TTL_MIN }));

app.get('/api/posts', auth, (req, res) => {
  res.json(posts.map(p => view(p, req.user.id)));
});

const lastPost = new Map();

app.post('/api/posts', auth, upload.single('photo'), (req, res) => {
  const uid = req.user.id;
  const type = req.body.type === 'patrol' ? 'patrol' : 'post';
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  const comment = String(req.body.comment || '').trim().slice(0, 200);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Нет координат' });
  if (dist(lat, lng, CITY.lat, CITY.lng) > CITY.radius)
    return res.status(400).json({ error: 'Здесь пока soon… Работает только Мелеуз' });

  const last = lastPost.get(uid) || 0;
  if (Date.now() - last < COOLDOWN_SEC * 1000)
    return res.status(429).json({ error: 'Подожди пару минут перед новой точкой' });

  let photo = null;
  if (req.file) {
    const b = req.file.buffer;
    const isJpg = b[0] === 0xff && b[1] === 0xd8;
    const isPng = b[0] === 0x89 && b[1] === 0x50;
    if (!isJpg && !isPng) return res.status(400).json({ error: 'Фото должно быть JPG или PNG' });
    photo = crypto.randomUUID() + (isPng ? '.png' : '.jpg');
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', photo), b);
  }

  const now = Date.now();
  const p = {
    id: crypto.randomUUID(), type, lat, lng, comment, photo,
    createdAt: now, lastActivity: now, authorId: uid,
    votes: { [uid]: { v: 'stands', t: now } },
  };
  posts.push(p);
  lastPost.set(uid, now);
  save();
  res.json(view(p, uid));
});

app.post('/api/posts/:id/vote', auth, (req, res) => {
  const p = posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Точка уже исчезла' });
  const v = req.body.v === 'gone' ? 'gone' : req.body.v === 'stands' ? 'stands' : null;
  if (!v) return res.status(400).json({ error: 'bad vote' });
  p.votes[req.user.id] = { v, t: Date.now() };
  if (v === 'stands') p.lastActivity = Date.now(); // подтверждение продлевает жизнь точки
  const gone = Object.values(p.votes).filter(x => x.v === 'gone').length;
  if (gone >= GONE_TO_REMOVE) { removePost(p); save(); return res.json({ removed: true }); }
  save();
  res.json(view(p, req.user.id));
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const p = posts.find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: true });
  if (p.authorId !== req.user.id && !ADMIN_IDS.includes(req.user.id))
    return res.status(403).json({ error: 'Нельзя' });
  removePost(p); save();
  res.json({ ok: true });
});

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

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
              text: '📡 ГАИ РАДАР — отмечай посты и патрули на карте Мелеуза',
              reply_markup: { inline_keyboard: [[{ text: 'Открыть радар', web_app: { url: WEBAPP_URL } }]] },
            });
          }
        }
      } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}
