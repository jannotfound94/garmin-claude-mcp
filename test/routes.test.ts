import { test } from "node:test";
import assert from "node:assert/strict";
import { compactness, proposeLoops, routeLengthM, tidyRoute } from "../src/routes";

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
