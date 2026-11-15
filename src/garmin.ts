/**
 * Garmin Connect, the same (unofficial) API the Garmin Connect web/mobile apps use.
 *
 * Login flow is the one used by the open-source `garth` library:
 *   SSO login (email + password [+ MFA code]) -> ticket -> OAuth1 token (valid ~1 year)
 *   -> OAuth2 access token (valid ~1 day, refreshed from OAuth1 automatically).
 * The password is used once and never stored. Only the tokens are kept (in the CoachState Durable Object).
 *
 * Garmin can change this flow at any time; if it breaks, intervals.icu keeps working.
 */

const SSO = "https://sso.garmin.com/sso";
const SSO_EMBED = `${SSO}/embed`;
const API = "https://connectapi.garmin.com";
const CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const UA_LOGIN = "com.garmin.android.apps.connectmobile";
const UA_API = "GCM-iOS-5.7.2.1";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface OAuth1Token {
  oauth_token: string;
  oauth_token_secret: string;
  mfa_token?: string;
}
export interface OAuth2Token {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch seconds
}
export interface GarminTokens {
  oauth1: OAuth1Token;
  oauth2: OAuth2Token;
  displayName?: string;
  connectedAt: string;
}
/** Saved between the password step and the MFA-code step. */
export interface GarminPendingMfa {
  cookies: Record<string, string>;
  csrf: string;
  createdAt: number;
}

// ---------------- small HTTP helpers ----------------

class Jar {
  constructor(public cookies: Record<string, string> = {}) {}
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  store(res: Response) {
    const list: string[] = (res.headers as any).getSetCookie?.() ?? [];
    for (const c of list) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  /** fetch with cookies, following redirects manually so cookies set on redirects are kept. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    let current = url;
    let opts: RequestInit = init;
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(current, {
        ...opts,
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA, ...(opts.headers ?? {}), Cookie: this.header() },
      });
      this.store(res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        opts = { method: "GET", headers: init.headers };
        continue;
      }
      return res;
    }
    throw new Error("Garmin: za dużo przekierowań");
  }
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmacSha1(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** OAuth 1.0a HMAC-SHA1 Authorization header. */
export async function oauth1Header(
  method: string,
  url: string,
  consumer: { key: string; secret: string },
  token?: { key: string; secret: string },
  formBody?: Record<string, string>,
): Promise<string> {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
  };
  if (token) oauth.oauth_token = token.key;
  const all: [string, string][] = [
    ...Object.entries(oauth),
    ...[...u.searchParams.entries()],
    ...Object.entries(formBody ?? {}),
  ];
  const paramStr = all
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(paramStr)].join("&");
  const signature = await hmacSha1(`${enc(consumer.secret)}&${enc(token?.secret ?? "")}`, base);
  oauth.oauth_signature = signature;
  return (
    "OAuth " +
    Object.entries(oauth)
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(", ")
  );
}

async function consumer(): Promise<{ key: string; secret: string }> {
  const res = await fetch(CONSUMER_URL);
  if (!res.ok) throw new Error(`Garmin: nie udało się pobrać klucza aplikacji (${res.status})`);
  const j: any = await res.json();
  return { key: j.consumer_key, secret: j.consumer_secret };
}

// ---------------- login ----------------

const SIGNIN_PARAMS = new URLSearchParams({
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: SSO_EMBED,
  service: SSO_EMBED,
  source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED,
  redirectAfterAccountCreationUrl: SSO_EMBED,
});

const csrfOf = (html: string) => /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1];
const titleOf = (html: string) => /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
const ticketOf = (html: string) => /embed\?ticket=([^"&]+)"/.exec(html)?.[1];

export type LoginResult = { status: "ok"; tokens: GarminTokens } | { status: "mfa"; pending: GarminPendingMfa };

export async function garminLogin(email: string, password: string): Promise<LoginResult> {
  const jar = new Jar();
  await jar.fetch(
    `${SSO}/embed?${new URLSearchParams({ id: "gauth-widget", embedWidget: "true", gauthHost: SSO })}`,
  );
  const signinUrl = `${SSO}/signin?${SIGNIN_PARAMS}`;
  const page = await (await jar.fetch(signinUrl, { headers: { Referer: `${SSO}/embed` } })).text();
  const csrf = csrfOf(page);
  if (!csrf) throw new Error(`Garmin: brak tokenu logowania na stronie (tytuł: "${titleOf(page)}"). Garmin mógł zablokować logowanie z serwera.`);

  const res = await jar.fetch(signinUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: signinUrl },
    body: new URLSearchParams({ username: email, password, embed: "true", _csrf: csrf }).toString(),
  });
  const html = await res.text();
  const title = titleOf(html);

  if (/MFA/i.test(title)) {
    const mfaCsrf = csrfOf(html);
    if (!mfaCsrf) throw new Error("Garmin prosi o kod weryfikacyjny, ale nie udało się odczytać formularza.");
    return { status: "mfa", pending: { cookies: jar.cookies, csrf: mfaCsrf, createdAt: Date.now() } };
  }
  if (title !== "Success") {
    if (/locked/i.test(html)) throw new Error("Garmin: konto tymczasowo zablokowane po nieudanych próbach logowania.");
    throw new Error(`Garmin: logowanie nieudane (tytuł strony: "${title || res.status}"). Sprawdź e-mail i hasło.`);
  }
  const ticket = ticketOf(html);
  if (!ticket) throw new Error("Garmin: logowanie przeszło, ale brak biletu (ticket).");
  return { status: "ok", tokens: await tokensFromTicket(ticket) };
}

export async function garminSubmitMfa(pending: GarminPendingMfa, code: string): Promise<GarminTokens> {
  const jar = new Jar(pending.cookies);
  const url = `${SSO}/verifyMFA/loginEnterMfaCode?${SIGNIN_PARAMS}`;
  const res = await jar.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${SSO}/signin?${SIGNIN_PARAMS}` },
    body: new URLSearchParams({ "mfa-code": code.trim(), embed: "true", _csrf: pending.csrf, fromPage: "setupEnterMfaCode" }).toString(),
  });
  const html = await res.text();
  if (titleOf(html) !== "Success") throw new Error(`Garmin: kod nieprawidłowy lub wygasł (tytuł: "${titleOf(html)}").`);
  const ticket = ticketOf(html);
  if (!ticket) throw new Error("Garmin: brak biletu po kodzie weryfikacyjnym.");
  return tokensFromTicket(ticket);
}

async function tokensFromTicket(ticket: string): Promise<GarminTokens> {
  const c = await consumer();
  const url = `${API}/oauth-service/oauth/preauthorized?${new URLSearchParams({
    ticket,
    "login-url": SSO_EMBED,
    "accepts-mfa-tokens": "true",
  })}`;
  const res = await fetch(url, { headers: { Authorization: await oauth1Header("GET", url, c), "User-Agent": UA_LOGIN } });
  if (!res.ok) throw new Error(`Garmin OAuth1 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const q = new URLSearchParams(await res.text());
  const oauth1: OAuth1Token = {
    oauth_token: q.get("oauth_token") ?? "",
    oauth_token_secret: q.get("oauth_token_secret") ?? "",
    ...(q.get("mfa_token") ? { mfa_token: q.get("mfa_token")! } : {}),
  };
  if (!oauth1.oauth_token) throw new Error("Garmin: pusty token OAuth1.");
  const oauth2 = await exchange(oauth1, c);
  return { oauth1, oauth2, connectedAt: new Date().toISOString() };
}

/** OAuth1 -> fresh OAuth2 access token. */
export async function exchange(oauth1: OAuth1Token, c?: { key: string; secret: string }): Promise<OAuth2Token> {
  c ??= await consumer();
  const url = `${API}/oauth-service/oauth/exchange/user/2.0`;
  const form: Record<string, string> = oauth1.mfa_token ? { mfa_token: oauth1.mfa_token } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: await oauth1Header("POST", url, c, { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret }, form),
      "User-Agent": UA_LOGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`Garmin OAuth2 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(j.expires_in ?? 3600),
  };
}

// ---------------- API client ----------------

export class GarminClient {
  constructor(
    private tokens: GarminTokens,
    private save: (t: GarminTokens) => Promise<void>,
  ) {}

  private async token(): Promise<string> {
    if (this.tokens.oauth2.expires_at - 120 < Date.now() / 1000) {
      this.tokens = { ...this.tokens, oauth2: await exchange(this.tokens.oauth1) };
      await this.save(this.tokens);
    }
    return this.tokens.oauth2.access_token;
  }

  async get(path: string): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${await this.token()}`, "User-Agent": UA_API, "DI-Backend": "connectapi.garmin.com" },
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Garmin ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  async displayName(): Promise<string> {
    if (!this.tokens.displayName) {
      const p = await this.get("/userprofile-service/socialProfile");
      this.tokens = { ...this.tokens, displayName: p.displayName };
      await this.save(this.tokens);
    }
    return this.tokens.displayName!;
  }

  /** Recovery picture for one day: training readiness, body battery, stress, sleep, HRV. */
  async daily(date: string) {
    const name = await this.displayName();
    const safe = (p: Promise<any>) => p.catch((e) => ({ error: String(e).slice(0, 160) }));
    const [readiness, battery, stress, sleep, hrv, summary] = await Promise.all([
      safe(this.get(`/metrics-service/metrics/trainingreadiness/${date}`)),
      safe(this.get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${date}&endDate=${date}`)),
      safe(this.get(`/wellness-service/wellness/dailyStress/${date}`)),
      safe(this.get(`/wellness-service/wellness/dailySleepData/${encodeURIComponent(name)}?date=${date}&nonSleepBufferMinutes=60`)),
      safe(this.get(`/hrv-service/hrv/${date}`)),
      safe(this.get(`/usersummary-service/usersummary/daily/${encodeURIComponent(name)}?calendarDate=${date}`)),
    ]);
    const r = Array.isArray(readiness) ? readiness[0] : readiness;
    const b = Array.isArray(battery) ? battery[0] : battery;
    const s = sleep?.dailySleepDTO;
    return clean({
      date,
      training_readiness: r?.score,
      training_readiness_level: r?.level,
      training_readiness_feedback: r?.feedbackShort,
      recovery_time_h: r?.recoveryTime != null ? Math.round(r.recoveryTime / 60) : undefined,
      body_battery_charged: b?.charged,
      body_battery_drained: b?.drained,
      body_battery_high: summary?.bodyBatteryHighestValue,
      body_battery_low: summary?.bodyBatteryLowestValue,
      body_battery_wake: summary?.bodyBatteryAtWakeTime,
      stress_avg: stress?.avgStressLevel ?? summary?.averageStressLevel,
      stress_max: stress?.maxStressLevel ?? summary?.maxStressLevel,
      sleep_h: s?.sleepTimeSeconds ? Math.round(s.sleepTimeSeconds / 360) / 10 : undefined,
      sleep_score: s?.sleepScores?.overall?.value,
      sleep_deep_min: s?.deepSleepSeconds != null ? Math.round(s.deepSleepSeconds / 60) : undefined,
      sleep_rem_min: s?.remSleepSeconds != null ? Math.round(s.remSleepSeconds / 60) : undefined,
      sleep_awake_min: s?.awakeSleepSeconds != null ? Math.round(s.awakeSleepSeconds / 60) : undefined,
      hrv_last_night: hrv?.hrvSummary?.lastNightAvg,
      hrv_weekly_avg: hrv?.hrvSummary?.weeklyAvg,
      hrv_status: hrv?.hrvSummary?.status,
      resting_hr: summary?.restingHeartRate,
      steps: summary?.totalSteps,
      errors: [readiness, battery, stress, sleep, hrv, summary].filter((x) => x?.error).map((x) => x.error),
    });
  }

  /** Fitness picture: VO2max, training status, race predictions (incl. marathon). */
  async fitness(date: string) {
    const name = await this.displayName();
    const safe = (p: Promise<any>) => p.catch((e) => ({ error: String(e).slice(0, 160) }));
    const [maxmet, status, race] = await Promise.all([
      safe(this.get(`/metrics-service/metrics/maxmet/daily/${date}/${date}`)),
      safe(this.get(`/metrics-service/metrics/trainingstatus/aggregated/${date}`)),
      safe(this.get(`/metrics-service/metrics/racepredictions/latest/${encodeURIComponent(name)}`)),
    ]);
    const vo2 = Array.isArray(maxmet) ? maxmet[0]?.generic : maxmet?.generic;
    const ts = status?.mostRecentTrainingStatus?.latestTrainingStatusData;
    const tsFirst = ts ? (Object.values(ts)[0] as any) : undefined;
    const hms = (s?: number) =>
      s ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : undefined;
    return clean({
      date,
      vo2max: vo2?.vo2MaxPreciseValue ?? vo2?.vo2MaxValue,
      fitness_age: vo2?.fitnessAge,
      training_status: tsFirst?.trainingStatusFeedbackPhrase ?? tsFirst?.trainingStatus,
      acute_load: tsFirst?.acuteTrainingLoadDTO?.dailyTrainingLoadAcute,
      race_prediction_5k: hms(race?.time5K),
      race_prediction_10k: hms(race?.time10K),
      race_prediction_half: hms(race?.timeHalfMarathon),
      race_prediction_marathon: hms(race?.timeMarathon),
      errors: [maxmet, status, race].filter((x) => x?.error).map((x) => x.error),
    });
  }
}

function clean(o: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)),
  );
}
