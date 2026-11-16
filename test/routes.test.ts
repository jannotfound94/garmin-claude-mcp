import { test } from "node:test";
import assert from "node:assert/strict";
import { compactness, mapPage, proposeLoops, routeLengthM, tidyRoute } from "../src/routes";
import { TextRouteError, detourPoints, distM, osmName, planTextRoute, sanitizeParsed } from "../src/textroute";
import vm from "node:vm";

const LAT = 52.2;
const KX = 111320 * Math.cos((LAT * Math.PI) / 180);
const ll = ([x, y]: number[]): [number, number] => [21 + x / KX, LAT + y / 110540];
const path = (pts: number[][]) => pts.map(ll);

// Kwadrat 1 km x 1 km zaczynający się w (0,0), zgodnie z ruchem wskazówek zegara.
const square = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];

test("czysta pętla nie jest zmieniana", () => {
  const c = path(square);
  const t = tidyRoute(c);
  assert.equal(t.trimmedM, 0);
  assert.equal(t.coords, c);
  assert.ok(Math.abs(t.lengthM - 4000) < 5);
});

test("zbędna odnoga i pętla wokół budynku są wycinane, reszta trasy zostaje", () => {
  const withDetours = [
    [0, 0],
    [500, 0], [500, 80], [500, 0], // odnoga 80 m tam i z powrotem (160 m)
    [1000, 0],
    [1000, 500], [1100, 500], [1100, 600], [1000, 600], [1000, 500], // okrążenie budynku (400 m) wracające w to samo miejsce
    [1000, 1000], [0, 1000], [0, 0],
  ];
  const before = routeLengthM(path(withDetours));
  assert.ok(Math.abs(before - 4560) < 5);
  const t = tidyRoute(path(withDetours));
  assert.ok(Math.abs(t.trimmedM - 560) < 40, `wycięto ${t.trimmedM} m`);
  assert.ok(Math.abs(t.lengthM - 4000) < 40, `długość ${t.lengthM}`);
  assert.ok(Math.abs(routeLengthM(t.coords) - t.lengthM) < 30, "geometria zgadza się z podaną długością");
  // trasa nadal zaczyna i kończy się w domu i przechodzi przez rogi kwadratu
  assert.deepEqual(t.coords[0], ll([0, 0]));
  assert.deepEqual(t.coords[t.coords.length - 1], ll([0, 0]));
  for (const corner of [[1000, 0], [1000, 1000], [0, 1000]]) {
    const [cx, cy] = ll(corner);
    assert.ok(t.coords.some(([x, y]) => Math.abs(x - cx) < 1e-5 && Math.abs(y - cy) < 1e-5), `brak rogu ${corner}`);
  }
  // kształt jest już zwartą pętlą
  assert.ok(compactness(t.coords) > 0.7);
  assert.ok(compactness(path(withDetours)) < compactness(t.coords));
});

test("dwa przejścia obok siebie daleko od siebie (wyjście i powrót do domu) nie są wycinane", () => {
  // 600 m ulicą tam i z powrotem to jedna odnoga 1,2 km: odległość wzdłuż trasy > 600 m, więc zostaje
  const t = tidyRoute(path([[0, 0], [600, 0], [600, 600], [0, 600], [0, 20], [0, 0]]));
  assert.equal(t.trimmedM, 0);
});

test("gdy do wycięcia byłoby ponad 25% trasy, trasa zostaje bez zmian", () => {
  // kwadrat 250 m (1 km) z pętelką 400 m: 400/1400 to prawie 29%
  const lasso = path([[0, 0], [250, 0], [250, 100], [350, 100], [350, 200], [250, 200], [250, 100], [250, 250], [0, 250], [0, 0]]);
  const t = tidyRoute(lasso);
  assert.equal(t.trimmedM, 0);
  assert.equal(t.coords, lasso);
});

test("zwartość: koło ~1, kwadrat ~0,79, tam i z powrotem ~0", () => {
  const circle = Array.from({ length: 73 }, (_, i) => ll([500 * Math.cos((i * Math.PI) / 36), 500 * Math.sin((i * Math.PI) / 36)]));
  assert.ok(compactness(circle) > 0.97);
  assert.ok(Math.abs(compactness(path(square)) - Math.PI / 4) < 0.02);
  assert.ok(compactness(path([[0, 0], [1000, 0], [0, 0]])) < 0.01);
});

test("proposeLoops: odnogi i pętelki z trasy ORS są wycinane, a długość liczona po wycięciu", async () => {
  const detoured = path([[0, 0], [500, 0], [500, 80], [500, 0], [1000, 0], [1000, 500], [1100, 500], [1100, 600], [1000, 600], [1000, 500], [1000, 1000], [0, 1000], [0, 0]]);
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: detoured }, properties: { summary: { distance: 4560 }, extras: {} } }] }));
  }) as any;
  try {
    const out = await proposeLoops("k", { lat: LAT, lon: 21 }, 4, []);
    assert.ok(calls > 0);
    assert.ok(out.length >= 1);
    for (const o of out) {
      assert.ok(Math.abs(o.distance_km - 4.0) < 0.1, `dystans ${o.distance_km}`);
      assert.ok(o.trimmed_m && o.trimmed_m > 400, "zapisano, ile wycięto");
      assert.ok((o.compact ?? 0) > 0.7);
      assert.equal(o.retrace_pct, 0);
    }
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------- trasa z opisu ----------------

const HOME = { lat: 52.27, lon: 20.98 };
const PLACES: Record<string, { lat: number; lon: number; label?: string; conf?: number }> = {
  "Fort Sokolnickiego": { lat: 52.268, lon: 20.97 },
  "Plaża Żoliborz": { lat: 52.275, lon: 20.99 },
  Kaniowa: { lat: 52.28, lon: 20.985, label: "Kaniowa, Warszawa", conf: 0.95 },
  "Park Cytadela": { lat: 52.2655, lon: 20.9985 },
  "Most Gdański": { lat: 52.265, lon: 21.015 },
  "Kładka": { lat: 52.28, lon: 21.01, conf: 0.3 },
};

/** Podstawia wszystkie usługi zewnętrzne; zapisuje, o co pytano ORS (kolejność punktów w żądaniach trasy). */
function stubWorld(parsed: unknown, opts: { missing?: string[] } = {}) {
  const real = globalThis.fetch;
  const routeCalls: number[][][] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(parsed) }] } }] }));
    }
    if (u.includes("/geocode/reverse")) return new Response(JSON.stringify({ features: [{ properties: { neighbourhood: "Żoliborz", locality: "Warszawa" } }] }));
    if (u.includes("/geocode/search")) {
      const text = new URL(u).searchParams.get("text")!;
      const key = Object.keys(PLACES).find((k) => text.includes(k));
      if (!key || opts.missing?.some((m) => text.includes(m))) return new Response(JSON.stringify({ features: [] }));
      const pl = PLACES[key];
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [pl.lon, pl.lat] }, properties: { label: pl.label ?? key, confidence: pl.conf ?? 0.9 } }] }));
    }
    if (u.includes("overpass")) {
      const q = decodeURIComponent(String(init?.body));
      const key = Object.keys(PLACES).find((k) => q.includes(`"name"~"${osmName(k)}"`));
      if (!key || opts.missing?.some((m) => q.includes(m)) || PLACES[key].conf !== undefined) return new Response(JSON.stringify({ elements: [] }));
      return new Response(JSON.stringify({ elements: [{ type: "node", lat: PLACES[key].lat, lon: PLACES[key].lon, tags: { name: key } }] }));
    }
    if (u.includes("/v2/directions/")) {
      const coords: number[][] = JSON.parse(init.body).coordinates;
      routeCalls.push(coords);
      const line: number[][] = [];
      for (let i = 1; i < coords.length; i++) {
        const [x0, y0] = coords[i - 1];
        const [x1, y1] = coords[i];
        const n = Math.max(1, Math.ceil(distM({ lat: y0, lon: x0 }, { lat: y1, lon: x1 }) / 150));
        for (let k = 0; k < n; k++) line.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
      }
      line.push(coords[coords.length - 1]);
      const len = line.slice(1).reduce((a, p, i) => a + distM({ lat: line[i][1], lon: line[i][0] }, { lat: p[1], lon: p[0] }), 0);
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: line }, properties: { summary: { distance: len }, extras: {} } }] }));
    }
    throw new Error(`nieoczekiwane zapytanie ${u}`);
  }) as any;
  return { routeCalls, restore: () => (globalThis.fetch = real) };
}
const env: any = { ORS_API_KEY: "o", GEMINI_API_KEY: "g" };
const parsedDetailed = {
  stops: [
    { query: "Fort Sokolnickiego, Żoliborz, Warszawa", kind: "place" },
    { query: "Plaża Żoliborz, Warszawa", kind: "area" },
    { query: "ulica Kaniowa, Żoliborz, Warszawa", kind: "street" },
    { query: "Park Cytadela, Warszawa", kind: "park" },
  ],
  green: true, quiet: true, unsupported: [],
};

test("trasa z opisu: punkty w podanej kolejności, start i meta w domu, przejście przez wszystkie miejsca", async () => {
  const w = stubWorld(parsedDetailed);
  try {
    const r = await planTextRoute(env, HOME, "z domu przez Fort Sokolnickiego, plażę Żoliborz, Kaniową i park przy Cytadeli do domu");
    assert.deepEqual(r.points.map((p) => p.name), ["Start", "Fort Sokolnickiego", "Plaża Żoliborz", "Kaniowa", "Park Cytadela", "Meta (start)"]);
    assert.equal(r.points[0].lat, HOME.lat);
    const first = w.routeCalls[0];
    assert.equal(first.length, 6, "start + 4 miejsca + meta");
    assert.deepEqual(first[0], [HOME.lon, HOME.lat]);
    assert.deepEqual(first[5], [HOME.lon, HOME.lat]);
    assert.deepEqual(first[3], [PLACES.Kaniowa.lon, PLACES.Kaniowa.lat], "kolejność jak w opisie");
    assert.ok(r.options.length >= 1);
    assert.equal(r.options[0].source, "opis");
    assert.deepEqual(r.options[0].via, ["Fort Sokolnickiego", "Plaża Żoliborz", "Kaniowa", "Park Cytadela"]);
    assert.ok(r.options[0].distance_km > 3 && r.options[0].distance_km < 12);
    assert.deepEqual(r.warnings, []);
  } finally {
    w.restore();
  }
});

test("trasa z opisu: luźny opis z dystansem jest wydłużany objazdem po wskazanej stronie do zadanej długości", async () => {
  const w = stubWorld({ target_km: 10, stops: [{ query: "Most Gdański, Warszawa", kind: "bridge" }, { query: "Kładka, Warszawa", kind: "bridge" }], slack_after: 0, green: true, quiet: true, unsupported: [] });
  try {
    const r = await planTextRoute(env, HOME, "10 km, najpierw po tej stronie Wisły, Gdańskim na drugą, powrót kładką");
    const base = w.routeCalls[0];
    assert.equal(base.length, 4, "bez objazdu: start, most, kładka, meta");
    assert.ok(w.routeCalls.length > 1, "próby z objazdem");
    assert.ok(w.routeCalls.slice(1).every((c) => c.length === 5 && c[2][0] === base[1][0]), "objazd wstawiony przed pierwszym miejscem (slack_after 0)");
    const km = r.options[0].distance_km;
    assert.ok(Math.abs(km - 10) <= 1, `wyszło ${km} km`);
    assert.ok(r.points.some((p) => p.confidence === "low"), "kładka rozpoznana niepewnie");
    assert.ok(r.warnings.some((x) => x.includes("Kładka")));
    assert.ok(r.options.length <= 2);
  } finally {
    w.restore();
  }
});

test("trasa z opisu: nieznane miejsce, pytanie modelu i brak miejsc dają zrozumiałe błędy", async () => {
  let w = stubWorld(parsedDetailed, { missing: ["Kaniowa"] });
  try {
    await assert.rejects(planTextRoute(env, HOME, "x".repeat(20)), (e: any) => e instanceof TextRouteError && e.code === "not_found" && /Kaniowa/.test(e.message));
  } finally {
    w.restore();
  }
  w = stubWorld({ question: "Gdzie chcesz biec?", stops: [], green: true, quiet: true, unsupported: [] });
  try {
    await assert.rejects(planTextRoute(env, HOME, "biegnę"), (e: any) => e.code === "unclear" && /Gdzie/.test(e.message));
  } finally {
    w.restore();
  }
  w = stubWorld({ target_km: 8, stops: [], green: true, quiet: true, unsupported: ["bez wzniesień"] });
  try {
    await assert.rejects(planTextRoute(env, HOME, "osiem kilometrów bez górek"), (e: any) => e.code === "no_stops");
  } finally {
    w.restore();
  }
});

test("sanitizeParsed: ogranicza liczbę miejsc, odrzuca śmieci, dystans poza zakresem", () => {
  const p = sanitizeParsed({ stops: Array.from({ length: 12 }, (_, i) => ({ query: `Miejsce ${i}`, kind: i === 0 ? "wymyslone" : "park" })).concat([{ query: " ", kind: "park" }]), target_km: 500, slack_after: -1, green: false, unsupported: ["a", 5] });
  assert.equal(p.stops.length, 8);
  assert.equal(p.stops[0].kind, "place");
  assert.equal(p.targetKm, null);
  assert.equal(p.slackAfter, null);
  assert.equal(p.green, false);
  assert.equal(p.quiet, true);
  assert.deepEqual(p.unsupported, ["a"]);
});

test("detourPoints: objazd dodaje żądaną długość, po obu stronach odcinka", () => {
  const a = { lat: 52.27, lon: 20.98 };
  const b = { lat: 52.27, lon: 21.02 };
  for (const t of [0.3, 0.5, 0.7]) {
    const d = detourPoints(a, b, 3000, t);
    for (const p of [d.left, d.right]) {
      const added = distM(a, p) + distM(p, b) - distM(a, b);
      assert.ok(Math.abs(added - 3000) < 40, `t=${t}: dodano ${added}`);
    }
    assert.ok(d.left.lat > a.lat && d.right.lat < a.lat, "po przeciwnych stronach odcinka");
  }
  // odcinek zerowej długości (start = pierwsze miejsce): objazd nadal wychodzi
  const z = detourPoints(a, a, 2000, 0.5);
  assert.ok(Math.abs(distM(a, z.left) * 2 - 2000) < 40);
});

test("osmName odcina miasto i słowa ozdobne", () => {
  assert.equal(osmName("ulica Kaniowa, Żoliborz, Warszawa"), "Kaniowa");
  assert.equal(osmName("Most Gdański, Warszawa"), "Most Gdański");
  assert.equal(osmName("ul. Gen. Zajączka"), "Gen. Zajączka");
});

test("czyszczenie trasy nie wycina odnogi, w której leży miejsce wskazane przez Jana", () => {
  // dojście 120 m do punktu i z powrotem: bez ochrony to odnoga do wycięcia
  const c = path([[0, 0], [500, 0], [500, 120], [500, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]);
  assert.ok(tidyRoute(c).trimmedM > 200, "bez ochrony odnoga jest wycinana");
  const tip = ll([500, 120]);
  const t = tidyRoute(c, [tip]);
  assert.equal(t.trimmedM, 0, "z ochroną zostaje");
  assert.equal(t.coords, c);
});

test("mapa trasy z punktami: skrypt się kompiluje, nazwy nie wychodzą ze skryptu", () => {
  const html = mapPage("Trasa A · 8,0 km", [[21, 52], [21.01, 52.01]], "/trasa/x/A.gpx", "szczegóły", [{ name: "Dziwny </script><b>\"punkt'", lat: 52, lon: 21 }, { name: "Drugi", lat: 52.01, lon: 21.01, confidence: "low" }]);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, "nazwa z </script> nie zamyka skryptu");
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});
