/**
 * כל החישוב הכבד רץ כאן, כדי שהמפה והכפתורים יישארו חלקים:
 * פענוח נתוני המפה, בניית הגרף, חיפוש מסלולים ונקודות ניווט.
 * הגרף נשמר בזיכרון בין בקשות באותו אזור.
 */
import { buildGraph, plan, navWaypoints } from './engine.js?v=4';

let graph = null, graphKey = null;

self.onmessage = (event) => {
  const { id, type } = event.data;
  const progress = (message) => self.postMessage({ id, type: 'progress', message });
  try {
    if (type === 'hasGraph') {
      self.postMessage({ id, type: 'result', data: graphKey === event.data.key });
      return;
    }
    if (type === 'load') {
      if (graphKey !== event.data.key) {
        progress('בונה את רשת הרחובות והשבילים…');
        const parsed = JSON.parse(event.data.text);
        graph = buildGraph(parsed.elements);
        graphKey = event.data.key;
      }
      self.postMessage({ id, type: 'result', data: { nodes: graph.n, edges: graph.m } });
      return;
    }
    if (type === 'plan') {
      if (!graph) throw Object.assign(new Error('אין מפה טעונה'), { code: 'NO_GRAPH' });
      const { routes, start } = plan(graph, event.data.opts, progress);
      progress('מכין נקודות ניווט…');
      const out = routes.map((r) => ({
        coords: r.coords,
        length: r.length,
        byClass: r.byClass,
        repeatShare: r.repeatShare,
        note: r.note || '',
        waypoints: navWaypoints(graph, r),
      }));
      self.postMessage({ id, type: 'result', data: { routes: out, start: [graph.lat[start], graph.lon[start]] } });
      return;
    }
    throw new Error(`unknown message ${type}`);
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e.message, code: e.code || null });
  }
};
