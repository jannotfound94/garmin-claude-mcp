/**
 * Where Jan is, for weather and routes.
 *
 * The default is home. A location shared on Telegram (one tap on the 📍 button) overrides it:
 *  - near home (< 3 km): ignored, home is used (same place, home is more exact);
 *  - elsewhere in the same area (3-20 km): used for 12 hours;
 *  - far from home (>= 20 km, i.e. away): used for 48 hours (a hotel stay), then it expires.
 * Nothing is tracked: only the last shared point is stored, and /setup can delete it.
 */

import type { LatLon } from "./routes";

export const NEAR_HOME_KM = 3;
export const AWAY_KM = 20;
export const FRESH_H = 12;
export const AWAY_FRESH_H = 48;

export function distKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface ResolvedLocation {
  point: LatLon;
  kind: "dom" | "udostepniona";
  poza_domem: boolean; // the shared location is far from home (>= 20 km) and still valid
  od_domu_km: number | null; // distance of the shared location from home, if both are known
  udostepniona_godz_temu: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function resolveLocation(
  home: LatLon | null,
  last: (LatLon & { at: string }) | null,
  now: number = Date.now(),
): ResolvedLocation | null {
  const ageH = last ? (now - Date.parse(last.at)) / 3_600_000 : null;
  const dHome = last && home ? distKm(home, last) : null;

  if (last && ageH !== null && ageH >= 0) {
    const away = dHome !== null && dHome >= AWAY_KM;
    const valid = ageH <= (away ? AWAY_FRESH_H : FRESH_H);
    const nearHome = dHome !== null && dHome < NEAR_HOME_KM;
    if (valid && !nearHome) {
      return {
        point: { lat: last.lat, lon: last.lon },
        kind: "udostepniona",
        poza_domem: away,
        od_domu_km: dHome === null ? null : r1(dHome),
        udostepniona_godz_temu: r1(ageH),
      };
    }
  }
  if (home) {
    return {
      point: { lat: home.lat, lon: home.lon },
      kind: "dom",
      poza_domem: false,
      od_domu_km: dHome === null ? null : r1(dHome),
      udostepniona_godz_temu: ageH === null ? null : r1(ageH),
    };
  }
  return null;
}
