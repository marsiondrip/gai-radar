// ГАИ РАДАР — клиент (by mrsndrp)
const tg = window.Telegram?.WebApp;
try {
  tg?.ready(); tg?.expand();
  tg?.setHeaderColor?.('#04100a'); tg?.setBackgroundColor?.('#04100a');
  tg?.disableVerticalSwipes?.();
} catch {}

const $ = id => document.getElementById(id);
const MELEUZ = [52.9586, 55.9300];
let RADIUS = 18000;
let TTL_MIN = 120;

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'X-Init-Data': tg?.initData || '', ...(opts.headers || {}) };
  const r = await fetch('/api' + path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

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
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин назад`;
}

// ---------- карта ----------
const map = L.map('map', {
  zoomControl: false, minZoom: 4, maxZoom: 18, zoomSnap: 0.5, worldCopyJump: true,
}).setView(MELEUZ, 13);

L.control.attribution({ prefix: false })
  .addAttribution('© OpenStreetMap <span style="opacity:.18">· by mrsndrp</span>')
  .addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'tiles',
}).addTo(map);

// зона покрытия
L.circle(MELEUZ, {
  radius: RADIUS, color: '#39ff88', weight: 1, dashArray: '4 8', fillOpacity: 0.03, interactive: false,
}).addTo(map);

// «soon…» для остальных городов — видно при отдалении
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
const soonIcon = (name, live) => L.divIcon({
  className: 'soon' + (live ? ' live' : ''),
  html: `<b>${name}</b><i>${live ? '● LIVE' : 'soon…'}</i>`,
  iconSize: [0, 0],
});
L.marker(MELEUZ, { icon: soonIcon('МЕЛЕУЗ', true), interactive: false, zIndexOffset: -500 }).addTo(map);
CITIES.forEach(([n, lat, lng]) =>
  L.marker([lat, lng], { icon: soonIcon(n, false), interactive: false, zIndexOffset: -1000 }).addTo(map));

const updateZoom = () => document.body.classList.toggle('far', map.getZoom() <= 9.5);
map.on('zoomend', updateZoom);
updateZoom();

// ---------- точки ----------
const markers = new Map();
let posts = [];

const pinIcon = p => {
  const stale = Date.now() - p.lastActivity > 40 * 60000;
  return L.divIcon({
    className: '',
    iconSize: [56, 56], iconAnchor: [28, 28],
    html: `<div class="pin ${p.type}${stale ? ' stale' : ''}">
      <span class="ring"></span><span class="ring r2"></span><span class="core"></span>
      <em>${p.type === 'post' ? 'ПОСТ' : 'ПАТРУЛЬ'}</em></div>`,
  });
};

function render() {
  const ids = new Set(posts.map(p => p.id));
  for (const [id, m] of markers) if (!ids.has(id)) { map.removeLayer(m); markers.delete(id); }
  for (const p of posts) {
    let m = markers.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lng], { icon: pinIcon(p), zIndexOffset: 1000 }).addTo(map);
      m.on('click', () => { buzz(); openView(p.id); });
      markers.set(p.id, m);
    } else m.setIcon(pinIcon(p));
  }
  $('count').textContent = posts.length;
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

// ---------- панель ----------
const sheet = $('sheet');
let viewId = null;
let addMode = false;

function showSheet(mode) {
  sheet.hidden = false;
  $('mode-add').hidden = mode !== 'add';
  $('mode-view').hidden = mode !== 'view';
  document.body.classList.add('busy');
}
function hideSheet() {
  sheet.hidden = true; viewId = null; addMode = false;
  $('cross').hidden = true;
  document.body.classList.remove('busy');
  tg?.MainButton?.hide?.();
}

// просмотр
function openView(id) {
  viewId = id;
  addMode = false;
  $('cross').hidden = true;
  showSheet('view');
  refreshView();
  const p = posts.find(x => x.id === id);
  if (p) map.panTo([p.lat, p.lng], { animate: true });
}
function refreshView() {
  const p = posts.find(x => x.id === viewId);
  if (!p) { hideSheet(); return; }
  $('v-title').textContent = p.type === 'post' ? '🚨 ПОСТ' : '🚓 ПАТРУЛЬ';
  $('v-age').textContent = `отмечен ${ago(p.createdAt)} · обновлён ${ago(p.lastActivity)}`;
  $('v-comment').textContent = p.comment || '';
  const img = $('v-photo');
  if (p.photo) { img.src = p.photo; img.hidden = false; } else img.hidden = true;
  $('v-stands').textContent = p.stands;
  $('v-gone').textContent = p.gone;
  $('v-yes').classList.toggle('voted', p.myVote === 'stands');
  $('v-no').classList.toggle('voted', p.myVote === 'gone');
  $('v-del').hidden = !p.canDelete;
}
async function vote(v) {
  if (!viewId) return;
  buzz('medium');
  try {
    const r = await api(`/posts/${viewId}/vote`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v }),
    });
    if (r.removed) { toast('Точка убрана — уехали'); hideSheet(); }
    else {
      toast(v === 'stands' ? 'Подтвердил: стоит' : 'Отметил: уехали');
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

// добавление
let type = 'post';
let photoBlob = null;

$('add').onclick = () => {
  buzz();
  viewId = null; addMode = true;
  if (map.distance(map.getCenter(), MELEUZ) > RADIUS) map.flyTo(MELEUZ, 14);
  else if (map.getZoom() < 14) map.setZoom(15);
  showSheet('add');
  $('cross').hidden = false;
};
$('cancel').onclick = () => { photoBlob = null; $('photo-name').textContent = 'без фото'; hideSheet(); };

document.querySelectorAll('.seg button').forEach(b => (b.onclick = () => {
  type = b.dataset.t;
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
  buzz();
}));

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
  const c = map.getCenter();
  if (map.distance(c, MELEUZ) > RADIUS) { toast('Здесь пока soon… Работает только Мелеуз', true); return; }
  const fd = new FormData();
  fd.append('type', type);
  fd.append('lat', c.lat); fd.append('lng', c.lng);
  fd.append('comment', $('comment').value);
  if (photoBlob) fd.append('photo', photoBlob, 'p.jpg');
  $('send').disabled = true;
  try {
    const p = await api('/posts', { method: 'POST', body: fd });
    buzz('heavy');
    toast('Точка поставлена');
    $('comment').value = ''; photoBlob = null; $('photo-name').textContent = 'без фото'; $('photo').value = '';
    hideSheet();
    posts.push(p); render(); load();
  } catch (e) { toast(e.message, true); }
  $('send').disabled = false;
};

// ---------- моё гео ----------
let meMarker = null, myPos = null;
function onPos(pos) {
  myPos = [pos.coords.latitude, pos.coords.longitude];
  $('geo').textContent = 'ГЕО: ВКЛ';
  if (!meMarker) meMarker = L.marker(myPos, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 2000 }).addTo(map);
  else meMarker.setLatLng(myPos);
}
function startGeo() {
  if (!navigator.geolocation) { $('geo').textContent = 'ГЕО: НЕТ'; return; }
  navigator.geolocation.watchPosition(onPos, () => ($('geo').textContent = 'ГЕО: ВЫКЛ'),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}
$('locate').onclick = () => {
  buzz();
  if (myPos) map.flyTo(myPos, Math.max(map.getZoom(), 15));
  else { startGeo(); toast('Ищу тебя… разреши геолокацию'); }
};
// ---------- пасхалка: 5 тапов по лого ----------
let taps = 0, tapT;
$('logo').onclick = () => {
  taps++; clearTimeout(tapT); tapT = setTimeout(() => (taps = 0), 1200);
  if (taps >= 5) { taps = 0; toast('📡 by mrsndrp'); buzz('heavy'); }
};

// ---------- старт ----------
(async () => {
  try {
    const cfg = await api('/config');
    RADIUS = cfg.city.radius; TTL_MIN = cfg.ttlMin;
  } catch {}
  startGeo();
  load();
  setInterval(load, 15000);
})();
