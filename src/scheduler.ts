import { Icu, compactActivity } from "./icu";
import { coach } from "./telegram";
import { addDays, fmtWarsaw, warsaw } from "./time";

/**
 * Runs every 15 minutes (Cloudflare Cron Trigger, free). No AI here: it only decides whether there
 * is a reason to wake the coach, and if so fires the Claude Code scheduled task once.
 */

const PULSES: { name: string; reason: string; at: (weekday: string) => string }[] = [
  { name: "poranek", reason: "PORANNY_PRZEGLAD", at: (wd) => (wd === "Sun" ? "07:30" : "06:45") },
  { name: "wieczor", reason: "WIECZORNY_PRZEGLAD", at: () => "20:15" },
];

const ACTIVE_FROM_HOUR = 6;
const ACTIVE_TO_HOUR = 22;

export async function runScheduler(env: Env) {
  const now = new Date();
  const local = warsaw(now);
  if (local.hour < ACTIVE_FROM_HOUR || local.hour >= ACTIVE_TO_HOUR) return;

  const state = coach(env);
  const reasons: string[] = [];

  // 1. New runs synced from Garmin.
  try {
    const icu = new Icu(env.INTERVALS_API_KEY, env.INTERVALS_ATHLETE_ID);
    const acts = (await icu.activities(addDays(local.date, -2))) ?? [];
    const mem = await state.getMemory();
    const ids = acts.map((a: any) => String(a.id));
    const fresh = acts.filter((a: any) => !mem.knownActivities.includes(String(a.id)));
    if (mem.knownActivities.length === 0) {
      // First run ever: remember what exists, don't announce old runs.
      await state.setKnownActivities(ids);
    } else if (fresh.length) {
      await state.setKnownActivities([...mem.knownActivities, ...fresh.map((a: any) => String(a.id))]);
      for (const a of fresh) {
        const c = compactActivity(a);
        reasons.push(`NOWA_AKTYWNOSC ${c.id} (${c.type}, ${c.start}, ${c.distance_km ?? "?"} km)`);
      }
    }
  } catch (e) {
    console.error("activity poll failed", e);
  }

  // 2. Daily pulses.
  const mem = await state.getMemory();
  for (const p of PULSES) {
    if (local.time >= p.at(local.weekday) && mem.pulses[p.name] !== local.date) {
      await state.markPulse(p.name, local.date);
      reasons.push(`${p.reason} (${local.weekdayPl})`);
    }
  }

  // 3. Check-ins the coach scheduled for itself.
  for (const c of await state.takeDueCheckIns(now.toISOString())) {
    reasons.push(`UMOWIONE_SPRAWDZENIE z ${fmtWarsaw(c.at)}: ${c.reason}`);
  }

  await state.queueWake(reasons, 0);
}
