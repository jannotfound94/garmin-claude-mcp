import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import TRENER from "../coach/TRENER.md";
import { Icu, compactActivity, compactEvent, compactIntervals, compactWellness, computeSplits } from "./icu";
import { capJson } from "./garmin";
import { garminClient, nutritionReport } from "./diet";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, pingGemini } from "./gemini";
import { runScheduler } from "./scheduler";
import { distKm, resolveLocation } from "./location";
import { fetchForecast } from "./weather";
import { geocode, mapPage, proposeLoops, toGpx } from "./routes";
import { loadAnchors, warmAnchors } from "./anchors";
import { coach, handleTelegramWebhook, sendTelegram, sendTelegramFile, tg, webhookSecret } from "./telegram";
import { addDays, daysBetween, fmtWarsaw, warsaw, warsawToUtc } from "./time";

export { CoachState } from "./state";

const MARATHON_DATE = "2027-04-25";

/** Home by default; a location shared on Telegram overrides it for a while (see location.ts). */
async function currentLocation(env: Env) {
  const { home, last } = await coach(env).getRouteSettings();
  return resolveLocation(home, last);
}

async function weatherLocation(env: Env) {
  return (await currentLocation(env))?.point ?? null;
}

const NO_LOCATION = "Pogoda niedostępna: brak punktu startu (adres lub współrzędne na stronie /setup albo udostępniona lokalizacja).";

const NO_GARMIN = "Garmin Connect nie jest podłączony (brak sekretu GARMIN_PERSONAL_API_KEY).";

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) }],
});

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Intervals.icu + Trener", version: "2.0.0" });
  private contextAt: string | null = null;

  private icu() {
    return new Icu(this.env.INTERVALS_API_KEY, this.env.INTERVALS_ATHLETE_ID);
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;
    const today = () => warsaw().date;

    // ---------------- data ----------------

    this.server.tool(
      "getRecentActivities",
      "Recent activities, compact (distance, moving time, pace, HR, cadence).",
      {
        days: z.number().optional().describe("Days back, default 14"),
        raw: z.boolean().optional().describe("Return the full intervals.icu objects (large). Default false."),
      },
      async ({ days = 14, raw = false }) => {
        const data = await this.icu().activities(addDays(today(), -days));
        return text(raw ? data : data.map(compactActivity));
      },
    );

    this.server.tool(
      "getActivityDetails",
      "One activity in detail: per-kilometre splits (pace on moving time), stops and walking time, laps/intervals. Use for run summaries; never guess splits without this.",
      { activityId: z.string().describe("Activity id, e.g. i210527512") },
      async ({ activityId }) => {
        const icu = this.icu();
        const [act, streams] = await Promise.all([
          icu.activity(activityId),
          icu.streams(activityId, ["time", "distance", "heartrate"]).catch((e) => ({ error: String(e) })),
        ]);
        const splits = (streams as any)?.error ? null : computeSplits(streams);
        return text({
          activity: compactActivity(act),
          ...(splits ?? { splits_error: (streams as any)?.error ?? "Brak strumieni czasu/dystansu" }),
          intervals: compactIntervals(act),
        });
      },
    );

    this.server.tool(
      "getWellness",
      "Sleep, resting HR, HRV, readiness etc. per day, compact.",
      { days: z.number().optional().describe("Days back, default 7") },
      async ({ days = 7 }) => {
        const data = await this.icu().wellness(addDays(today(), -days));
        return text(data.map(compactWellness));
      },
    );

    this.server.tool(
      "listUpcomingEvents",
      "Planned workouts and other calendar events, compact.",
      {
        days: z.number().optional().describe("Days ahead, default 14"),
        daysBack: z.number().optional().describe("Also include this many past days, default 0"),
      },
      async ({ days = 14, daysBack = 0 }) => {
        const data = await this.icu().events(addDays(today(), -daysBack), addDays(today(), days));
        return text(data.map(compactEvent));
      },
    );

    this.server.tool(
      "createWorkout",
      "Write a structured workout to the calendar; it syncs to Garmin.",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, etc."),
        description: z.string().describe("Structured steps, e.g. 'Warmup\\n- 1km 6:45-7:15/km Pace\\n\\nMain Set\\n- 3km 6:10-6:40/km Pace'"),
      },
      async ({ date, name, type, description }) => {
        const data = await this.icu().req(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return text(compactEvent(data));
      },
    );

    this.server.tool(
      "updateWorkout",
      "Edit a planned workout (move date, rename, change steps).",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, date, name, type, description }) => {
        const body: Record<string, unknown> = {};
        if (date) body.start_date_local = `${date}T00:00:00`;
        if (name) body.name = name;
        if (type) body.type = type;
        if (description) body.description = description;
        const data = await this.icu().req(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return text(compactEvent(data));
      },
    );

    this.server.tool(
      "deleteEvent",
      "Remove a planned workout.",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const data = await this.icu().req(`/athlete/${athlete}/events/${eventId}`, { method: "DELETE" });
        return text(data);
      },
    );

    // ---------------- Garmin Connect (direct) ----------------

    this.server.tool(
      "getGarminRecovery",
      "Official Garmin Connect Personal API, per day: sleep (hours, times, score, deep/REM), Body Battery (peak after the night, now), HRV vs. Jan's own normal range, resting HR, stress. details: true adds the raw (pruned) Garmin data.",
      {
        days: z.number().optional().describe("How many days back including today, default 7, max 14"),
        details: z.boolean().optional().describe("Also return raw Garmin sections (large). Default false."),
      },
      async ({ days = 7, details = false }) => {
        const g = garminClient(this.env);
        if (!g) return text(NO_GARMIN);
        const n = Math.min(Math.max(days, 1), 14);
        const start = addDays(today(), -(n - 1));
        const summary = await g.readiness(start, today());
        return text(capJson(details ? { podsumowanie: summary, szczegoly: await g.recovery(start, today()) } : summary));
      },
    );

    this.server.tool(
      "getGarminFitness",
      "Official Garmin Connect Personal API: VO2max (running) over the last 4 weeks and fitness age.",
      {},
      async () => {
        const g = garminClient(this.env);
        if (!g) return text(NO_GARMIN);
        return text(capJson(await g.fitness(addDays(today(), -28), today())));
      },
    );

    // ---------------- weather ----------------

    this.server.tool(
      "getWeather",
      "Weather forecast for running (Open-Meteo), per day and time window (poranek 6-9, poludnie 11-14, wieczor 16-19): best start hour, verdict dobra/znosna/zla with reasons, temperature, feels-like, rain, wind, gusts, darkness, plus sunrise/sunset. For home. Use it to propose moving a run to a better day or time.",
      { days: z.number().optional().describe("How many days including today, default 7, max 7") },
      async ({ days = 7 }) => {
        const loc = await weatherLocation(this.env);
        if (!loc) return text(NO_LOCATION);
        return text(await fetchForecast(loc.lat, loc.lon, days));
      },
    );

    // ---------------- running routes ----------------

    this.server.tool(
      "proposeRoutes",
      "Generate two running loops (A and B) of the given length from Jan's start point (home, or the location he shared on Telegram if it is still valid, see lokalizacja in getCoachContext), preferring unpaved paths, parks and greenery. Returns stats and links to a map with a GPX download. Send Jan both options and ask him to choose.",
      { distanceKm: z.number().min(2).max(42).describe("Total distance of today's run, km") },
      async ({ distanceKm }) => {
        if (!this.env.ORS_API_KEY) return text("Trasy niedostępne: brak sekretu ORS_API_KEY.");
        const state = coach(this.env);
        const { origin } = await state.getRouteSettings();
        const loc = await currentLocation(this.env);
        if (!loc) return text("Trasy niedostępne: brak punktu startu (ustaw adres domowy na stronie /setup albo poproś Jana o udostępnienie lokalizacji).");
        const start = loc.point;
        const fromHome = loc.kind === "dom";
        const { anchors, info } = await loadAnchors(this.env, start, distanceKm, "interactive");
        const options = await proposeLoops(this.env.ORS_API_KEY, start, distanceKm, anchors);
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        await state.saveProposal({
          id,
          created: new Date().toISOString(),
          target_km: distanceKm,
          start,
          start_label: fromHome ? "dom" : "udostępniona lokalizacja",
          options,
        });
        const base = origin ?? "";
        return text({
          proposalId: id,
          start: fromHome ? "dom" : "udostępniona lokalizacja Jana",
          poza_domem: loc.poza_domem,
          ...(anchors.length ? {} : { uwaga: `Brak danych o parkach (${info}); trasy z OpenRouteService.` }),
          opcje: options.map((o) => ({
            trasa: o.label,
            dystans_km: o.distance_km,
            nawierzchnia_nieutwardzona_proc: o.unpaved_pct,
            nawierzchnia_utwardzona_proc: o.paved_pct,
            nawierzchnia_nieznana_proc: o.unknown_surface_pct,
            sciezki_i_alejki_proc: o.paths_pct,
            zielen_0_10: o.green_avg,
            odcinki_biegane_dwa_razy_proc: o.retrace_pct,
            typ: o.source === "parki" ? "pętla przez parki i ścieżki" : "pętla z OpenRouteService",
            ...(o.via ? { przez: o.via } : {}),
            mapa: `${base}/trasa/${id}/${o.label}`,
          })),
          uwaga: "Dane o nawierzchni pochodzą z OpenStreetMap i bywają niepełne (stąd „nieznana”).",
        });
      },
    );

    this.server.tool(
      "chooseRoute",
      "After Jan picks A or B: sends him the GPX file of the chosen loop on Telegram (to open in Locus Map or import as a Garmin course) and returns its distance, so you can update today's workout steps to match it.",
      { proposalId: z.string(), option: z.string().describe("A or B") },
      async ({ proposalId, option }) => {
        const state = coach(this.env);
        const p = await state.getProposal(proposalId);
        if (!p) return text("Nie znaleziono propozycji tras (mogła wygasnąć). Wygeneruj nowe przez proposeRoutes.");
        const o = p.options.find((x) => x.label.toUpperCase() === option.trim().toUpperCase());
        if (!o) return text(`Brak trasy ${option}. Dostępne: ${p.options.map((x) => x.label).join(", ")}`);
        const date = warsaw().date;
        const name = `Trasa ${o.label} ${o.distance_km} km (${date})`;
        await sendTelegramFile(
          this.env,
          `trasa-${date}-${o.label}.gpx`,
          toGpx(name, o.coords),
          `${name}. Stuknij plik i otwórz w Locus Map, albo zaimportuj jako kurs w Garmin Connect.`,
        );
        await state.markChosen(proposalId, o.label);
        const { origin } = await state.getRouteSettings();
        return text({ wyslano_gpx: true, trasa: o.label, dystans_km: o.distance_km, mapa: `${origin ?? ""}/trasa/${proposalId}/${o.label}` });
      },
    );

    // ---------------- dietetyk ----------------

    this.server.tool(
      "getNutrition",
      "Dietetyk: posiłki Jana (zapisane z jego zdjęć i opisów na Telegramie) z podsumowaniem. Zwraca: typ dnia (z planu i aktywności) i cele kcal/makro, dzisiejsze spożycie z listą posiłków i tym, co zostało, status posiłków z planu (zapisany/pominięty/brak wpisu), dni wstecz (days, domyślnie 1, max 14) ze spożyciem vs spalone kcal z Garmina, średnią 7 dni, wagę i trend, kalibrację rzeczywistego zapotrzebowania (po ok. 3 tygodniach danych). Liczby są policzone przez serwer: nie przeliczaj ich ponownie, tylko interpretuj.",
      { days: z.number().optional().describe("Ile dni wstecz łącznie z dzisiejszym, domyślnie 1, max 14") },
      async ({ days = 1 }) => text(await nutritionReport(this.env, days)),
    );

    this.server.tool(
      "setNutritionConfig",
      "Zmienia ustawienia dietetyka Jana, gdy sam o to poprosi lub gdy ustalicie cel (np. redukcja). Zmieniaj tylko to, co wynika z rozmowy. Deficyt dotyczy wyłącznie dni bez biegu i łatwych; w dni akcentów i długich biegów serwer go ignoruje.",
      {
        deficitKcal: z.number().min(0).max(700).optional().describe("Dzienny deficyt kcal (0 = utrzymanie)"),
        proteinPerKg: z.number().min(1.2).max(2.5).optional(),
        fatPerKg: z.number().min(0.6).max(1.5).optional(),
        carbsPerKg: z
          .object({
            rest: z.number().min(2).max(10).optional(),
            easy: z.number().min(2).max(10).optional(),
            quality: z.number().min(2).max(10).optional(),
            long: z.number().min(2).max(10).optional(),
          })
          .optional()
          .describe("g węglowodanów na kg wg typu dnia"),
        remindAfterMin: z.number().min(30).max(360).optional().describe("Po ilu minutach od planowanej godziny posiłku przypomnieć"),
      },
      async (patch) => {
        const st = coach(this.env);
        const cur = await st.getNutCfg();
        const { carbsPerKg, ...rest } = patch;
        const next = await st.patchNutCfg({
          ...rest,
          ...(carbsPerKg ? { carbsPerKg: { ...cur.carbsPerKg, ...Object.fromEntries(Object.entries(carbsPerKg).filter(([, v]) => v !== undefined)) } } : {}),
        });
        return text({ deficyt_kcal: next.deficitKcal, bialko_g_na_kg: next.proteinPerKg, tluszcz_g_na_kg: next.fatPerKg, weglowodany_g_na_kg: next.carbsPerKg, przypomnienie_po_min: next.remindAfterMin });
      },
    );

    // ---------------- coach agent ----------------

    this.server.tool(
      "getCoachContext",
      "START HERE when acting as Jan's running coach. Returns the coach instructions, memory (notes, open items, scheduled check-ins), the Telegram conversation with NEW messages from Jan marked, why you were woken, and a data snapshot (runs 14 days, plan -7..+14 days, wellness 7 days).",
      {},
      async () => {
        const now = new Date();
        const local = warsaw(now);
        this.contextAt = now.toISOString();
        const mem = await coach(this.env).getMemory();
        const icu = this.icu();
        const g = garminClient(this.env);
        const [acts, events, well, garminToday, weather] = await Promise.allSettled([
          icu.activities(addDays(local.date, -14)),
          icu.events(addDays(local.date, -7), addDays(local.date, 14)),
          g ? Promise.resolve(null) : icu.wellness(addDays(local.date, -7)), // Garmin data supersedes it
          g ? g.readiness(addDays(local.date, -3), local.date) : Promise.resolve(NO_GARMIN),
          weatherLocation(this.env).then((loc): Promise<unknown> | string =>
            loc ? fetchForecast(loc.lat, loc.lon, 4, ["poranek", "wieczor"]) : NO_LOCATION,
          ),
        ]);
        const val = <T,>(r: PromiseSettledResult<T>, f: (x: T) => unknown) =>
          r.status === "fulfilled" ? f(r.value) : { error: String(r.reason) };

        return text({
          teraz: { data: local.date, dzien: local.weekdayPl, godzina: local.time, strefa: "Europe/Warsaw" },
          dni_do_maratonu: daysBetween(local.date, MARATHON_DATE),
          powody_pobudki: mem.lastWakeReasons,
          instrukcja_trenera: TRENER,
          pamiec: {
            notatki: mem.notes,
            otwarte_sprawy: mem.openItems,
            zaplanowane_sprawdzenia: mem.checkIns.map((c) => ({ id: c.id, kiedy: fmtWarsaw(c.at), powod: c.reason })),
            omowione_biegi: mem.reviewedActivities.slice(-15),
            biegi_bez_podsumowania: val(acts, (list: any[]) =>
              list
                .filter((x) => /Run/i.test(x.type) && String(x.start_date_local) >= "2026-11-01" && !mem.reviewedActivities.includes(String(x.id)))
                .map((x) => compactActivity(x)),
            ),
          },
          rozmowa: mem.conversation.slice(-16).map((m) => ({
            kiedy: fmtWarsaw(m.at),
            kto: m.from,
            tekst: m.text,
            ...(m.from === "jan" && (!mem.lastHandledAt || m.at > mem.lastHandledAt) ? { NOWA: true } : {}),
          })),
          dane: {
            biegi_14_dni: val(acts, (a: any[]) => a.map(compactActivity)),
            kalendarz_od_minus7_do_plus14: val(events, (e: any[]) => e.map(compactEvent)),
            ...(g ? {} : { samopoczucie_7_dni: val(well, (w: any) => (w as any[]).map(compactWellness)) }),
            garmin_regeneracja_4_dni: val(garminToday, (x) => x),
            pogoda_4_dni: val(weather, (x) => x),
          },
          lokalizacja: await (async () => {
            const l = await currentLocation(this.env);
            if (!l) return "brak punktu startu";
            return {
              punkt_startu: l.kind === "dom" ? "dom" : "udostępniona lokalizacja",
              poza_domem: l.poza_domem,
              ...(l.kind === "udostepniona" ? { od_domu_km: l.od_domu_km, udostepniona_godz_temu: l.udostepniona_godz_temu } : {}),
            };
          })(),
          telegram_skonfigurowany: Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID),
          dietetyk_wlaczony: Boolean(this.env.GEMINI_API_KEY),
          trasy: await (async () => {
            const { home, last } = await coach(this.env).getRouteSettings();
            const props = await coach(this.env).listProposals();
            const latest = props[props.length - 1];
            return {
              dostepne: Boolean(this.env.ORS_API_KEY && (home || last)),
              start_dom_ustawiony: Boolean(home),
              udostepniona_lokalizacja: last ? fmtWarsaw(last.at) : null,
              ostatnia_propozycja: latest
                ? { proposalId: latest.id, kiedy: fmtWarsaw(latest.created), dystans_km: latest.target_km, wybrana: latest.chosen ?? null }
                : null,
            };
          })(),
        });
      },
    );

    this.server.tool(
      "sendMessage",
      "Send a Telegram message to Jan (plain text, Polish). The message is saved in the conversation history. Under the input field Jan always has a button '📍 Jestem gdzie indziej' that shares his location with one tap, so you can point to it.",
      { text: z.string().min(1) },
      async ({ text: msg }) => {
        await sendTelegram(this.env, msg);
        await coach(this.env).logOutgoing(msg);
        return text("Wysłano.");
      },
    );

    this.server.tool(
      "updateMemory",
      "Update the coach's memory. Call at the end of every run with markHandled: true. Check-in times are Warsaw local time 'YYYY-MM-DD HH:MM'; at that time the server wakes you with the given reason.",
      {
        addNotes: z.array(z.string()).optional().describe("Lasting facts worth remembering (injury, travel, preferences)"),
        removeNoteIds: z.array(z.number()).optional(),
        addOpenItems: z.array(z.string()).optional().describe("Things waiting for Jan's answer or a later decision"),
        resolveOpenItemIds: z.array(z.number()).optional(),
        addCheckIns: z
          .array(z.object({ at: z.string().describe("YYYY-MM-DD HH:MM, Warsaw time"), reason: z.string() }))
          .optional()
          .describe("Wake me up later to check something, e.g. 17:00 whether today's run happened"),
        removeCheckInIds: z.array(z.number()).optional(),
        reviewedActivities: z.array(z.string()).optional().describe("Activity ids already summarised to Jan"),
        markHandled: z.boolean().optional().describe("Mark Jan's messages read up to the moment of getCoachContext"),
      },
      async (ops) => {
        const checkIns = (ops.addCheckIns ?? []).map((c) => ({ at: warsawToUtc(c.at).toISOString(), reason: c.reason }));
        const m = await coach(this.env).applyOps({ ...ops, addCheckIns: checkIns }, this.contextAt);
        return text({
          notatki: m.notes,
          otwarte_sprawy: m.openItems,
          zaplanowane_sprawdzenia: m.checkIns.map((c) => ({ id: c.id, kiedy: fmtWarsaw(c.at), powod: c.reason })),
        });
      },
    );
  }
}

// ---------------- HTML pages ----------------

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui;max-width:34rem;margin:2rem auto;padding:0 1rem;line-height:1.45">
<h2>${esc(title)}</h2>${body}</body>`;

function loginPage(state: string, error: string) {
  return page(
    "Intervals.icu MCP",
    `<p style="color:#c00">${esc(error)}</p>
  <form method="post">
    <input type="hidden" name="state" value="${esc(state)}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form>`,
  );
}

const btn = (action: string, label: string) =>
  `<button name="action" value="${action}" style="padding:.5rem .8rem;margin:.2rem 0">${esc(label)}</button>`;

async function setupPage(env: Env, password: string, notice: string) {
  const ok = (b: boolean) => (b ? "✅" : "❌");
  let webhook = "nie sprawdzono";
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const info = await tg(env, "getWebhookInfo", {});
      webhook = info.url ? `ustawiony (${esc(info.url)})${info.last_error_message ? `, ostatni błąd: ${esc(info.last_error_message)}` : ""}` : "nieustawiony";
    } catch (e) {
      webhook = `błąd: ${esc(e)}`;
    }
  }
  const mem = await coach(env).getMemory();
  const fires = mem.fires
    .slice(-5)
    .reverse()
    .map((f) => `<li>${esc(fmtWarsaw(f.at))} ${f.ok ? "✅" : "❌"} ${esc(f.reasons.join("; "))}${f.ok ? "" : ` (${esc(f.info)})`}</li>`)
    .join("");
  return page(
    "Trener: konfiguracja",
    `${notice ? `<p style="background:#eef;padding:.6rem">${esc(notice)}</p>` : ""}
  <ul>
    <li>${ok(Boolean(env.TELEGRAM_BOT_TOKEN))} TELEGRAM_BOT_TOKEN</li>
    <li>${ok(Boolean(env.TELEGRAM_CHAT_ID))} TELEGRAM_CHAT_ID</li>
    <li>${ok(Boolean(env.ROUTINE_FIRE_URL))} ROUTINE_FIRE_URL</li>
    <li>${ok(Boolean(env.ROUTINE_FIRE_TOKEN))} ROUTINE_FIRE_TOKEN</li>
    <li>Webhook Telegrama: ${webhook}</li>
    <li>Pamięć: ${mem.notes.length} notatek, ${mem.openItems.length} otwartych spraw, ${mem.checkIns.length} zaplanowanych sprawdzeń, ${mem.conversation.length} wiadomości w historii</li>
  </ul>
  <p>Ostatnie pobudki trenera:</p><ul>${fires || "<li>brak</li>"}</ul>
  ${await garminSection(env, password)}
  ${await dietSection(env, password)}
  <form method="post">
    <input type="hidden" name="password" value="${esc(password)}">
    ${btn("connect", "1. Podłącz Telegram (webhook) i wyślij wiadomość testową")}<br>
    ${btn("wake", "2. Obudź trenera teraz (test)")}<br>
    ${btn("refresh", "Odśwież")}<br><br>
    ${btn("disconnect", "Odłącz webhook Telegrama (powrót do Composio)")}
  </form>`,
  );
}

async function garminSection(env: Env, password: string) {
  const hidden = `<input type="hidden" name="password" value="${esc(password)}">`;
  const body = env.GARMIN_PERSONAL_API_KEY
    ? `<p>✅ Osobisty klucz API Garmina jest wpisany (GARMIN_PERSONAL_API_KEY).</p>
    <form method="post">${hidden}${btn("garmin_test", "Sprawdź dane z Garmin Connect")}</form>`
    : `<p>❌ Brak klucza. Utwórz „Osobisty klucz API” w Garmin Connect (przeglądarka) i wpisz go w Cloudflare jako sekret <code>GARMIN_PERSONAL_API_KEY</code>.</p>`;
  return `<h3>Garmin Connect</h3>${body}${await routesSection(env, password)}`;
}

async function dietSection(env: Env, password: string) {
  const hidden = `<input type="hidden" name="password" value="${esc(password)}">`;
  const cfg = await coach(env).getNutCfg();
  const slots = (l: { name: string; time: string }[]) => l.map((s) => `${esc(s.name)} ${s.time}`).join("; ");
  return `<h3>Dietetyk</h3>
  <ul><li>${env.GEMINI_API_KEY ? "✅" : "❌"} GEMINI_API_KEY (darmowy klucz z aistudio.google.com) · model: ${esc(env.GEMINI_MODEL || DEFAULT_MODEL)}, zapasowy: ${esc(env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL)}</li>
  <li>Plan posiłków pn–pt: ${cfg.slots.length ? slots(cfg.slots) : "brak (ustaw na Telegramie: /posilki)"}${cfg.weekendSlots.length ? ` · weekend: ${slots(cfg.weekendSlots)}` : ""}</li>
  <li>Przypomnienia: ${cfg.remindersOn ? "włączone" : "wyłączone"}</li></ul>
  <form method="post">${hidden}${btn("gemini_test", "Sprawdź Gemini (test na opisie tekstowym)")}</form>`;
}

async function routesSection(env: Env, password: string) {
  const hidden = `<input type="hidden" name="password" value="${esc(password)}">`;
  const { home, last } = await coach(env).getRouteSettings();
  const loc = resolveLocation(home, last);
  const lastInfo = last
    ? `${esc(fmtWarsaw(last.at))}${home ? `, ${Math.round(distKm(home, last) * 10) / 10} km od domu` : ""}`
    : "brak";
  return `<h3>Trasy i lokalizacja</h3>
  <ul><li>${env.ORS_API_KEY ? "✅" : "❌"} ORS_API_KEY (darmowy klucz z openrouteservice.org)</li>
  <li>${home ? `✅ Punkt startu (dom): ${esc(home.label)}` : "❌ Brak punktu startu (dom)"}</li>
  <li>Teraz pogoda i trasy liczone są dla: ${loc ? (loc.kind === "dom" ? "domu" : "udostępnionej lokalizacji") : "nic (brak punktu startu)"}</li>
  <li>Ostatnia udostępniona lokalizacja: ${lastInfo}</li></ul>
  <form method="post">${hidden}<input name="home_address" placeholder="Adres lub współrzędne startu, np. 52.2500, 21.0000" style="width:100%;padding:.5rem;margin-bottom:.5rem">
  ${btn("set_home", "Zapisz punkt startu")} ${btn("warm_parks", "Pobierz dane o parkach")} ${btn("routes_test", "Wygeneruj testowe trasy 5 km")} ${btn("weather_test", "Sprawdź pogodę")} ${btn("clear_location", "Usuń zapamiętaną lokalizację")}</form>`;
}

async function handleSetup(request: Request, env: Env, origin: string): Promise<Response> {
  const html = { "content-type": "text/html;charset=utf-8" };
  const askPassword = (err = "") =>
    new Response(
      page(
        "Trener: konfiguracja",
        `<p style="color:#c00">${esc(err)}</p><form method="post">
      <input type="password" name="password" placeholder="MCP_PASSWORD" autofocus style="width:100%;padding:.5rem;margin-bottom:.5rem">
      <button name="action" value="refresh" style="width:100%;padding:.5rem">Wejdź</button></form>`,
      ),
      { status: err ? 401 : 200, headers: html },
    );
  if (request.method !== "POST") return askPassword();

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (password !== env.MCP_PASSWORD) return askPassword("Złe hasło");

  let notice = "";
  try {
    switch (String(form.get("action"))) {
      case "connect":
        await tg(env, "setWebhook", {
          url: `${origin}/telegram`,
          secret_token: await webhookSecret(env),
          allowed_updates: ["message", "edited_message", "callback_query"],
          drop_pending_updates: false,
        });
        await sendTelegram(env, "Trener podłączony ✅ Od teraz odpowiadam na Twoje wiadomości na bieżąco.");
        notice = "Webhook ustawiony, wiadomość testowa wysłana.";
        break;
      case "wake":
        await coach(env).wakeNow("TEST_Z_PANELU (sprawdź kontekst; napisz do Jana tylko jeśli jest ku temu powód)");
        notice = "Trener zostanie obudzony w ciągu kilku sekund. Odśwież za chwilę, by zobaczyć wynik.";
        break;
      case "set_home": {
        const raw = String(form.get("home_address") ?? "").trim();
        const ll = /^(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(raw);
        if (!ll && !env.ORS_API_KEY) throw new Error("Adres wymaga sekretu ORS_API_KEY. Bez niego wpisz współrzędne, np. 52.2500, 21.0000.");
        const h = ll
          ? { lat: Number(ll[1]), lon: Number(ll[2]), label: `współrzędne ${ll[1]}, ${ll[2]}` }
          : await geocode(env.ORS_API_KEY!, raw);
        await coach(env).setHome(h);
        notice = `Punkt startu zapisany: ${h.label} (${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}).`;
        break;
      }
      case "clear_location":
        await coach(env).clearLastLocation();
        notice = "Zapamiętana lokalizacja usunięta. Używany jest dom.";
        break;
      case "weather_test": {
        const loc = (await currentLocation(env))?.point;
        if (!loc) throw new Error("Najpierw zapisz punkt startu.");
        const days = await fetchForecast(loc.lat, loc.lon, 3);
        notice =
          "Pogoda działa ✅ " +
          days
            .map((d) => `${d.dzien} ${d.data}: ${d.temp_min_c}…${d.temp_max_c}°C, opady ${d.opady_dzien_mm} mm, bieg: ${d.ocena_dnia}`)
            .join(" | ");
        break;
      }
      case "warm_parks": {
        const loc = (await currentLocation(env))?.point;
        if (!loc) throw new Error("Najpierw zapisz punkt startu.");
        const r = await loadAnchors(env, loc, 5, "force");
        notice = `Dane o parkach: ${r.info}${r.anchors.length ? ` Najcięższe miejsca: ${r.anchors.slice(0, 6).map((a) => a.name ?? "ścieżki").join(", ")}.` : ""}`;
        break;
      }
      case "routes_test": {
        if (!env.ORS_API_KEY) throw new Error("Najpierw dodaj sekret ORS_API_KEY.");
        const { home } = await coach(env).getRouteSettings();
        if (!home) throw new Error("Najpierw zapisz punkt startu.");
        await coach(env).setOrigin(origin);
        const { anchors, info } = await loadAnchors(env, home, 5, "force");
        const options = await proposeLoops(env.ORS_API_KEY, home, 5, anchors);
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        await coach(env).saveProposal({ id, created: new Date().toISOString(), target_km: 5, start: home, start_label: "dom", options });
        notice =
          `(${info}) ` +
          options
            .map(
              (o) =>
                `Trasa ${o.label}: ${o.distance_km} km, ${o.source === "parki" ? "przez parki" : "pętla ORS"}${o.via ? ` (${o.via.join(", ")})` : ""}, ` +
                `nieutwardzona ${o.unpaved_pct}%, zieleń ${o.green_avg}/10, dwa razy ${o.retrace_pct}% → ${origin}/trasa/${id}/${o.label}`,
            )
            .join(" | ");
        break;
      }
      case "garmin_test": {
        const g = garminClient(env);
        if (!g) throw new Error(NO_GARMIN);
        await coach(env).setGarminToken(null); // force a fresh key->token exchange
        const d = await g.recovery(addDays(warsaw().date, -1), warsaw().date);
        notice = `Garmin Connect działa ✅ Wczoraj i dziś: ${capJson(d, 1500)}`;
        break;
      }
      case "gemini_test":
        notice = `Gemini działa ✅ ${await pingGemini(env)}`;
        break;
      case "disconnect":
        await tg(env, "deleteWebhook", { drop_pending_updates: false });
        notice = "Webhook usunięty.";
        break;
    }
  } catch (e) {
    notice = `Błąd: ${e}`;
  }
  return new Response(await setupPage(env, password, notice), { headers: html });
}

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const html = { "content-type": "text/html;charset=utf-8" };

    if (url.pathname === "/telegram" && request.method === "POST") {
      await coach(env).setOrigin(url.origin);
      return handleTelegramWebhook(request, env, ctx);
    }
    const route = /^\/trasa\/([a-f0-9]{16})\/([A-Z])(\.gpx)?$/.exec(url.pathname);
    if (route) {
      const p = await coach(env).getProposal(route[1]);
      const o = p?.options.find((x) => x.label === route[2]);
      if (!p || !o) return new Response("Nie ma takiej trasy", { status: 404 });
      const name = `Trasa ${o.label} ${o.distance_km} km`;
      if (route[3]) {
        return new Response(toGpx(name, o.coords), {
          headers: { "content-type": "application/gpx+xml", "content-disposition": `attachment; filename="trasa-${o.label}.gpx"` },
        });
      }
      const title = `${name}: ${o.unpaved_pct}% nieutwardzonej, zieleń ${o.green_avg}/10, ${o.retrace_pct}% dwa razy${o.via ? `, przez ${o.via.join(", ")}` : ""}`;
      return new Response(mapPage(esc(title), o.coords, `/trasa/${p.id}/${o.label}.gpx`), { headers: html });
    }
    if (url.pathname === "/setup") return handleSetup(request, env, url.origin);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });

    const provider = (env as any).OAUTH_PROVIDER;
    if (request.method === "GET") {
      const info = await provider.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await provider.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // The park data for the current start point is fetched here, where nobody is waiting for it.
    ctx.waitUntil(Promise.all([runScheduler(env), warmAnchors(env).catch((e) => console.error("warmAnchors", e))]));
  },
} satisfies ExportedHandler<Env>;
