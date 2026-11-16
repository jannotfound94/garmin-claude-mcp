/**
 * Running loops from OpenRouteService (free key, openrouteservice.org).
 * foot-hiking profile + "green" and "quiet" weightings; several random loops of the target length
 * are generated and the two with the most unpaved surface and greenery are offered.
 */

const ORS = "https://api.openrouteservice.org";

// Surface ids (OpenRouteService extra info "surface") counted as unpaved/soft.
const UNPAVED = new Set([2, 8, 10, 11, 12, 15, 17, 18]);
const PAVED = new Set([1, 3, 4, 6, 7, 14]);
// Way types: 4 path, 5 track, 7 footway/pedestrian.
const PATHS = new Set([4, 5, 7]);

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteOption {
  label: string; // "A", "B"
  distance_km: number;
  unpaved_pct: number;
  paved_pct: number;
  unknown_surface_pct: number;
  paths_pct: number; // paths, tracks, footways
  green_avg: number; // 0-10
  retrace_pct: number; // share of the loop run twice (out-and-back parts); 0 = clean loop
  coords: [number, number][]; // [lon, lat]
}

export interface RouteProposal {
  id: string;
  created: string;
  target_km: number;
  start: LatLon;
  start_label: string;
  options: RouteOption[];
  chosen?: string;
}

export async function geocode(apiKey: string, text: string): Promise<LatLon & { label: string }> {
  const url = `${ORS}/geocode/search?${new URLSearchParams({ api_key: apiKey, text, size: "1", "boundary.country": "PL" })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geokodowanie ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  const f = j.features?.[0];
  if (!f) throw new Error(`Nie znaleziono adresu: ${text}`);
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties?.label ?? text };
}

function summaryPct(summary: any[] | undefined, pick: (v: number) => boolean): number {
  if (!Array.isArray(summary)) return 0;
  return summary.filter((s) => pick(Number(s.value))).reduce((a, s) => a + Number(s.amount ?? 0), 0);
}

function weightedAvg(summary: any[] | undefined): number {
  if (!Array.isArray(summary)) return 0;
  const total = summary.reduce((a, s) => a + Number(s.amount ?? 0), 0);
  return total ? summary.reduce((a, s) => a + Number(s.value) * Number(s.amount ?? 0), 0) / total : 0;
}

async function loop(apiKey: string, start: LatLon, meters: number, seed: number) {
  const res = await fetch(`${ORS}/v2/directions/foot-hiking/geojson`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
    body: JSON.stringify({
      coordinates: [[start.lon, start.lat]],
      instructions: false,
      extra_info: ["surface", "waytype", "green"],
      options: {
        round_trip: { length: meters, points: 6, seed },
        avoid_features: ["steps"],
        profile_params: { weightings: { green: 1, quiet: 1 } },
      },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouteService ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  const f = j.features?.[0];
  if (!f) throw new Error("OpenRouteService: brak trasy");
  const ex = f.properties?.extras ?? {};
  const unpaved = summaryPct(ex.surface?.summary, (v) => UNPAVED.has(v));
  const paved = summaryPct(ex.surface?.summary, (v) => PAVED.has(v));
  return {
    distance_km: Math.round((f.properties?.summary?.distance ?? 0) / 100) / 10,
    unpaved_pct: Math.round(unpaved),
    paved_pct: Math.round(paved),
    unknown_surface_pct: Math.max(0, Math.round(100 - unpaved - paved)),
    paths_pct: Math.round(summaryPct(ex.waytype?.summary, (v) => PATHS.has(v))),
    retrace_pct: retracePct(f.geometry.coordinates),
    green_avg: Math.round(weightedAvg(ex.green?.summary) * 10) / 10,
    coords: f.geometry.coordinates as [number, number][],
  };
}

/** Score: soft surface first, then greenery, then paths; unknown surface on paths counts half. */
function score(o: Omit<RouteOption, "label">) {
  return (
    o.unpaved_pct + 0.5 * Math.min(o.unknown_surface_pct, o.paths_pct) + 3 * o.green_avg + 0.2 * o.paths_pct - 1.5 * o.retrace_pct
  );
}

/**
 * How much of a loop is run twice (Jan dislikes out-and-back): the route is resampled every ~25 m
 * and a sample counts as retraced if the route passes within ~25 m of it again more than 300 m
 * later or earlier. The first and last 250 m (leaving and returning home) are ignored.
 */
export function retracePct(coords: number[][]): number {
  if (coords.length < 2) return 0;
  const lat0 = (coords[0][1] * Math.PI) / 180;
  const xy = coords.map(([lon, lat]) => [lon * 111320 * Math.cos(lat0), lat * 110540]);
  const pts: { x: number; y: number; d: number }[] = [];
  let dist = 0;
  pts.push({ x: xy[0][0], y: xy[0][1], d: 0 });
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 25; t < seg; t += 25) pts.push({ x: x0 + ((x1 - x0) * t) / seg, y: y0 + ((y1 - y0) * t) / seg, d: dist + t });
    dist += seg;
    pts.push({ x: x1, y: y1, d: dist });
  }
  const inner = pts.filter((p) => p.d > 250 && p.d < dist - 250);
  if (!inner.length) return 0;
  let retraced = 0;
  for (const p of inner) {
    if (inner.some((q) => Math.abs(q.d - p.d) > 300 && Math.abs(q.x - p.x) < 25 && Math.abs(q.y - p.y) < 25 && Math.hypot(q.x - p.x, q.y - p.y) < 25)) retraced++;
  }
  return Math.round((100 * retraced) / inner.length);
}

/** Overlap of two loops (share of sampled points of a lying within ~60 m of b). */
function overlap(a: [number, number][], b: [number, number][]) {
  const step = Math.max(1, Math.floor(a.length / 60));
  let hit = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += step) {
    n++;
    const [x, y] = a[i];
    if (b.some(([u, v]) => Math.abs(u - x) < 0.0009 && Math.abs(v - y) < 0.0006)) hit++;
  }
  return n ? hit / n : 0;
}

/**
 * OpenRouteService treats the round-trip length only as a preference, so a loop for "5 km" can come
 * back as 6-8 km. For each seed the requested length is rescaled by target/actual and re-requested
 * (up to 2 corrections), keeping the closest result.
 */
async function calibratedLoop(apiKey: string, start: LatLon, targetKm: number, seed: number) {
  let request = targetKm * 1000;
  let best = await loop(apiKey, start, Math.round(request), seed);
  for (let i = 0; i < 2; i++) {
    const err = best.distance_km / targetKm - 1;
    if (Math.abs(err) <= 0.05 || best.distance_km <= 0) break;
    request = request * (targetKm / best.distance_km);
    const next = await loop(apiKey, start, Math.round(request), seed).catch(() => null);
    if (next && Math.abs(next.distance_km - targetKm) < Math.abs(best.distance_km - targetKm)) best = next;
  }
  return best;
}

export async function proposeLoops(apiKey: string, start: LatLon, targetKm: number, tries = 6): Promise<RouteOption[]> {
  const seeds = Array.from({ length: tries }, (_, i) => Math.floor(Math.random() * 1000) + i * 1000);
  const settled = await Promise.allSettled(seeds.map((s) => calibratedLoop(apiKey, start, targetKm, s)));
  const ok = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof loop>>> => r.status === "fulfilled").map((r) => r.value);
  if (!ok.length) {
    const err = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    throw new Error(String(err?.reason ?? "Nie udało się wyznaczyć tras"));
  }
  const off = (o: { distance_km: number }) => Math.abs(o.distance_km - targetKm) / targetKm;
  // Only loops within 10% of the target; if fewer than two qualify, take the closest ones by length.
  // Prefer real loops (at most ~25% run twice) when there are enough of them.
  const loopsOnly = ok.filter((o) => o.retrace_pct <= 25);
  const candidates = loopsOnly.length >= 2 ? loopsOnly : ok;
  const near = candidates.filter((o) => off(o) <= 0.1);
  const pool = near.length >= 2 ? near.sort((a, b) => score(b) - score(a)) : [...candidates].sort((a, b) => off(a) - off(b));
  const picked = [pool[0]];
  const second = pool.slice(1).find((o) => overlap(o.coords, pool[0].coords) < 0.6) ?? pool[1];
  if (second) picked.push(second);
  return picked.map((o, i) => ({ label: String.fromCharCode(65 + i), ...o }));
}

export function toGpx(name: string, coords: number[][]): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const pts = coords.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trener Jana" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name></metadata>
<trk><name>${esc(name)}</name><type>running</type><trkseg>${pts}</trkseg></trk>
</gpx>`;
}

export function mapPage(title: string, coords: number[][], gpxUrl: string): string {
  const latlngs = JSON.stringify(coords.map(([lon, lat]) => [lat, lon]));
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>html,body{margin:0;height:100%;font-family:system-ui;background:#fff}#map{position:absolute;top:56px;bottom:0;left:0;right:0}
header{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;box-sizing:border-box;border-bottom:1px solid #ddd}
a.btn{background:#1a73e8;color:#fff;padding:8px 12px;border-radius:6px;text-decoration:none}</style></head>
<body><header><b>${title}</b><a class="btn" href="${gpxUrl}">Pobierz GPX</a></header><div id="map"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>const p=${latlngs};const m=L.map('map');L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(m);
const l=L.polyline(p,{color:'#d32f2f',weight:5}).addTo(m);L.circleMarker(p[0],{radius:7,color:'#1a73e8'}).addTo(m).bindPopup('Start / meta');m.fitBounds(l.getBounds(),{padding:[20,20]});</script>
</body></html>`;
}
