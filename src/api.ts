/**
 * JSON API aplikacji (PWA / APK). Jeden użytkownik, jedno hasło (MCP_PASSWORD): logowanie zwraca podpisany token (HMAC),
 * który aplikacja trzyma w urządzeniu. Cała logika (cele, rozpoznawanie posiłków, trener) jest ta sama co w Telegramie.
 */
import { applyCorrection, buildAndSaveMeal, dayOverview, saveFavoriteMeal, slotNamesFor } from "./diet";
import { b64urlDecode, hmacHex as hmac, safeEqual } from "./crypto";
import { currentLocation } from "./loc";
import { pushToAll, verifyReminderToken } from "./notify";
import { GeminiTransientError, analyzeMeal } from "./gemini";
import {
  type NutritionConfig,
  dateOfMealId,
  goalProgress,
  type NotifyChannel,
  isMealKind,
  hhmmToMin,
  parseSlots,
  sumMacros,
  validHhmm,
} from "./nutrition";
import { buildPlan, buildRoutes, buildSummary, buildWeek } from "./summary";
import { coach } from "./telegram";
import { daysBetween, warsaw, warsawToUtc } from "./time";

const TOKEN_DAYS = 30;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Adresy usług push przeglądarek (Chrome/FCM, Firefox, Safari, Edge/WNS). Serwer nie wysyła powiadomień gdziekolwiek indziej. */
const PUSH_ENDPOINT = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const API_RUN = { budgetMs: 55_000, attemptCapMs: 25_000 }; // żądanie HTTP nie ma 30-sekundowego limitu pracy w tle

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status: number, error: string, message: string, headers: Record<string, string> = {}) => json({ error, message }, status, headers);

// ---------------- token ----------------

/** Token "wygaśnięcie.podpis". Zmiana MCP_PASSWORD unieważnia wszystkie wydane tokeny. */
export async function issueToken(env: Env, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + TOKEN_DAYS * 86400;
  return `${exp}.${await hmac(env.MCP_PASSWORD, `app-token:${exp}`)}`;
}

export async function verifyToken(env: Env, token: string, nowMs = Date.now()): Promise<boolean> {
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[1]) < nowMs / 1000) return false;
  return safeEqual(m[2], await hmac(env.MCP_PASSWORD, `app-token:${m[1]}`));
}

// ---------------- pomocnicze ----------------

async function readJson(request: Request): Promise<any> {
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Za duży plik (max 8 MB).");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Za duży plik (max 8 MB).");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Niepoprawny JSON.");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    msg: string,
  ) {
    super(msg);
  }
}

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/** Unix (s) dla posiłku: teraz albo podana data/godzina (czas polski), bez przyszłości i nie starszy niż 14 dni. */
function mealUnix(body: any): number {
  const nowLocal = warsaw();
  const date = body.date ?? nowLocal.date;
  const time = body.time ?? nowLocal.time;
  if (!isDate(date) || typeof time !== "string" || !validHhmm(time)) throw new HttpError(400, "bad_time", "Zła data lub godzina posiłku.");
  if (daysBetween(date, nowLocal.date) < 0 || daysBetween(date, nowLocal.date) > 14) throw new HttpError(400, "bad_time", "Posiłek można dodać najwyżej 14 dni wstecz i nie w przyszłości.");
  if (date === nowLocal.date && hhmmToMin(time) > hhmmToMin(nowLocal.time) + 5) throw new HttpError(400, "bad_time", "Ta godzina jeszcze nie minęła.");
  return Math.floor(warsawToUtc(`${date} ${time}`).getTime() / 1000);
}

function mapGeminiError(e: unknown): never {
  if (e instanceof GeminiTransientError) throw new HttpError(503, "gemini_busy", "Gemini jest chwilowo przeciążony. Spróbuj za moment.");
  if (e instanceof Error && /GEMINI_API_KEY/.test(e.message)) throw new HttpError(501, "gemini_not_configured", "Rozpoznawanie posiłków nie jest skonfigurowane (brak GEMINI_API_KEY).");
  throw new HttpError(502, "analysis_failed", `Nie udało się rozpoznać posiłku: ${String(e instanceof Error ? e.message : e).replace(/key=[^&\s]+/g, "key=…").slice(0, 200)}`);
}

// ---------------- ustawienia ----------------

function settingsView(cfg: NutritionConfig) {
  const fmt = (l: { name: string; time: string }[]) => l.map((s) => `${s.name} ${s.time}`).join("; ");
  return {
    deficitKcal: cfg.deficitKcal,
    proteinPerKg: cfg.proteinPerKg,
    fatPerKg: cfg.fatPerKg,
    garminFactor: cfg.garminFactor,
    goalWeightKg: cfg.goalWeightKg,
    goalDate: cfg.goalDate,
    macroWeightKg: cfg.macroWeightKg,
    remindersOn: cfg.remindersOn,
    remindAfterMin: cfg.remindAfterMin,
    notifyChannel: cfg.notifyChannel,
    slotsText: fmt(cfg.slots),
    weekendSlotsText: fmt(cfg.weekendSlots),
  };
}

function validateSettings(b: any, today: string): Partial<NutritionConfig> {
  const patch: Partial<NutritionConfig> = {};
  const num = (k: string, lo: number, hi: number, label: string): number => {
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, "bad_value", `${label}: ${lo}–${hi}.`);
    return v;
  };
  if ("deficitKcal" in b) patch.deficitKcal = Math.round(num("deficitKcal", 0, 800, "Deficyt (kcal)"));
  if ("proteinPerKg" in b) patch.proteinPerKg = num("proteinPerKg", 1.2, 2.5, "Białko (g/kg)");
  if ("fatPerKg" in b) patch.fatPerKg = num("fatPerKg", 0.6, 1.5, "Tłuszcz (g/kg)");
  if ("garminFactor" in b) patch.garminFactor = num("garminFactor", 0.7, 1.1, "Korekta Garmina");
  if ("remindAfterMin" in b) patch.remindAfterMin = Math.round(num("remindAfterMin", 30, 360, "Przypomnienie (min)"));
  if ("goalWeightKg" in b) patch.goalWeightKg = b.goalWeightKg === null ? null : Math.round(num("goalWeightKg", 40, 200, "Waga docelowa") * 10) / 10;
  if ("macroWeightKg" in b) patch.macroWeightKg = b.macroWeightKg === null ? null : Math.round(num("macroWeightKg", 40, 200, "Masa referencyjna") * 10) / 10;
  if ("goalDate" in b) {
    if (b.goalDate === null) patch.goalDate = null;
    else if (isDate(b.goalDate) && daysBetween(today, b.goalDate) > 0) patch.goalDate = b.goalDate;
    else throw new HttpError(400, "bad_value", "Termin celu: data w przyszłości (RRRR-MM-DD).");
  }
  if ("remindersOn" in b) patch.remindersOn = Boolean(b.remindersOn);
  if ("notifyChannel" in b) {
    if (!["app", "telegram", "both"].includes(b.notifyChannel)) throw new HttpError(400, "bad_value", "Kanał powiadomień: aplikacja, Telegram albo oba.");
    patch.notifyChannel = b.notifyChannel as NotifyChannel;
  }
  for (const [key, field] of [["slotsText", "slots"], ["weekendSlotsText", "weekendSlots"]] as const) {
    if (!(key in b)) continue;
    const text = String(b[key] ?? "").trim();
    if (!text) patch[field] = [];
    else {
      const parsed = parseSlots(text);
      if ("error" in parsed) throw new HttpError(400, "bad_value", parsed.error);
      patch[field] = parsed.slots;
    }
  }
  return patch;
}

// ---------------- router ----------------

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const st = coach(env);
  try {
    if (path === "/api/login" && method === "POST") {
      const status = await st.authStatus();
      if (!status.allowed) return fail(429, "locked", `Za dużo prób. Spróbuj za ${Math.ceil(status.retryAfterS / 60)} min.`, { "retry-after": String(status.retryAfterS) });
      const b = await readJson(request);
      const given = String(b.password ?? "");
      // Porównanie przez HMAC obu wartości: stały czas i brak wycieku długości hasła.
      const ok = safeEqual(await hmac("login", given), await hmac("login", env.MCP_PASSWORD));
      if (!ok) {
        await st.authFailed();
        return fail(401, "bad_password", "Złe hasło.");
      }
      await st.authOk();
      return json({ token: await issueToken(env), days: TOKEN_DAYS });
    }

    // Przyciski w powiadomieniu o posiłku ("Pominąłem", "Za godzinę") działają bez logowania, na podstawie podpisanego, krótko ważnego tokenu.
    if (path === "/api/reminder-action" && method === "POST") {
      const b = await readJson(request);
      const v = await verifyReminderToken(env, String(b.token ?? ""));
      if (!v) return fail(401, "bad_token", "Token wygasł lub jest niepoprawny.");
      const today = warsaw().date;
      if (v.date !== today) return fail(410, "stale", "To przypomnienie jest już nieaktualne.");
      const key = `${v.date}|${v.slotKey}`;
      if (b.action === "skip") await st.setReminders({ [key]: "skip" }, today);
      else if (b.action === "later") await st.setReminders({ [key]: `snooze:${new Date(Date.now() + 3600_000).toISOString()}` }, today);
      else if (b.action !== "add") return fail(400, "bad_action", "Nieznana akcja.");
      return json({ ok: true });
    }

    const auth = request.headers.get("authorization") ?? "";
    if (!(await verifyToken(env, auth.startsWith("Bearer ") ? auth.slice(7) : ""))) return fail(401, "unauthorized", "Zaloguj się ponownie.");

    await st.setOrigin(url.origin); // adres serwera potrzebny m.in. jako kontakt w powiadomieniach push (VAPID)
    if (path === "/api/me" && method === "GET") return json({ ok: true });
    if (path === "/api/summary" && method === "GET") return json(await buildSummary(env));
    if (path === "/api/week" && method === "GET") return json(await buildWeek(env));
    if (path === "/api/plan" && method === "GET") return json(await buildPlan(env));

    // ----- posiłki -----
    if (path === "/api/meals" && method === "GET") {
      const date = url.searchParams.get("date") ?? warsaw().date;
      if (!isDate(date)) throw new HttpError(400, "bad_date", "Zła data.");
      return json(await dayOverview(env, date));
    }
    if (path === "/api/meals" && method === "POST") {
      const b = await readJson(request);
      const text = String(b.text ?? "").trim().slice(0, 1500);
      const img = b.image && typeof b.image === "object" ? b.image : null;
      if (!text && !img) throw new HttpError(400, "empty", "Napisz, co zjadłeś, albo dodaj zdjęcie.");
      if (img && (!IMAGE_MIMES.has(String(img.mime)) || typeof img.data !== "string" || img.data.length < 100 || img.data.length > 7_000_000)) {
        throw new HttpError(400, "bad_image", "Zdjęcie musi być w formacie JPEG, PNG lub WebP i mieć do ok. 5 MB.");
      }
      if (b.kind != null && b.kind !== "" && !isMealKind(b.kind)) throw new HttpError(400, "bad_kind", "Nieznany rodzaj posiłku.");
      const kind = isMealKind(b.kind) ? b.kind : undefined;
      const unix = mealUnix(b);
      const nowLocal = warsaw(new Date(unix * 1000));
      let a;
      try {
        a = await analyzeMeal(env, {
          ...(img ? { image: { mime: String(img.mime), b64: img.data } } : {}),
          note: text,
          nowLocal,
          slotNames: await slotNamesFor(env, nowLocal.date),
          ...API_RUN,
        });
      } catch (e) {
        mapGeminiError(e);
      }
      if (!a.isFood) throw new HttpError(422, "no_food", "Nie widzę tu jedzenia ani picia. Dopisz opis, jeśli to jednak posiłek.");
      const r = await buildAndSaveMeal(env, a, { source: img ? "photo" : "text", note: text, msgUnix: unix, ...(kind ? { kind } : {}) });
      return json({ meal: r.meal, slotName: r.slotName, extra: r.extra, overview: await dayOverview(env, r.meal.date) }, 201);
    }
    const mealRoute = /^\/api\/meals\/([0-9]{8}\.[0-9a-f]{6})(?:\/(revise|favorite))?$/.exec(path);
    if (mealRoute) {
      const id = mealRoute[1];
      const date = dateOfMealId(id);
      if (!date) throw new HttpError(400, "bad_id", "Zły identyfikator posiłku.");
      if (!mealRoute[2] && method === "DELETE") {
        const ok = await st.deleteMeal(id);
        return ok ? json({ ok: true, overview: await dayOverview(env, date) }) : fail(404, "not_found", "Nie ma takiego posiłku.");
      }
      if (mealRoute[2] === "revise" && method === "POST") {
        const b = await readJson(request);
        const text = String(b.text ?? "").trim().slice(0, 1500);
        if (!text) throw new HttpError(400, "empty", "Napisz, co poprawić (np. „to było 200 g”).");
        let r;
        try {
          r = await applyCorrection(env, id, text, Math.floor(Date.now() / 1000), API_RUN);
        } catch (e) {
          mapGeminiError(e);
        }
        if (r.status === "missing") throw new HttpError(404, "not_found", "Nie ma takiego posiłku.");
        if (r.status === "unclear") throw new HttpError(422, "unclear", "Nie załapałem tej poprawki. Napisz np. „to było 200 g”, „bez sosu”.");
        return json({ meal: r.meal, slotName: r.slotName, extra: r.extra, overview: await dayOverview(env, date) });
      }
      if (mealRoute[2] === "favorite" && method === "POST") {
        const m = await st.findMeal(id);
        if (!m) throw new HttpError(404, "not_found", "Nie ma takiego posiłku.");
        await st.addFavorite({ name: m.label.slice(0, 40), items: m.items });
        return json({ ok: true });
      }
    }
    if (path === "/api/favorites" && method === "GET") {
      const favs = await st.getFavorites();
      return json({ favorites: favs.map((f, index) => ({ index, name: f.name, ...sumMacros(f.items) })) });
    }
    const favRoute = /^\/api\/favorites\/(\d{1,3})(\/log)?$/.exec(path);
    if (favRoute) {
      const index = Number(favRoute[1]);
      if (favRoute[2] && method === "POST") {
        const r = await saveFavoriteMeal(env, index);
        if (!r) throw new HttpError(404, "not_found", "Nie ma takiego ulubionego.");
        return json({ meal: r.meal, slotName: r.slotName, overview: await dayOverview(env, r.meal.date) }, 201);
      }
      if (!favRoute[2] && method === "DELETE") {
        return (await st.removeFavorite(index)) ? json({ ok: true }) : fail(404, "not_found", "Nie ma takiego ulubionego.");
      }
    }

    // ----- waga -----
    if (path === "/api/weight" && method === "GET") {
      const [weights, cfg] = await Promise.all([st.getWeights(), st.getNutCfg()]);
      const today = warsaw().date;
      const gp = goalProgress(weights, cfg.goalWeightKg, today, cfg.goalDate);
      const first = weights[0] ?? null;
      return json({
        entries: weights.slice(-180),
        goalKg: cfg.goalWeightKg,
        goalDate: cfg.goalDate,
        plan: first && cfg.goalWeightKg && cfg.goalDate && first.kg > cfg.goalWeightKg ? { startDate: first.date, startKg: first.kg, goalDate: cfg.goalDate, goalKg: cfg.goalWeightKg } : null,
        progress: gp,
      });
    }
    if (path === "/api/weight" && method === "POST") {
      const b = await readJson(request);
      const kg = Number(String(b.kg ?? "").replace(",", "."));
      const today = warsaw().date;
      const date = b.date ?? today;
      if (!Number.isFinite(kg) || kg < 30 || kg > 250) throw new HttpError(400, "bad_value", "Waga w kg (30–250).");
      if (!isDate(date) || daysBetween(date, today) < 0 || daysBetween(date, today) > 60) throw new HttpError(400, "bad_time", "Zła data ważenia.");
      await st.addWeight({ date, kg: Math.round(kg * 10) / 10 });
      const [weights, cfg] = await Promise.all([st.getWeights(), st.getNutCfg()]);
      return json({ ok: true, progress: goalProgress(weights, cfg.goalWeightKg, today, cfg.goalDate) }, 201);
    }

    // ----- trasy -----
    if (path === "/api/routes" && method === "POST") {
      const b = await readJson(request);
      const km = Number(b.km);
      if (!Number.isFinite(km) || km < 2 || km > 42) throw new HttpError(400, "bad_value", "Dystans trasy: 2–42 km.");
      const res = await buildRoutes(env, Math.round(km * 10) / 10, url.origin);
      const problem = res as { error?: string; message?: string };
      if (problem.error) return fail(problem.error === "no_ors_key" ? 501 : 409, problem.error, problem.message ?? "Trasy niedostępne.");
      return json(res);
    }

    // ----- ustawienia -----
    if (path === "/api/settings" && method === "GET") return json({ settings: settingsView(await st.getNutCfg()) });
    if (path === "/api/settings" && method === "PATCH") {
      const patch = validateSettings(await readJson(request), warsaw().date);
      // Zabezpieczenie: nie pozwalamy wybrać "tylko aplikacja", dopóki żadne urządzenie nie ma włączonych powiadomień.
      if (patch.notifyChannel === "app" && !(await st.getPushSubs()).length) {
        throw new HttpError(409, "no_push", "Najpierw włącz powiadomienia na tym telefonie i wyślij testowe, dopiero potem wyłącz Telegram.");
      }
      return json({ settings: settingsView(await st.patchNutCfg(patch)) });
    }

    // ----- powiadomienia push -----
    if (path === "/api/push/key" && method === "GET") {
      return json({ publicKey: (await st.getVapid()).publicKey, subscriptions: (await st.getPushSubs()).length });
    }
    if (path === "/api/push/subscribe" && method === "POST") {
      const sub = (await readJson(request)).subscription;
      const endpoint = String(sub?.endpoint ?? "");
      const p256dh = String(sub?.keys?.p256dh ?? "");
      const authKey = String(sub?.keys?.auth ?? "");
      if (!PUSH_ENDPOINT.test(endpoint) || endpoint.length > 600) throw new HttpError(400, "bad_subscription", "Nieobsługiwany adres usługi powiadomień.");
      let okKeys = false;
      try {
        const pk = b64urlDecode(p256dh);
        okKeys = pk.length === 65 && pk[0] === 4 && b64urlDecode(authKey).length >= 16;
      } catch {
        okKeys = false;
      }
      if (!okKeys) throw new HttpError(400, "bad_subscription", "Niepoprawne klucze subskrypcji.");
      await st.addPushSub({ endpoint, p256dh, auth: authKey, createdAt: new Date().toISOString() });
      return json({ ok: true, subscriptions: (await st.getPushSubs()).length }, 201);
    }
    if (path === "/api/push/subscribe" && method === "DELETE") {
      const endpoint = String((await readJson(request)).endpoint ?? "");
      const removed = await st.removePushSub(endpoint);
      return json({ ok: removed, subscriptions: (await st.getPushSubs()).length });
    }
    if (path === "/api/push/test" && method === "POST") {
      if (!(await st.getPushSubs()).length) throw new HttpError(409, "no_push", "Brak urządzeń z włączonymi powiadomieniami.");
      const r = await pushToAll(env, { title: "Garda", body: "Test powiadomień: jeśli to widzisz, trener i przypomnienia o posiłkach dotrą do Ciebie tutaj. 💪", url: "/app/#/ty/ustawienia", tag: "test", kind: "test" }, { ttlS: 600, urgency: "high" });
      return r.sent ? json({ ok: true, sent: r.sent, failed: r.failed }) : fail(502, "push_failed", "Nie udało się dostarczyć testowego powiadomienia. Wyłącz i włącz powiadomienia jeszcze raz.");
    }

    // ----- lokalizacja (punkt startu dla pogody i tras) -----
    if (path === "/api/location" && method === "POST") {
      const b = await readJson(request);
      const lat = Number(b.lat);
      const lon = Number(b.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, "bad_value", "Zła lokalizacja.");
      await st.setLastLocation({ lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, at: new Date().toISOString() });
      const loc = await currentLocation(env);
      return json({ ok: true, location: loc ? { kind: loc.kind, pozaDomem: loc.poza_domem, odDomuKm: (loc as any).od_domu_km ?? null } : null }, 201);
    }
    if (path === "/api/location" && method === "DELETE") {
      await st.clearLastLocation();
      return json({ ok: true });
    }

    // ----- trener (Claude): ta sama rozmowa co na Telegramie -----
    if (path === "/api/coach" && method === "GET") {
      const m = await st.getMemory();
      const messages = m.conversation.slice(-40).map((c) => ({ at: c.at, from: c.from, text: c.text }));
      const last = messages[messages.length - 1];
      return json({ messages, awaiting: Boolean(last && last.from === "jan" && Date.now() - Date.parse(last.at) < 30 * 60_000) });
    }
    if (path === "/api/coach" && method === "POST") {
      const b = await readJson(request);
      const text = String(b.text ?? "").trim().slice(0, 2000);
      if (!text) throw new HttpError(400, "empty", "Napisz wiadomość.");
      await st.addIncoming(text, new Date().toISOString());
      return json({ ok: true }, 201);
    }
    if (path === "/api/coach/plan" && method === "POST") {
      const b = await readJson(request);
      const weeks = Math.min(4, Math.max(1, Math.round(Number(b.weeks) || 2)));
      const note = String(b.note ?? "").trim().slice(0, 500);
      const text =
        `Proszę o plan treningowy na najbliższe ${weeks} ${weeks === 1 ? "tydzień" : "tygodnie"}: uzupełnij kalendarz zgodnie z zasadami (cel maratonu, wytyczne, moja regeneracja i pogoda), ` +
        `a w odpowiedzi napisz krótko, co zaplanowałeś i dlaczego.${note ? ` Uwaga ode mnie: ${note}` : ""}`;
      await st.addIncoming(text, new Date().toISOString());
      return json({ ok: true, message: "Poprosiłem trenera o plan. Odpowiedź i zmiany w kalendarzu pojawią się w ciągu kilku minut." }, 201);
    }

    return fail(404, "not_found", "Nie ma takiego endpointu.");
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    console.error("api", path, e);
    return fail(500, "internal", "Coś poszło nie tak po stronie serwera.");
  }
}

