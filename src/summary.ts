/**
 * Dane dla aplikacji: podsumowanie dnia (jedzenie, trening dziś i jutro, pogoda, regeneracja, waga) z rekomendacjami,
 * widok tygodnia i plan treningów. Każde źródło danych jest opcjonalne: gdy któreś zawiedzie, reszta nadal się pokazuje,
 * a powód ląduje w polu "errors".
 */
import { dayInfo, dayOverview, garminClient } from "./diet";
import { Icu } from "./icu";
import { loadAnchors } from "./anchors";
import { currentLocation, weatherLocation } from "./loc";
import { DAY_TYPE_PL, goalProgress, sumMacros } from "./nutrition";
import { greeting, recommend } from "./recommend";
import { proposeLoops } from "./routes";
import { coach } from "./telegram";
import { addDays, daysBetween, warsaw } from "./time";
import { type DayForecast, fetchForecast } from "./weather";

export const MARATHON = { date: "2027-04-25", goal: "poniżej 4:30:00", pace: "ok. 6:23/km" };

const isRun = (x: any) => /run/i.test(String(x?.type ?? ""));
const km = (m: unknown) => (typeof m === "number" && m > 0 ? Math.round(m / 100) / 10 : null);

export interface PlanItem {
  id: number | null;
  date: string;
  name: string;
  type: string;
  km: number | null;
  minutes: number | null;
  description: string;
}

export function planItem(e: any): PlanItem {
  return {
    id: typeof e.id === "number" ? e.id : null,
    date: String(e.start_date_local ?? "").slice(0, 10),
    name: String(e.name ?? "Trening"),
    type: String(e.type ?? ""),
    km: km(e.distance),
    minutes: typeof e.moving_time === "number" ? Math.round(e.moving_time / 60) : null,
    description: String(e.description ?? "").slice(0, 600),
  };
}

const workouts = (events: any[]) => (events ?? []).filter((e) => !e?.category || e.category === "WORKOUT");

function activityItem(a: any) {
  const dist = km(a.distance ?? a.icu_distance);
  const secs = a.moving_time as number | undefined;
  return {
    id: String(a.id),
    date: String(a.start_date_local ?? "").slice(0, 10),
    time: String(a.start_date_local ?? "").slice(11, 16),
    name: String(a.name ?? "Aktywność"),
    type: String(a.type ?? ""),
    km: dist,
    minutes: secs ? Math.round(secs / 60) : null,
    paceMinPerKm: dist && secs ? Math.round((secs / dist / 60) * 100) / 100 : null,
    avgHr: typeof a.average_heartrate === "number" ? Math.round(a.average_heartrate) : null,
  };
}

const settled = async <T,>(errors: string[], label: string, p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    errors.push(`${label}: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`);
    return null;
  }
};

export async function buildSummary(env: Env) {
  const now = new Date();
  const local = warsaw(now);
  const today = local.date;
  const tomorrow = addDays(today, 1);
  const errors: string[] = [];
  const st = coach(env);
  const icu = new Icu(env.INTERVALS_API_KEY, env.INTERVALS_ATHLETE_ID);
  const g = garminClient(env);
  const loc = await weatherLocation(env).catch(() => null);

  const [food, tomorrowInfo, events, acts, forecast, readiness, weights, cfg] = await Promise.all([
    settled(errors, "jedzenie", dayOverview(env, today)),
    settled(errors, "jutro", dayInfo(env, tomorrow)),
    settled(errors, "plan", icu.events(today, addDays(today, 4))),
    settled(errors, "aktywności", icu.activities(addDays(today, -1), today)),
    loc ? settled(errors, "pogoda", fetchForecast(loc.lat, loc.lon, 3, ["poranek", "poludnie", "wieczor"])) : Promise.resolve(null),
    g ? settled(errors, "Garmin", g.readiness(today, today)) : Promise.resolve(null),
    st.getWeights(),
    st.getNutCfg(),
  ]);

  const plan = workouts(events ?? []).map(planItem);
  const todayPlan = plan.filter((p) => p.date === today);
  const tomorrowPlan = plan.filter((p) => p.date === tomorrow);
  const done = (acts ?? []).filter((a: any) => String(a.start_date_local ?? "").startsWith(today)).map(activityItem);
  const doneRun = done.some((a) => isRun({ type: a.type }) && (a.km ?? 0) >= 1);

  const wd = (forecast ?? []) as DayForecast[];
  const weather = { today: wd.find((d) => d.data === today) ?? null, tomorrow: wd.find((d) => d.data === tomorrow) ?? null };

  const day0 = (readiness as any[] | null)?.find((d) => d?.data === today) ?? null;
  const recovery = day0
    ? {
        sleepH: day0.sen?.godziny ?? null,
        sleepScore: day0.sen?.ocena ?? null,
        bbPeak: day0.body_battery?.szczyt_po_nocy ?? null,
        bbNow: day0.body_battery?.teraz ?? null,
        hrv: day0.hrv?.ostatnia_noc ?? null,
        hrvStatus: day0.hrv?.status ?? null,
        restingHr: day0.tetno_spoczynkowe ?? null,
        steps: day0.kroki ?? null,
      }
    : null;

  const gp = goalProgress(weights, cfg.goalWeightKg, today, cfg.goalDate);
  const weight = {
    last: gp.last,
    goalKg: cfg.goalWeightKg,
    goalDate: cfg.goalDate,
    toGoKg: gp.toGoKg,
    planKgToday: gp.planKgToday,
    aheadKg: gp.aheadKg,
    requiredKgPerWeek: gp.requiredKgPerWeek,
    trendKgPerWeek: gp.trendKgPerWeek,
    daysSinceWeighIn: gp.daysSinceWeighIn,
    weeksLeft: gp.weeksLeft,
  };

  const recommendations = recommend({
    now: { date: today, hour: local.hour, minute: local.minute },
    food: {
      kcal: food?.totals.kcal ?? 0,
      protein: food?.totals.protein ?? 0,
      carbs: food?.totals.carbs ?? 0,
      fat: food?.totals.fat ?? 0,
      mealsCount: food?.meals.length ?? 0,
      targets: food?.targets ? { kcal: food.targets.kcal, protein: food.targets.protein, carbs: food.targets.carbs, fat: food.targets.fat, deficit: food.targets.deficit } : null,
      dayType: food?.dayType ?? "rest",
      targetNote: food?.targets?.note ?? null,
    },
    tomorrow: { dayType: tomorrowInfo?.dayType ?? "rest", events: tomorrowPlan.filter((p) => isRun(p)).map((p) => ({ name: p.name, km: p.km })), known: events !== null },
    today: { planned: todayPlan.filter((p) => isRun(p)).map((p) => ({ name: p.name, km: p.km })), doneRun },
    weather,
    recovery: recovery ? { sleepH: recovery.sleepH, bbPeak: recovery.bbPeak, hrvStatus: recovery.hrvStatus } : null,
    weight: { daysSinceWeighIn: gp.daysSinceWeighIn, aheadKg: gp.aheadKg, requiredKgPerWeek: gp.requiredKgPerWeek, toGoKg: gp.toGoKg, goalKg: cfg.goalWeightKg },
  });

  return {
    generatedAt: now.toISOString(),
    now: { date: today, time: local.time, weekdayPl: local.weekdayPl },
    greeting: greeting(local.hour),
    marathon: { ...MARATHON, daysLeft: daysBetween(today, MARATHON.date) },
    food,
    training: {
      today: { planned: todayPlan, done },
      tomorrow: { dayType: tomorrowInfo?.dayType ?? null, dayTypeLabel: tomorrowInfo ? DAY_TYPE_PL[tomorrowInfo.dayType] : null, planned: tomorrowPlan },
      upcoming: plan.filter((p) => p.date > tomorrow),
    },
    weather,
    recovery,
    weight,
    recommendations,
    errors,
  };
}

/** Plan treningów: najbliższe dwa tygodnie z intervals.icu, ostatnie aktywności i pogoda na kilka dni. */
export async function buildPlan(env: Env) {
  const today = warsaw().date;
  const errors: string[] = [];
  const icu = new Icu(env.INTERVALS_API_KEY, env.INTERVALS_ATHLETE_ID);
  const loc = await weatherLocation(env).catch(() => null);
  const [events, acts, forecast] = await Promise.all([
    settled(errors, "plan", icu.events(today, addDays(today, 14))),
    settled(errors, "aktywności", icu.activities(addDays(today, -14), today)),
    loc ? settled(errors, "pogoda", fetchForecast(loc.lat, loc.lon, 5, ["poranek", "wieczor"])) : Promise.resolve(null),
  ]);
  const upcoming = workouts(events ?? []).map(planItem).sort((a, b) => a.date.localeCompare(b.date));
  const recent = (acts ?? []).map(activityItem).sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  const week = (from: string) => recent.filter((a) => isRun({ type: a.type }) && a.date >= from && a.date <= today).reduce((s, a) => s + (a.km ?? 0), 0);
  return {
    today,
    upcoming,
    recent,
    weather: (forecast ?? []) as DayForecast[],
    runKmLast7: Math.round(week(addDays(today, -6)) * 10) / 10,
    runKmLast14: Math.round(week(addDays(today, -13)) * 10) / 10,
    errors,
  };
}

/** Widok tygodnia: dla 7 ostatnich dni spożycie względem celu i spalanie z Garmina. */
export async function buildWeek(env: Env) {
  const today = warsaw().date;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(today, -6 + i));
  const st = coach(env);
  const g = garminClient(env);
  const errors: string[] = [];
  const [byDate, energy] = await Promise.all([
    st.getMealsRange(dates),
    g ? settled(errors, "Garmin", g.energy(dates[0], today)) : Promise.resolve(null),
  ]);
  const infos = await Promise.all(dates.map((d) => settled(errors, `cele ${d}`, dayInfo(env, d))));
  const days = dates.map((d, i) => {
    const meals = byDate[d] ?? [];
    const t = sumMacros(meals.map((m) => m.totals));
    const target = infos[i]?.targets ?? null;
    return {
      date: d,
      weekdayPl: warsaw(new Date(`${d}T12:00:00Z`)).weekdayPl,
      meals: meals.length,
      kcal: t.kcal,
      protein: t.protein,
      carbs: t.carbs,
      fat: t.fat,
      targetKcal: target?.kcal ?? null,
      targetProtein: target?.protein ?? null,
      dayTypeLabel: infos[i] ? DAY_TYPE_PL[infos[i]!.dayType] : null,
      burnedKcal: energy?.[d]?.total ?? null,
      activeKcal: energy?.[d]?.active ?? null,
      partial: d === today,
    };
  });
  const logged = days.filter((d) => d.meals >= 2 && d.kcal >= 1000 && !d.partial);
  const avg = (f: (d: (typeof days)[number]) => number) => (logged.length ? Math.round(logged.reduce((s, d) => s + f(d), 0) / logged.length) : null);
  return { days, loggedDays: logged.length, avgKcal: avg((d) => d.kcal), avgProtein: avg((d) => d.protein), errors };
}

/** Dwie propozycje pętli o zadanym dystansie z punktu startu (dom lub udostępniona lokalizacja). */
export async function buildRoutes(env: Env, distanceKm: number, origin: string) {
  if (!env.ORS_API_KEY) return { error: "no_ors_key", message: "Trasy niedostępne: brak sekretu ORS_API_KEY (instrukcja w SETUP-TRENER.md)." } as const;
  const loc = await currentLocation(env);
  if (!loc) return { error: "no_start", message: "Brak punktu startu: ustaw adres domowy na stronie /setup albo udostępnij lokalizację na Telegramie." } as const;
  const st = coach(env);
  const fromHome = loc.kind === "dom";
  const { anchors, info } = await loadAnchors(env, loc.point, distanceKm, "interactive");
  const options = await proposeLoops(env.ORS_API_KEY, loc.point, distanceKm, anchors);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await st.saveProposal({ id, created: new Date().toISOString(), target_km: distanceKm, start: loc.point, start_label: fromHome ? "dom" : "udostępniona lokalizacja", options });
  return {
    proposalId: id,
    start: fromHome ? "dom" : "udostępniona lokalizacja",
    note: anchors.length ? null : `Brak danych o parkach (${info}); trasy z OpenRouteService.`,
    options: options.map((o) => ({
      label: o.label,
      km: o.distance_km,
      unpavedPct: o.unpaved_pct,
      pavedPct: o.paved_pct,
      greenAvg: o.green_avg,
      retracePct: o.retrace_pct,
      kind: o.source === "parki" ? "park" : "ors",
      via: o.via ?? null,
      mapUrl: `${origin}/trasa/${id}/${o.label}`,
      gpxUrl: `${origin}/trasa/${id}/${o.label}.gpx`,
    })),
  } as const;
}
