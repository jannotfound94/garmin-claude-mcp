import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import TRENER from "../coach/TRENER.md";
import { Icu, compactActivity, compactEvent, compactIntervals, compactWellness, computeSplits } from "./icu";
import { GarminClient, garminLogin, garminSubmitMfa } from "./garmin";
import { runScheduler } from "./scheduler";
import { coach, handleTelegramWebhook, sendTelegram, tg, webhookSecret } from "./telegram";
import { addDays, daysBetween, fmtWarsaw, warsaw, warsawToUtc } from "./time";

export { CoachState } from "./state";

const MARATHON_DATE = "2027-04-25";

async function garminClient(env: Env): Promise<GarminClient | null> {
  const state = coach(env);
  const tokens = await state.getGarmin();
  return tokens ? new GarminClient(tokens, (t) => state.setGarmin(t)) : null;
}

const NO_GARMIN = "Garmin Connect nie jest podłączony (strona /setup serwera, sekcja Garmin Connect).";

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
      "Straight from Garmin Connect: training readiness, Body Battery, stress, sleep phases, HRV status, resting HR, per day. Data intervals.icu does not have.",
      { days: z.number().optional().describe("How many days back including today, default 3, max 14") },
      async ({ days = 3 }) => {
        const g = await garminClient(this.env);
        if (!g) return text(NO_GARMIN);
        const n = Math.min(Math.max(days, 1), 14);
        const dates = Array.from({ length: n }, (_, i) => addDays(today(), -i));
        const out = [];
        for (const d of dates) out.push(await g.daily(d));
        return text(out);
      },
    );

    this.server.tool(
      "getGarminFitness",
      "Straight from Garmin Connect: VO2max, fitness age, training status, and Garmin's race-time predictions (5k, 10k, half, marathon).",
      {},
      async () => {
        const g = await garminClient(this.env);
        if (!g) return text(NO_GARMIN);
        return text(await g.fitness(today()));
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
        const g = await garminClient(this.env);
        const [acts, events, well, garminToday] = await Promise.allSettled([
          icu.activities(addDays(local.date, -14)),
          icu.events(addDays(local.date, -7), addDays(local.date, 14)),
          icu.wellness(addDays(local.date, -7)),
          g ? g.daily(local.date) : Promise.resolve(NO_GARMIN),
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
          },
          rozmowa: mem.conversation.slice(-30).map((m) => ({
            kiedy: fmtWarsaw(m.at),
            kto: m.from,
            tekst: m.text,
            ...(m.from === "jan" && (!mem.lastHandledAt || m.at > mem.lastHandledAt) ? { NOWA: true } : {}),
          })),
          dane: {
            biegi_14_dni: val(acts, (a: any[]) => a.map(compactActivity)),
            kalendarz_od_minus7_do_plus14: val(events, (e: any[]) => e.map(compactEvent)),
            samopoczucie_7_dni: val(well, (w: any[]) => w.map(compactWellness)),
            garmin_connect_dzis: val(garminToday, (x) => x),
          },
          telegram_skonfigurowany: Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID),
        });
      },
    );

    this.server.tool(
      "sendMessage",
      "Send a Telegram message to Jan (plain text, Polish). The message is saved in the conversation history.",
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
  const state = coach(env);
  const tokens = await state.getGarmin();
  const pending = await state.getGarminPending();
  const hidden = `<input type="hidden" name="password" value="${esc(password)}">`;
  const field = (name: string, type: string, ph: string) =>
    `<input name="${name}" type="${type}" placeholder="${ph}" style="width:100%;padding:.5rem;margin-bottom:.5rem" autocomplete="off">`;
  let body: string;
  if (tokens) {
    body = `<p>✅ Połączono ${esc(fmtWarsaw(tokens.connectedAt))}${tokens.displayName ? ` (${esc(tokens.displayName)})` : ""}.</p>
    <form method="post">${hidden}${btn("garmin_test", "Sprawdź dane z Garmin Connect")} ${btn("garmin_disconnect", "Odłącz Garmin Connect")}</form>`;
  } else if (pending) {
    body = `<p>Garmin wysłał Ci kod weryfikacyjny (e-mail lub SMS). Wpisz go poniżej (ważny kilka minut).</p>
    <form method="post">${hidden}${field("garmin_code", "text", "Kod z Garmina")}${btn("garmin_mfa", "Potwierdź kod")}</form>`;
  } else {
    body = `<p>Wpisz dane logowania do Garmin Connect. Hasło jest użyte jednorazowo do zalogowania i <b>nie jest nigdzie zapisywane</b>; serwer zachowuje tylko klucz dostępu (ważny ok. roku).</p>
    <form method="post">${hidden}${field("garmin_email", "email", "E-mail Garmin")}${field("garmin_password", "password", "Hasło Garmin")}${btn("garmin_login", "Połącz z Garmin Connect")}</form>`;
  }
  return `<h3>Garmin Connect</h3>${body}`;
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
          allowed_updates: ["message", "edited_message"],
          drop_pending_updates: false,
        });
        await sendTelegram(env, "Trener podłączony ✅ Od teraz odpowiadam na Twoje wiadomości na bieżąco.");
        notice = "Webhook ustawiony, wiadomość testowa wysłana.";
        break;
      case "wake":
        await coach(env).wakeNow("TEST_Z_PANELU (sprawdź kontekst; napisz do Jana tylko jeśli jest ku temu powód)");
        notice = "Trener zostanie obudzony w ciągu kilku sekund. Odśwież za chwilę, by zobaczyć wynik.";
        break;
      case "garmin_login": {
        const r = await garminLogin(String(form.get("garmin_email") ?? ""), String(form.get("garmin_password") ?? ""));
        if (r.status === "mfa") {
          await coach(env).setGarminPending(r.pending);
          notice = "Garmin prosi o kod weryfikacyjny. Wpisz go w sekcji Garmin Connect.";
        } else {
          await coach(env).setGarmin(r.tokens);
          notice = "Połączono z Garmin Connect ✅";
        }
        break;
      }
      case "garmin_mfa": {
        const pending = await coach(env).getGarminPending();
        if (!pending) throw new Error("Kod wygasł. Zaloguj się ponownie.");
        await coach(env).setGarmin(await garminSubmitMfa(pending, String(form.get("garmin_code") ?? "")));
        await coach(env).setGarminPending(null);
        notice = "Połączono z Garmin Connect ✅";
        break;
      }
      case "garmin_test": {
        const g = await garminClient(env);
        if (!g) throw new Error(NO_GARMIN);
        const d = await g.daily(warsaw().date);
        notice = `Garmin Connect, dziś: ${JSON.stringify(d)}`;
        break;
      }
      case "garmin_disconnect":
        await coach(env).setGarmin(null);
        await coach(env).setGarminPending(null);
        notice = "Odłączono Garmin Connect.";
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
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const html = { "content-type": "text/html;charset=utf-8" };

    if (url.pathname === "/telegram" && request.method === "POST") return handleTelegramWebhook(request, env);
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
    ctx.waitUntil(runScheduler(env));
  },
} satisfies ExportedHandler<Env>;
