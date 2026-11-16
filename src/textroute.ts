/**
 * Trasa z opisu słownego: "z domu nad Wisłę przez Fort Sokolnickiego, do plaży Żoliborz, potem Kaniowa i park przy Cytadeli"
 * albo luźniej: "10 km, najpierw po tej stronie Wisły, Gdańskim na drugą stronę i powrót kładką".
 * 1) Gemini zamienia opis na uporządkowaną listę miejsc (bez wymyślania: tylko to, co Jan napisał),
 * 2) każde miejsce jest wyszukiwane w OpenStreetMap (nazwa w okolicy startu) lub w geokoderze OpenRouteService,
 * 3) OpenRouteService wyznacza trasę dokładnie przez te punkty w podanej kolejności,
 * 4) przy luźnym opisie z dystansem trasa jest wydłużana objazdem w wybranym miejscu, aż wyjdzie wskazana długość.
 */
import { askGeminiJson } from "./gemini";
import { currentLocation } from "./loc";
import { queryOverpass } from "./parks";
import { type LatLon, type Measured, type RouteOption, type RouteProposal, routeThrough } from "./routes";
import { coach } from "./telegram";

const ORS = "https://api.openrouteservice.org";
const MAX_STOPS = 8;

export type StopKind = "place" | "street" | "park" | "bridge" | "area" | "address";
export interface ParsedRequest {
  question: string | null; // gdy opisu nie da się zamienić na trasę
  targetKm: number | null;
  start: string | null; // null = dom albo udostępniona lokalizacja
  end: string | null; // null = to samo co start
  stops: { query: string; kind: StopKind }[];
  slackAfter: number | null; // po którym punkcie (0 = start) wolny dystans ma być "nadrobiony"
  green: boolean;
  quiet: boolean;
  unsupported: string[];
}
export interface ResolvedPoint {
  name: string;
  query: string;
  lat: number;
  lon: number;
  kind: string;
  confidence: "high" | "low";
  found: string; // pod jaką nazwą znaleziono
}

// ---------------- 1. rozbiór opisu ----------------

const SYSTEM = `Zamieniasz opis trasy biegowej Janka (po polsku, często podyktowany głosem) na dane do wyznaczenia trasy.
Zasady:
- stops: miejsca, przez które trasa MA przebiegać, dokładnie w kolejności z opisu, bez startu i mety (dom jest startem i metą, jeśli Jan nie napisał inaczej). Nie dodawaj miejsc, o których Jan nie wspomniał.
- query: nazwa możliwie dokładna do wyszukania na mapie, razem z miastem lub dzielnicą z kontekstu (np. "Most Gdański, Warszawa", "ulica Kaniowa, Żoliborz, Warszawa", "Park Cytadela, Warszawa"). Popraw oczywiste przekręcenia z dyktowania (np. "Fortecę Kręglickich" nazwij tak, jak brzmi, ale dodaj dzielnicę). Jeśli miejsce opisano tylko ogólnie (np. "kładką"), podaj najlepszy trop jako query (np. "kładka pieszo-rowerowa przez Wisłę, Warszawa").
- kind: street (ulica), address (numer domu), park (park, las, ogród, błonia), bridge (most, kładka), area (dzielnica, osiedle, plaża, bulwar), place (reszta: fort, budynek, pomnik, stacja).
- target_km: tylko gdy Jan podał dystans ("10 km"); inaczej null.
- slack_after: gdy Jan prosi, by dodatkowy dystans nadrobić w pewnym miejscu ("najpierw po tej stronie Wisły" = 0, czyli przed pierwszym miejscem; "na koniec jeszcze kółko po parku" = numer ostatniego miejsca). Inaczej null. Liczy się od startu: 0 = start, 1 = po pierwszym miejscu itd.
- start: tylko gdy Jan zaczyna gdzie indziej niż z domu (wtedy query miejsca), inaczej null. end: gdy kończy gdzie indziej niż start, inaczej null.
- green: true domyślnie (preferuj zieleń); false tylko gdy Jan prosi o najkrótszą/miejską. quiet: true domyślnie; false, gdy nie przeszkadza ruch.
- unsupported: rzeczy, których nie da się zapisać w trasie (np. "unikaj ulicy X", "bez wzniesień", pory dnia). Krótko po polsku.
- question: wypełnij tylko wtedy, gdy opis jest pusty, nie dotyczy biegania albo nie da się z niego wyczytać ani jednego miejsca ani dystansu. Wtedy krótkie pytanie po polsku, w pozostałych polach puste wartości.`;

const STR = (extra: Record<string, unknown> = {}) => ({ type: "STRING", ...extra });
const SCHEMA = {
  type: "OBJECT",
  properties: {
    question: STR({ nullable: true }),
    target_km: { type: "NUMBER", nullable: true },
    start: STR({ nullable: true }),
    end: STR({ nullable: true }),
    stops: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { query: STR(), kind: STR({ enum: ["place", "street", "park", "bridge", "area", "address"] }) }, required: ["query", "kind"] },
    },
    slack_after: { type: "INTEGER", nullable: true },
    green: { type: "BOOLEAN" },
    quiet: { type: "BOOLEAN" },
    unsupported: { type: "ARRAY", items: STR() },
  },
  required: ["stops", "green", "quiet", "unsupported"],
};

const KINDS = new Set(["place", "street", "park", "bridge", "area", "address"]);
const clean = (v: unknown, n = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

export function sanitizeParsed(j: any): ParsedRequest {
  const stops = (Array.isArray(j?.stops) ? j.stops : [])
    .map((s: any) => ({ query: clean(s?.query), kind: (KINDS.has(s?.kind) ? s.kind : "place") as StopKind }))
    .filter((s: { query: string }) => s.query.length >= 2)
    .slice(0, MAX_STOPS);
  const km = Number(j?.target_km);
  const slack = Number.isInteger(j?.slack_after) && j.slack_after >= 0 ? j.slack_after : null;
  return {
    question: clean(j?.question, 300) || null,
    targetKm: Number.isFinite(km) && km >= 2 && km <= 50 ? Math.round(km * 10) / 10 : null,
    start: clean(j?.start) || null,
    end: clean(j?.end) || null,
    stops,
    slackAfter: slack,
    green: j?.green !== false,
    quiet: j?.quiet !== false,
    unsupported: (Array.isArray(j?.unsupported) ? j.unsupported : []).map((u: unknown) => clean(u, 100)).filter(Boolean).slice(0, 5),
  };
}

export async function parseRequest(env: Env, text: string, context: string): Promise<ParsedRequest> {
  const user = `${context ? `Okolica startu Janka: ${context}.\n` : ""}Opis trasy: """${text}"""`;
  return sanitizeParsed(await askGeminiJson(env, { system: SYSTEM, user, schema: SCHEMA }));
}

// ---------------- 2. wyszukiwanie miejsc ----------------
// Geokodery potrafią zwrócić "cokolwiek": dla nieznanej nazwy środek miasta albo inny park. Dlatego każdy kandydat
// z trzech źródeł (OpenRouteService/Pelias, Photon, OpenStreetMap po nazwie) jest oceniany po tym, czy jego NAZWA
// zawiera charakterystyczne słowa z opisu, a miejsca, których nie da się potwierdzić, są pomijane z ostrzeżeniem.

const R = 6371000;
export function distM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const norm = (s: string) => s.toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Słowa, które nie wyróżniają miejsca (rodzaj obiektu, przyimki, miasto). */
const GENERIC = new Set(["park", "parku", "ulica", "ul", "aleja", "al", "plac", "pl", "im", "imienia", "most", "mostu", "kladka", "kladki", "kladke", "bulwar", "bulwary", "bulwaru", "ogrod", "skwer", "nad", "pod", "przez", "do", "na", "w", "z", "i", "oraz", "warszawa", "warszawie", "warsaw", "polska", "poland", "gdansk", "krakow", "wroclaw", "poznan"]);

export interface Tok {
  raw: string; // małymi literami, z polskimi znakami (do wyrażenia regularnego w OSM)
  n: string; // bez znaków diakrytycznych
}
const tokens = (s: string): Tok[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
    .map((raw) => ({ raw, n: norm(raw) }));
/** Słowa charakterystyczne: bez rodzajów obiektów; gdy nic nie zostaje, wszystkie. */
export function distinctTokens(query: string): Tok[] {
  const all = tokens(osmName(query));
  const d = all.filter((t) => !GENERIC.has(t.n));
  return d.length ? d : all;
}
/** Odmiany po polsku ("Gdańskim", "Traugutta"/"Traugutt"): zgodne, gdy równe albo mają wspólny początek (min. 5 liter). */
const tokMatch = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && a.slice(0, 5) === b.slice(0, 5));

export interface Scored {
  score: number; // udział słów charakterystycznych z opisu znalezionych w nazwie kandydata
  hasKey: boolean; // czy znaleziono najdłuższe (zwykle nazwisko lub właściwą nazwę) słowo
  typeWords: boolean; // czy nazwa ma też rodzaj obiektu z opisu ("Most", "Park", "Bulwar"): odróżnia Most Gdański od Dworca Gdańskiego
}
const TYPE_WORDS = new Set(["park", "parku", "most", "mostu", "kladka", "kladki", "kladke", "bulwar", "bulwary", "bulwaru", "plac", "aleja", "ogrod", "skwer"]);
export function scoreName(query: string, candidateName: string): Scored {
  const want = distinctTokens(query);
  if (!want.length) return { score: 0, hasKey: false, typeWords: false };
  const have = tokens(candidateName).map((t) => t.n);
  const types = tokens(osmName(query)).filter((t) => TYPE_WORDS.has(t.n));
  const key = want.reduce((m, t) => (t.n.length > m.n.length ? t : m), want[0]);
  const hit = want.filter((w) => have.some((h) => tokMatch(w.n, h)));
  return { score: hit.length / want.length, hasKey: hit.includes(key), typeWords: types.every((t) => have.some((h) => tokMatch(t.n, h))) };
}

interface Cand {
  lat: number;
  lon: number;
  name: string;
  source: "ors" | "photon" | "osm";
  typeOk: boolean; // rodzaj obiektu zgadza się z oczekiwanym (park, most, ulica)
  genericOnly?: boolean;
}

/** Nazwa miejsca bez miasta i bez słów-ozdobników ("ulica", "ul."), do pokazania i do dopasowania. */
export function osmName(query: string): string {
  const first = query.split(",")[0].trim();
  return first.replace(/^(ulica|ul\.?|aleja|al\.?|plac|pl\.?)\s+/i, "").replace(/[^\p{L}\p{N} .'\-]/gu, "").trim();
}

const KIND_LAYERS: Record<string, string> = {
  street: "street,address,venue",
  address: "address,street",
  park: "venue,neighbourhood,street",
  bridge: "venue,street",
  area: "venue,neighbourhood,street",
  place: "venue,street,neighbourhood",
};

async function peliasCands(apiKey: string, query: string, kind: string, near: LatLon): Promise<Cand[]> {
  const qs = new URLSearchParams({
    api_key: apiKey,
    text: query,
    size: "8",
    layers: KIND_LAYERS[kind] ?? "venue,street,neighbourhood",
    "focus.point.lat": String(near.lat),
    "focus.point.lon": String(near.lon),
    "boundary.circle.lat": String(near.lat),
    "boundary.circle.lon": String(near.lon),
    "boundary.circle.radius": "40",
    "boundary.country": "PL",
  });
  const res = await fetch(`${ORS}/geocode/search?${qs}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const j: any = await res.json();
  return (j.features ?? [])
    .filter((f: any) => Array.isArray(f?.geometry?.coordinates))
    .map((f: any): Cand => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], name: String(f.properties?.name ?? f.properties?.label ?? ""), source: "ors", typeOk: true }));
}

async function photonCands(query: string, near: LatLon): Promise<Cand[]> {
  const qs = new URLSearchParams({ q: osmName(query), lat: String(near.lat), lon: String(near.lon), limit: "8" });
  const res = await fetch(`https://photon.komoot.io/api/?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const j: any = await res.json();
  return (j.features ?? [])
    .filter((f: any) => Array.isArray(f?.geometry?.coordinates))
    .map((f: any): Cand => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], name: String(f.properties?.name ?? f.properties?.street ?? ""), source: "photon", typeOk: true }));
}

const typeOk = (kind: string, t: Record<string, string>) =>
  kind === "park" ? ["park", "garden", "nature_reserve", "common", "recreation_ground"].includes(t.leisure) || t.landuse === "forest" || t.natural === "wood"
  : kind === "bridge" ? Boolean(t.bridge) || t.man_made === "bridge"
  : kind === "street" || kind === "address" ? Boolean(t.highway)
  : true;

/** Jedno zapytanie do Overpass dla wszystkich miejsc naraz (łagodniej dla darmowych serwerów niż osobne). */
async function osmCands(stops: { query: string; kind: string }[], near: LatLon): Promise<Cand[][]> {
  const clauses = stops.map((s) => {
    const key = distinctTokens(s.query).reduce<Tok | null>((m, t) => (!m || t.raw.length > m.raw.length ? t : m), null);
    if (!key || key.raw.length < 4) return "";
    const stem = (key.raw.length > 6 ? key.raw.slice(0, key.raw.length - 2) : key.raw).replace(/[.\\'^$*+?()[\]{}|-]/g, "\\$&");
    return `nwr["name"~"${stem}",i](around:25000,${near.lat},${near.lon});`;
  });
  if (!clauses.some(Boolean)) return stops.map(() => []);
  let json: any;
  try {
    json = (await queryOverpass(`[out:json][timeout:15];(${clauses.join("")});out center tags 300;`, 14000, 3000)).json;
  } catch {
    return stops.map(() => []);
  }
  const all: { lat: number; lon: number; tags: Record<string, string> }[] = (json.elements ?? [])
    .map((e: any) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, tags: e.tags ?? {} }))
    .filter((e: any) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  return stops.map((s) =>
    all.flatMap((e) => {
      const names = [e.tags.name, e.tags["name:pl"], e.tags.alt_name, e.tags.official_name, e.tags.old_name].filter(Boolean);
      return names.map((name): Cand => ({ lat: e.lat, lon: e.lon, name, source: "osm", typeOk: typeOk(s.kind, e.tags) }));
    }),
  );
}

/** Wybiera najlepszego kandydata: musi nazywać się podobnie do opisu, potem pasujący rodzaj, potem najbliższy startowi. */
export function pickCandidate(query: string, kind: string, cands: Cand[], near: LatLon, maxKm = 40): ResolvedPoint | null {
  const onlyGeneric = tokens(osmName(query)).every((t) => GENERIC.has(t.n)); // np. samo "kładka": wiemy tylko, jakiego rodzaju ma być miejsce
  const scored = cands
    .map((c) => {
      const sc = scoreName(query, c.name);
      const d = distM(near, c);
      return { c, sc, d };
    })
    .filter(({ sc, d }) => d <= maxKm * 1000 && (sc.score >= 0.6 || (sc.hasKey && sc.score > 0)))
    .sort((a, b) => b.sc.score - a.sc.score || Number(b.sc.typeWords) - Number(a.sc.typeWords) || Number(b.c.typeOk) - Number(a.c.typeOk) || Number(b.sc.hasKey) - Number(a.sc.hasKey) || a.d - b.d);
  const best = scored[0];
  if (!best) return null;
  return { name: osmName(query) || query, query, lat: best.c.lat, lon: best.c.lon, kind, confidence: best.sc.score >= 0.99 && best.d < 35000 && !onlyGeneric ? "high" : "low", found: best.c.name };
}

/** Rozpoznaje wszystkie miejsca z opisu; nie rozpoznane (albo tylko "zgadnięte") zostają null. */
export async function resolveStops(apiKey: string, stops: { query: string; kind: string }[], near: LatLon): Promise<(ResolvedPoint | null)[]> {
  const [osm, rest] = await Promise.all([
    osmCands(stops, near).catch(() => stops.map(() => [] as Cand[])),
    Promise.all(
      stops.map(async (s) => {
        const [p, f] = await Promise.allSettled([peliasCands(apiKey, s.query, s.kind, near), photonCands(s.query, near)]);
        return [...(p.status === "fulfilled" ? p.value : []), ...(f.status === "fulfilled" ? f.value : [])];
      }),
    ),
  ]);
  return stops.map((s, i) => pickCandidate(s.query, s.kind, [...osm[i], ...rest[i]], near));
}

async function areaLabel(apiKey: string, p: LatLon): Promise<string> {
  try {
    const res = await fetch(`${ORS}/geocode/reverse?${new URLSearchParams({ api_key: apiKey, "point.lat": String(p.lat), "point.lon": String(p.lon), size: "1" })}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "";
    const pr = ((await res.json()) as any).features?.[0]?.properties ?? {};
    return [pr.neighbourhood ?? pr.borough, pr.locality ?? pr.localadmin].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

// ---------------- 3. wydłużanie do zadanego dystansu ----------------

/** Punkty objazdu, który wydłuża odcinek A→B o `extraM` (w linii prostej): z boku, w ułamku `t` długości odcinka. */
export function detourPoints(a: LatLon, b: LatLon, extraM: number, t: number): { left: LatLon; right: LatLon; h: number } {
  const kx = 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const ky = 110540;
  const dx = (b.lon - a.lon) * kx;
  const dy = (b.lat - a.lat) * ky;
  const s = Math.hypot(dx, dy);
  // dodatkowa długość przez punkt oddalony o h: sqrt((t s)^2 + h^2) + sqrt(((1-t) s)^2 + h^2) - s
  const added = (h: number) => Math.hypot(t * s, h) + Math.hypot((1 - t) * s, h) - s;
  let lo = 0;
  let hi = 40000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (added(mid) < extraM) lo = mid;
    else hi = mid;
  }
  const h = (lo + hi) / 2;
  const nx = s > 1 ? -dy / s : 0;
  const ny = s > 1 ? dx / s : 1;
  const cx = a.lon * kx + dx * t;
  const cy = a.lat * ky + dy * t;
  const at = (sign: number): LatLon => ({ lon: (cx + sign * h * nx) / kx, lat: (cy + sign * h * ny) / ky });
  return { left: at(1), right: at(-1), h };
}

const straightLen = (pts: LatLon[]) => pts.slice(1).reduce((s, p, i) => s + distM(pts[i], p), 0);
const lenM = (m: Measured) => m.distance_km * 1000;

function overlapShare(a: [number, number][], b: [number, number][]) {
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

// ---------------- 4. całość ----------------

export interface TextRouteResult {
  points: ResolvedPoint[]; // start, miejsca, meta (w kolejności trasy)
  options: RouteOption[];
  parsed: ParsedRequest;
  warnings: string[];
}

export class TextRouteError extends Error {
  constructor(
    readonly code: "unclear" | "no_stops" | "not_found" | "route_failed",
    message: string,
  ) {
    super(message);
  }
}

export async function planTextRoute(env: { ORS_API_KEY: string } & Env, start: LatLon, text: string): Promise<TextRouteResult> {
  const key = env.ORS_API_KEY;
  const context = await areaLabel(key, start);
  const parsed = await parseRequest(env, text, context);
  if (parsed.question) throw new TextRouteError("unclear", parsed.question);
  if (!parsed.stops.length) {
    throw new TextRouteError("no_stops", "Nie znalazłem w opisie żadnych miejsc. Podaj przynajmniej jedno (ulicę, park, most) albo użyj „Zaproponuj trasy” dla zwykłej pętli.");
  }
  const warnings: string[] = parsed.unsupported.length ? [`Tego jeszcze nie uwzględniam: ${parsed.unsupported.join("; ")}.`] : [];

  const home = (name: string): ResolvedPoint => ({ name, query: name, lat: start.lat, lon: start.lon, kind: "start", confidence: "high", found: name });
  const wanted = [...(parsed.start ? [{ query: parsed.start, kind: "place" }] : []), ...(parsed.end ? [{ query: parsed.end, kind: "place" }] : []), ...parsed.stops];
  const found = await resolveStops(key, wanted, start);
  let at = 0;
  const startPt = parsed.start ? found[at++] : home("Start");
  const endPt = parsed.end ? found[at++] : null;
  const stopRes = found.slice(at);
  const stops = stopRes.filter((p): p is ResolvedPoint => Boolean(p));
  const missing = [...(parsed.start && !startPt ? [parsed.start] : []), ...(parsed.end && !endPt ? [parsed.end] : []), ...parsed.stops.filter((_, i) => !stopRes[i]).map((s) => osmName(s.query) || s.query)];
  if (!startPt || !stops.length) {
    throw new TextRouteError("not_found", `Nie znalazłem na mapie: ${missing.join("; ")}. Doprecyzuj (pełna nazwa, ulica, dzielnica) i spróbuj jeszcze raz.`);
  }
  // Miejsca, których nie udało się potwierdzić, pomijamy, ale głośno: lepsza trasa przez resztę niż przez "cokolwiek".
  if (missing.length) warnings.push(`Nie znalazłem na mapie: ${missing.join("; ")}. Trasa idzie bez tych punktów. Doprecyzuj nazwę (ulica, dzielnica), jeśli mają być uwzględnione.`);
  const finish = endPt ?? { ...startPt, name: startPt.name === "Start" ? "Meta (start)" : startPt.name };
  for (const p of [startPt, endPt, ...stops]) {
    if (p && p.confidence === "low") warnings.push(`„${p.name}” rozpoznałem niepewnie (znalazłem: ${p.found}). Sprawdź na mapie.`);
  }
  const ordered: ResolvedPoint[] = [startPt, ...stops, finish];
  const latlons: LatLon[] = ordered.map((p) => ({ lat: p.lat, lon: p.lon }));
  const protect = stops.map((p) => ({ lat: p.lat, lon: p.lon }));
  const prefs = { green: parsed.green, quiet: parsed.quiet, protect };
  const run = (pts: LatLon[]) => routeThrough(key, pts, prefs);

  let base: Measured;
  try {
    base = await run(latlons);
  } catch (e) {
    const m = String(e instanceof Error ? e.message : e);
    const idx = /coordinate (\d+)/.exec(m);
    const bad = idx ? ordered[Number(idx[1])] : null;
    throw new TextRouteError("route_failed", bad ? `Nie da się dobiec do punktu „${bad.name}” (brak drogi dla pieszych w pobliżu). Doprecyzuj albo pomiń go.` : `Nie udało się wyznaczyć trasy: ${m.slice(0, 160)}`);
  }

  const candidates: Measured[] = [base];
  if (parsed.targetKm && lenM(base) < 0.9 * parsed.targetKm * 1000) {
    // Za krótko: objazd w wybranym miejscu (domyślnie na najdłuższym odcinku).
    let seg = parsed.slackAfter !== null && parsed.slackAfter <= latlons.length - 2 ? parsed.slackAfter : 0;
    if (parsed.slackAfter === null) {
      let best = -1;
      latlons.slice(1).forEach((p, i) => {
        const d = distM(latlons[i], p);
        if (d > best) {
          best = d;
          seg = i;
        }
      });
    }
    const ratio = Math.min(1.6, Math.max(1.1, lenM(base) / Math.max(1, straightLen(latlons))));
    const extra = (parsed.targetKm * 1000 - lenM(base)) / ratio;
    const tries: { side: "left" | "right"; t: number }[] = [
      { side: "left", t: 0.35 },
      { side: "right", t: 0.35 },
      { side: "left", t: 0.65 },
      { side: "right", t: 0.65 },
    ];
    const withDetour = (e: number, side: "left" | "right", t: number) => {
      const d = detourPoints(latlons[seg], latlons[seg + 1], e, t);
      return [...latlons.slice(0, seg + 1), d[side], ...latlons.slice(seg + 1)];
    };
    const round1 = await Promise.allSettled(tries.map((x) => run(withDetour(extra, x.side, x.t))));
    const scored = round1.flatMap((r, i) => (r.status === "fulfilled" ? [{ m: r.value, ...tries[i] }] : []));
    // druga runda: dokorygowanie najlepszego kandydata o brakujące lub nadmiarowe metry
    scored.sort((a, b) => Math.abs(lenM(a.m) - parsed.targetKm! * 1000) - Math.abs(lenM(b.m) - parsed.targetKm! * 1000));
    for (const s of scored.slice(0, 2)) {
      const err = parsed.targetKm * 1000 - lenM(s.m);
      if (Math.abs(err) > 0.04 * parsed.targetKm * 1000) {
        const second = await run(withDetour(Math.max(50, extra + err / ratio), s.side, s.t)).catch(() => null);
        if (second) scored.push({ m: second, side: s.side, t: s.t });
      }
    }
    candidates.push(...scored.map((s) => s.m));
    if (!scored.length) warnings.push("Nie udało się dobrać objazdu do podanego dystansu, pokazuję trasę przez same wskazane miejsca.");
  }

  // Wybór: najbliższe zadanego dystansu (jeśli podano), z różnymi przebiegami.
  const target = parsed.targetKm ? parsed.targetKm * 1000 : null;
  const ranked = [...candidates].sort((a, b) => (target ? Math.abs(lenM(a) - target) - Math.abs(lenM(b) - target) : 0));
  const picked = [ranked[0]];
  const alt = ranked.slice(1).find((c) => overlapShare(c.coords, picked[0].coords) < 0.85 && (!target || Math.abs(lenM(c) - target) < 0.2 * target));
  if (alt) picked.push(alt);
  if (target && Math.abs(lenM(picked[0]) - target) > 0.1 * target) {
    warnings.push(`Wyszło ${picked[0].distance_km.toLocaleString("pl-PL")} km, a prosiłeś o ${parsed.targetKm!.toLocaleString("pl-PL")} km. Dodaj miejsce albo napisz, gdzie dołożyć dystans.`);
  }
  // Kontrola jakości: czy trasa naprawdę przechodzi przez wskazane miejsca i czy nie biegnie w dużej części tą samą drogą.
  const best = picked[0];
  for (const p of stops) {
    const near = best.coords.reduce((m, [lon, lat]) => Math.min(m, distM(p, { lat, lon })), Infinity);
    if (near > 300) warnings.push(`Trasa omija „${p.name}” (najbliżej ${Math.round(near / 10) * 10} m): nie ma tam drogi dla pieszych albo punkt został rozpoznany nie w tym miejscu.`);
  }
  if (best.retrace_pct > 35) warnings.push(`${best.retrace_pct}% trasy biegnie tą samą drogą dwa razy. Sprawdź kolejność miejsc i czy każde jest we właściwym miejscu na mapie.`);
  const via = stops.map((p) => p.name);
  const options: RouteOption[] = picked.map((m, i) => ({ label: String.fromCharCode(65 + i), ...m, source: "opis", via }));
  return { points: ordered, options, parsed, warnings };
}

/** Wejście z aplikacji i z narzędzia trenera: punkt startu z ustawień, zapis propozycji (mapa i GPX pod /trasa/...). */
export async function buildTextRoutes(env: Env, text: string, origin: string) {
  if (!env.ORS_API_KEY) return { error: "no_ors_key", message: "Trasy niedostępne: brak sekretu ORS_API_KEY (instrukcja w SETUP-TRENER.md)." } as const;
  if (!env.GEMINI_API_KEY) return { error: "no_gemini_key", message: "Opis trasy rozumie Gemini, a brakuje sekretu GEMINI_API_KEY." } as const;
  const loc = await currentLocation(env);
  if (!loc) return { error: "no_start", message: "Brak punktu startu: ustaw adres domowy na stronie /setup albo użyj „Użyj mojej lokalizacji”." } as const;
  let r: TextRouteResult;
  try {
    r = await planTextRoute(env as Env & { ORS_API_KEY: string }, loc.point, text);
  } catch (e) {
    if (e instanceof TextRouteError) return { error: e.code, message: e.message } as const;
    throw e;
  }
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const fromHome = loc.kind === "dom";
  const points = r.points.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, kind: p.kind, confidence: p.confidence }));
  const proposal: RouteProposal = {
    id,
    created: new Date().toISOString(),
    target_km: r.parsed.targetKm ?? r.options[0].distance_km,
    start: loc.point,
    start_label: fromHome ? "dom" : "udostępniona lokalizacja",
    options: r.options,
    points,
    request: text.slice(0, 800),
  };
  await coach(env).saveProposal(proposal);
  return {
    proposalId: id,
    start: proposal.start_label,
    note: null,
    warnings: r.warnings,
    points: r.points.map((p) => ({ name: p.name, found: p.found, kind: p.kind, confidence: p.confidence })),
    options: r.options.map((o) => ({
      label: o.label,
      km: o.distance_km,
      unpavedPct: o.unpaved_pct,
      pavedPct: o.paved_pct,
      greenAvg: o.green_avg,
      retracePct: o.retrace_pct,
      kind: "opis",
      via: o.via ?? null,
      mapUrl: `${origin}/trasa/${id}/${o.label}`,
      gpxUrl: `${origin}/trasa/${id}/${o.label}.gpx`,
    })),
  } as const;
}
