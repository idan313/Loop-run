/**
 * מנוע המסלולים: נתוני OSM גולמיים ← גרף הולכי רגל ← מסלולים לפי מרחק יעד.
 * מודול טהור, בלי DOM ובלי רשת, כדי שאפשר יהיה לבדוק אותו ב-Node.
 * כל הקואורדינטות הן [lat, lon] במעלות, כל המרחקים במטרים.
 */

const EARTH = 6371008.8;
const RAD = Math.PI / 180;

export function hav(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** נקודה במרחק ובכיוון נתונים (כיוון במעלות, 0 = צפון). */
export function destination(lat, lon, bearingDeg, dist) {
  const d = dist / EARTH, b = bearingDeg * RAD, p1 = lat * RAD, l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
}

export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/* ===================== סוגי דרכים ===================== */

/** מחלקות קשת. הסדר קובע גם את הצבעים בממשק. */
export const CLS = { PATH: 0, QUIET: 1, TERTIARY: 2, SECONDARY: 3, PRIMARY: 4, STEPS: 5 };
export const CLS_NAMES = ['שבילים', 'רחובות שקטים', 'כביש מקומי', 'כביש משני', 'כביש ראשי', 'מדרגות'];

const HIGHWAY_CLASS = {
  footway: CLS.PATH, path: CLS.PATH, pedestrian: CLS.PATH, cycleway: CLS.PATH, bridleway: CLS.PATH,
  track: CLS.PATH, corridor: CLS.PATH,
  residential: CLS.QUIET, living_street: CLS.QUIET, service: CLS.QUIET, unclassified: CLS.QUIET, road: CLS.QUIET,
  tertiary: CLS.TERTIARY, tertiary_link: CLS.TERTIARY,
  secondary: CLS.SECONDARY, secondary_link: CLS.SECONDARY,
  primary: CLS.PRIMARY, primary_link: CLS.PRIMARY,
  // כביש בינעירוני נכנס רק כשהולכי רגל מותרים בו במפורש (למשל גשר עם מדרכה)
  trunk: CLS.PRIMARY, trunk_link: CLS.PRIMARY,
  steps: CLS.STEPS,
};

const HIGHWAY_RE = Object.keys(HIGHWAY_CLASS).join('|');

/** שאילתת Overpass לכל הדרכים שאפשר לרוץ בהן בתוך תיבה [south, west, north, east]. */
export function overpassQuery([s, w, n, e]) {
  const box = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  return `[out:json][timeout:90];way["highway"~"^(${HIGHWAY_RE})$"](${box});out body qt;>;out skel qt;`;
}

/** תיבה סביב נקודה, ברדיוס במטרים. */
export function bboxAround(lat, lon, radius) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos(lat * RAD));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

function walkable(tags) {
  const cls = HIGHWAY_CLASS[tags.highway];
  if (cls === undefined) return null;
  const foot = tags.foot;
  if (foot === 'no' || foot === 'private' || foot === 'use_sidepath') return null;
  const footOk = foot === 'yes' || foot === 'designated' || foot === 'permissive';
  if (!footOk && (tags.access === 'no' || tags.access === 'private')) return null;
  if (/^trunk/.test(tags.highway) && !footOk) return null;
  if (tags.highway === 'service' && /^(parking_aisle|drive-through|driveway)$/.test(tags.service || '')) return null;
  // כביש בלי מדרכה ובלי שוליים הוא לא מקום לרוץ בו; כביש עם מדרכה נפרדת
  // מופה גם כשביל, ואז השביל יקבל את העדיפות דרך העלויות.
  if (cls >= CLS.SECONDARY && tags.sidewalk === 'no') return null;
  return cls;
}

/* ===================== גרף ===================== */

/**
 * בונה גרף לא מכוון בפורמט CSR מתוך elements של Overpass או של OSM API.
 * קשת = קטע בין שתי נקודות עוקבות בדרך.
 */
export function buildGraph(elements) {
  const nodeIdx = new Map();
  const lats = [], lons = [];
  for (const el of elements) {
    if (el.type === 'node' && !nodeIdx.has(el.id)) {
      nodeIdx.set(el.id, lats.length);
      lats.push(el.lat); lons.push(el.lon);
    }
  }
  const eA = [], eB = [], eLen = [], eCls = [], eLit = [];
  const seen = new Set();
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.nodes) continue;
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    const cls = walkable(el.tags);
    if (cls === null) continue;
    const lit = el.tags.lit === 'yes' ? 1 : 0;
    for (let i = 1; i < el.nodes.length; i++) {
      const a = nodeIdx.get(el.nodes[i - 1]), b = nodeIdx.get(el.nodes[i]);
      if (a === undefined || b === undefined || a === b) continue;
      eA.push(a); eB.push(b); eCls.push(cls); eLit.push(lit);
      eLen.push(hav(lats[a], lons[a], lats[b], lons[b]));
    }
  }
  const n = lats.length, m = eA.length;
  const deg = new Int32Array(n + 1);
  for (let k = 0; k < m; k++) { deg[eA[k] + 1]++; deg[eB[k] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const adjStart = deg;
  const fill = adjStart.slice(0, n);
  const adjTo = new Int32Array(2 * m), adjEdge = new Int32Array(2 * m);
  for (let k = 0; k < m; k++) {
    adjTo[fill[eA[k]]] = eB[k]; adjEdge[fill[eA[k]]++] = k;
    adjTo[fill[eB[k]]] = eA[k]; adjEdge[fill[eB[k]]++] = k;
  }
  const g = {
    n, m,
    lat: Float64Array.from(lats), lon: Float64Array.from(lons),
    adjStart, adjTo, adjEdge,
    eLen: Float32Array.from(eLen), eCls: Uint8Array.from(eCls), eLit: Uint8Array.from(eLit),
    eA: Int32Array.from(eA), eB: Int32Array.from(eB),
  };
  g.comp = components(g);
  g.grid = buildGrid(g);
  g.scratch = makeScratch(n);
  return g;
}

function components(g) {
  const comp = new Int32Array(g.n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(g.n);
  for (let s = 0; s < g.n; s++) {
    if (comp[s] !== -1 || g.adjStart[s] === g.adjStart[s + 1]) continue;
    const id = sizes.length; let top = 0, size = 0;
    stack[top++] = s; comp[s] = id;
    while (top) {
      const u = stack[--top]; size++;
      for (let p = g.adjStart[u]; p < g.adjStart[u + 1]; p++) {
        const v = g.adjTo[p];
        if (comp[v] === -1) { comp[v] = id; stack[top++] = v; }
      }
    }
    sizes.push(size);
  }
  return { id: comp, sizes };
}

const CELL = 0.002;
function cellKey(lat, lon) { return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`; }
function buildGrid(g) {
  const grid = new Map();
  for (let i = 0; i < g.n; i++) {
    if (g.adjStart[i] === g.adjStart[i + 1]) continue;
    const k = cellKey(g.lat[i], g.lon[i]);
    let arr = grid.get(k);
    if (!arr) grid.set(k, arr = []);
    arr.push(i);
  }
  return grid;
}

/** הצומת הקרוב ביותר, אופציונלית רק מתוך רכיב קשירות נתון. */
export function nearestNode(g, lat, lon, comp = -1, maxRing = 12) {
  const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
  let best = -1, bestD = Infinity;
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const arr = g.grid.get(`${ci + di}:${cj + dj}`);
        if (!arr) continue;
        for (const i of arr) {
          if (comp >= 0 && g.comp.id[i] !== comp) continue;
          const d = hav(lat, lon, g.lat[i], g.lon[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    // טבעת נוספת אחרי שמצאנו מועמד, כי תא שכן יכול להכיל נקודה קרובה יותר
    if (best >= 0 && ring * CELL * 111000 > bestD + CELL * 111000) break;
  }
  return best;
}

/** רכיב הקשירות הגדול שקרוב לנקודה: מונע התחלה על שביל מבודד. */
export function startComponent(g, lat, lon) {
  const largest = Math.max(0, ...g.comp.sizes);
  const node = nearestNode(g, lat, lon);
  if (node < 0) return -1;
  const c = g.comp.id[node];
  if (g.comp.sizes[c] >= Math.min(500, largest * 0.2)) return c;
  let biggest = 0;
  for (let i = 1; i < g.comp.sizes.length; i++) if (g.comp.sizes[i] > g.comp.sizes[biggest]) biggest = i;
  return biggest;
}

/* ===================== עלויות ===================== */

/**
 * מכפילי עלות לפי מחלקה. prefs: traffic 0..2, green 0..2, steps true = להימנע.
 * המכפיל הנמוך ביותר נחוץ להיוריסטיקה של A*.
 */
export function costModel(prefs = {}) {
  const traffic = prefs.traffic ?? 1, green = prefs.green ?? 1;
  const mul = new Float32Array(6);
  mul[CLS.PATH] = 1 - 0.13 * green;
  mul[CLS.QUIET] = 1;
  mul[CLS.TERTIARY] = 1 + 0.35 * traffic;
  mul[CLS.SECONDARY] = 1 + 0.9 * traffic;
  mul[CLS.PRIMARY] = 1 + 1.7 * traffic;
  mul[CLS.STEPS] = prefs.avoidSteps === false ? 1.4 : 8;
  return { mul, min: Math.min(...mul), litBonus: prefs.lit ? 0.75 : 1 };
}

/* ===================== חיפוש מסלול ===================== */

function makeScratch(n) {
  return { dist: new Float64Array(n), prev: new Int32Array(n), prevEdge: new Int32Array(n), stamp: new Int32Array(n), closed: new Int32Array(n), gen: 0, heap: new Heap() };
}

class Heap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.vals.length; }
  clear() { this.keys.length = 0; this.vals.length = 0; }
  push(k, v) {
    const K = this.keys, V = this.vals; let i = V.length; K.push(k); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = k; V[i] = v;
  }
  pop() {
    const K = this.keys, V = this.vals, top = V[0], lk = K.pop(), lv = V.pop(), n = V.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= lk) break; K[i] = K[c]; V[i] = V[c]; i = c; }
      K[i] = lk; V[i] = lv;
    }
    return top;
  }
}

/**
 * A* בין שני צמתים. used: Map edge→מספר שימושים קודמים, נקנס ב-reuse.
 * מחזיר { nodes, edges, length } או null.
 */
export function route(g, src, dst, cost, used = null, reuse = 3) {
  const S = g.scratch; const gen = ++S.gen;
  const { dist, prev, prevEdge, stamp, closed, heap } = S;
  heap.clear();
  const tl = g.lat[dst], tn = g.lon[dst], hm = cost.min * cost.litBonus;
  dist[src] = 0; prev[src] = -1; prevEdge[src] = -1; stamp[src] = gen;
  heap.push(hav(g.lat[src], g.lon[src], tl, tn) * hm, src);
  while (heap.size) {
    const u = heap.pop();
    if (closed[u] === gen) continue;
    closed[u] = gen;
    if (u === dst) break;
    const du = dist[u];
    for (let p = g.adjStart[u]; p < g.adjStart[u + 1]; p++) {
      const v = g.adjTo[p];
      if (closed[v] === gen) continue;
      const e = g.adjEdge[p];
      let w = g.eLen[e] * cost.mul[g.eCls[e]];
      if (g.eLit[e]) w *= cost.litBonus;
      if (used) { const c = used.get(e); if (c) w *= 1 + reuse * c; }
      const nd = du + w;
      if (stamp[v] !== gen || nd < dist[v]) {
        stamp[v] = gen; dist[v] = nd; prev[v] = u; prevEdge[v] = e;
        heap.push(nd + hav(g.lat[v], g.lon[v], tl, tn) * hm, v);
      }
    }
  }
  if (closed[dst] !== gen) return null;
  const nodes = [], edges = [];
  for (let v = dst; v !== -1; v = prev[v]) { nodes.push(v); if (prevEdge[v] >= 0) edges.push(prevEdge[v]); }
  nodes.reverse(); edges.reverse();
  let length = 0; for (const e of edges) length += g.eLen[e];
  return { nodes, edges, length };
}

/** Dijkstra באורך גולמי בלבד, עד רדיוס. מחזיר מערך מרחקים זמני (תקף עד הקריאה הבאה). */
function shortestFrom(g, src, maxDist) {
  const S = g.scratch; const gen = ++S.gen;
  const { dist, stamp, closed, heap } = S;
  heap.clear(); dist[src] = 0; stamp[src] = gen; heap.push(0, src);
  while (heap.size) {
    const u = heap.pop();
    if (closed[u] === gen) continue;
    closed[u] = gen;
    if (dist[u] > maxDist) break;
    for (let p = g.adjStart[u]; p < g.adjStart[u + 1]; p++) {
      const v = g.adjTo[p];
      if (closed[v] === gen) continue;
      const nd = dist[u] + g.eLen[g.adjEdge[p]];
      if (stamp[v] !== gen || nd < dist[v]) { stamp[v] = gen; dist[v] = nd; heap.push(nd, v); }
    }
  }
  return (v) => (closed[v] === gen ? dist[v] : Infinity);
}

/* ===================== בניית מסלול לפי מרחק ===================== */

/** מחולל אקראי דטרמיניסטי, כדי ש"עוד אפשרות" תיתן תוצאה חדשה אבל ניתנת לשחזור. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function chain(g, points, cost) {
  const used = new Map();
  const nodes = [points[0]], edges = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i] === points[i - 1]) continue;
    const leg = route(g, points[i - 1], points[i], cost, used);
    if (!leg) return null;
    for (const e of leg.edges) used.set(e, (used.get(e) || 0) + 1);
    nodes.push(...leg.nodes.slice(1)); edges.push(...leg.edges);
  }
  return cleanSpurs(g, nodes, edges);
}

/**
 * מסיר "קוצים": יציאה לרחוב צדדי וחזרה באותה דרך מיד אחר כך,
 * שנוצרת כשנקודת ביניים נצמדת לרחוב ללא מוצא.
 */
function cleanSpurs(g, nodes, edges) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < nodes.length - 1; i++) {
      if (nodes[i - 1] === nodes[i + 1]) {
        nodes.splice(i, 2); edges.splice(i - 1, 2);
        changed = true; break;
      }
    }
  }
  let length = 0; for (const e of edges) length += g.eLen[e];
  return { nodes, edges, length };
}

/** מרחקי רשת (אורך גולמי) מצומת לכל הצמתים, עד תקרה. מערך חדש, לא זמני. */
export function distances(g, src, maxDist) {
  const sp = shortestFrom(g, src, maxDist);
  const out = new Float32Array(g.n);
  for (let v = 0; v < g.n; v++) out[v] = sp(v);
  return out;
}

function angleDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

/**
 * בוחר צומת שמרחקי הרשת שלו קרובים ליעדים, ושהכיוון אליו מנקודת הייחוס
 * קרוב לכיוון הרצוי. בחירה לפי מרחק רשת ולא לפי מעגל גאומטרי, כי
 * כבישים מהירים, נחלים ומסילות הופכים מרחק אווירי לחסר משמעות.
 */
function pickNode(g, comp, terms, refLat, refLon, wantBearing, angleWeight) {
  let best = -1, bestS = Infinity;
  for (let v = 0; v < g.n; v++) {
    if (g.comp.id[v] !== comp) continue;
    let s = 0, ok = true;
    for (const [arr, want] of terms) {
      const d = arr[v];
      if (!(d < Infinity)) { ok = false; break; }
      const rel = Math.abs(d - want) / want;
      if (rel > 0.35) { ok = false; break; }
      s += rel;
    }
    if (!ok) continue;
    if (wantBearing !== null) s += angleWeight * angleDiff(bearing(refLat, refLon, g.lat[v], g.lon[v]), wantBearing) / 180;
    if (s < bestS) { bestS = s; best = v; }
  }
  return best;
}

/** ניתוח מסלול: פילוח לפי סוג דרך, חלק שחוזר על עצמו, קואורדינטות. */
export function describe(g, r) {
  const byClass = new Float64Array(6);
  const count = new Map();
  for (const e of r.edges) { byClass[g.eCls[e]] += g.eLen[e]; count.set(e, (count.get(e) || 0) + 1); }
  let repeated = 0;
  for (const [e, c] of count) if (c > 1) repeated += g.eLen[e] * c;
  const coords = r.nodes.map((v) => [g.lat[v], g.lon[v]]);
  return { ...r, coords, byClass: Array.from(byClass), repeatShare: r.length ? repeated / r.length : 0, edgeSet: new Set(count.keys()) };
}

function overlap(g, a, b) {
  let shared = 0, total = 0;
  for (const e of a.edgeSet) { total += g.eLen[e]; if (b.edgeSet.has(e)) shared += g.eLen[e]; }
  return total ? shared / total : 0;
}

/** כמה כל מסלול "שווה": קרבה למרחק, פחות חזרות, ועלות הדרך לפי ההעדפות. */
function score(g, r, target, cost) {
  const err = Math.abs(r.length - target) / target;
  let weighted = 0;
  for (let c = 0; c < 6; c++) weighted += r.byClass[c] * cost.mul[c];
  const pref = weighted / r.length;
  return err * 4 + r.repeatShare * 4 + (pref - cost.min);
}

/**
 * הפונקציה הראשית.
 * opts: { start:[lat,lon], end?:[lat,lon], distance (m), prefs, seed, variants }
 * onProgress(message) נקרא בין שלבים.
 */
export function plan(g, opts, onProgress = () => {}) {
  const { start: [lat, lon], end = null, distance: target, prefs = {}, seed = 1, variants = 3 } = opts;
  const cost = costModel(prefs);
  const comp = startComponent(g, lat, lon);
  if (comp < 0) throw planError('NO_ROADS', 'אין דרכים מתאימות ליד נקודת ההתחלה.');
  const start = nearestNode(g, lat, lon, comp);
  const snapStart = hav(lat, lon, g.lat[start], g.lon[start]);
  if (snapStart > 400) throw planError('FAR_START', 'נקודת ההתחלה רחוקה מכל דרך שאפשר לרוץ בה.');
  let endNode = -1;
  if (end) {
    endNode = nearestNode(g, end[0], end[1], comp);
    if (endNode < 0 || hav(end[0], end[1], g.lat[endNode], g.lon[endNode]) > 400) throw planError('FAR_END', 'נקודת הסיום רחוקה מכל דרך שאפשר לרוץ בה.');
  }
  const random = rng(seed);
  const candidates = [];
  const tries = Math.max(variants * 4, 12);

  if (end) {
    const direct = route(g, start, endNode, cost);
    if (!direct) throw planError('NO_CONNECTION', 'לא נמצא חיבור בין נקודת ההתחלה לנקודת הסיום.');
    if (direct.length >= target * 0.97) {
      const d = describe(g, cleanSpurs(g, direct.nodes, direct.edges));
      d.note = direct.length > target * 1.03 ? `הדרך הקצרה ביותר כבר ${(direct.length / 1000).toFixed(1)} ק"מ` : '';
      return { routes: [d], start, end: endNode };
    }
  }

  const sLat = g.lat[start], sLon = g.lon[start];
  onProgress('מודד מרחקים ברשת הדרכים…');
  const d0 = distances(g, start, target * 0.8);
  const dEnd = end ? distances(g, endNode, target * 0.8) : null;
  const toEnd = end ? bearing(sLat, sLon, g.lat[endNode], g.lon[endNode]) : 0;

  for (let t = 0; t < tries; t++) {
    onProgress(`מחפש אפשרויות… ${t + 1}/${tries}`);
    const theta = (random() * 360 + t * 137.5) % 360;
    const dir = t % 2 ? 1 : -1;
    const square = t % 3 === 2;
    let best = null;
    // a = אורך רשת רצוי לכל צלע. מתחילים מעט קצר כי הקנס על שימוש חוזר
    // בדרכים מאריך את המסלול בפועל, ומתקנים לפי האורך שהתקבל.
    let a = end ? target / 2 : target / (square ? 4 : 3) / 1.08;
    const split = end ? 0.4 + 0.2 * random() : 0;
    for (let it = 0; it < 5; it++) {
      let pts = null;
      if (!end && !square) {
        const p1 = pickNode(g, comp, [[d0, a]], sLat, sLon, theta, 0.6);
        if (p1 >= 0) {
          const d1 = distances(g, p1, a * 1.5);
          const p2 = pickNode(g, comp, [[d0, a], [d1, a]], sLat, sLon, (theta + dir * 60 + 360) % 360, 0.6);
          if (p2 >= 0) pts = [start, p1, p2, start];
        }
      } else if (!end) {
        const p1 = pickNode(g, comp, [[d0, a]], sLat, sLon, theta, 0.6);
        if (p1 >= 0) {
          const d1 = distances(g, p1, a * 1.5);
          const p2 = pickNode(g, comp, [[d0, a * 1.41], [d1, a]], sLat, sLon, (theta + dir * 45 + 360) % 360, 0.5);
          if (p2 >= 0) {
            const d2 = distances(g, p2, a * 1.5);
            const p3 = pickNode(g, comp, [[d0, a], [d2, a]], sLat, sLon, (theta + dir * 90 + 360) % 360, 0.5);
            if (p3 >= 0) pts = [start, p1, p2, p3, start];
          }
        }
      } else {
        const want = (toEnd + dir * (square ? 70 : 40) + 360) % 360;
        const p = pickNode(g, comp, [[d0, 2 * a * split], [dEnd, 2 * a * (1 - split)]], sLat, sLon, want, 0.4);
        if (p >= 0) pts = [start, p, endNode];
      }
      const res = pts && chain(g, pts, cost);
      if (!res || res.length < 100) { a *= 0.85; continue; }
      if (!best || Math.abs(res.length - target) < Math.abs(best.length - target)) best = res;
      const err = res.length / target;
      if (Math.abs(err - 1) < 0.02) break;
      a *= Math.pow(1 / err, 0.9);
    }
    if (best) {
      const d = describe(g, best);
      d.score = score(g, d, target, cost);
      candidates.push(d);
    }
  }
  if (!candidates.length) throw planError('DISTANCE_NOT_FOUND', 'לא נמצא מסלול במרחק הזה. נסה מרחק אחר או נקודה אחרת.');

  candidates.sort((a, b) => a.score - b.score);
  const close = candidates.filter((c) => Math.abs(c.length - target) / target <= 0.07);
  const pool = close.length ? close : candidates.slice(0, 1);
  const chosen = [];
  for (const c of pool) {
    if (chosen.length >= variants) break;
    if (chosen.some((o) => overlap(g, c, o) > 0.6)) continue;
    chosen.push(c);
  }
  // אם כל האפשרויות דומות מדי, עדיף להציג פחות מסלולים מאשר כפילויות
  return { routes: chosen, start, end: endNode };
}

function planError(code, message) { return Object.assign(new Error(message), { code }); }

/* ===================== נקודות ניווט ל-Apple Maps ===================== */

/**
 * בוחר נקודות ביניים כך שאפליקציית ניווט שמחשבת בעצמה את הדרך הקצרה
 * ביותר בין כל שתי נקודות תיצמד למסלול שלנו.
 *
 * מכל נקודה מתקדמים לאורך המסלול כל עוד הקטע שלנו הוא גם הדרך הקצרה
 * ביותר (בסטייה של עד tol). איפה שזה נשבר, שמים נקודה באמצע הקשת
 * האחרונה שעוד מתאימה — באמצע רחוב ולא בצומת, כדי שהנקודה לא תיצמד
 * לרחוב חוצה.
 *
 * זה קירוב: לאפליקציה יש מפה ושיקולים משלה. tol קטן = יותר נקודות.
 */
export function navWaypoints(g, r, { tol = 25, maxLeg = 5000 } = {}) {
  const nodes = r.nodes, last = nodes.length - 1;
  const cum = new Float64Array(nodes.length);
  for (let i = 1; i <= last; i++) cum[i] = cum[i - 1] + g.eLen[r.edges[i - 1]];
  const points = [];
  let i = 0;
  while (i < last) {
    const remaining = cum[last] - cum[i];
    const reach = Math.min(maxLeg, remaining) + tol + 50;
    const sp = shortestFrom(g, nodes[i], reach);
    let j = i + 1;
    while (j < last && cum[j + 1] - cum[i] <= maxLeg && sp(nodes[j + 1]) >= cum[j + 1] - cum[i] - tol) j++;
    if (j >= last && sp(nodes[last]) >= cum[last] - cum[i] - tol) break;
    const a = nodes[j - 1], b = nodes[j];
    // נקודה בשני-שלישים של הקשת, קרוב לסופה אבל לא על הצומת
    points.push([g.lat[a] + (g.lat[b] - g.lat[a]) * 0.66, g.lon[a] + (g.lon[b] - g.lon[a]) * 0.66]);
    i = j;
  }
  return points;
}

/** מצמצם רשימת נקודות למקסימום, בשמירה על פיזור לאורך המסלול. */
export function thin(points, max) {
  if (points.length <= max) return points.slice();
  const out = [];
  for (let k = 0; k < max; k++) out.push(points[Math.round(((k + 0.5) * points.length) / max - 0.5)]);
  return out;
}

/* ===================== גובה ===================== */

/** דוגם עד max נקודות לאורך המסלול, במרווחים שווים. */
export function sample(coords, max = 100) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav(...coords[i - 1], ...coords[i]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let k = 0; k < max; k++) {
    const d = (total * k) / (max - 1);
    while (j < coords.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1, t = Math.min(1, Math.max(0, (d - cum[j]) / seg));
    out.push({ d, lat: coords[j][0] + (coords[j + 1][0] - coords[j][0]) * t, lon: coords[j][1] + (coords[j + 1][1] - coords[j][1]) * t });
  }
  return out;
}

/** טיפוס מצטבר עם סף רעש, כדי שקפיצות של מודל הגובה לא ייספרו כעלייה. */
export function climb(elev, threshold = 3) {
  let gain = 0, loss = 0, ref = elev[0];
  for (const e of elev) {
    if (e - ref >= threshold) { gain += e - ref; ref = e; }
    else if (ref - e >= threshold) { loss += ref - e; ref = e; }
  }
  return { gain: Math.round(gain), loss: Math.round(loss) };
}
