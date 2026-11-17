// ГАИ РАДАР — клиент (by mrsndrp)
const tg = window.Telegram?.WebApp;
try {
  tg?.ready(); tg?.expand();
  tg?.setHeaderColor?.('#04100a'); tg?.setBackgroundColor?.('#04100a');
  tg?.disableVerticalSwipes?.();
} catch {}

const $ = id => document.getElementById(id);
const MELEUZ = { lat: 52.9586, lng: 55.9300 };
let RADIUS = 18000;

// ---------- реклама в чате (меняй тексты здесь) ----------
const ADS = [
  { text: 'Для покупки рекламы пишите в чат: баннеры, звуковые рекламы' },
  { text: 'тг @marsisup', link: 'https://t.me/marsisup' },
];

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'X-Init-Data': tg?.initData || '', ...(opts.headers || {}) };
  const r = await fetch('/api' + path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка');
  return data;
}
const jsonOpts = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------- мелочи ----------
let toastT;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = ''), 2600);
}
const buzz = (k = 'light') => { try { tg?.HapticFeedback?.impactOccurred(k); } catch {} };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const plural = (n, f) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5) return f[1];
  return b === 1 ? f[0] : f[2];
};
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин назад`;
}
function fmtDist(m) {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} м`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const rad = x => (x * Math.PI) / 180;
function distM(a, b) {
  const R = 6371000;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearingTo(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function lerpAngle(a, b, k) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * k + 360) % 360;
}
function div(cls, text) {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- справочники ----------
const TYPE_LABEL = { post: 'ПОСТ', patrol: 'ПАТРУЛЬ', fuel: 'АЗС' };
const TYPE_TITLE = { post: '🚨 ПОСТ', patrol: '🚓 ПАТРУЛЬ', fuel: '⛽ АЗС' };
const FUELS = [['92', 'АИ-92'], ['95', 'АИ-95'], ['100', 'АИ-100'], ['dt', 'ДТ'], ['gas', 'ГАЗ']];
const QUEUES = [['НЕТ', 'очереди нет'], ['МАЛО', 'до 5 машин'], ['СРЕДНЯЯ', '5–15 машин'], ['БОЛЬШАЯ', 'больше 15 машин']];
const fuelName = k => (FUELS.find(f => f[0] === k) || [k, k])[1];

// ---------- состояние ----------
let map = null;
let posts = [];
const markers = new Map();     // id -> { m, el, p }
let myPos = null;              // { lat, lng, t, speed (м/с), heading (°) }
let meMarker = null;
let sheetOpen = false;
let addMode = false;
let viewId = null;
let crossY = 0;

// навигатор («как у таксистов»)
let follow = false;            // карта едет за мной
let courseUp = false;          // карта поворачивается по курсу
let autoEngaged = false;       // включился сам, когда поехал
let blockedUntil = 0;          // после ручного сдвига карты не включаемся сами
let userZoomUntil = 0;         // после ручного зума не меняем масштаб
let fastCount = 0, stillSince = 0;

const TOP_PAD = 72;
const busy = () => sheetOpen || !$('chat').hidden;

// ---------- карта ----------
async function ensureMapLib() {
  if (window.maplibregl) return true;
  try {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css';
    document.head.appendChild(l);
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  } catch {}
  return !!window.maplibregl;
}

const CITIES = [
  ['УФА', 54.7388, 55.9721], ['СТЕРЛИТАМАК', 53.6246, 55.9505], ['САЛАВАТ', 53.3617, 55.9246],
  ['КУМЕРТАУ', 52.7706, 55.7833], ['ОКТЯБРЬСКИЙ', 54.4815, 53.4659], ['СИБАЙ', 52.7208, 58.6663],
  ['ОРЕНБУРГ', 51.7682, 55.0970], ['ОРСК', 51.2049, 58.5668], ['САМАРА', 53.1959, 50.1002],
  ['КАЗАНЬ', 55.7887, 49.1221], ['ЧЕЛЯБИНСК', 55.1644, 61.4368], ['ЕКАТЕРИНБУРГ', 56.8389, 60.6057],
  ['ПЕРМЬ', 58.0105, 56.2502], ['САРАТОВ', 51.5336, 46.0343], ['ВОЛГОГРАД', 48.7080, 44.5133],
  ['НОВОСИБИРСК', 55.0084, 82.9357], ['МОСКВА', 55.7558, 37.6173], ['САНКТ-ПЕТЕРБУРГ', 59.9343, 30.3351],
  ['КРАСНОДАР', 45.0355, 38.9753], ['РОСТОВ', 47.2357, 39.7015], ['ВОРОНЕЖ', 51.6720, 39.1843],
  ['НИЖНИЙ НОВГОРОД', 56.2965, 43.9361], ['ОМСК', 54.9885, 73.3242], ['ТЮМЕНЬ', 57.1522, 65.5272],
  ['КРАСНОЯРСК', 56.0153, 92.8932], ['ИРКУТСК', 52.2870, 104.3050], ['ВЛАДИВОСТОК', 43.1155, 131.8855],
];

function soonEl(name, live) {
  const e = div('soon' + (live ? ' live' : ''));
  e.append(Object.assign(document.createElement('b'), { textContent: name }),
    Object.assign(document.createElement('i'), { textContent: live ? '● LIVE' : 'soon…' }));
  return e;
}
const mk = (el, lng, lat, extra = {}) =>
  new maplibregl.Marker({ element: el, anchor: 'center', rotationAlignment: 'viewport', pitchAlignment: 'viewport', ...extra })
    .setLngLat([lng, lat]).addTo(map);

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap' } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#04100a' } },
        { id: 'osm', type: 'raster', source: 'osm' },
      ],
    },
    center: [MELEUZ.lng, MELEUZ.lat], zoom: 12, minZoom: 3, maxZoom: 18,
    maxPitch: 0, pitchWithRotate: false, touchPitch: false, dragRotate: true,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: '<span class="by">by mrsndrp</span>' }), 'bottom-right');

  // «soon…» для остальных городов — видно при отдалении
  mk(soonEl('МЕЛЕУЗ', true), MELEUZ.lng, MELEUZ.lat);
  CITIES.forEach(([n, lat, lng]) => mk(soonEl(n, false), lng, lat));

  // граница рабочей зоны (рисуем на экране, чтобы не попадать под зелёный фильтр карты)
  const zone = div('zone');
  mk(zone, MELEUZ.lng, MELEUZ.lat);
  const sizeZone = () => {
    const mpp = (78271.516964 * Math.cos(rad(MELEUZ.lat))) / 2 ** map.getZoom();
    const px = (2 * RADIUS) / mpp;
    zone.style.display = px > 3200 ? 'none' : 'block';
    zone.style.width = zone.style.height = Math.round(px) + 'px';
  };

  const onZoom = () => {
    const z = map.getZoom();
    document.body.classList.toggle('far', z <= 8.5);
    document.body.classList.toggle('zin', z >= 14);
    sizeZone();
  };
  const onRotate = () => {
    const b = map.getBearing();
    $('needle').style.transform = `rotate(${-b}deg)`;
    $('compass').classList.toggle('rot', Math.abs(((b + 180) % 360) - 180) > 1);
  };
  map.on('zoom', onZoom);
  map.on('rotate', onRotate);
  onZoom(); onRotate();

  // сдвинул карту рукой — выходим из навигатора; зумнул — не трогаем масштаб
  map.on('dragstart', () => {
    if (busy() || !follow) return;
    follow = false; courseUp = false; autoEngaged = false;
    blockedUntil = Date.now() + 45000;
    syncNav(); applyPadding(true);
  });
  map.on('zoomstart', e => { if (e.originalEvent) userZoomUntil = Date.now() + 20000; });
  window.addEventListener('resize', () => { applyPadding(false); });

  // метка «я» со стрелкой курса
  const meEl = div('me still');
  meEl.append(div('cone'), div('dot'));
  meMarker = new maplibregl.Marker({ element: meEl, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'viewport' });
  meMarker._el = meEl;
}

// ---------- отступы карты: прицел и «я чуть ниже центра» ----------
function computePadding() {
  const H = $('map').clientHeight;
  if (sheetOpen) return { top: TOP_PAD, bottom: $('sheet').offsetHeight, left: 0, right: 0 };
  if (follow) return { top: Math.round(H * 0.42), bottom: 0, left: 0, right: 0 };
  return { top: 0, bottom: 0, left: 0, right: 0 };
}
function placeCross() {
  const H = $('map').clientHeight, p = computePadding();
  crossY = p.top + (H - p.top - p.bottom) / 2;
  $('cross').style.top = crossY + 'px';
}
function applyPadding(animate = true) {
  if (!map) return;
  placeCross();
  map.easeTo({ padding: computePadding(), duration: animate ? 240 : 0 });
}
function crossLngLat() {
  return map.unproject([$('map').clientWidth / 2, crossY]);
}
function mapCenterLL() {
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

// ---------- метки на карте ----------
const PIN_HTML = '<div class="pin"><span class="ring"></span><span class="ring r2"></span><span class="core"></span><em></em><small></small></div>';

function fuelSummary(p) {
  const nodes = [];
  for (const [k] of FUELS) {
    const s = p.fuel && p.fuel[k];
    if (!s) continue;
    const b = document.createElement('b');
    b.textContent = k === 'dt' ? 'ДТ' : k === 'gas' ? 'ГАЗ' : k;
    if (s === 'no') b.className = 'no';
    nodes.push(b);
  }
  if (p.queue !== null && p.queue !== undefined) {
    const q = document.createElement('span');
    q.className = 'qq l' + p.queue;
    q.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    nodes.push(q);
  }
  return nodes;
}

function paintPin(e) {
  const p = e.p, pin = e.el.firstElementChild;
  const stale = Date.now() - p.lastActivity > 40 * 60000;
  pin.className = `pin ${p.type}${stale ? ' stale' : ''}`;
  let label = TYPE_LABEL[p.type];
  if (myPos) {
    const d = distM(myPos, p);
    if (d < 30000) label += ' · ' + fmtDist(d);
  }
  pin.querySelector('em').textContent = label;
  pin.querySelector('small').replaceChildren(...(p.type === 'fuel' ? fuelSummary(p) : []));
}

function render() {
  if (!map) return;
  const ids = new Set(posts.map(p => p.id));
  for (const [id, e] of markers) if (!ids.has(id)) { e.m.remove(); markers.delete(id); }
  for (const p of posts) {
    let e = markers.get(p.id);
    if (!e) {
      const el = div('pinwrap');
      el.innerHTML = PIN_HTML;
      el.addEventListener('click', ev => { ev.stopPropagation(); buzz(); openView(p.id); });
      e = { m: mk(el, p.lng, p.lat), el, p };
      markers.set(p.id, e);
    }
    e.p = p;
    paintPin(e);
  }
  const n = posts.length;
  $('count').textContent = `${n} ${plural(n, ['ТОЧКА', 'ТОЧКИ', 'ТОЧЕК'])}`;
  updateNear();
}

async function load() {
  try {
    posts = await api('/posts');
    render();
    if (viewId) refreshView();
  } catch (e) {
    if (!posts.length) toast(e.message, true);
  }
}

// ближайший пост/патруль — плашка в режиме навигатора
function updateNear() {
  const el = $('near');
  if (!myPos || !follow) { el.hidden = true; return; }
  let best = null, bd = 3000;
  for (const p of posts) {
    if (p.type === 'fuel') continue;
    const d = distM(myPos, p);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) { el.hidden = true; return; }
  el.textContent = `${TYPE_LABEL[best.type]} · ${fmtDist(bd)}`;
  el.hidden = false;
}

// ---------- панель ----------
const sheet = $('sheet');

function showSheet(mode) {
  sheetOpen = true;
  sheet.hidden = false;
  $('mode-add').hidden = mode !== 'add';
  $('mode-view').hidden = mode !== 'view';
  document.body.classList.add('busy');
}
function hideSheet() {
  sheetOpen = false; viewId = null; addMode = false;
  sheet.hidden = true;
  $('cross').hidden = true;
  document.body.classList.remove('busy');
  if (map) {
    applyPadding(true);
    if (follow && myPos) followTo(myPos);
  }
  syncBack();
}

// карточка точки
function openView(id) {
  if (!map) return;
  viewId = id; addMode = false;
  $('cross').hidden = true;
  showSheet('view');
  refreshView();
  const p = posts.find(x => x.id === id);
  placeCross();
  if (p) map.easeTo({ center: [p.lng, p.lat], padding: computePadding(), duration: 400 });
  syncBack();
}
function refreshView() {
  const p = posts.find(x => x.id === viewId);
  if (!p) { hideSheet(); return; }
  const fuel = p.type === 'fuel';
  $('v-title').textContent = TYPE_TITLE[p.type];
  $('v-age').textContent = `отмечен ${ago(p.createdAt)} · обновлён ${ago(p.lastActivity)}`;
  $('v-comment').textContent = p.comment || '';
  const img = $('v-photo');
  if (p.photo) { img.src = p.photo; img.hidden = false; } else img.hidden = true;

  $('v-fuel').hidden = !fuel;
  if (fuel) {
    const chips = $('v-chips');
    chips.replaceChildren();
    for (const [k] of FUELS) {
      const s = p.fuel && p.fuel[k];
      if (!s) continue;
      const c = div('vchip ' + s, fuelName(k) + (s === 'yes' ? ' ✓' : ' ✗'));
      chips.append(c);
    }
    if (!chips.children.length) chips.append(div('vchip', 'бензин: нет данных'));
    const q = p.queue;
    $('v-qlabel').textContent = q === null || q === undefined ? 'очередь: нет данных' : `очередь: ${QUEUES[q][1]}`;
    $('v-qbar').className = 'qbar' + (q === null || q === undefined ? '' : ' l' + q);
  }

  $('v-stands').textContent = p.stands;
  $('v-gone').textContent = p.gone;
  $('v-gone-l').textContent = fuel ? 'не так' : 'уехали';
  $('v-yes').textContent = fuel ? 'ВЕРНО ✓' : 'СТОИТ ✓';
  $('v-no').textContent = fuel ? 'НЕВЕРНО ✗' : 'УЕХАЛИ ✗';
  $('v-yes').classList.toggle('voted', p.myVote === 'stands');
  $('v-no').classList.toggle('voted', p.myVote === 'gone');
  $('v-upd').hidden = !fuel;
  $('v-del').hidden = !p.canDelete;
}
async function vote(v) {
  if (!viewId) return;
  buzz('medium');
  try {
    const r = await api(`/posts/${viewId}/vote`, jsonOpts('POST', { v }));
    if (r.removed) { toast('Точка убрана'); hideSheet(); }
    else {
      toast(v === 'stands' ? 'Подтвердил' : 'Отметил: уже не так');
      posts = posts.map(p => (p.id === r.id ? r : p));
    }
    await load();
  } catch (e) { toast(e.message, true); }
}
$('v-yes').onclick = () => vote('stands');
$('v-no').onclick = () => vote('gone');
$('close').onclick = hideSheet;
$('v-del').onclick = async () => {
  try { await api(`/posts/${viewId}`, { method: 'DELETE' }); hideSheet(); load(); } catch (e) { toast(e.message, true); }
};
$('v-upd').onclick = () => {
  const p = posts.find(x => x.id === viewId);
  if (p) openAdd({ type: 'fuel', at: p, fuel: p.fuel, queue: p.queue });
};

// ---------- добавление точки ----------
let type = 'post';
let photoBlob = null;
let fuelSt = {};       // { '92': 'yes' | 'no' }
let queueSt = null;    // 0..3

function buildFuelForm() {
  const chips = $('fuel-chips');
  chips.replaceChildren();
  for (const [k, label] of FUELS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.k = k;
    b.textContent = label.replace('АИ-', '');
    b.onclick = () => {
      const s = fuelSt[k];
      if (!s) fuelSt[k] = 'yes'; else if (s === 'yes') fuelSt[k] = 'no'; else delete fuelSt[k];
      paintFuelForm(); buzz();
    };
    chips.append(b);
  }
  const row = $('queue-row');
  row.replaceChildren();
  QUEUES.forEach(([label], i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.q = String(i);
    b.textContent = label;
    b.onclick = () => { queueSt = queueSt === i ? null : i; paintFuelForm(); buzz(); };
    row.append(b);
  });
  paintFuelForm();
}
function paintFuelForm() {
  for (const b of $('fuel-chips').children) {
    const s = fuelSt[b.dataset.k];
    b.className = 'chip' + (s ? ' ' + s : '');
    const base = b.dataset.k === 'dt' ? 'ДТ' : b.dataset.k === 'gas' ? 'ГАЗ' : b.dataset.k;
    b.textContent = base + (s === 'yes' ? ' ✓' : s === 'no' ? ' ✗' : '');
  }
  for (const b of $('queue-row').children) {
    const i = Number(b.dataset.q);
    b.className = `qb q${i}` + (queueSt === i ? ' on' : '');
  }
}

function setType(t) {
  type = t;
  for (const b of $('seg').children) b.classList.toggle('on', b.dataset.t === t);
  $('fuel-form').hidden = t !== 'fuel';
  $('add-title').textContent = t === 'fuel' ? 'ЗАПРАВКА' : 'НОВАЯ ТОЧКА';
  $('comment').placeholder = t === 'fuel'
    ? 'комментарий (по желанию): какая АЗС, что случилось…'
    : 'комментарий (по желанию): где именно, в какую сторону…';
  if (sheetOpen && map) applyPadding(true);   // панель стала выше или ниже — двигаем прицел
}
for (const b of $('seg').children) b.onclick = () => { setType(b.dataset.t); buzz(); };

function resetForm() {
  fuelSt = {}; queueSt = null; photoBlob = null;
  $('comment').value = ''; $('photo').value = ''; $('photo-name').textContent = 'без фото';
  paintFuelForm();
}

function openAdd(opts = {}) {
  if (!map) return;
  buzz();
  viewId = null; addMode = true;
  resetForm();
  fuelSt = opts.fuel ? { ...opts.fuel } : {};
  queueSt = opts.queue === undefined ? null : opts.queue;
  paintFuelForm();
  showSheet('add');
  setType(opts.type || 'post');
  $('cross').hidden = false;
  placeCross();

  // куда смотреть: на заданную точку, на себя (если я в зоне) или на Мелеуз
  let at = opts.at || null;
  if (!at && myPos && distM(myPos, MELEUZ) <= RADIUS) at = myPos;
  if (!at && distM(mapCenterLL(), MELEUZ) > RADIUS) at = MELEUZ;
  const o = { padding: computePadding(), duration: 450 };
  if (at) { o.center = [at.lng, at.lat]; o.zoom = Math.max(map.getZoom(), 15.5); }
  else if (map.getZoom() < 14) o.zoom = 15;
  map.easeTo(o);
  syncBack();
}
$('add').onclick = () => openAdd();
$('cancel').onclick = () => { resetForm(); hideSheet(); };

// фото: сжимаем на телефоне перед отправкой
$('photo').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    photoBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
    $('photo-name').textContent = `фото ✓ (${Math.round(photoBlob.size / 1024)} КБ)`;
  } catch { toast('Не удалось обработать фото', true); }
};

$('send').onclick = async () => {
  if (!map) return;
  const c = crossLngLat();
  if (distM({ lat: c.lat, lng: c.lng }, MELEUZ) > RADIUS) { toast('Здесь пока soon… Работает только Мелеуз', true); return; }
  if (type === 'fuel' && !Object.keys(fuelSt).length && queueSt === null) { toast('Отметь бензин или очередь', true); return; }
  const fd = new FormData();
  fd.append('type', type);
  fd.append('lat', c.lat); fd.append('lng', c.lng);
  fd.append('comment', $('comment').value);
  if (type === 'fuel') {
    fd.append('fuel', JSON.stringify(fuelSt));
    if (queueSt !== null) fd.append('queue', String(queueSt));
  }
  if (photoBlob) fd.append('photo', photoBlob, 'p.jpg');
  $('send').disabled = true;
  try {
    const p = await api('/posts', { method: 'POST', body: fd });
    buzz('heavy');
    toast(p.merged ? 'Данные по АЗС обновлены' : 'Точка поставлена');
    resetForm();
    hideSheet();
    posts = posts.filter(x => x.id !== p.id).concat(p);
    render(); load();
  } catch (e) { toast(e.message, true); }
  $('send').disabled = false;
};

// ---------- моё гео и навигатор ----------
function zoomForSpeed(kmh) { return clamp(16.4 - kmh * 0.026, 14.2, 16.4); }

function syncNav() {
  $('locate').classList.toggle('on', follow);
  document.body.classList.toggle('nav', follow);
  $('hud').hidden = !follow;
  updateNear();
}

function followTo(p) {
  if (!map || !follow || busy()) return;
  const kmh = (p.speed || 0) * 3.6;
  const o = {
    center: [p.lng, p.lat],
    zoom: Date.now() < userZoomUntil ? map.getZoom() : zoomForSpeed(kmh),
    padding: computePadding(),
    duration: 900, easing: t => t,
  };
  if (courseUp && p.heading !== null && p.heading !== undefined && kmh >= 4) o.bearing = p.heading;
  map.easeTo(o);
}

function startFollow(auto) {
  if (!map || !myPos) return;
  follow = true; autoEngaged = !!auto;
  courseUp = (myPos.speed || 0) * 3.6 >= 8;
  syncNav();
  if (auto) toast('НАВИГАТОР: карта едет за тобой');
  if (!busy()) followTo(myPos);
}
function stopFollow() {
  follow = false; courseUp = false; autoEngaged = false;
  syncNav();
  if (map) applyPadding(true);
}

function onPos(pos) {
  const c = pos.coords, now = Date.now();
  const cur = { lat: c.latitude, lng: c.longitude, t: now };
  let speed = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
  let heading = Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : null;
  const prev = myPos;
  if (prev) {
    const dt = (now - prev.t) / 1000, d = distM(prev, cur);
    if (speed === null && dt > 0.3) speed = d >= 3 ? d / dt : 0;
    if (heading === null && d >= 6) heading = bearingTo(prev, cur);
  }
  cur.speed = speed === null ? 0 : speed;
  const ph = prev ? prev.heading : null;
  cur.heading = heading === null ? ph : ph === null || ph === undefined ? heading : lerpAngle(ph, heading, 0.6);
  myPos = cur;

  $('geo').textContent = 'ГЕО: ВКЛ';
  if (map) {
    if (!meMarker.getLngLat || !meMarker._added) { meMarker.setLngLat([cur.lng, cur.lat]).addTo(map); meMarker._added = true; }
    else meMarker.setLngLat([cur.lng, cur.lat]);
    const moving = cur.speed * 3.6 >= 4 && cur.heading !== null && cur.heading !== undefined;
    meMarker._el.classList.toggle('still', !moving);
    if (moving) meMarker.setRotation(cur.heading);
  }

  // едем — включаем навигатор сам; стоим долго — отпускаем
  const kmh = cur.speed * 3.6;
  if (kmh >= 8) { fastCount++; stillSince = 0; } else { fastCount = 0; if (!stillSince) stillSince = now; }
  if (!follow && fastCount >= 2 && now > blockedUntil && !busy()) startFollow(true);
  if (follow && autoEngaged && stillSince && now - stillSince > 60000) stopFollow();

  if (follow) $('spd').textContent = `${Math.round(kmh)} КМ/Ч`;
  for (const e of markers.values()) paintPin(e);
  updateNear();
  followTo(cur);
}

let geoStarted = false;
function startGeo() {
  if (geoStarted) return;
  if (!navigator.geolocation) { $('geo').textContent = 'ГЕО: НЕТ'; return; }
  geoStarted = true;
  navigator.geolocation.watchPosition(onPos, () => { $('geo').textContent = 'ГЕО: ВЫКЛ'; geoStarted = false; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

$('locate').onclick = () => {
  buzz();
  if (!myPos) { startGeo(); toast('Ищу тебя… разреши геолокацию'); return; }
  if (follow) { stopFollow(); return; }
  startFollow(false);
  if (map && !busy()) followTo(myPos);
};
$('compass').onclick = () => {
  if (!map) return;
  buzz();
  courseUp = false;
  map.easeTo({ bearing: 0, duration: 400 });
};

// ---------- чат ----------
const chatEl = $('chat');
let chatSeq = 0;            // последний номер сообщения на экране
let chatMe = null;
let chatPoll = null;
let seen = Number(store.get('gr_seen') || 0);
let unread = 0;

function setBadge(n) {
  unread = n;
  $('badge').hidden = n <= 0;
  $('badge').textContent = n > 99 ? '99+' : String(n);
}

function msgEl(m) {
  const el = div('msg' + (m.mine ? ' mine' : ''));
  el.dataset.n = m.n;
  const hd = div('hd');
  const nick = div('nick', m.mine ? `${m.nick} (ты)` : m.nick);
  nick.style.color = `hsl(${m.hue} 85% 66%)`;
  hd.append(nick, div('tm', fmtTime(m.t)));
  el.append(hd, div('tx', m.text));
  if (m.canDelete || (chatMe && chatMe.admin)) {
    const acts = div('acts');
    if (m.canDelete) {
      const d = document.createElement('button');
      d.type = 'button'; d.textContent = 'УДАЛИТЬ';
      d.onclick = async ev => {
        ev.stopPropagation();
        try { await api(`/chat/${m.n}`, { method: 'DELETE' }); el.remove(); } catch (e) { toast(e.message, true); }
      };
      acts.append(d);
    }
    if (chatMe && chatMe.admin && !m.mine) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dng'; b.textContent = 'БАН';
      b.onclick = async ev => {
        ev.stopPropagation();
        try { await api(`/chat/${m.n}/ban`, { method: 'POST' }); toast('Пользователь заблокирован'); loadChat(true); }
        catch (e) { toast(e.message, true); }
      };
      acts.append(b);
    }
    el.append(acts);
    el.addEventListener('click', () => el.classList.toggle('open'));
  }
  return el;
}

function appendMsgs(list) {
  const box = $('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  for (const m of list) {
    if (box.querySelector(`.msg[data-n="${m.n}"]`)) continue;
    box.append(msgEl(m));
    chatSeq = Math.max(chatSeq, m.n);
  }
  if (nearBottom || list.some(m => m.mine)) box.scrollTop = box.scrollHeight;
}

async function loadChat(full) {
  try {
    const r = await api('/chat' + (full ? '' : `?after=${chatSeq}`));
    chatMe = r.me;
    if (full) {
      chatSeq = 0;
      const box = $('msgs');
      box.replaceChildren();
      const note = div('note');
      note.append('Чат анонимный. Ты — ');
      const b = document.createElement('b'); b.textContent = r.me.nick;
      note.append(b, '. Ссылки и @имена писать нельзя.');
      box.append(note);
      $('chat-me').textContent = r.me.nick;
    }
    appendMsgs(r.messages);
    seen = Math.max(seen, chatSeq); store.set('gr_seen', String(seen));
  } catch (e) { if (full) toast(e.message, true); }
}

async function pollUnread() {
  if (!chatEl.hidden) return;
  try {
    const r = await api(`/chat?after=${seen}`);
    setBadge(r.messages.filter(m => !m.mine).length);
  } catch {}
}

// баннеры: влетают, висят пару секунд и улетают
let adTimer = null, adIdx = 0;
function showAd(ad) {
  const el = $('ad');
  $('ad-text').textContent = ad.text;
  el.classList.toggle('link', !!ad.link);
  el.onclick = ad.link ? () => { try { tg?.openTelegramLink ? tg.openTelegramLink(ad.link) : window.open(ad.link, '_blank'); } catch {} } : null;
  el.classList.remove('fly');
  void el.offsetWidth;                // перезапуск анимации
  el.classList.add('fly');
}
function startAds() {
  stopAds();
  const play = () => {
    showAd(ADS[adIdx % ADS.length]);
    adIdx++;
    adTimer = setTimeout(play, adIdx % ADS.length === 0 ? 16000 : 5600);
  };
  adTimer = setTimeout(play, 700);
}
function stopAds() { clearTimeout(adTimer); $('ad').classList.remove('fly'); }

function openChat() {
  buzz();
  chatEl.hidden = false;
  document.body.classList.add('busy');
  setBadge(0);
  loadChat(true);
  clearInterval(chatPoll);
  chatPoll = setInterval(() => loadChat(false), 4000);
  startAds();
  syncBack();
}
function closeChat() {
  chatEl.hidden = true;
  if (!sheetOpen) document.body.classList.remove('busy');
  clearInterval(chatPoll); chatPoll = null;
  stopAds();
  if (map && follow && myPos) { applyPadding(false); followTo(myPos); }
  syncBack();
}
$('chatbtn').onclick = openChat;
$('chat-close').onclick = closeChat;

$('chat-form').onsubmit = async ev => {
  ev.preventDefault();
  const inp = $('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  try {
    const m = await api('/chat', jsonOpts('POST', { text }));
    appendMsgs([m]);
    seen = Math.max(seen, chatSeq); store.set('gr_seen', String(seen));
  } catch (e) { inp.value = text; toast(e.message, true); }
};

// кнопка «Назад» в Telegram закрывает чат или панель
function syncBack() {
  try {
    const open = !chatEl.hidden || sheetOpen;
    if (open) tg?.BackButton?.show?.(); else tg?.BackButton?.hide?.();
  } catch {}
}
try {
  tg?.BackButton?.onClick?.(() => { if (!chatEl.hidden) closeChat(); else if (sheetOpen) { resetForm(); hideSheet(); } });
} catch {}

// ---------- пасхалка: 5 тапов по лого ----------
let taps = 0, tapT;
$('logo').onclick = () => {
  taps++; clearTimeout(tapT); tapT = setTimeout(() => (taps = 0), 1200);
  if (taps >= 5) { taps = 0; toast('📡 by mrsndrp'); buzz('heavy'); }
};

// страница не должна «уезжать» при открытии клавиатуры
const unscroll = () => { if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } };
window.addEventListener('scroll', unscroll, true);
document.addEventListener('focusin', () => setTimeout(unscroll, 50));

// ---------- старт ----------
buildFuelForm();
(async () => {
  try {
    const cfg = await api('/config');
    RADIUS = cfg.city.radius;
  } catch {}
  startGeo();
  const ok = await ensureMapLib();
  if (!ok) toast('Карта не загрузилась. Проверь интернет и открой заново', true);
  else {
    try { initMap(); } catch (e) { console.error(e); map = null; toast('Не удалось запустить карту (нужен WebGL)', true); }
  }
  load();
  pollUnread();
  setInterval(load, 15000);
  setInterval(pollUnread, 25000);
})();
