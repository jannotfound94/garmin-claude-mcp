/**
 * Waga z inteligentnej wagi trafia przez Google Fit do intervals.icu (Wellness: waga i tkanka tłuszczowa). Stąd raz na jakiś
 * czas dopisujemy ją do Gardy. Ręczny wpis Janka zawsze wygrywa: automat nie nadpisuje dnia, w którym waga została wpisana ręcznie.
 */
import { Icu } from "./icu";
import type { Weight } from "./nutrition";
import { coach } from "./telegram";
import { addDays, daysBetween, warsaw } from "./time";

const DAYS_BACK = 13;
const MIN_KG = 30;
const MAX_KG = 250;
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Czysta logika: które wpisy z "wellness" intervals.icu trzeba dopisać lub zaktualizować. */
export function pickWeights(wellness: any[], existing: Weight[], today: string): Weight[] {
  const byDate = new Map(existing.map((w) => [w.date, w]));
  const out: Weight[] = [];
  for (const w of wellness) {
    const date = typeof w?.id === "string" ? w.id : "";
    const kg = num(w?.weight);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || kg === null || kg < MIN_KG || kg > MAX_KG) continue;
    const d = daysBetween(date, today);
    if (d < 0 || d > DAYS_BACK) continue; // przyszłość i zbyt stare dane pomijamy
    const fat = num(w?.bodyFat);
    const fatPct = fat !== null && fat >= 3 && fat <= 70 ? r1(fat) : undefined;
    const cur = byDate.get(date);
    if (cur && cur.src !== "auto") continue; // wpis ręczny
    if (cur && cur.kg === r1(kg) && cur.fatPct === fatPct) continue; // bez zmian
    out.push({ date, kg: r1(kg), src: "auto", ...(fatPct !== undefined ? { fatPct } : {}) });
  }
  return out;
}

/**
 * Pobiera wagę z intervals.icu i zapisuje nowe pomiary. maxAgeMs ogranicza częstotliwość zapytań (cron wołamy co 15 minut,
 * aplikacja przy każdym otwarciu). notify: powiadomienie o nowym dzisiejszym pomiarze (tylko z crona, nie przy otwarciu aplikacji).
 */
export async function syncWeights(env: Env, opts: { maxAgeMs?: number; notify?: boolean } = {}): Promise<{ added: number; skipped: "no_keys" | "fresh" | null }> {
  if (!env.INTERVALS_API_KEY || !env.INTERVALS_ATHLETE_ID) return { added: 0, skipped: "no_keys" };
  const st = coach(env);
  const now = Date.now();
  const last = await st.getWeightSyncAt();
  if (opts.maxAgeMs && last && now - last < opts.maxAgeMs) return { added: 0, skipped: "fresh" };
  await st.setWeightSyncAt(now); // zapis przed zapytaniem: awaria intervals.icu nie powoduje serii powtórzeń
  const today = warsaw().date;
  const wellness = (await new Icu(env.INTERVALS_API_KEY, env.INTERVALS_ATHLETE_ID).wellness(addDays(today, -DAYS_BACK), today)) ?? [];
  const fresh = pickWeights(wellness, await st.getWeights(), today);
  for (const w of fresh) await st.addWeight(w);
  const todays = fresh.find((w) => w.date === today);
  if (opts.notify && todays) {
    const { notifySystem } = await import("./notify");
    await notifySystem(env, { title: "Waga zapisana", body: `${String(todays.kg).replace(".", ",")} kg z wagi${todays.fatPct ? `, tkanka tłuszczowa ${String(todays.fatPct).replace(".", ",")}%` : ""}.`, url: "/app/#/ty/postep", tag: "weight", kind: "coach" }).catch((e) => console.error("weight notify", e));
  }
  return { added: fresh.length, skipped: null };
}
