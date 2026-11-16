/**
 * Dostarczanie powiadomień Jankowi: aplikacja (Web Push), Telegram albo oba, zależnie od ustawienia notifyChannel.
 * Zasada bezpieczeństwa: jeśli wybrany kanał niczego nie dostarczył (np. wybrano tylko aplikację, a telefon wygasł),
 * próbujemy drugiego kanału, żeby trener nigdy nie "ucichł". Wiadomości trenera są zawsze zapisywane w rozmowie.
 */
import { hmacHex, safeEqual } from "./crypto";
import type { NotifyChannel } from "./nutrition";
import { sendPush } from "./push";
import { coach, sendTelegram } from "./telegram";

export interface PushPayload {
  title: string;
  body: string;
  url: string; // względny, np. "/app/#/ty/trener"
  tag?: string;
  kind: "coach" | "reminder" | "test";
  actions?: { action: string; title: string }[];
  rt?: string; // token akcji przypomnienia (patrz reminderToken)
}

export const hasTelegram = (env: Env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Wysyła do wszystkich urządzeń; wygasłe subskrypcje (404/410) usuwa. Zwraca liczbę udanych wysyłek. */
export async function pushToAll(env: Env, payload: PushPayload, opts: { ttlS?: number; urgency?: "low" | "normal" | "high" } = {}): Promise<{ sent: number; failed: number }> {
  const st = coach(env);
  const subs = await st.getPushSubs();
  if (!subs.length) return { sent: 0, failed: 0 };
  const keys = await st.getVapid();
  const { origin } = await st.getRouteSettings();
  const body = { ...payload, title: clip(payload.title, 60), body: clip(payload.body, 220) };
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      const r = await sendPush(s, body, keys, { subject: origin ?? "mailto:garda@example.com", ttlS: opts.ttlS, urgency: opts.urgency });
      if (r.ok) sent++;
      else {
        failed++;
        if (r.gone) await st.removePushSub(s.endpoint);
      }
    }),
  );
  return { sent, failed };
}

export interface Delivery {
  push: number;
  telegram: boolean;
  channelUsed: "app" | "telegram" | "both" | "none";
  fallback: boolean;
}

/**
 * Wybiera kanały wg ustawienia i zapewnia zapasowy. push() zwraca liczbę dostarczonych powiadomień, telegram() informuje,
 * czy wysłano. Funkcje są przekazywane z zewnątrz, żeby ta sama polityka obsługiwała wiadomości trenera i przypomnienia.
 */
export async function deliver(channel: NotifyChannel, send: { push: (() => Promise<number>) | null; telegram: (() => Promise<boolean>) | null }): Promise<Delivery> {
  const tryPush = async () => (send.push ? await send.push().catch(() => 0) : 0);
  const tryTg = async () => (send.telegram ? await send.telegram().catch(() => false) : false);
  let push = 0;
  let telegram = false;
  if (channel !== "telegram") push = await tryPush();
  if (channel !== "app") telegram = await tryTg();
  let fallback = false;
  if (!push && !telegram) {
    fallback = true;
    if (channel === "app") telegram = await tryTg();
    else if (channel === "telegram") push = await tryPush();
    else {
      /* "both" już próbowało obu */
    }
  }
  return { push, telegram, channelUsed: push && telegram ? "both" : push ? "app" : telegram ? "telegram" : "none", fallback: fallback && Boolean(push || telegram) };
}

/** Wiadomość trenera (Claude): zawsze trafia do rozmowy, potem do kanałów wg ustawienia. */
export async function notifyCoach(env: Env, text: string): Promise<Delivery> {
  const st = coach(env);
  await st.logOutgoing(text);
  const cfg = await st.getNutCfg();
  return deliver(cfg.notifyChannel, {
    push: async () => (await pushToAll(env, { title: "Garda", body: text, url: "/app/#/ty/trener", tag: "coach", kind: "coach" }, { ttlS: 86400 })).sent,
    telegram: hasTelegram(env)
      ? async () => {
          await sendTelegram(env, text);
          return true;
        }
      : null,
  });
}

// ---------------- akcje przycisków w powiadomieniu o posiłku ----------------

const REMINDER_VALID_S = 6 * 3600;

/** Podpisany token, którym przyciski w powiadomieniu (Pominąłem / Za godzinę) mogą zmienić stan przypomnienia bez logowania. */
export async function reminderToken(env: Env, date: string, slotKey: string, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + REMINDER_VALID_S;
  return `${date}|${slotKey}|${exp}.${await hmacHex(env.MCP_PASSWORD, `reminder:${date}|${slotKey}|${exp}`)}`;
}

export async function verifyReminderToken(env: Env, token: string, nowMs = Date.now()): Promise<{ date: string; slotKey: string } | null> {
  const m = /^(\d{4}-\d{2}-\d{2})\|([a-z0-9]{1,14})\|(\d{9,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[3]) < nowMs / 1000) return null;
  return safeEqual(m[4], await hmacHex(env.MCP_PASSWORD, `reminder:${m[1]}|${m[2]}|${m[3]}`)) ? { date: m[1], slotKey: m[2] } : null;
}
