/** בקר האפליקציה: טופס, מפה, worker ויצוא. */
import { bboxAround, sample, climb, thin, CLS } from './engine.js';
import { fetchWays, elevations, geocode, reverse } from './data.js';
import { appleMapsUrl, googleMapsUrl, GOOGLE_MAX_WAYPOINTS, toGpx, shareOrDownload } from './export.js';

const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = 'loop.settings.v1';
const MAX_KM = 30;

const state = {
  start: null, startLabel: '',
  end: null, endLabel: '',
  mode: 'loop',
  pickEnd: false,
  routes: [], selected: 0,
  seed: Math.floor(Math.random() * 1e9),
  busy: false,
  elev: new Map(),
};

/* ===================== הגדרות שמורות ===================== */

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    return s;
  } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      km: Number($('#distance').value), mode: state.mode, prefs: readPrefs(),
      start: state.start, startLabel: state.startLabel,
    }));
  } catch {}
}

/* ===================== worker ===================== */

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let msgId = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  if (data.type === 'progress') { p.onProgress?.(data.message); return; }
  pending.delete(data.id);
  if (data.type === 'result') p.resolve(data.data);
  else p.reject(Object.assign(new Error(data.message), { code: data.code }));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error('שגיאה בחישוב. רענן את הדף ונסה שוב.'));
  pending.clear();
  console.error(e);
};
function call(type, payload = {}, onProgress) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...payload });
  });
}

/* ===================== מפה ===================== */

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([32.0853, 34.7818], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
map.attributionControl.setPrefix(false);

const pin = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
let startMarker = null, endMarker = null;
const routeLayer = L.layerGroup().addTo(map);
const waypointLayer = L.layerGroup().addTo(map);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const routeColor = (i) => css(`--r${(i % 3) + 1}`);

map.on('click', (e) => {
  const p = [e.latlng.lat, e.latlng.lng];
  if (state.mode === 'p2p' && (state.pickEnd || (state.start && !state.end))) setEnd(p);
  else setStart(p);
});

function setStart(p, label = '') {
  state.start = p; state.startLabel = label;
  if (!startMarker) {
    startMarker = L.marker(p, { icon: pin('start'), draggable: true, keyboard: false }).addTo(map);
    startMarker.on('dragend', () => { const ll = startMarker.getLatLng(); setStart([ll.lat, ll.lng]); });
  } else startMarker.setLatLng(p);
  $('#start-label').textContent = label || 'מאתר כתובת…';
  if (!label) reverse(p[0], p[1]).then((name) => {
    if (state.start === p) { state.startLabel = name; $('#start-label').textContent = name || fmtPoint(p); saveSettings(); }
  });
  clearRoutes();
  saveSettings();
  updateHint();
}

function setEnd(p, label = '') {
  state.end = p; state.endLabel = label; state.pickEnd = false;
  if (!endMarker) {
    endMarker = L.marker(p, { icon: pin('end'), draggable: true, keyboard: false }).addTo(map);
    endMarker.on('dragend', () => { const ll = endMarker.getLatLng(); setEnd([ll.lat, ll.lng]); });
  } else endMarker.setLatLng(p);
  $('#end-label').textContent = label || 'מאתר כתובת…';
  if (!label) reverse(p[0], p[1]).then((name) => {
    if (state.end === p) { state.endLabel = name; $('#end-label').textContent = name || fmtPoint(p); }
  });
  clearRoutes();
  updateHint();
}

const fmtPoint = (p) => `${p[0].toFixed(4)}, ${p[1].toFixed(4)}`;

function updateHint() {
  const hint = $('#map-hint');
  hint.classList.remove('active');
  if (state.mode === 'p2p' && (state.pickEnd || (state.start && !state.end))) {
    hint.textContent = 'לחץ על המפה כדי לסמן את נקודת הסיום';
    hint.classList.add('active');
  } else hint.textContent = state.start ? 'אפשר לגרור את הסמן או ללחוץ במקום אחר במפה' : 'אפשר גם ללחוץ על המפה';
}

/* ===================== טופס ===================== */

function radio(group, value) {
  for (const b of document.querySelectorAll(`${group} [role="radio"]`)) b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
}
function radioValue(group) {
  return document.querySelector(`${group} [aria-checked="true"]`)?.dataset.value;
}
function bindRadio(group, onChange) {
  const el = $(group);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (!b) return;
    radio(group, b.dataset.value);
    onChange?.(b.dataset.value);
  });
  // חצים בין האפשרויות, כמו קבוצת רדיו רגילה
  el.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = [...el.querySelectorAll('[role="radio"]')];
    const i = items.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = (e.key === 'ArrowLeft') === (document.dir === 'rtl') ? 1 : -1;
    const next = items[(i + step + items.length) % items.length];
    next.click(); next.focus(); e.preventDefault();
  });
}

function readPrefs() {
  return {
    traffic: Number(radioValue('#pref-traffic') ?? 1),
    green: Number(radioValue('#pref-green') ?? 1),
    avoidSteps: $('#pref-steps').checked,
    lit: $('#pref-lit').checked,
  };
}

function setMode(mode) {
  state.mode = mode;
  radio('#mode', mode);
  $('#end-row').hidden = mode !== 'p2p';
  if (mode === 'loop' && endMarker) { endMarker.remove(); endMarker = null; state.end = null; $('#end-label').textContent = 'לא נבחרה'; }
  clearRoutes(); updateHint(); saveSettings();
}

function syncChips() {
  const v = Number($('#distance').value);
  for (const b of document.querySelectorAll('#chips button')) b.setAttribute('aria-pressed', String(Number(b.dataset.km) === v));
}

function setStatus(text, error = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('error', error);
}

function setBusy(busy) {
  state.busy = busy;
  const b = $('#btn-build');
  b.disabled = busy;
  b.classList.toggle('loading', busy);
  b.setAttribute('aria-busy', String(busy));
}

/* ===================== מיקום וחיפוש ===================== */

function locate({ quiet = false } = {}) {
  if (!navigator.geolocation) { if (!quiet) setStatus('הדפדפן לא תומך במיקום.', true); return; }
  if (!quiet) setStatus('מאתר מיקום…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      setStart(p);
      map.setView(p, 15);
      if (!quiet) setStatus(pos.coords.accuracy > 100 ? `מיקום משוער, דיוק של כ-${Math.round(pos.coords.accuracy)} מ'. אפשר לגרור את הסמן.` : '');
    },
    (err) => {
      if (quiet) return;
      setStatus(err.code === 1 ? 'אין הרשאת מיקום. אפשר לחפש כתובת או ללחוץ על המפה.' : 'לא הצלחתי לאתר מיקום. אפשר לחפש כתובת או ללחוץ על המפה.', true);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
  );
}

let searchTimer = null;
function bindSearch() {
  const input = $('#search'), list = $('#search-results');
  const close = () => { list.hidden = true; list.replaceChildren(); };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    try {
      const results = await geocode(q, state.start || [map.getCenter().lat, map.getCenter().lng]);
      list.replaceChildren(...results.map((r, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option'); li.id = `sr-${i}`; li.textContent = r.label;
        li.addEventListener('click', () => {
          const p = [r.lat, r.lon];
          const short = r.label.split(',').slice(0, 2).join(',');
          if (state.mode === 'p2p' && state.pickEnd) setEnd(p, short); else setStart(p, short);
          map.setView(p, 15);
          input.value = ''; close(); input.blur();
        });
        return li;
      }));
      list.hidden = results.length === 0;
    } catch (e) {
      if (e.name !== 'AbortError') close();
    }
  };
  input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 450); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); run(); }
    if (e.key === 'Escape') close();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) close(); });
}

/* ===================== בנייה ===================== */

function neededBox(km) {
  const target = km * 1000;
  if (state.mode === 'loop' || !state.end) return bboxAround(state.start[0], state.start[1], Math.max(900, target * 0.42 + 250));
  const pad = Math.max(700, target * 0.3);
  const a = bboxAround(state.start[0], state.start[1], pad), b = bboxAround(state.end[0], state.end[1], pad);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

let buildController = null;
async function build({ newSeed = false } = {}) {
  if (state.busy) return;
  if (!state.start) { setStatus('מאיפה יוצאים? מיקום נוכחי, חיפוש או לחיצה על המפה.', true); return; }
  if (state.mode === 'p2p' && !state.end) { setStatus('סמן נקודת סיום במפה, או בחר מסלול מעגלי.', true); updateHint(); return; }
  let km = Number($('#distance').value);
  if (!(km >= 1)) { setStatus('מרחק מינימלי: 1 ק"מ.', true); return; }
  if (km > MAX_KM) { km = MAX_KM; $('#distance').value = MAX_KM; syncChips(); }
  if (newSeed) state.seed = (state.seed * 1103515245 + 12345) >>> 0;

  setBusy(true);
  buildController?.abort();
  buildController = new AbortController();
  const progress = (m) => setStatus(m);
  const t0 = performance.now();
  try {
    const box = neededBox(km);
    const ways = await fetchWays(box, { signal: buildController.signal, onProgress: progress });
    const has = await call('hasGraph', { key: ways.key });
    if (!has) await call('load', { key: ways.key, text: ways.text }, progress);
    const result = await call('plan', {
      opts: {
        start: state.start, end: state.mode === 'p2p' ? state.end : null,
        distance: km * 1000, prefs: readPrefs(), seed: state.seed, variants: 3,
      },
    }, progress);
    state.routes = result.routes;
    state.selected = 0;
    state.elev = new Map();
    render();
    fitSelected();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const few = result.routes.length < 3 ? ' · באזור הזה נמצאו פחות אפשרויות שונות' : '';
    setStatus(`${result.routes.length === 1 ? 'מסלול אחד' : `${result.routes.length} מסלולים`} · ${secs} שניות${few}${result.routes[0].note ? ` · ${result.routes[0].note}` : ''}`);
    writeHash();
    saveSettings();
    loadElevations();
    $('#results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus(e.message || 'משהו השתבש. נסה שוב.', true);
  } finally {
    setBusy(false);
  }
}

function clearRoutes() {
  state.routes = [];
  routeLayer.clearLayers(); waypointLayer.clearLayers();
  $('#results').hidden = true;
}

/* ===================== תצוגת תוצאות ===================== */

function pct(r, ...classes) { return Math.round(classes.reduce((s, c) => s + r.byClass[c], 0) / r.length * 100); }

function render() {
  routeLayer.clearLayers();
  const order = state.routes.map((_, i) => i).filter((i) => i !== state.selected).concat(state.selected);
  for (const i of order) {
    const r = state.routes[i];
    const sel = i === state.selected;
    const line = L.polyline(r.coords, {
      color: routeColor(i), weight: sel ? 6 : 4, opacity: sel ? 0.95 : 0.45, lineJoin: 'round',
    }).addTo(routeLayer);
    line.on('click', (e) => { L.DomEvent.stopPropagation(e); select(i); });
  }
  waypointLayer.clearLayers();
  const cur = state.routes[state.selected];
  for (const w of cur.waypoints) L.marker(w, { icon: L.divIcon({ className: '', html: '<div class="wpt"></div>', iconSize: [10, 10] }), interactive: false, keyboard: false }).addTo(waypointLayer);

  const cards = $('#cards');
  cards.replaceChildren(...state.routes.map((r, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'card'; b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(i === state.selected));
    b.style.setProperty('--c', routeColor(i));
    const e = state.elev.get(i);
    const climbTxt = e ? `↑${e.gain} מ' טיפוס` : e === null ? 'גובה: לא זמין' : 'גובה: בודק…';
    b.innerHTML = `<span class="top"><span class="dot"></span>אפשרות ${i + 1}</span>
      <span class="km">${(r.length / 1000).toFixed(2)} <small>ק״מ</small></span>
      <span class="meta">${climbTxt}<br>${pct(r, CLS.PATH)}% שבילים${r.repeatShare > 0.05 ? `<br>${Math.round(r.repeatShare * 100)}% הלוך-חזור` : ''}${pct(r, CLS.SECONDARY, CLS.PRIMARY) > 10 ? `<br>${pct(r, CLS.SECONDARY, CLS.PRIMARY)}% כבישים ראשיים` : ''}</span>`;
    b.addEventListener('click', () => select(i));
    return b;
  }));
  $('#results').hidden = false;
  renderActions();
  renderProfile();
}

function select(i) {
  if (i === state.selected) return;
  state.selected = i;
  render();
  fitSelected();
}

function fitSelected() {
  const r = state.routes[state.selected];
  if (r) map.fitBounds(L.latLngBounds(r.coords), { padding: [28, 28] });
}

function renderActions() {
  const r = state.routes[state.selected];
  const start = r.coords[0], end = r.coords[r.coords.length - 1];
  $('#go-apple').href = appleMapsUrl(start, end, r.waypoints);
  $('#apple-sub').textContent = `${r.waypoints.length} נקודות ביניים · ניווט קולי גם כשהמסך כבוי, והתראות בשעון`;
  const gw = thin(r.waypoints, GOOGLE_MAX_WAYPOINTS);
  $('#go-google').href = googleMapsUrl(start, end, gw);
  $('#google-note').textContent = r.waypoints.length > GOOGLE_MAX_WAYPOINTS
    ? `Google Maps מקבלת עד ${GOOGLE_MAX_WAYPOINTS} נקודות, לכן שם המסלול עלול לסטות. וגם: אין בה הוראות הליכה באופליין.`
    : 'Google Maps לא נותנת הוראות הליכה באופליין.';
}

async function loadElevations() {
  const routes = state.routes;
  // אחד אחרי השני, כדי לא להיתקע במגבלת קצב של שירות הגובה
  for (const [i, r] of routes.entries()) {
    try {
      const pts = sample(r.coords, 100);
      const el = await elevations(pts);
      if (state.routes !== routes) return;
      state.elev.set(i, { ...climb(el), profile: pts.map((p, k) => ({ d: p.d, e: el[k] })) });
    } catch {
      // גובה הוא תוספת; בלעדיו הכרטיס מציג קו במקום מספר
      if (state.routes !== routes) return;
      state.elev.set(i, null);
    }
    render();
  }
}

function renderProfile() {
  const e = state.elev.get(state.selected);
  const box = $('#profile');
  if (!e) { box.hidden = true; return; }
  const prof = e.profile, total = prof[prof.length - 1].d || 1;
  const min = Math.min(...prof.map((p) => p.e)), max = Math.max(...prof.map((p) => p.e));
  const span = Math.max(15, max - min);
  // RTL: ההתחלה בצד ימין, כמו כיוון הקריאה
  const x = (d) => 300 - (d / total) * 300;
  const y = (v) => 60 - ((v - min) / span) * 54;
  const pts = prof.map((p) => `${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`);
  $('#profile-svg').innerHTML = `<path class="area" d="M300,64 L${pts.join(' L')} L0,64 Z"/><path class="line" d="M${pts.join(' L')}"/>`;
  $('#profile-range').textContent = `${Math.round(min)}–${Math.round(max)} מ' · ↑${e.gain} ↓${e.loss}`;
  box.hidden = false;
}

/* ===================== שיתוף ויצוא ===================== */

function writeHash() {
  if (!state.start) return;
  const p = new URLSearchParams({ s: state.start.map((n) => n.toFixed(5)).join(','), d: $('#distance').value });
  if (state.mode === 'p2p' && state.end) p.set('e', state.end.map((n) => n.toFixed(5)).join(','));
  history.replaceState(null, '', `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const parse = (v) => {
    const parts = (v || '').split(',').map(Number);
    return parts.length === 2 && parts.every(Number.isFinite) && Math.abs(parts[0]) <= 90 && Math.abs(parts[1]) <= 180 ? parts : null;
  };
  return { s: parse(p.get('s')), e: parse(p.get('e')), d: Number(p.get('d')) };
}

function bindActions() {
  $('#btn-build').addEventListener('click', () => build());
  $('#btn-more').addEventListener('click', () => build({ newSeed: true }));
  $('#btn-locate').addEventListener('click', () => locate());
  $('#btn-pick-end').addEventListener('click', () => { state.pickEnd = true; updateHint(); });
  $('#distance').addEventListener('input', () => { syncChips(); clearRoutes(); saveSettings(); });
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#distance').value = b.dataset.km; syncChips(); clearRoutes(); saveSettings();
  });
  for (const id of ['#pref-steps', '#pref-lit']) $(id).addEventListener('change', () => { clearRoutes(); saveSettings(); });
  bindRadio('#mode', setMode);
  bindRadio('#pref-traffic', () => { clearRoutes(); saveSettings(); });
  bindRadio('#pref-green', () => { clearRoutes(); saveSettings(); });

  $('#btn-gpx').addEventListener('click', async () => {
    const r = state.routes[state.selected]; if (!r) return;
    const km = (r.length / 1000).toFixed(1);
    const name = `לולאה ${km} ק"מ`;
    const date = new Date().toISOString().slice(0, 10);
    const res = await shareOrDownload(`loop-${km}km-${date}.gpx`, toGpx(name, r.coords, r.waypoints));
    if (res === 'downloaded') setStatus('קובץ GPX ירד למכשיר.');
  });
  $('#btn-share').addEventListener('click', async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); setStatus('הקישור הועתק. מי שיפתח אותו יקבל את אותה נקודה ומרחק.'); }
    catch { setStatus(`הקישור: ${location.href}`); }
  });
}

/* ===================== התחלה ===================== */

function init() {
  const s = loadSettings();
  const h = readHash();
  $('#distance').value = h.d > 0 ? Math.min(MAX_KM, h.d) : (s.km || 5);
  syncChips();
  radio('#pref-traffic', s.prefs?.traffic ?? 1);
  radio('#pref-green', s.prefs?.green ?? 1);
  if (s.prefs) { $('#pref-steps').checked = s.prefs.avoidSteps !== false; $('#pref-lit').checked = !!s.prefs.lit; }
  bindActions();
  bindSearch();
  setMode(h.e ? 'p2p' : (s.mode || 'loop'));

  if (h.s) {
    setStart(h.s);
    if (h.e) setEnd(h.e);
    map.setView(h.s, 15);
    build();
  } else if (s.start) {
    setStart(s.start, s.startLabel || '');
    map.setView(s.start, 15);
  } else {
    // מבקשים מיקום אוטומטית רק אם כבר ניתנה הרשאה, בלי חלון הרשאה מפתיע
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locate({ quiet: true }); }).catch(() => {});
  }
  updateHint();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
