/**
 * Park data around the start: cached, fetched in the background, and never a reason for a route request to fail.
 *
 * The public Overpass servers are free but often slow or down. So the data is:
 *  - cached for 30 days (parks hardly change),
 *  - pre-fetched by the 15-minute cron (nobody is waiting there), for home or the shared location,
 *  - fetched on demand only with a short budget, and not at all for 30 minutes after a failure.
 * Without park data the routes fall back to OpenRouteService's own round trips.
 */

import { resolveLocation } from "./location";
import { type Anchor, anchorRadiusM, fetchAnchors } from "./parks";
import { coach } from "./telegram";

const TTL_MS = 30 * 86400_000;
const FAIL_COOLDOWN_MS = 30 * 60_000;

type Start = { lat: number; lon: number };
const keyOf = (s: Start, radius: number) => `anchors:${s.lat.toFixed(3)},${s.lon.toFixed(3)}:${radius}`;

export type LoadMode = "interactive" | "warm" | "force";

export async function loadAnchors(env: Env, start: Start, targetKm: number, mode: LoadMode = "interactive") {
  const radius = anchorRadiusM(targetKm);
  const key = keyOf(start, radius);
  const st = coach(env);

  const hit = await st.getCache(key, TTL_MS);
  if (hit) {
    const cached = JSON.parse(hit) as Anchor[];
    return { anchors: cached, info: `dane o parkach z pamięci (${cached.length} miejsc)` };
  }
  if (mode !== "force" && (await st.getCache(`fail:${key}`, FAIL_COOLDOWN_MS))) {
    return { anchors: [] as Anchor[], info: "dane o parkach chwilowo niedostępne (pobiorą się w tle), trasy z OpenRouteService" };
  }
  try {
    // Interactive: short budget, someone is waiting. Warm and force: patient.
    const opts = mode === "interactive" ? { timeoutMs: 12000, staggerMs: 3000 } : { timeoutMs: 25000, staggerMs: 5000 };
    const { anchors, info } = await fetchAnchors(start, radius, opts);
    await st.setCache(key, JSON.stringify(anchors));
    return { anchors, info: `pobrano dane o parkach: ${info}` };
  } catch (e) {
    await st.setCache(`fail:${key}`, "1");
    return { anchors: [] as Anchor[], info: `bez danych o parkach: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` };
  }
}

/** Called by the cron: makes sure the park data for the current start point is cached (one fetch per tick). */
export async function warmAnchors(env: Env) {
  if (!env.ORS_API_KEY) return; // park data is only used for routes
  const { home, last } = await coach(env).getRouteSettings();
  const loc = resolveLocation(home, last);
  if (!loc) return;
  for (const km of [5, 10]) {
    // radius tiers 2.5 km (runs up to ~7 km) and 4 km (up to ~12 km); longer runs fetch on demand
    const radius = anchorRadiusM(km);
    if (await coach(env).getCache(keyOf(loc.point, radius), TTL_MS)) continue;
    // A recent failure means the servers are struggling: wait an hour instead of trying the next tier.
    if (await coach(env).getCache(`fail:${keyOf(loc.point, radius)}`, 60 * 60_000)) return;
    await loadAnchors(env, loc.point, km, "warm");
    return;
  }
}
