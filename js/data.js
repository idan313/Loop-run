/**
 * רשת: נתוני מפה מ-Overpass (עם מראות גיבוי ומטמון), גובה מ-Open-Meteo,
 * וחיפוש כתובות מ-Nominatim.
 */
import { overpassQuery } from './engine.js';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE = 'loop-osm-v1';
const INDEX_KEY = 'loop.osm.index.v1';
const MAX_AGE = 14 * 24 * 3600 * 1000;

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || []; } catch { return []; }
}
function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, 6))); } catch {}
}
const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

/** מחזיר תיבה שמורה שמכילה את המבוקשת, אם יש. */
export function cachedBoxFor(bbox) {
  return readIndex().find((e) => Date.now() - e.at < MAX_AGE && contains(e.bbox, bbox)) || null;
}

async function fromCache(key) {
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(key);
    return r ? await r.text() : null;
  } catch { return null; }
}

async function toCache(key, text, bbox) {
  try {
    const c = await caches.open(CACHE);
    await c.put(key, new Response(text, { headers: { 'content-type': 'application/json' } }));
    const index = readIndex().filter((e) => e.key !== key);
    index.unshift({ key, bbox, at: Date.now() });
    // ניקוי רשומות שיצאו מהאינדקס
    for (const old of index.slice(6)) c.delete(old.key).catch(() => {});
    writeIndex(index);
  } catch {}
}

/**
 * מוריד את הדרכים בתיבה. קודם מטמון, אחר כך מראות לפי הסדר.
 * onProgress(message) מתעדכן בזמן ההורדה.
 */
export async function fetchWays(bbox, { signal, onProgress = () => {} } = {}) {
  const hit = cachedBoxFor(bbox);
  if (hit) {
    const text = await fromCache(hit.key);
    if (text) { onProgress('מפת האזור כבר שמורה במכשיר'); return { text, key: hit.key, bbox: hit.bbox, cached: true }; }
  }
  // מרחיבים מעט את התיבה כדי שבקשה הבאה באזור תתאים למטמון
  const pad = 0.004;
  const big = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  const body = new URLSearchParams({ data: overpassQuery(big) });
  let lastError = null;
  for (const [i, url] of MIRRORS.entries()) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    onProgress(i === 0 ? 'מוריד את מפת האזור…' : `השרת הראשון לא ענה, מנסה שרת ${i + 1}…`);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 70000);
    const onAbort = () => timeout.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, { method: 'POST', body, signal: timeout.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // בדיקה זולה בלי לפענח כאן את כל ה-JSON; הפענוח קורה ב-worker
      if (!text.includes('"elements"')) throw new Error('תשובה לא תקינה');
      const remark = text.slice(-600).match(/"remark"\s*:\s*"([^"]*)"/);
      if (remark && /runtime error|timed out|out of memory/i.test(remark[1])) throw new Error(remark[1]);
      const key = `https://loop.local/osm/${big.map((n) => n.toFixed(4)).join('_')}`;
      toCache(key, text, big);
      return { text, key, bbox: big, cached: false };
    } catch (e) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      lastError = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw Object.assign(new Error('לא הצלחתי להוריד את מפת האזור. בדוק חיבור לאינטרנט ונסה שוב.'), { cause: lastError, code: 'MAP_DOWNLOAD' });
}

/** גובה לעד 100 נקודות (מודל Copernicus 90 מ' דרך Open-Meteo). */
export async function elevations(points) {
  const lat = points.map((p) => p.lat.toFixed(5)).join(',');
  const lon = points.map((p) => p.lon.toFixed(5)).join(',');
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  if (!res.ok) throw new Error('elevation');
  const data = await res.json();
  return data.elevation;
}

let geoController = null;
export async function geocode(q, near) {
  geoController?.abort();
  geoController = new AbortController();
  const p = new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'he', addressdetails: '0' });
  if (near) {
    const d = 0.25;
    p.set('viewbox', `${near[1] - d},${near[0] + d},${near[1] + d},${near[0] - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, { signal: geoController.signal });
  if (!res.ok) throw new Error('geocode');
  const list = await res.json();
  return list.map((r) => ({ label: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }));
}

export async function reverse(lat, lon) {
  try {
    const p = new URLSearchParams({ lat, lon, format: 'jsonv2', zoom: '17', 'accept-language': 'he' });
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${p}`);
    if (!res.ok) return '';
    const r = await res.json();
    const a = r.address || {};
    return [a.road || a.pedestrian || a.footway || r.name, a.suburb || a.town || a.city].filter(Boolean).join(', ');
  } catch { return ''; }
}
