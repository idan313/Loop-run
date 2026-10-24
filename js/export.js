/**
 * העברת מסלול לאפליקציות ניווט ולקבצים.
 * Apple Maps: קישור אחיד (iOS 18.4 ומעלה) עם נקודות ביניים, במצב הליכה.
 * Google Maps: עד 9 נקודות ביניים; באופליין אין שם הוראות הליכה בכלל.
 */

const fmt = ([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

export function appleMapsUrl(start, end, waypoints) {
  const p = new URLSearchParams();
  p.set('source', fmt(start));
  p.set('destination', fmt(end));
  for (const w of waypoints) p.append('waypoint', fmt(w));
  p.set('mode', 'walking');
  return `https://maps.apple.com/directions?${p}`;
}

export const GOOGLE_MAX_WAYPOINTS = 9;

export function googleMapsUrl(start, end, waypoints) {
  const p = new URLSearchParams({ api: '1', origin: fmt(start), destination: fmt(end), travelmode: 'walking' });
  if (waypoints.length) p.set('waypoints', waypoints.map(fmt).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * GPX 1.1: מסלול מלא כ-trk (מה שאפליקציות ריצה ושעונים מייבאים),
 * ונקודות הניווט כ-rte למי שמשתמש בהן.
 */
export function toGpx(name, coords, waypoints = [], elevations = null) {
  const time = new Date().toISOString();
  const trk = coords.map((c, i) => {
    const ele = elevations && elevations[i] != null ? `<ele>${elevations[i].toFixed(1)}</ele>` : '';
    return `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}">${ele}</trkpt>`;
  }).join('\n      ');
  const rte = [coords[0], ...waypoints, coords[coords.length - 1]]
    .map((c) => `<rtept lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"/>`).join('\n    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Loop" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${time}</time></metadata>
  <rte><name>${esc(name)}</name>
    ${rte}
  </rte>
  <trk><name>${esc(name)}</name><type>running</type>
    <trkseg>
      ${trk}
    </trkseg>
  </trk>
</gpx>
`;
}

/** שיתוף קובץ דרך גיליון השיתוף של המערכת, ואם אין — הורדה רגילה. */
export async function shareOrDownload(filename, text, mime = 'application/gpx+xml') {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}

/**
 * גרסאות חלופיות של קישור Apple Maps, לבדיקה על מכשיר.
 * בבדיקה הראשונה Apple Maps פתחה רק את המוצא ונקודה אחת, ולא ידוע עדיין
 * איזה פרט בקישור גרם לזה. כל גרסה משנה דבר אחד בלבד.
 */
export function appleVariants(coords, waypoints) {
  const start = coords[0], end = coords[coords.length - 1];
  const loop = Math.abs(start[0] - end[0]) < 1e-6 && Math.abs(start[1] - end[1]) < 1e-6;
  // נקודה כ-60 מ' לפני הסוף, כדי שהיעד לא יהיה זהה למוצא
  let near = end, acc = 0;
  for (let i = coords.length - 1; i > 0 && acc < 60; i--) {
    const [a, b] = [coords[i], coords[i - 1]];
    acc += Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
    near = b;
  }
  const raw = (pairs) => `https://maps.apple.com/directions?${pairs.map(([k, v]) => `${k}=${v}`).join('&')}`;
  const w = waypoints.map((p) => ['waypoint', fmt(p)]);
  return [
    { id: 'A', label: 'הקישור הנוכחי', url: appleMapsUrl(start, end, waypoints) },
    { id: 'B', label: 'בלי מוצא, מתחיל מהמיקום שלך', url: raw([['destination', fmt(end)], ...w, ['mode', 'walking']]) },
    { id: 'C', label: loop ? 'יעד 60 מ\' לפני הסוף, שונה מהמוצא' : 'יעד מוזז 60 מ\'', url: raw([['source', fmt(start)], ['destination', fmt(near)], ...w, ['mode', 'walking']]) },
    { id: 'D', label: 'הנקודות לפני היעד בסדר הפרמטרים', url: raw([['source', fmt(start)], ...w, ['destination', fmt(loop ? near : end)], ['mode', 'walking']]) },
    { id: 'E', label: 'מצב הליכה ראשון, בלי מוצא', url: raw([['mode', 'walking'], ...w, ['destination', fmt(loop ? near : end)]]) },
  ];
}
