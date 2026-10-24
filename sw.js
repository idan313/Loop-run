/* מעטפת האפליקציה ואריחי מפה שכבר נצפו נשמרים, כדי שהאפליקציה תיפתח גם בקליטה חלשה. */
const VERSION = 'loop-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/apple-touch-icon.png'];
const TILES = 'loop-tiles-v1';
const MAX_TILES = 1500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('loop-v') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { c.put(req, res.clone()); trimTiles(); }
      return res;
    }));
    return;
  }
  if (url.hostname === 'cdnjs.cloudflare.com' || url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com') {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; })));
    return;
  }
  if (url.origin === location.origin) {
    // רשת קודם, כדי שעדכונים יגיעו מיד; מטמון כשאין רשת
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
  }
});
