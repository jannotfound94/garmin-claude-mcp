/**
 * Green anchors for loops through parks and unpaved paths.
 *
 * OpenRouteService alone cannot be told "avoid asphalt", so loops come out as streets even when parks
 * are next door. Here the OpenStreetMap data around the start (parks, forests, meadows, and paths or
 * tracks with a soft surface) is fetched once from Overpass, merged into a few weighted "anchor" points,
 * and loops are built through them: start -> anchor -> anchor -> start, routed by OpenRouteService.
 * The caller scores the real routes, so a bad guess here only costs a candidate, never a wrong answer.
 */

import type { LatLon } from "./routes";

export interface Anchor {
  lat: number;
  lon: number;
  w: number; // weight: how much green/unpaved mapped data is concentrated here
  name?: string; // park name, if any
}

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

const SOFT_SURFACES = new Set([
  "ground", "dirt", "earth", "gravel", "fine_gravel", "compacted", "grass", "sand", "unpaved", "pebblestone", "mud", "woodchips",
]);

/** Radius tiers, so that nearby run lengths share one cached download. */
export function anchorRadiusM(targetKm: number): number {
  const need = targetKm * 330; // anchors lie up to ~1/3 of the run length from the start
  return need <= 2500 ? 2500 : need <= 4000 ? 4000 : 6000;
}

export function overpassQuery(lat: number, lon: number, radiusM: number): string {
  const a = `(around:${radiusM},${lat.toFixed(3)},${lon.toFixed(3)})`; // ~100 m is enough for a 2.5+ km search
  const open = `["access"!~"^(private|no)$"]`;
  return (
    `[out:json][timeout:25];(` +
    `way["leisure"~"^(park|nature_reserve)$"]${open}${a};` +
    `relation["leisure"~"^(park|nature_reserve)$"]${open}${a};` +
    `way["landuse"~"^(forest|meadow|recreation_ground|village_green)$"]${open}${a};` +
    `way["natural"~"^(wood|grassland|heath|scrub)$"]${open}${a};` +
    `way["highway"~"^(path|track|footway|bridleway)$"]["surface"~"^(${[...SOFT_SURFACES].join("|")})$"]${open}${a};` +
    `way["highway"="track"][!"surface"]${open}${a};` +
    `);out center tags qt 1500;`
  );
}

interface Raw {
  lat: number;
  lon: number;
  w: number;
  name?: string;
  area: boolean;
}

export function parseRaw(json: any): Raw[] {
  const out: Raw[] = [];
  for (const el of json?.elements ?? []) {
    const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c) continue;
    const t = el.tags ?? {};
    if (t.access === "private" || t.access === "no") continue;
    let w = 0;
    let area = false;
    if (t.leisure === "park" || t.leisure === "nature_reserve" || t.landuse === "forest" || t.natural === "wood") {
      w = 3;
      area = true;
    } else if (["meadow", "recreation_ground", "village_green"].includes(t.landuse) || ["grassland", "heath", "scrub"].includes(t.natural)) {
      w = 1.5;
      area = true;
    } else if (t.highway) {
      w = SOFT_SURFACES.has(t.surface) ? 1 : t.highway === "track" && !t.surface ? 0.6 : 0;
    }
    if (w > 0) out.push({ lat: c.lat, lon: c.lon, w, name: t.name, area });
  }
  return out;
}

/** Local metric plane around the start: x east, y north, metres. */
export function plane(origin: LatLon) {
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const ky = 110540;
  return {
    toXY: (p: LatLon) => ({ x: (p.lon - origin.lon) * kx, y: (p.lat - origin.lat) * ky }),
    toLL: (x: number, y: number): LatLon => ({ lat: origin.lat + y / ky, lon: origin.lon + x / kx }),
  };
}

/** Merges raw points into ~160 m cells; keeps the heaviest clusters. */
export function clusterAnchors(raw: Raw[], start: LatLon, max = 150): Anchor[] {
  const { toXY, toLL } = plane(start);
  const cells = new Map<string, { sx: number; sy: number; w: number; best?: { w: number; name: string } }>();
  for (const r of raw) {
    const { x, y } = toXY(r);
    const key = `${Math.floor(x / 160)},${Math.floor(y / 160)}`;
    const c = cells.get(key) ?? { sx: 0, sy: 0, w: 0 };
    c.sx += x * r.w;
    c.sy += y * r.w;
    c.w += r.w;
    if (r.area && r.name && (!c.best || r.w > c.best.w)) c.best = { w: r.w, name: r.name };
    cells.set(key, c);
  }
  return [...cells.values()]
    .filter((c) => c.w >= 1.2)
    .sort((a, b) => b.w - a.w)
    .slice(0, max)
    .map((c) => {
      const ll = toLL(c.sx / c.w, c.sy / c.w);
      return { lat: ll.lat, lon: ll.lon, w: Math.round(c.w * 10) / 10, ...(c.best ? { name: c.best.name } : {}) };
    });
}

export async function fetchAnchors(start: LatLon, radiusM: number): Promise<Anchor[]> {
  const body = `data=${encodeURIComponent(overpassQuery(start.lat, start.lon, radiusM))}`;
  let lastError = "";
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "running-coach-worker/1.0" },
        body,
        signal: AbortSignal.timeout(24000),
      });
      if (!res.ok) {
        lastError = `${url} ${res.status}`;
        continue;
      }
      const json: any = await res.json();
      if (typeof json.remark === "string" && /runtime error|timed out|out of memory/i.test(json.remark)) {
        lastError = `${url}: ${json.remark.slice(0, 80)}`;
        continue;
      }
      return clusterAnchors(parseRaw(json), start);
    } catch (e) {
      lastError = `${url}: ${String(e).slice(0, 80)}`;
    }
  }
  throw new Error(`Overpass niedostępny (${lastError})`);
}

// ---------------- loop candidates through anchors ----------------

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ViaCandidate {
  pts: Anchor[]; // in visiting order, without the start
  estM: number; // straight-line length of start -> pts -> start
}

/**
 * Picks `count` different sets of anchors whose straight-line perimeter is about target/f
 * (f = how much longer streets are than straight lines, ~1.3). Anchors are visited in order of
 * bearing, so the loop goes around the start instead of back and forth.
 */
export function viaCandidates(
  start: LatLon,
  anchors: Anchor[],
  targetKm: number,
  f: number,
  count: number,
  rand: () => number,
): ViaCandidate[] {
  const k = targetKm < 8 ? 2 : targetKm < 16 ? 3 : 4;
  const lt = (targetKm * 1000) / f;
  const { toXY } = plane(start);
  const pool = anchors
    .map((a) => {
      const { x, y } = toXY(a);
      return { a, x, y, d: Math.hypot(x, y), th: Math.atan2(y, x) };
    })
    .filter((p) => p.d >= Math.max(250, 0.1 * lt) && p.d <= 0.5 * lt);
  if (pool.length < k) return [];

  const total = pool.reduce((s, p) => s + p.a.w, 0);
  const pick = () => {
    let r = rand() * total;
    for (const p of pool) {
      r -= p.a.w;
      if (r <= 0) return p;
    }
    return pool[pool.length - 1];
  };

  const seen = new Set<string>();
  const out: ViaCandidate[] = [];
  for (let attempt = 0; attempt < 600 && out.length < count; attempt++) {
    const chosen = new Set<(typeof pool)[number]>();
    while (chosen.size < k) chosen.add(pick());
    const sorted = [...chosen].sort((p, q) => p.th - q.th);
    const key = sorted.map((p) => `${p.a.lat.toFixed(4)},${p.a.lon.toFixed(4)}`).join("|");
    if (seen.has(key)) continue;
    // Anchors must be spread around the start: consecutive bearings at least 30 degrees apart.
    let ok = true;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].th - sorted[i - 1].th < (30 * Math.PI) / 180) ok = false;
    const span = sorted[sorted.length - 1].th - sorted[0].th;
    if (k === 2 ? span < (50 * Math.PI) / 180 || span > (170 * Math.PI) / 180 : span > (300 * Math.PI) / 180) ok = false;
    if (!ok) continue;
    const order = rand() < 0.5 ? sorted : [...sorted].reverse(); // clockwise or counter-clockwise
    let est = order[0].d + order[order.length - 1].d;
    for (let i = 1; i < order.length; i++) est += Math.hypot(order[i].x - order[i - 1].x, order[i].y - order[i - 1].y);
    if (est < 0.85 * lt || est > 1.15 * lt) continue;
    seen.add(key);
    out.push({ pts: order.map((p) => p.a), estM: est });
  }
  return out;
}
