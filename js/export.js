/**
 * העברת מסלול לאפליקציות ניווט ולקבצים.
 * Google Maps: עד 9 נקודות ביניים; באופליין אין שם הוראות הליכה בכלל.
 * Apple Maps לא נתמכת: בבדיקה על אייפון היא מחקה את נקודות הביניים במצב הליכה.
 */

const fmt = ([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

export const GOOGLE_MAX_WAYPOINTS = 9;

export function googleMapsUrl(start, end, waypoints) {
  const p = new URLSearchParams({ api: '1', origin: fmt(start), destination: fmt(end), travelmode: 'walking' });
  if (waypoints.length) p.set('waypoints', waypoints.map(fmt).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * GPX 1.1: מסלול מלא כ-trk, מה שאפליקציות ריצה ושעונים מייבאים.
 * rte נכתב רק אם מעבירים נקודות במפורש: יש אפליקציות שבוחרות אותו
 * במקום ה-trk, ואז מנווטות בקו גס בין כמה נקודות.
 */
export function toGpx(name, coords, waypoints = [], elevations = null) {
  const time = new Date().toISOString();
  const trk = coords.map((c, i) => {
    const ele = elevations && elevations[i] != null ? `<ele>${elevations[i].toFixed(1)}</ele>` : '';
    return `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}">${ele}</trkpt>`;
  }).join('\n      ');
  const rte = waypoints.length ? `<rte><name>${esc(name)}</name>
    ${[coords[0], ...waypoints, coords[coords.length - 1]].map((c) => `<rtept lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"/>`).join('\n    ')}
  </rte>
  ` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Loop" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${time}</time></metadata>
  ${rte}<trk><name>${esc(name)}</name><type>running</type>
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

