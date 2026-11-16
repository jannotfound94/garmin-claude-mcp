/**
 * Running loops from OpenRouteService (free key, openrouteservice.org).
 * foot-hiking profile + "green" and "quiet" weightings. Candidates come from two sources:
 *  - loops routed through parks and unpaved paths found in OpenStreetMap (see parks.ts), and
 *  - OpenRouteService's own round trips (fallback when there is no park data or too few good loops).
 * Every candidate is a real routed loop that is measured (length, surface, greenery, out-and-back share);
 * the two best near the target length are offered.
 */

import { type Anchor, mulberry32, viaCandidates } from "./parks";

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
  green_avg: number; // 0-10, 10 = greenest (converted: ORS reports its green index inverted, see greenness())
  retrace_pct: number; // share of the loop run twice (out-and-back parts); 0 = clean loop
  compact?: number; // 0-1, how "round" the loop is (4*pi*area/length^2); thin out-and-back shapes are near 0
  trimmed_m?: number; // metres of needless spurs and small loops cut out of the routed path (see tidyRoute)
  source: "parki" | "ors"; // through parks/unpaved paths (own generator) or an OpenRouteService round trip
  via?: string[]; // names of the parks the loop goes through
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

/**
 * ORS' documentation says the "green" extra runs from 0 (little green) to 10 (a lot of green).
 * Its source says otherwise: the underlying level comes from an "ungreen factor" (higher = less green;
 * the green weighting penalises high levels) and is reported to clients as 3..10. A route through dense
 * city streets therefore shows ~10, which is how a 10/10 "greenery" came out for a street route.
 * Convert to a 0-10 score where 10 really is greenest.
 */
function greenness(summary: any[] | undefined): number {
  const ungreen = weightedAvg(summary); // 3 (greenest) .. 10 (least green)
  if (!ungreen) return 0;
  return Math.max(0, Math.min(10, ((10 - ungreen) / 7) * 10));
}

function weightedAvg(summary: any[] | undefined): number {
  if (!Array.isArray(summary)) return 0;
  const total = summary.reduce((a, s) => a + Number(s.amount ?? 0), 0);
  return total ? summary.reduce((a, s) => a + Number(s.value) * Number(s.amount ?? 0), 0) / total : 0;
}

async function loop(apiKey: string, start: LatLon, meters: number, seed: number) {
  const res = await fetch(`${ORS}/v2/directions/foot-hiking/geojson`, {
    signal: AbortSignal.timeout(25000),
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
    body: JSON.stringify({
      coordinates: [[start.lon, start.lat]],
      instructions: false,
      extra_info: ["surface", "waytype", "green"],
      options: {
        round_trip: { length: meters, points: 4, seed },
        avoid_features: ["steps"],
        profile_params: { weightings: { green: 1, quiet: 1 } },
      },
    }),
  });
  return parseRoute(res);
}

type Measured = Omit<RouteOption, "label" | "source" | "via">;

async function parseRoute(res: Response): Promise<Measured> {
  if (!res.ok) throw new Error(`OpenRouteService ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  const f = j.features?.[0];
  if (!f) throw new Error("OpenRouteService: brak trasy");
  const ex = f.properties?.extras ?? {};
  const tidy = tidyRoute(f.geometry.coordinates as [number, number][]);
  const unpaved = summaryPct(ex.surface?.summary, (v) => UNPAVED.has(v));
  const paved = summaryPct(ex.surface?.summary, (v) => PAVED.has(v));
  return {
    // After trimming, the length comes from the geometry; untouched routes keep the router's own figure.
    distance_km: Math.round((tidy.trimmedM > 0 ? tidy.lengthM : (f.properties?.summary?.distance ?? tidy.lengthM)) / 100) / 10,
    unpaved_pct: Math.round(unpaved),
    paved_pct: Math.round(paved),
    unknown_surface_pct: Math.max(0, Math.round(100 - unpaved - paved)),
    paths_pct: Math.round(summaryPct(ex.waytype?.summary, (v) => PATHS.has(v))),
    retrace_pct: retracePct(tidy.coords),
    compact: Math.round(compactness(tidy.coords) * 100) / 100,
    ...(tidy.trimmedM > 0 ? { trimmed_m: Math.round(tidy.trimmedM) } : {}),
    green_avg: Math.round(greenness(ex.green?.summary) * 10) / 10,
    coords: tidy.coords,
  };
}

// ---------------- sprzątanie geometrii: zbędne odnogi i pętelki ----------------

function plane(lat0: number) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (lon: number, lat: number): [number, number] => [lon * kx, lat * 110540];
}

interface Pt {
  lon: number;
  lat: number;
  x: number;
  y: number;
  d: number; // distance along the route, m
  orig: boolean; // a vertex returned by the router (interpolated samples are dropped from the output)
  keep?: boolean; // end of a cut: always emitted
}

/** The route as points at most `step` m apart (original vertices included), with distance along the route. */
function samplePoints(coords: number[][], step = 10): Pt[] {
  const xy = plane(coords[0][1]);
  const out: Pt[] = [];
  let dist = 0;
  const push = (lon: number, lat: number, d: number, orig: boolean) => {
    const [x, y] = xy(lon, lat);
    out.push({ lon, lat, x, y, d, orig });
  };
  push(coords[0][0], coords[0][1], 0, true);
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = xy(coords[i - 1][0], coords[i - 1][1]);
    const [x1, y1] = xy(coords[i][0], coords[i][1]);
    const seg = Math.hypot(x1 - x0, y1 - y0);
    for (let t = step; t < seg; t += step) {
      const f = t / seg;
      push(coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f, dist + t, false);
    }
    dist += seg;
    push(coords[i][0], coords[i][1], dist, true);
  }
  return out;
}

export const routeLengthM = (coords: number[][]) => (coords.length ? (() => { const p = samplePoints(coords, 1e9); return p[p.length - 1].d; })() : 0);

/**
 * Routers love detours: a short stub into a courtyard and back, or a lap around a building block, because the
 * via point snapped to a spot off the street. Both leave the route passing the same place twice within a few
 * hundred metres. For every point we look for a later point within 15 m of it that is 40-600 m further along;
 * everything in between is cut out (the longest such excursion first). Two passes near the same spot far apart
 * along the route (e.g. leaving and returning home) are untouched. If more than 25% of the route would go, the
 * route is returned as it was: that is not a detour but a different kind of route.
 */
export function tidyRoute(coords: [number, number][]): { coords: [number, number][]; trimmedM: number; lengthM: number } {
  if (coords.length < 4) return { coords, trimmedM: 0, lengthM: routeLengthM(coords) };
  let pts = samplePoints(coords);
  const total = pts[pts.length - 1].d;
  const CELL = 15;
  const NEAR = 15;
  let trimmed = 0;
  for (let guard = 0; guard < 40; guard++) {
    const grid = new Map<string, number[]>();
    pts.forEach((p, i) => {
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    });
    let cut: [number, number] | null = null;
    for (let i = 0; i < pts.length && !cut; i++) {
      const cx = Math.floor(pts[i].x / CELL);
      const cy = Math.floor(pts[i].y / CELL);
      let bestJ = -1;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            const gap = pts[j].d - pts[i].d;
            if (j > i && gap >= 40 && gap <= 600 && j > bestJ && Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) < NEAR) bestJ = j;
          }
      if (bestJ > 0) cut = [i, bestJ];
    }
    if (!cut) break;
    const [i, j] = cut;
    trimmed += pts[j].d - pts[i].d;
    if (trimmed > 0.25 * total) return { coords, trimmedM: 0, lengthM: total };
    pts[i].keep = pts[j].keep = true;
    pts = [...pts.slice(0, i + 1), ...pts.slice(j)];
    // distances after the cut: the jump i -> j is at most NEAR metres
    let d = 0;
    pts.forEach((p, k) => {
      if (k) d += Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y);
      p.d = d;
    });
  }
  const out = pts.filter((p) => p.orig || p.keep).map((p): [number, number] => [p.lon, p.lat]);
  return { coords: trimmed > 0 ? out : coords, trimmedM: trimmed, lengthM: trimmed > 0 ? pts[pts.length - 1].d : total };
}

/** 4*pi*area/length^2 of the closed route: 1 = circle, ~0.6 = 3:1 rectangle, ~0 = out-and-back or figure-eight. */
export function compactness(coords: number[][]): number {
  if (coords.length < 3) return 0;
  const xy = plane(coords[0][1]);
  const p = coords.map(([lon, lat]) => xy(lon, lat));
  let area = 0;
  let len = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    area += x0 * y1 - x1 * y0;
    len += Math.hypot(x1 - x0, y1 - y0);
  }
  return len > 0 ? Math.min(1, (4 * Math.PI * Math.abs(area / 2)) / (len * len)) : 0;
}

/** A loop start -> anchors -> start, routed on foot-hiking with the same measurements. */
async function viaRoute(apiKey: string, start: LatLon, pts: Anchor[]) {
  const coords = [start, ...pts, start].map((p) => [p.lon, p.lat]);
  const res = await fetch(`${ORS}/v2/directions/foot-hiking/geojson`, {
    method: "POST",
    signal: AbortSignal.timeout(25000),
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
    body: JSON.stringify({
      coordinates: coords,
      instructions: false,
      extra_info: ["surface", "waytype", "green"],
      radiuses: coords.map((_, i) => (i === 0 || i === coords.length - 1 ? 350 : 500)),
      options: { avoid_features: ["steps"], profile_params: { weightings: { green: 1, quiet: 1 } } },
    }),
  });
  return parseRoute(res);
}

/** Score: soft surface first, then greenery, then paths; unknown surface on paths counts half. */
function score(o: Omit<RouteOption, "label">) {
  return (
    o.unpaved_pct +
    0.5 * Math.min(o.unknown_surface_pct, o.paths_pct) +
    3 * o.green_avg +
    0.2 * o.paths_pct -
    1.5 * o.retrace_pct +
    60 * (o.compact ?? 0.3) - // a round, simple shape beats a tangle of detours (the most visible quality)
    0.05 * (o.trimmed_m ?? 0)
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
  // Spatial hash (25 m cells): a point is retraced if another point more than 300 m away along the
  // route lies within 25 m of it. Looking only at the 3x3 neighbouring cells keeps this linear.
  const grid = new Map<string, number[]>();
  inner.forEach((p, i) => {
    const key = `${Math.floor(p.x / 25)},${Math.floor(p.y / 25)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
  });
  let retraced = 0;
  for (const p of inner) {
    const cx = Math.floor(p.x / 25);
    const cy = Math.floor(p.y / 25);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++)
      for (let dy = -1; dy <= 1 && !hit; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const q = inner[j];
          if (Math.abs(q.d - p.d) > 300 && Math.hypot(q.x - p.x, q.y - p.y) < 25) {
            hit = true;
            break;
          }
        }
    if (hit) retraced++;
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

type Cand = Measured & { source: "parki" | "ors"; via?: string[] };

async function settle<T>(jobs: Promise<T>[]): Promise<{ ok: Awaited<T>[]; firstError?: unknown }> {
  const r = await Promise.allSettled(jobs);
  const ok: Awaited<T>[] = [];
  let firstError: unknown;
  for (const x of r) {
    if (x.status === "fulfilled") ok.push(x.value);
    else firstError ??= x.reason;
  }
  return { ok, firstError };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/**
 * Proposes two loops. With park data (`anchors`) it first routes loops through parks and soft paths:
 * a first batch assumes streets are 1.35x longer than straight lines, the observed ratio then corrects
 * a second batch. If fewer than two good loops come out (or there is no park data), OpenRouteService's
 * own round trips are added. Candidates must be within 10% of the target length.
 */
export async function proposeLoops(apiKey: string, start: LatLon, targetKm: number, anchors: Anchor[] = []): Promise<RouteOption[]> {
  const pool: Cand[] = [];
  let firstError: unknown;
  const off = (o: { distance_km: number }) => Math.abs(o.distance_km - targetKm) / targetKm;
  const tidy = (o: { retrace_pct: number; compact?: number }) => o.retrace_pct <= 25 && (o.compact ?? 1) >= 0.15;
  const good = () => pool.filter((o) => off(o) <= 0.1 && tidy(o));

  if (anchors.length >= 3) {
    const rand = mulberry32(Math.floor(Math.random() * 2 ** 31));
    const run = async (cands: ReturnType<typeof viaCandidates>) => {
      const results = await Promise.allSettled(cands.map((c) => viaRoute(apiKey, start, c.pts)));
      const ratios: number[] = [];
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          firstError ??= r.reason;
          return;
        }
        ratios.push((r.value.distance_km * 1000) / cands[i].estM);
        const names = cands[i].pts.map((p) => p.name).filter((n): n is string => Boolean(n));
        pool.push({ ...r.value, source: "parki", ...(names.length ? { via: names } : {}) });
      });
      return ratios;
    };
    const r1 = await run(viaCandidates(start, anchors, targetKm, 1.35, 6, rand));
    const f = r1.length ? Math.min(2, Math.max(1.1, median(r1))) : 1.35;
    await run(viaCandidates(start, anchors, targetKm, f, 5, rand));
  }

  if (good().length < 2) {
    const seeds = Array.from({ length: 5 }, (_, i) => Math.floor(Math.random() * 1000) + i * 1000);
    const { ok, firstError: e } = await settle(seeds.map((s) => calibratedLoop(apiKey, start, targetKm, s)));
    firstError ??= e;
    pool.push(...ok.map((o): Cand => ({ ...o, source: "ors" })));
  }
  if (!pool.length) throw new Error(String(firstError ?? "Nie udało się wyznaczyć tras"));

  // Prefer real loops within 10% of the target, best score first; otherwise the closest by length.
  const loopsOnly = pool.filter(tidy);
  const candidates = loopsOnly.length >= 2 ? loopsOnly : pool;
  const near = candidates.filter((o) => off(o) <= 0.1);
  const ranked = near.length >= 2 ? near.sort((a, b) => score(b) - score(a)) : [...candidates].sort((a, b) => off(a) - off(b));
  const picked = [ranked[0]];
  const second = ranked.slice(1).find((o) => overlap(o.coords, ranked[0].coords) < 0.6) ?? ranked[1];
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

export function mapPage(title: string, coords: number[][], gpxUrl: string, details = ""): string {
  const latlngs = JSON.stringify(coords.map(([lon, lat]) => [lat, lon]));
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>html,body{margin:0;height:100%;font-family:system-ui;background:#fff}#map{position:absolute;top:64px;bottom:0;left:0;right:0}
header{height:64px;display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box;border-bottom:1px solid #ddd}
header .t{flex:1;min-width:0}header b{display:block;font-size:16px}header small{display:block;color:#555;font-size:12px;line-height:1.25;max-height:2.5em;overflow:hidden}
a.btn{background:#1a73e8;color:#fff;padding:8px 12px;border-radius:6px;text-decoration:none;white-space:nowrap;font-size:14px}a.back{background:#eef2f7;color:#1a2433}</style></head>
<body><header><a class="btn back" href="/app/#/plan" onclick="if(history.length>1){history.back();return false}">← Wróć</a><div class="t"><b>${title}</b>${details ? `<small>${details}</small>` : ""}</div><a class="btn" href="${gpxUrl}">GPX</a></header><div id="map"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>const p=${latlngs};const m=L.map('map');L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(m);
const l=L.polyline(p,{color:'#d32f2f',weight:5}).addTo(m);L.circleMarker(p[0],{radius:7,color:'#1a73e8'}).addTo(m).bindPopup('Start / meta');m.fitBounds(l.getBounds(),{padding:[20,20]});</script>
</body></html>`;
}
