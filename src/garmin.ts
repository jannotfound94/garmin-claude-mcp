/**
 * Garmin Connect Personal API (official, https://developer.garmin.com/gc-developer-program/personal/personal-api/).
 *
 * The athlete creates a Personal API key in Garmin Connect Web (valid 1 year) and stores it as the
 * GARMIN_PERSONAL_API_KEY secret. The key is exchanged for a short-lived bearer token (JWT), which is
 * cached in the CoachState Durable Object and refreshed when less than an hour remains.
 * Endpoints and auth follow Garmin's own client: github.com/garmin/connect-personal-api-python.
 */

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const REFRESH_WINDOW_S = 3600;

export interface GarminToken {
  access_token: string;
  expires_at: number; // epoch seconds
}

function jwtExp(token: string): number {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
    return Number(json.exp);
  } catch {
    throw new Error("Garmin: odpowiedź z tokenem nie jest poprawnym JWT.");
  }
}

export async function obtainToken(apiKey: string): Promise<GarminToken> {
  const res = await fetch(`${BASE}${TOKEN_PATH}`, {
    method: "POST",
    headers: { Accept: "*/*", Authorization: `ApiKey ${apiKey.trim()}` },
  });
  const body = (await res.text()).trim();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " Klucz jest nieprawidłowy, wygasł albo został skasowany." : "";
    throw new Error(`Garmin: nie udało się uzyskać tokenu (${res.status}).${hint} ${body.slice(0, 200)}`);
  }
  return { access_token: body, expires_at: jwtExp(body) };
}

/**
 * Keeps scalar fields and short lists; drops nulls and long time series (e.g. per-minute stress or
 * body-battery samples) so responses stay small enough for the coach.
 */
export function prune(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    if (v.length > 14 || depth > 4) return undefined;
    const out = v.map((x) => prune(x, depth + 1)).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof v === "object") {
    if (depth > 5) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x, depth + 1);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v === "string" && v.length > 300) return v.slice(0, 300) + "…";
  return v;
}

export class GarminPersonal {
  constructor(
    private apiKey: string,
    private loadToken: () => Promise<GarminToken | null>,
    private saveToken: (t: GarminToken) => Promise<void>,
  ) {}

  private async token(force = false): Promise<string> {
    const cached = force ? null : await this.loadToken();
    if (cached && cached.expires_at - Date.now() / 1000 > REFRESH_WINDOW_S) return cached.access_token;
    const t = await obtainToken(this.apiKey);
    await this.saveToken(t);
    return t.access_token;
  }

  async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = `${BASE}${path}${params ? `?${new URLSearchParams(params)}` : ""}`;
    let res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401) {
      res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${await this.token(true)}` } });
    }
    if (!res.ok) throw new Error(`Garmin ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  /** Sleep, HRV, stress, Body Battery and daily summary for an inclusive date range. */
  async recovery(start: string, end: string) {
    const safe = (p: Promise<unknown>) => p.then(prune).catch((e) => ({ error: String(e).slice(0, 200) }));
    const [sleep, hrv, stress, bodyBattery, daily] = await Promise.all([
      safe(this.get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: start, endDate: end })),
      safe(this.get(`/hrv-service/hrv/daily/${start}/${end}`)),
      safe(this.get(`/usersummary-service/stats/stress/daily/${start}/${end}`)),
      safe(this.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: start, endDate: end })),
      safe(this.get("/usersummary-service/v2/dailysummaries", { startDate: start, endDate: end })),
    ]);
    return { okres: `${start}..${end}`, sen: sleep, hrv, stres: stress, body_battery: bodyBattery, podsumowanie_dnia: daily };
  }

  /** VO2max over the last weeks and fitness age. */
  async fitness(start: string, end: string) {
    const safe = (p: Promise<unknown>) => p.then(prune).catch((e) => ({ error: String(e).slice(0, 200) }));
    const [vo2max, fitnessAge] = await Promise.all([
      safe(this.get(`/metrics-service/metrics/maxmet/daily/${start}/${end}`, { sport: "RUNNING" })),
      safe(this.get(`/fitnessage-service/fitnessage/v2/${end}`)),
    ]);
    return { okres: `${start}..${end}`, vo2max, wiek_sprawnosci: fitnessAge };
  }
}

/** Caps a JSON payload so one tool result cannot flood the coach's context. */
export function capJson(data: unknown, max = 12000): string {
  const s = JSON.stringify(data);
  return s.length > max ? `${s.slice(0, max)}… [obcięto ${s.length - max} znaków]` : s;
}
