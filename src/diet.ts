/**
 * Dietetyk w Telegramie: zdjęcie/opis posiłku -> Gemini -> zapis w Durable Object -> odpowiedź z przyciskami.
 * Do zadań Claude'a (podsumowania, rozmowa) służy getNutrition w index.ts, który korzysta z nutritionReport().
 */
import { GarminPersonal } from "./garmin";
import { Icu } from "./icu";
import { GeminiTransientError, analyzeMeal, applyBarcode, toBase64 } from "./gemini";
import {
  CONFIDENCE_PL,
  DAY_TYPE_PL,
  type DayType,
  type DietJob,
  type EnergyBase,
  GARMIN_ACTIVE_HAIRCUT,
  RUN_KCAL_PER_KG_KM,
  DEFAULT_RUN_KM,
  type Macros,
  type Meal,
  type NutritionConfig,
  type Targets,
  classifyDay,
  computeTargets,
  estimateTdee,
  goalProgress,
  evaluateReminders,
  fmtMacros,
  hhmmToMin,
  isLoggedDay,
  labelForTime,
  newMealId,
  overallConfidence,
  parseSlots,
  r0,
  r1,
  reminderDueMin,
  satisfiedSlots,
  slotKey,
  slotsFor,
  sumMacros,
  weightStats,
} from "./nutrition";
import { coach, tg } from "./telegram";
import { addDays, daysBetween, warsaw } from "./time";

export function garminClient(env: Env): GarminPersonal | null {
  if (!env.GARMIN_PERSONAL_API_KEY) return null;
  const state = coach(env);
  return new GarminPersonal(env.GARMIN_PERSONAL_API_KEY, () => state.getGarminToken(), (t) => state.setGarminToken(t));
}

const weekdayOf = (date: string) => warsaw(new Date(`${date}T12:00:00Z`)).weekday;
const chatId = (env: Env) => env.TELEGRAM_CHAT_ID;

async function say(env: Env, text: string, buttons?: { text: string; callback_data: string }[][], html = false): Promise<number | null> {
  const res = await tg(env, "sendMessage", {
    chat_id: chatId(env),
    text: text.slice(0, 4000),
    ...(html ? { parse_mode: "HTML" } : {}),
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  return typeof res?.message_id === "number" ? res.message_id : null;
}

// ---------------- dzień: typ treningu i cele ----------------

export interface DayInfo {
  date: string;
  dayType: DayType;
  dayTypeWhy: string;
  weightKg: number | null;
  targets: Targets | null;
  base: EnergyBase | null;
  runKm: number | null;
  activeTodayKcal: number | null;
  cfg: NutritionConfig;
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Rzeczywiste dzienne zapotrzebowanie, od którego liczymy cel kcal: kalibracja z wagi i spożycia, gdy są dane (≥ 3 tygodnie),
 * w przeciwnym razie średnia spalania z Garmina z 14 dni (spoczynkowe + aktywne × 0,85). Bez żadnego z nich: null.
 */
export async function energyBase(env: Env, today: string): Promise<EnergyBase | null> {
  const st = coach(env);
  const dates = Array.from({ length: 28 }, (_, i) => addDays(today, -27 + i));
  const [byDate, weights] = await Promise.all([st.getMealsRange(dates), st.getWeights()]);
  const cal = estimateTdee(
    dates.map((d) => ({ date: d, kcal: sumMacros((byDate[d] ?? []).map((m) => m.totals)).kcal, meals: (byDate[d] ?? []).length })),
    weights,
    today,
  );
  if (cal.ready) return { kcal: cal.tdeeKcal, source: "kalibracja" };

  // Klucz z wersją: zmiana sposobu liczenia nie może zwracać starej wartości z pamięci podręcznej.
  const cached = await st.getCache(`energybase:v3:${today}`, 6 * 3600_000);
  if (cached) {
    const c = JSON.parse(cached) as EnergyBase;
    if (c.source !== "garmin" || c.detail) return c;
  }
  const g = garminClient(env);
  if (!g) return null;
  const rows = Object.values(await g.energy(addDays(today, -14), addDays(today, -1))).filter(
    (e) => e.total && e.total > 0 && e.resting != null && e.active != null,
  );
  if (rows.length < 5) return null;
  // Mediana, nie średnia: pojedynczy dziwny dzień (np. błąd synchronizacji zegarka) nie zawyża celu.
  const day = rows.map((e) => e.resting! + GARMIN_ACTIVE_HAIRCUT * e.active!);
  const base: EnergyBase = {
    kcal: r0(median(day)),
    source: "garmin",
    detail: {
      days: rows.length,
      resting: r0(median(rows.map((e) => e.resting!))),
      active: r0(median(rows.map((e) => e.active!))),
      // Spokojny dzień: mediana aktywnych kcal z ok. jednej trzeciej dni z najmniejszym wysiłkiem (min. 3).
      quietActive: r0(median([...rows].sort((a, b) => a.active! - b.active!).slice(0, Math.max(3, Math.round(rows.length / 3))).map((e) => e.active!))),
      min: r0(Math.min(...day)),
      max: r0(Math.max(...day)),
    },
  };
  await st.setCache(`energybase:v3:${today}`, JSON.stringify(base));
  return base;
}

/** Typ dnia z planu i aktywności (intervals.icu, cache 20 min) + cele z zapotrzebowania i masy ciała. */
export async function dayInfo(env: Env, date: string): Promise<DayInfo> {
  const st = coach(env);
  const [cfg, weights] = await Promise.all([st.getNutCfg(), st.getWeights()]);
  const weightKg = weightStats(weights, date).last?.kg ?? cfg.weightFallbackKg;
  let cls: { type: DayType; why: string; km?: number } | null = null;
  const cached = await st.getCache(`daytype:${date}`, 20 * 60_000);
  if (cached) cls = JSON.parse(cached);
  else {
    try {
      const icu = new Icu(env.INTERVALS_API_KEY, env.INTERVALS_ATHLETE_ID);
      const [events, acts] = await Promise.all([icu.events(date, date), icu.activities(date, date)]);
      const onDay = (x: any) => String(x?.start_date_local ?? "").slice(0, 10) === date;
      cls = classifyDay((events ?? []).filter(onDay), (acts ?? []).filter(onDay));
      await st.setCache(`daytype:${date}`, JSON.stringify(cls));
    } catch (e) {
      cls = { type: "easy", why: `brak danych z intervals.icu (${String(e).slice(0, 60)}), przyjęto łatwy dzień` };
    }
  }
  // Garmin nie ma własnego limitu czasu, a siedzimy w budżecie ~30 s pracy w tle: po 6 s cele liczą się bez niego.
  const timeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 6000))]).catch(() => null);
  const base = await timeout(energyBase(env, date));
  // Dzisiejsze aktywne kcal z Garmina (cząstkowe do końca dnia): gdy przekraczają plan, cel rośnie do faktycznego spalania.
  const activeTodayKcal = base?.source === "garmin" && date === warsaw().date ? await timeout(activeToday(env, date)) : null;
  const runKm = cls!.km ?? null;
  return {
    date,
    dayType: cls!.type,
    dayTypeWhy: cls!.why,
    weightKg,
    targets: computeTargets(cfg, weightKg, cls!.type, base, { runKm, activeTodayKcal }),
    base,
    runKm,
    activeTodayKcal,
    cfg,
  };
}

/** Aktywne kcal Garmina z dzisiejszego dnia do tej pory (pamięć podręczna 10 min). */
async function activeToday(env: Env, date: string): Promise<number | null> {
  const st = coach(env);
  const cached = await st.getCache(`activetoday:${date}`, 10 * 60_000);
  if (cached) return JSON.parse(cached) as number | null;
  const g = garminClient(env);
  if (!g) return null;
  const v = (await g.energy(date, date))[date]?.active ?? null;
  if (v != null) await st.setCache(`activetoday:${date}`, JSON.stringify(v));
  return v;
}

/** Przegląd dnia dla aplikacji: typ dnia, cele, spożycie, posiłki ze składnikami i spalanie z Garmina. */
export async function dayOverview(env: Env, date: string) {
  const st = coach(env);
  const [meals, info] = await Promise.all([st.getMeals(date), dayInfo(env, date)]);
  const totals = sumMacros(meals.map((m) => m.totals));
  let garmin: { resting: number | null; active: number | null; total: number | null; partial: boolean } | null = null;
  const g = garminClient(env);
  if (g) {
    try {
      const e = (await g.energy(date, date))[date];
      if (e) garmin = { ...e, partial: date === warsaw().date };
    } catch {
      /* Garmin opcjonalny */
    }
  }
  const t = info.targets;
  return {
    date,
    dayType: info.dayType,
    dayTypeLabel: DAY_TYPE_PL[info.dayType],
    dayTypeWhy: info.dayTypeWhy,
    runKm: info.runKm,
    weightKg: info.weightKg,
    targets: t ? { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, deficit: t.deficitApplied, source: t.source, note: t.note } : null,
    totals,
    left: t ? { kcal: t.kcal - totals.kcal, protein: t.protein - totals.protein, carbs: t.carbs - totals.carbs, fat: t.fat - totals.fat } : null,
    meals: meals.map((m) => ({
      id: m.id,
      time: m.time,
      label: m.label,
      slot: m.slot ?? null,
      source: m.source,
      confidence: m.confidence,
      note: m.note,
      question: m.question,
      totals: m.totals,
      items: m.items.map((i) => ({ name: i.name, grams: i.grams, kcal: i.kcal, protein: i.protein, carbs: i.carbs, fat: i.fat, confidence: i.confidence, label: i.basis === "label" })),
    })),
    garmin,
    activeTodayKcal: info.activeTodayKcal,
    baseSource: info.base?.source ?? null,
    deficitKcal: info.cfg.deficitKcal,
  };
}

const pl = (n: number) => String(n).replace(".", ",");
const sign = (n: number) => (n > 0 ? `+${r0(n)}` : `${r0(n)}`);

/** Escape do trybu HTML Telegrama (nazwy produktów, notatki i pytania modelu mogą zawierać < > &). */
const h = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const bar = (have: number, target: number) => {
  const n = target > 0 ? Math.max(0, Math.min(10, Math.round((have / target) * 10))) : 0;
  return "▰".repeat(n) + "▱".repeat(10 - n);
};

/** Blok "Dziś": spożycie vs cele, każde makro w osobnej linii. */
function dayBlock(have: Macros, info: DayInfo | null, title = "Dziś"): string[] {
  const t = info?.targets;
  if (!t) {
    return [`📊 <b>${title}</b>: ${h(fmtMacros(have))}`, ...(info ? ["ℹ️ Cele pojawią się po wpisaniu wagi: /waga 82,5"] : [])];
  }
  const left = t.kcal - have.kcal;
  const lines = [
    `📊 <b>${title}</b> · ${h(DAY_TYPE_PL[t.dayType])}`,
    `🔥 <b>${r0(have.kcal)}</b> / ${t.kcal} kcal`,
    `${bar(have.kcal, t.kcal)}  ${Math.round((have.kcal / t.kcal) * 100)}% · ${left >= 0 ? `zostało ${r0(left)} kcal` : `ponad celem o ${r0(-left)} kcal`}`,
    `🥩 Białko: ${r0(have.protein)} / ${t.protein} g`,
    `🍞 Węglowodany: ${r0(have.carbs)} / ${t.carbs} g`,
    `🥑 Tłuszcz: ${r0(have.fat)} / ${t.fat} g`,
  ];
  if (t.deficitApplied > 0) lines.push(`🎯 Cel uwzględnia deficyt ${t.deficitApplied} kcal (redukcja)`);
  if (t.note) lines.push(`ℹ️ ${h(t.note)}`);
  return lines;
}

// ---------------- komunikaty ----------------

function mealMessage(meal: Meal, slotName: string, dayTotals: Macros, info: DayInfo | null, extra: string[] = []): string {
  const lines = [`🍽 <b>${h(slotName)}</b> · ${meal.time}`, `<i>${h(meal.label)}</i>`, "", "<b>Składniki</b>"];
  for (const it of meal.items) {
    lines.push(
      `• <b>${h(it.name)}</b>${it.grams ? ` · ${it.grams} g` : ""}${it.basis === "label" ? " 🏷" : ""}${it.confidence === "low" ? " (?)" : ""}`,
      `     ${it.kcal} kcal · B ${r0(it.protein)} · W ${r0(it.carbs)} · T ${r0(it.fat)}`,
    );
  }
  lines.push(
    "",
    `<b>Ten posiłek: ${r0(meal.totals.kcal)} kcal</b>`,
    `B ${r0(meal.totals.protein)} · W ${r0(meal.totals.carbs)} · T ${r0(meal.totals.fat)} g · pewność: ${CONFIDENCE_PL[meal.confidence]}`,
    "",
    ...dayBlock(dayTotals, info),
  );
  if (extra.length) lines.push("", ...extra.map(h));
  if (meal.question) lines.push("", `❓ <b>${h(meal.question)}</b>`);
  lines.push("", "✏️ <i>Poprawka? Odpowiedz na tę wiadomość (np. „to było 200 g”).</i>");
  return lines.join("\n");
}

const mealButtons = (id: string) => [
  [
    { text: "🗑 Usuń", callback_data: `m:del:${id}` },
    { text: "⭐ Ulubione", callback_data: `m:fav:${id}` },
  ],
];

// ---------------- zapis posiłku ----------------

export async function slotNamesFor(env: Env, date: string): Promise<string[]> {
  const cfg = await coach(env).getNutCfg();
  return slotsFor(cfg, weekdayOf(date)).map((x) => x.name);
}

export interface MealCtx {
  source: Meal["source"];
  note: string;
  photoFileId?: string;
  msgUnix: number;
}

export async function buildAndSaveMeal(env: Env, a: Awaited<ReturnType<typeof analyzeMeal>>, c: MealCtx): Promise<{ meal: Meal; slotName: string; extra: string[] }> {
  const st = coach(env);
  const at = warsaw(new Date(c.msgUnix * 1000));
  const date = a.dayOffset === -1 ? addDays(at.date, -1) : at.date;
  const time = a.eatenTime ?? at.time;
  const { items, used } = await applyBarcode(a.items, a.barcode);
  const cfg = await st.getNutCfg();
  const slotName = a.slot ?? labelForTime(slotsFor(cfg, weekdayOf(date)), time, cfg.remindAfterMin);
  const meal: Meal = {
    id: newMealId(date),
    date,
    time,
    label: a.label,
    source: c.source,
    note: c.note,
    items,
    totals: sumMacros(items),
    confidence: overallConfidence(items),
    question: a.question,
    ...(a.slot ? { slot: a.slot } : {}),
    ...(c.photoFileId ? { photoFileId: c.photoFileId } : {}),
    createdAt: new Date().toISOString(),
  };
  await st.saveMeal(meal);
  return {
    meal,
    slotName,
    extra: [
      ...(used ? [`🏷 Wartości z bazy Open Food Facts: ${used}`] : []),
      ...(a.comment ? [`💬 ${a.comment}`] : []),
      ...(date !== at.date ? [`📅 Zapisano na ${date}.`] : []),
    ],
  };
}

async function storeAndAnnounce(env: Env, a: Awaited<ReturnType<typeof analyzeMeal>>, c: MealCtx) {
  const r = await buildAndSaveMeal(env, a, c);
  await announce(env, r.meal, r.slotName, r.extra);
}

async function announce(env: Env, meal: Meal, slotName: string, extra: string[] = []) {
  const st = coach(env);
  const day = sumMacros((await st.getMeals(meal.date)).map((m) => m.totals));
  const info = await dayInfo(env, meal.date).catch(() => null);
  const id = await say(env, mealMessage(meal, slotName, day, info, extra), mealButtons(meal.id), true);
  if (id) await st.rememberMealMessage(id, meal.id);
}

const mimeOf = (path: string) => (/\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg");

async function downloadTelegramFile(env: Env, fileId: string): Promise<{ b64: string; mime: string }> {
  const info = await tg(env, "getFile", { file_id: fileId });
  if (!info?.file_path) throw new Error("Telegram nie zwrócił ścieżki pliku (plik za duży?)");
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Pobranie zdjęcia: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 15 * 1024 * 1024) throw new Error("Zdjęcie jest za duże (max 15 MB)");
  return { b64: toBase64(buf), mime: mimeOf(info.file_path) };
}

const FAIL_HINT = "Spróbuj za chwilę jeszcze raz albo wrzuć posiłek tekstem: /jem 2 jajka, kromka chleba, masło";

async function guard(env: Env, what: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.error(`diet:${what}`, e);
    const msg = String(e instanceof Error ? e.message : e).replace(/key=[^&\s]+/g, "key=…").slice(0, 180);
    const text =
      e instanceof GeminiTransientError
        ? `⚠️ Gemini nadal nie odpowiada mimo kilku prób (${what}). Wrzuć to jeszcze raz za kilka minut albo wpisz posiłek tekstem: /jem 2 jajka, kromka chleba, masło\n(${msg})`
        : `⚠️ Ups, coś nie pykło (${what}): ${msg}\n${FAIL_HINT}`;
    await say(env, text).catch(() => {});
  }
}

async function needGemini(env: Env): Promise<boolean> {
  if (env.GEMINI_API_KEY) return false;
  await say(env, "Rozpoznawanie posiłków nie jest jeszcze włączone: brakuje sekretu GEMINI_API_KEY (instrukcja w SETUP-DIETETYK.md).");
  return true;
}

/** Opcje czasu dla ponowień w tle (budzik Durable Object nie ma 30-sekundowego limitu pracy po odpowiedzi do Telegrama). */
interface MealRun {
  budgetMs?: number;
  attemptCapMs?: number;
}

async function logPhoto(env: Env, fileId: string, note: string, unix: number, run: MealRun) {
  if (await needGemini(env)) return;
  await tg(env, "sendChatAction", { chat_id: chatId(env), action: "typing" }).catch(() => {});
  const image = await downloadTelegramFile(env, fileId);
  const now = warsaw(new Date(unix * 1000));
  const a = await analyzeMeal(env, { image, note, nowLocal: now, slotNames: await slotNamesFor(env, now.date), ...run });
  if (!a.isFood) {
    await say(env, "Janek, nie widzę tu żadnego jedzenia ani picia 🤔 Jak to jednak posiłek, dopisz opis: /jem …");
    return;
  }
  await storeAndAnnounce(env, a, { source: "photo", note, photoFileId: fileId, msgUnix: unix });
}

async function logText(env: Env, unix: number, text: string, run: MealRun) {
  if (await needGemini(env)) return;
  await tg(env, "sendChatAction", { chat_id: chatId(env), action: "typing" }).catch(() => {});
  const at = warsaw(new Date(unix * 1000));
  const a = await analyzeMeal(env, { note: text, nowLocal: at, slotNames: await slotNamesFor(env, at.date), ...run });
  if (!a.isFood) {
    await say(env, "Nie wyłapałem z tego nic do jedzenia. Napisz np.: /jem owsianka 60 g z mlekiem i bananem");
    return;
  }
  await storeAndAnnounce(env, a, { source: "text", note: text, msgUnix: unix });
}

/** Poprawka posiłku opisem Janka (Telegram i aplikacja). Bez wysyłania wiadomości. */
export async function applyCorrection(
  env: Env,
  mealId: string,
  text: string,
  unix: number,
  run: MealRun,
): Promise<{ status: "ok"; meal: Meal; slotName: string; extra: string[] } | { status: "missing" } | { status: "unclear" }> {
  const st = coach(env);
  const meal = await st.findMeal(mealId);
  if (!meal) return { status: "missing" };
  const a = await analyzeMeal(env, {
    note: text,
    previous: { label: meal.label, note: meal.note, items: meal.items },
    nowLocal: warsaw(new Date(unix * 1000)),
    slotNames: await slotNamesFor(env, meal.date),
    ...run,
  });
  if (!a.isFood) return { status: "unclear" };
  const { items, used } = await applyBarcode(a.items, a.barcode);
  const updated: Meal = {
    ...meal,
    label: a.label,
    items,
    totals: sumMacros(items),
    confidence: overallConfidence(items),
    question: a.question,
    slot: a.slot ?? meal.slot ?? null,
    note: [meal.note, text].filter(Boolean).join(" | ").slice(0, 600),
    time: a.eatenTime ?? meal.time, // data (a z nią id) zostaje: poprawka godziny nie przenosi posiłku na inny dzień
  };
  await st.saveMeal(updated);
  const cfg = await st.getNutCfg();
  return {
    status: "ok",
    meal: updated,
    slotName: updated.slot ?? labelForTime(slotsFor(cfg, weekdayOf(updated.date)), updated.time, cfg.remindAfterMin),
    extra: ["✏️ Poprawiono.", ...(used ? [`🏷 Wartości z bazy Open Food Facts: ${used}`] : [])],
  };
}

async function correctMeal(env: Env, mealId: string, text: string, unix: number, run: MealRun) {
  if (await needGemini(env)) return;
  if (!(await coach(env).findMeal(mealId))) {
    await say(env, "Nie widzę już tego posiłku, chyba został usunięty.");
    return;
  }
  await tg(env, "sendChatAction", { chat_id: chatId(env), action: "typing" }).catch(() => {});
  const r = await applyCorrection(env, mealId, text, unix, run);
  if (r.status === "missing") return void (await say(env, "Nie widzę już tego posiłku, chyba został usunięty."));
  if (r.status === "unclear") {
    return void (await say(env, "Nie załapałem tej poprawki, niczego nie zmieniłem. Napisz np.: „to było 200 g”, „bez sosu”, „to skyr naturalny”."));
  }
  await announce(env, r.meal, r.slotName, r.extra);
}

// ---------------- zadania ponawiane w tle ----------------

/** Opóźnienia kolejnych ponowień po chwilowej awarii Gemini (s): po 1 min, 2,5 min i 6,5 min. */
const RETRY_DELAYS_S = [60, 150, 400];
const BACKGROUND_RUN: MealRun = { budgetMs: 90_000, attemptCapMs: 45_000 };

const newJob = (kind: DietJob["kind"], at: number, extra: Partial<DietJob>): DietJob => ({
  id: crypto.randomUUID().slice(0, 8),
  kind,
  at,
  attempts: 0,
  nextAt: 0,
  ...extra,
});

const JOB_LABEL: Record<DietJob["kind"], string> = { photo: "Rozpoznanie zdjęcia", text: "Zapis posiłku", correct: "Poprawka posiłku" };

async function runMealTask(env: Env, job: DietJob) {
  const run = job.attempts > 0 ? BACKGROUND_RUN : {};
  if (job.kind === "photo") await logPhoto(env, job.fileId!, job.text ?? "", job.at, run);
  else if (job.kind === "text") await logText(env, job.at, job.text ?? "", run);
  else await correctMeal(env, job.mealId!, job.text ?? "", job.at, run);
}

/**
 * Jedna próba zadania. Gdy Gemini jest chwilowo niedostępny (przeciążenie, limit, timeout), zadanie trafia do kolejki
 * i wróci z budzika Durable Object; Jan dostaje jedną wiadomość o tym. Inne błędy lecą dalej do guard() (komunikat o błędzie).
 * Ponawiamy tylko błędy Gemini, które występują przed zapisem posiłku, więc ponowienie nie robi duplikatów.
 */
async function attemptJob(env: Env, job: DietJob) {
  try {
    await runMealTask(env, job);
  } catch (e) {
    if (!(e instanceof GeminiTransientError) || job.attempts >= RETRY_DELAYS_S.length) throw e;
    await coach(env).enqueueDietJob({ ...job, attempts: job.attempts + 1, nextAt: Date.now() + RETRY_DELAYS_S[job.attempts] * 1000 });
    if (job.attempts === 0) {
      await say(env, "⏳ Gemini jest chwilowo przeciążony. Spróbuję sam jeszcze kilka razy w ciągu paru minut, nic nie musisz robić (i nie wysyłaj tego drugi raz).").catch(() => {});
    }
  }
}

/** Wołane z budzika Durable Object dla zadań, których termin minął. */
export async function processDietJob(env: Env, job: DietJob): Promise<void> {
  await guard(env, JOB_LABEL[job.kind], () => attemptJob(env, job));
}

// ---------------- komendy ----------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const HELP = `🍽 Jak mnie używać, Janek
• Wrzuć zdjęcie posiłku (podpis pod nim to notatka) i ja ogarniam resztę.
• /jem 2 jajka, kromka chleba: to samo bez zdjęcia (działa też „zjadłem …”).
• Pomyłka? Odpowiedz na wiadomość z posiłkiem, np. „to było 200 g”.
• /dzis (albo /dzis wczoraj): co zjadłeś, cele, ile zostało · /usun 2: wywal posiłek nr 2
• /waga 106,5: waga i postęp do celu · /ulubione: szybkie dodawanie
• /posilki: Twoje pory jedzenia i przypomnienia · /cel: cele i ustawienia · /przypomnienia on|off
• /spalanie: spalanie z Garmina dzień po dniu (skąd biorą się kalorie w celach)`;

async function cmdToday(env: Env, arg: string) {
  const st = coach(env);
  const date = norm(arg).startsWith("wczoraj") ? addDays(warsaw().date, -1) : warsaw().date;
  const meals = await st.getMeals(date);
  const info = await dayInfo(env, date);
  const total = sumMacros(meals.map((m) => m.totals));
  const wd = warsaw(new Date(`${date}T12:00:00Z`)).weekdayPl;
  const lines = [`📅 <b>${h(wd)}, ${date}</b>`, ""];
  if (!meals.length) lines.push("Na razie pusto: nic jeszcze nie wpisałeś.");
  else {
    lines.push("<b>Posiłki</b>");
    meals.forEach((m, i) => {
      lines.push(`${i + 1}. <b>${m.time}</b> ${h(m.slot ?? m.label)}${m.slot ? ` · ${h(m.label)}` : ""}${m.confidence === "low" ? " (?)" : ""}`);
      lines.push(`     ${h(fmtMacros(m.totals))}`);
    });
  }
  lines.push("", ...dayBlock(total, info, "Podsumowanie"));
  try {
    const g = garminClient(env);
    const e = g ? (await g.energy(date, date))[date] : null;
    if (e?.total) {
      const today = date === warsaw().date;
      lines.push("", `⌚ <b>Garmin</b>${today ? " (dzień trwa)" : ""}`, `Spalone: ${r0(e.total)} kcal (spoczynkowe ${r0(e.resting ?? 0)} + aktywne ${r0(e.active ?? 0)})`);
      if (meals.length && !today) lines.push(`Zjedzone minus spalone: ${sign(total.kcal - e.total)} kcal`);
      lines.push("<i>Kalorie aktywne Garmina bywają zawyżone o 10–30%, bilans jest orientacyjny.</i>");
    }
  } catch {
    /* Garmin opcjonalny */
  }
  lines.push("", "<i>Usuń wpis: /usun numer</i>");
  await say(env, lines.join("\n"), undefined, true);
}

async function cmdDelete(env: Env, arg: string) {
  const st = coach(env);
  const n = Number(arg.trim());
  const meals = await st.getMeals(warsaw().date);
  if (!Number.isInteger(n) || n < 1 || n > meals.length) {
    await say(env, `Daj numer posiłku z /dzis (1–${meals.length || "?"}), np. /usun 2`);
    return;
  }
  const m = meals[n - 1];
  await st.deleteMeal(m.id);
  await say(env, `🗑 Wywaliłem: ${m.time} ${m.label} (${m.totals.kcal} kcal).`);
}

async function cmdWeight(env: Env, arg: string) {
  const kg = Number(arg.trim().replace(",", ".").replace(/kg$/i, ""));
  if (!Number.isFinite(kg) || kg < 30 || kg > 250) {
    await say(env, "Podaj wagę w kg, np. /waga 106,5");
    return;
  }
  const st = coach(env);
  const today = warsaw().date;
  await st.addWeight({ date: today, kg: r1(kg) });
  const cfg = await st.getNutCfg();
  const gp = goalProgress(await st.getWeights(), cfg.goalWeightKg, today, cfg.goalDate);
  const lines = [`⚖️ Mam: ${pl(r1(kg))} kg.`];
  if (cfg.goalWeightKg) {
    const left = r1(kg - cfg.goalWeightKg);
    lines.push(left > 0 ? `🎯 Do celu (${pl(cfg.goalWeightKg)} kg) zostało ${pl(left)} kg.` : `🎯 Cel ${pl(cfg.goalWeightKg)} kg zaliczony, jesteś ${pl(r1(-left))} kg poniżej. Respect!`);
  }
  if (gp.planKgToday !== null && gp.aheadKg !== null) {
    lines.push(
      `📍 Wg planu (prosto do ${cfg.goalDate}) dziś byłoby ok. ${pl(gp.planKgToday)} kg: ${gp.aheadKg > 0.2 ? `jesteś ${pl(gp.aheadKg)} kg do przodu 💪` : gp.aheadKg < -0.2 ? `brakuje ${pl(-gp.aheadKg)} kg do planu` : "idealnie wg planu"}.`,
    );
  }
  if (gp.requiredKgPerWeek !== null && gp.weeksLeft) {
    lines.push(`⏱ Żeby być na ${pl(cfg.goalWeightKg!)} kg ${cfg.goalDate}, trzeba ok. ${pl(gp.requiredKgPerWeek)} kg tygodniowo (zostało ${pl(gp.weeksLeft)} tyg.).${gp.requiredKgPerWeek > 0.75 ? " To już ostro przy treningu maratońskim, więc trzymamy rękę na pulsie." : ""}`);
  }
  if (gp.trendKgPerWeek !== null) {
    lines.push(`📉 Trend z ostatnich tygodni: ${gp.trendKgPerWeek > 0 ? "+" : ""}${pl(gp.trendKgPerWeek)} kg tygodniowo${gp.weeksToGoal ? `, w tym tempie cel za ok. ${gp.weeksToGoal} tyg.` : ""}.`);
  }
  lines.push("Waga potrafi skakać o 1–2 kg z dnia na dzień, więc patrz na trend, nie na pojedynczy pomiar. Najlepiej ważyć się raz w tygodniu, rano, w podobnych warunkach.");
  await say(env, lines.join("\n"));
}

async function cmdSlots(env: Env, arg: string) {
  const st = coach(env);
  const weekend = /^weekend(y)?(\s|$)/.test(norm(arg));
  const rest = weekend ? arg.replace(/^\S+\s*/, "") : arg;
  if (!arg.trim()) {
    const cfg = await st.getNutCfg();
    const fmt = (s: { name: string; time: string }[]) => (s.length ? s.map((x) => `${x.name} ${x.time}`).join("; ") : "brak");
    await say(
      env,
      `⏰ Plan posiłków\nPn–pt: ${fmt(cfg.slots)}\nWeekend: ${cfg.weekendSlots.length ? fmt(cfg.weekendSlots) : "jak w tygodniu"}\n` +
        `Przypomnienia: ${cfg.remindersOn ? "włączone" : "wyłączone"}, ${cfg.remindAfterMin / 60} h po planowanej godzinie.\n\n` +
        `Ustaw: /posilki śniadanie 07:30; obiad 13:30; kolacja 19:30\nWeekend: /posilki weekend śniadanie 09:00; obiad 14:00; kolacja 19:30\nWeekend jak w tygodniu: /posilki weekend reset`,
    );
    return;
  }
  if (weekend && /^(reset|tak samo|jak w tygodniu)/.test(norm(rest))) {
    await st.patchNutCfg({ weekendSlots: [] });
    await say(env, "Weekend ma teraz ten sam plan co w tygodniu.");
    return;
  }
  const parsed = parseSlots(rest);
  if ("error" in parsed) {
    await say(env, `⚠️ ${parsed.error}`);
    return;
  }
  const cfg = await st.patchNutCfg(weekend ? { weekendSlots: parsed.slots } : { slots: parsed.slots });
  // Okna, których termin przypomnienia już minął, nie dostają przypomnień wstecz.
  const local = warsaw();
  const nowMin = local.hour * 60 + local.minute;
  const patch: Record<string, string> = {};
  for (const s of slotsFor(cfg, local.weekday)) if (nowMin >= reminderDueMin(s, cfg.remindAfterMin)) patch[`${local.date}|${slotKey(s.name)}`] = "skip";
  await st.setReminders(patch, local.date);
  await say(env, `✅ Masz plan ${weekend ? "na weekend" : "pn–pt"}: ${parsed.slots.map((s) => `${s.name} ${s.time}`).join("; ")}.\nJak ${cfg.remindAfterMin / 60} h po planowanej godzinie nie będzie wpisu, to Cię szturchnę.`);
}

const DAY_KEYS: Record<string, DayType> = { wolny: "rest", odpoczynek: "rest", lekki: "easy", latwy: "easy", akcent: "quality", tempo: "quality", dlugi: "long" };

async function cmdGoals(env: Env, arg: string) {
  const st = coach(env);
  const tok = norm(arg).split(/\s+/).filter(Boolean);
  if (tok.length) {
    const v = (s?: string) => Number((s ?? "").replace(",", "."));
    const [what, a, b] = tok;
    let err: string | null = null;
    const x = v(a);
    if (what === "bialko") {
      if (x >= 1.2 && x <= 2.5) await st.patchNutCfg({ proteinPerKg: x });
      else err = "Białko: 1,2–2,5 g/kg.";
    } else if (what === "tluszcz") {
      if (x >= 0.6 && x <= 1.5) await st.patchNutCfg({ fatPerKg: x });
      else err = "Tłuszcz: 0,6–1,5 g/kg.";
    } else if (what === "deficyt") {
      if (x >= 0 && x <= 800) await st.patchNutCfg({ deficitKcal: r0(x) });
      else err = "Deficyt: 0–800 kcal (dotyczy tylko dni bez biegu i łatwych).";
    } else if (what === "garmin") {
      if (x >= 0.7 && x <= 1.1) await st.patchNutCfg({ garminFactor: x });
      else err = "Korekta Garmina: 0,7–1,1 (np. 0,9 = zegarek zawyża spalanie o ok. 10%, 1 = ufam zegarkowi).";
    } else if (what === "termin") {
      if (["off", "brak", "0"].includes(a ?? "")) await st.patchNutCfg({ goalDate: null });
      else if (/^\d{4}-\d{2}-\d{2}$/.test(a ?? "") && !Number.isNaN(Date.parse(`${a}T12:00:00Z`)) && daysBetween(warsaw().date, a!) > 0) await st.patchNutCfg({ goalDate: a! });
      else err = "Termin celu: data w przyszłości w formacie RRRR-MM-DD, np. /cel termin 2027-04-25 (albo „off”).";
    } else if (what === "cel") {
      if (["off", "0", "brak"].includes(a ?? "")) await st.patchNutCfg({ goalWeightKg: null });
      else if (x >= 40 && x <= 200) await st.patchNutCfg({ goalWeightKg: r1(x) });
      else err = "Waga docelowa: 40–200 kg albo „off”.";
    } else if (what === "masa") {
      if (["auto", "off", "0", "waga"].includes(a ?? "")) await st.patchNutCfg({ macroWeightKg: null });
      else if (x >= 40 && x <= 200) await st.patchNutCfg({ macroWeightKg: r1(x) });
      else err = "Masa referencyjna: 40–200 kg albo „auto” (aktualna waga).";
    } else if (what === "przypomnienie") {
      if (x >= 30 && x <= 360) await st.patchNutCfg({ remindAfterMin: r0(x) });
      else err = "Przypomnienie: 30–360 minut po planie.";
    } else if (what === "wegle" && DAY_KEYS[a ?? ""] && v(b) >= 2 && v(b) <= 10) {
      const cur = await st.getNutCfg();
      await st.patchNutCfg({ carbsPerKg: { ...cur.carbsPerKg, [DAY_KEYS[a]]: v(b) } });
    } else {
      err = "Użycie: /cel deficyt 600 · /cel cel 95 (waga docelowa) · /cel termin 2027-04-25 · /cel garmin 0,9 · /cel masa 95 · /cel bialko 1,8 · /cel tluszcz 1 · /cel wegle lekki 4,5 (wolny|lekki|akcent|dlugi) · /cel przypomnienie 180";
    }
    if (err) {
      await say(env, `⚠️ ${err}`);
      return;
    }
  }
  const cfg = await st.getNutCfg();
  const w = weightStats(await st.getWeights(), warsaw().date).last?.kg ?? cfg.weightFallbackKg;
  const ref = cfg.macroWeightKg ?? (w && cfg.goalWeightKg ? Math.min(w, cfg.goalWeightKg) : w);
  const lines = [
    `🎯 Cele · waga ${w ? `${pl(w)} kg` : "brak (/waga 82,5)"} · docelowa ${cfg.goalWeightKg ? `${pl(cfg.goalWeightKg)} kg` : "brak (/cel cel 95)"} · gramy na kg liczone od ${ref ? `${pl(ref)} kg` : "wagi"}`,
    `Białko ${pl(cfg.proteinPerKg)} g/kg · tłuszcz ${pl(cfg.fatPerKg)} g/kg · deficyt ${cfg.deficitKcal} kcal (tylko dni bez biegu i łatwe)`,
    `Korekta Garmina ×${pl(cfg.garminFactor)} (zegarki zawyżają spalanie; zmiana: /cel garmin 0,9)`,
  ];
  const gp = goalProgress(await st.getWeights(), cfg.goalWeightKg, warsaw().date, cfg.goalDate);
  if (cfg.goalDate && gp.requiredKgPerWeek !== null && gp.weeksLeft) {
    lines.push(`Termin ${cfg.goalDate}: zostało ${pl(gp.weeksLeft)} tyg., do celu potrzeba ok. ${pl(gp.requiredKgPerWeek)} kg tygodniowo (przy deficycie ${cfg.deficitKcal} realnie spodziewaj się ok. 0,3–0,45 kg)`);
  }
  const base = await energyBase(env, warsaw().date).catch(() => null);
  lines.push(
    base
      ? base.detail
        ? `Kcal od spokojnego dnia z Garmina: (spoczynkowe ${base.detail.resting} + lekka aktywność ${r0(GARMIN_ACTIVE_HAIRCUT * base.detail.quietActive)}, aktywne ×0,85) ×${pl(cfg.garminFactor)} = ${r0(cfg.garminFactor * (base.detail.resting + GARMIN_ACTIVE_HAIRCUT * base.detail.quietActive))}, plus ok. ${pl(RUN_KCAL_PER_KG_KM)} kcal/kg/km planowanego biegu. Gdy Garmin pokaże dziś więcej wysiłku, cel rośnie. Szczegóły: /spalanie`
        : `Kcal z kalibracji (waga i spożycie): ok. ${base.kcal} kcal na przeciętny dzień`
      : "Kcal z g/kg (brak danych o spalaniu: Garmin lub ≥ 3 tygodnie zapisów i wagi)",
    "",
  );
  for (const t of ["rest", "easy", "quality", "long"] as DayType[]) {
    const x = computeTargets(cfg, w, t, base);
    lines.push(`• ${DAY_TYPE_PL[t]}${base?.detail && DEFAULT_RUN_KM[t] ? ` (ok. ${DEFAULT_RUN_KM[t]} km)` : ""}: ${x ? `${x.kcal} kcal · B ${x.protein} · W ${x.carbs} (${pl(r1(x.carbs / (ref ?? 1)))} g/kg) · T ${x.fat}${x.deficitApplied > 0 ? ` · deficyt ${x.deficitApplied}` : ""}` : "brak wagi"}`);
  }
  await say(env, lines.join("\n"));
}

async function cmdFavorites(env: Env, arg: string) {
  const st = coach(env);
  const favs = await st.getFavorites();
  const del = /^usun\s+(\d+)/.exec(norm(arg));
  if (del) {
    const ok = await st.removeFavorite(Number(del[1]) - 1);
    await say(env, ok ? "Usunąłem z ulubionych." : "Nie ma takiego numeru.");
    return;
  }
  if (!favs.length) {
    await say(env, "Ulubionych jeszcze brak. Po zapisaniu posiłku stuknij ⭐ Ulubione pod wiadomością.");
    return;
  }
  const kb = favs.map((f, i) => [{ text: `${f.name} · ${sumMacros(f.items).kcal} kcal`.slice(0, 60), callback_data: `f:${i}` }]);
  await say(env, "⭐ Stuknij, żeby dodać od razu. Usuwanie: /ulubione usun 2", kb);
}

async function cmdReminders(env: Env, arg: string) {
  const on = /^(on|wl|tak|1)/.test(norm(arg));
  const off = /^(off|wyl|nie|0)/.test(norm(arg));
  if (!on && !off) {
    const cfg = await coach(env).getNutCfg();
    await say(env, `Przypomnienia o posiłkach: ${cfg.remindersOn ? "włączone" : "wyłączone"}. Zmiana: /przypomnienia on lub off`);
    return;
  }
  await coach(env).patchNutCfg({ remindersOn: on });
  await say(env, on ? "🔔 Przypomnienia włączone, będę Cię pilnował." : "🔕 Przypomnienia wyłączone (np. urlop). Włączysz: /przypomnienia on");
}

async function cmdBurn(env: Env) {
  const cfg = await coach(env).getNutCfg();
  const g = garminClient(env);
  if (!g) return void (await say(env, "Garmin Connect nie jest podłączony."));
  const today = warsaw().date;
  const days = await g.energy(addDays(today, -14), today);
  const rows = Object.entries(days).sort(([a], [b]) => a.localeCompare(b));
  const lines = ["⌚ <b>Spalanie z Garmina</b> (kcal: razem = spoczynkowe + aktywne)", ""];
  for (const [d, e] of rows) {
    lines.push(`${d.slice(5)}${d === today ? " (dziś, trwa)" : ""}: <b>${e.total != null ? r0(e.total) : "?"}</b> = ${e.resting != null ? r0(e.resting) : "?"} + ${e.active != null ? r0(e.active) : "?"}`);
  }
  const base = await energyBase(env, today).catch(() => null);
  const full = rows.filter(([d, e]) => d < today && e.total && e.resting != null && e.active != null);
  const perDay = full.map(([, e]) => e.resting! + GARMIN_ACTIVE_HAIRCUT * e.active!).sort((a, b) => a - b);
  lines.push("");
  if (base?.detail) {
    const d = base.detail;
    const quiet = d.resting + GARMIN_ACTIVE_HAIRCUT * d.quietActive;
    lines.push(`Spokojny dzień wg Garmina: ${d.resting} + ${r0(GARMIN_ACTIVE_HAIRCUT * d.quietActive)} = ${r0(quiet)} kcal (spoczynkowe + aktywne ×0,85 z najspokojniejszych dni)`);
    lines.push(`Po korekcie ×${pl(cfg.garminFactor)} (zegarek zawyża): <b>${r0(cfg.garminFactor * quiet)}</b> kcal, to baza celów`);
    lines.push(`Mediana wszystkich dni: ${base.kcal} kcal, najbardziej aktywny: ${r0(perDay[perDay.length - 1])} kcal`);
    lines.push("Do tego cel dolicza bieg z planu, a gdy Garmin pokaże dziś więcej wysiłku, rośnie do faktycznego spalania.");
  } else if (base) lines.push(`Baza do celów: <b>${base.kcal}</b> kcal (${base.source === "kalibracja" ? "z kalibracji wagi i spożycia" : "Garmin"})`);
  else lines.push(`Za mało pełnych dni z danymi (jest ${full.length}, potrzeba min. 5), żeby policzyć bazę.`);
  lines.push("<i>Duże rozrzuty między dniami oznaczają zwykle aktywności, o których cel nie wie z góry (spacery, góry, trening poza planem).</i>");
  await say(env, lines.join("\n"), undefined, true);
}

const COMMANDS: Record<string, (env: Env, arg: string, msg: any) => Promise<void>> = {
  spalanie: (env) => cmdBurn(env),
  dieta: async (env) => void (await say(env, HELP)),
  dzis: (env, arg) => cmdToday(env, arg),
  usun: (env, arg) => cmdDelete(env, arg),
  waga: (env, arg) => cmdWeight(env, arg),
  posilki: (env, arg) => cmdSlots(env, arg),
  cel: (env, arg) => cmdGoals(env, arg),
  ulubione: (env, arg) => cmdFavorites(env, arg),
  przypomnienia: (env, arg) => cmdReminders(env, arg),
  jem: async (env, arg, msg) => {
    if (!arg.trim()) await say(env, "Napisz, co wrzuciłeś na ząb, np. /jem owsianka 60 g z mlekiem i bananem");
    else await attemptJob(env, newJob("text", msg.date, { text: arg.trim() }));
  },
};

const NATURAL_MEAL = /^(zjadłem|zjadłam|zjadlem|zjadlam|wypiłem|wypiłam|wypilem|wypilam|jadłem|jadłam|jadlem|jadlam|na (śniadanie|sniadanie|obiad|kolację|kolacje|lunch|podwieczorek|drugie śniadanie|drugie sniadanie)|jem|piję|pije)(\s|[:,-]|$)/i;

/**
 * Wejście z webhooka Telegrama. Zwraca true, gdy wiadomość należy do dietetyka (wtedy trener jej nie dostaje).
 * Ciężką pracę (zdjęcie, Gemini) wykonuje w tle (waitUntil), żeby Telegram dostał odpowiedź od razu.
 */
export async function routeDietMessage(env: Env, msg: any, isEdit: boolean, ctx: ExecutionContext): Promise<boolean> {
  const text: string = String(msg.text ?? msg.caption ?? "").trim();
  const isImage = Boolean(msg.photo) || String(msg.document?.mime_type ?? "").startsWith("image/");

  if (isImage) {
    if (isEdit) return true; // edycja podpisu nie dubluje wpisu
    const group = msg.media_group_id ? String(msg.media_group_id) : null;
    if (group && !(await coach(env).firstSeen("group", group))) {
      ctx.waitUntil(say(env, "📎 Z albumu ogarniam tylko pierwsze zdjęcie. Resztę wrzuć osobno albo dopisz /jem …").catch(() => {}));
      return true;
    }
    const fileId: string = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    const job = newJob("photo", msg.date, { fileId, text: String(msg.caption ?? "").trim() });
    ctx.waitUntil(guard(env, JOB_LABEL.photo, () => attemptJob(env, job)));
    return true;
  }
  if (!text) return false;

  // Kilka komend w jednej wiadomości (każda w osobnej linii): wykonaj znane komendy dietetyka po kolei, nieznane pomiń.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => /^\/[a-zA-Z]+/.test(l))) {
    const known = lines
      .map((l) => /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m && COMMANDS[m[1].toLowerCase()]));
    if (known.length) {
      if (isEdit) return true;
      ctx.waitUntil(
        (async () => {
          for (const m of known) await guard(env, `Komenda /${m[1]}`, () => COMMANDS[m[1].toLowerCase()](env, m[2] ?? "", msg));
        })(),
      );
      return true;
    }
  }
  const cmd = /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (cmd) {
    const fn = COMMANDS[cmd[1].toLowerCase()];
    if (!fn) return false; // /start itp. zostają po staremu
    if (isEdit) return true;
    ctx.waitUntil(guard(env, `Komenda /${cmd[1]}`, () => fn(env, cmd[2] ?? "", msg)));
    return true;
  }
  if (isEdit) return false;

  const replyTo = msg.reply_to_message?.message_id;
  if (typeof replyTo === "number") {
    const mealId = await coach(env).mealForMessage(replyTo);
    if (mealId) {
      const job = newJob("correct", msg.date, { mealId, text });
      ctx.waitUntil(guard(env, JOB_LABEL.correct, () => attemptJob(env, job)));
      return true;
    }
  }
  if (NATURAL_MEAL.test(text)) {
    const job = newJob("text", msg.date, { text });
    ctx.waitUntil(guard(env, JOB_LABEL.text, () => attemptJob(env, job)));
    return true;
  }
  return false;
}

/** Zapisuje ulubiony posiłek jako zjedzony teraz (Telegram i aplikacja). */
export async function saveFavoriteMeal(env: Env, index: number): Promise<{ meal: Meal; slotName: string } | null> {
  const st = coach(env);
  const fav = (await st.getFavorites())[index];
  if (!fav) return null;
  const now = warsaw();
  const cfg = await st.getNutCfg();
  const meal: Meal = {
    id: newMealId(now.date),
    date: now.date,
    time: now.time,
    label: fav.name,
    source: "favorite",
    note: "",
    items: fav.items,
    totals: sumMacros(fav.items),
    confidence: overallConfidence(fav.items),
    question: null,
    createdAt: new Date().toISOString(),
  };
  await st.saveMeal(meal);
  return { meal, slotName: labelForTime(slotsFor(cfg, now.weekday), now.time, cfg.remindAfterMin) };
}

// ---------------- przyciski ----------------


export async function handleCallback(env: Env, cq: any): Promise<void> {
  const st = coach(env);
  const data = String(cq.data ?? "");
  const answer = (text: string) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  const stripButtons = () =>
    cq.message
      ? tg(env, "editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      : Promise.resolve();
  try {
    const [kind, act, ...rest] = data.split(":");
    if (kind === "m" && act === "del") {
      const ok = await st.deleteMeal(rest[0] ?? "");
      await answer(ok ? "Usunięto" : "Już usunięty");
      await stripButtons();
    } else if (kind === "m" && act === "fav") {
      const m = await st.findMeal(rest[0] ?? "");
      if (!m) return void (await answer("Nie znaleziono posiłku"));
      await st.addFavorite({ name: m.label.slice(0, 40), items: m.items });
      await answer("Dodano do ulubionych ⭐");
    } else if (kind === "f") {
      const r = await saveFavoriteMeal(env, Number(act));
      if (!r) return void (await answer("Nie znaleziono"));
      await answer("Dodaję…");
      await announce(env, r.meal, r.slotName);
    } else if (kind === "r") {
      const date = rest[0] ?? "";
      const key = `${date}|${rest[1] ?? ""}`;
      const today = warsaw().date;
      if (date !== today) {
        await answer("To przypomnienie jest już nieaktualne");
        return void (await stripButtons());
      }
      if (act === "skip") {
        await st.setReminders({ [key]: "skip" }, today);
        await answer("Okej, pominięte");
        await stripButtons();
      } else if (act === "later") {
        await st.setReminders({ [key]: `snooze:${new Date(Date.now() + 60 * 60_000).toISOString()}` }, today);
        await answer("Przypomnę za godzinę");
        await stripButtons();
      } else {
        await answer("Wrzuć zdjęcie lub opis 📸");
      }
    } else await answer("");
  } catch (e) {
    console.error("diet callback", e);
    await answer("Coś poszło nie tak, spróbuj ponownie");
  }
}

// ---------------- przypomnienia (wołane co 15 min ze schedulera) ----------------

export async function runDietReminders(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const st = coach(env);
  const cfg = await st.getNutCfg();
  if (!cfg.remindersOn || !(cfg.slots.length || cfg.weekendSlots.length)) return;
  const now = new Date();
  const local = warsaw(now);
  const [meals, state] = await Promise.all([st.getMeals(local.date), st.getReminders()]);
  const { due, markOk } = evaluateReminders({
    cfg,
    date: local.date,
    nowMin: local.hour * 60 + local.minute,
    weekday: local.weekday,
    meals,
    state,
    nowIso: now.toISOString(),
  });
  const patch: Record<string, string> = {};
  for (const k of markOk) patch[k] = "ok";
  for (const d of due) {
    const k = slotKey(d.slot.name);
    const buttons = [
      [
        { text: "📸 Dodam", callback_data: `r:add:${local.date}:${k}` },
        { text: "⏭ Pominąłem", callback_data: `r:skip:${local.date}:${k}` },
        ...(d.attempt === 1 ? [{ text: "⏰ Za godzinę", callback_data: `r:later:${local.date}:${k}` }] : []),
      ],
    ];
    const text =
      d.attempt === 1
        ? `🍽 Janek, nie widzę wpisu: ${d.slot.name} (plan ${d.slot.time}). Wrzuć zdjęcie albo krótki opis, albo kliknij poniżej.`
        : `🍽 Jeszcze raz o „${d.slot.name}” (plan ${d.slot.time}), Janek: zdjęcie, opis albo „Pominąłem”.`;
    try {
      await say(env, text, buttons);
      patch[d.key] = d.attempt === 1 ? "sent" : "sent2";
    } catch (e) {
      console.error("reminder send failed", e); // bez zapisu stanu: następny tick spróbuje ponownie
    }
  }
  if (Object.keys(patch).length) await st.setReminders(patch, local.date);
}

// ---------------- raport dla trenera (MCP getNutrition) ----------------

export async function nutritionReport(env: Env, days: number) {
  const st = coach(env);
  const now = new Date();
  const local = warsaw(now);
  const today = local.date;
  const n = Math.min(Math.max(Math.round(days), 1), 14);
  const dates28 = Array.from({ length: 28 }, (_, i) => addDays(today, -27 + i));
  const [byDate, weights, cfg, info] = await Promise.all([st.getMealsRange(dates28), st.getWeights(), st.getNutCfg(), dayInfo(env, today)]);

  const g = garminClient(env);
  let energy: Awaited<ReturnType<NonNullable<typeof g>["energy"]>> = {};
  let energyError: string | null = null;
  if (g) {
    try {
      energy = await g.energy(addDays(today, -(n - 1)), today);
    } catch (e) {
      energyError = String(e).slice(0, 160);
    }
  } else energyError = "Garmin Connect nie jest podłączony";

  const dayRow = (date: string) => {
    const meals = byDate[date] ?? [];
    const t = sumMacros(meals.map((m) => m.totals));
    const e = energy[date];
    return {
      data: date,
      posilki: meals.length,
      ...t,
      bialko_g_na_kg: info.weightKg ? r1(t.protein / info.weightKg) : null,
      garmin_spalone_kcal: e?.total ?? null,
      garmin_aktywne_kcal: e?.active ?? null,
      bilans_vs_garmin_kcal: e?.total != null && meals.length ? t.kcal - e.total : null,
      dzien_niepelny: date === today,
    };
  };
  const rows = dates28.slice(-n).map(dayRow);

  const intake = dates28.map((d) => ({ date: d, kcal: sumMacros((byDate[d] ?? []).map((m) => m.totals)).kcal, meals: (byDate[d] ?? []).length }));
  const last7 = intake.filter((d) => d.date < today).slice(-7).filter(isLoggedDay);
  const avg = (f: (d: { date: string }) => number) => (last7.length ? r0(last7.reduce((a, d) => a + f(d), 0) / last7.length) : null);
  const mealsOf = (d: string) => sumMacros((byDate[d] ?? []).map((m) => m.totals));
  const slots = slotsFor(cfg, local.weekday);
  const nowMin = local.hour * 60 + local.minute;
  const done = satisfiedSlots(slots, byDate[today] ?? [], cfg.remindAfterMin);
  const reminders = await st.getReminders();

  const todayMeals = byDate[today] ?? [];
  const tot = sumMacros(todayMeals.map((m) => m.totals));
  return {
    teraz: { data: today, godzina: local.time },
    typ_dnia: { typ: DAY_TYPE_PL[info.dayType], powod: info.dayTypeWhy },
    cele_dzis: info.targets
      ? { kcal: info.targets.kcal, bialko_g: info.targets.protein, weglowodany_g: info.targets.carbs, tluszcz_g: info.targets.fat, zrodlo_kcal: info.targets.source === "g/kg" ? "g/kg masy ciała (brak danych o spalaniu)" : info.targets.source === "garmin" ? `spokojny dzień z Garmina (spoczynkowe ${info.base?.detail?.resting} + aktywne ×0,85 z najspokojniejszych dni) plus bieg z planu (${info.runKm ?? "domyślny"} km); rośnie, gdy dzisiejszy wysiłek wg Garmina przekracza plan` : `kalibracja z wagi i spożycia: ${info.base?.kcal} kcal/dzień`, uwaga: info.targets.note }
      : "brak (Jan nie podał wagi: /waga)",
    spozycie_dzis: {
      ...tot,
      zostalo: info.targets ? { kcal: info.targets.kcal - tot.kcal, bialko_g: info.targets.protein - tot.protein, weglowodany_g: info.targets.carbs - tot.carbs, tluszcz_g: info.targets.fat - tot.fat } : null,
      posilki: todayMeals.map((m) => ({ godz: m.time, nazwa: m.label, ...m.totals, pewnosc: CONFIDENCE_PL[m.confidence], pozycje: m.items.map((i) => `${i.name}${i.grams ? ` ${i.grams} g` : ""}`), ...(m.note ? { notatka: m.note } : {}), ...(m.question ? { otwarte_pytanie: m.question } : {}) })),
    },
    plan_posilkow_dzis: slots.map((s, i) => ({
      posilek: s.name,
      plan: s.time,
      status: done.has(i) ? "zapisany" : reminders[`${today}|${slotKey(s.name)}`] === "skip" ? "pominiety" : nowMin < hhmmToMin(s.time) ? "jeszcze przed nami" : "brak wpisu",
    })),
    dni: rows,
    srednia_7_dni_zalogowane: { dni_w_probce: last7.length, kcal: avg((d) => mealsOf(d.date).kcal), bialko_g: avg((d) => mealsOf(d.date).protein), weglowodany_g: avg((d) => mealsOf(d.date).carbs), tluszcz_g: avg((d) => mealsOf(d.date).fat) },
    waga: (() => {
      const s = weightStats(weights, today);
      const gp = goalProgress(weights, cfg.goalWeightKg, today, cfg.goalDate);
      return {
        ostatnia: s.last,
        dni_od_ostatniego_wazenia: gp.daysSinceWeighIn,
        waga_docelowa_kg: cfg.goalWeightKg,
        do_celu_kg: gp.toGoKg,
        tempo_kg_na_tydzien: gp.trendKgPerWeek,
        prognoza_tygodni_do_celu: gp.weeksToGoal,
        termin_celu: cfg.goalDate,
        tygodni_do_terminu: gp.weeksLeft,
        plan_kg_dzis: gp.planKgToday,
        przed_planem_kg: gp.aheadKg,
        wymagane_tempo_kg_na_tydzien: gp.requiredKgPerWeek,
        srednia_7_dni: s.avg7,
        zmiana_tydzien_do_tygodnia_kg: s.deltaWeek,
        pomiary_28_dni: s.count28,
      };
    })(),
    kalibracja_zapotrzebowania: estimateTdee(intake, weights, today),
    garmin_uwagi: energyError ?? `Spalone = spoczynkowe + aktywne. Garmin zawyża spalanie (aktywne o 10–30%), więc cele liczone są z korektą ×${cfg.garminFactor} (ustawienia.korekta_garmina), a kolumny garmin_* w dniach to surowe dane zegarka. Dzisiejsza wartość jest cząstkowa do końca dnia.`,
    ustawienia: { deficyt_kcal: cfg.deficitKcal, waga_docelowa_kg: cfg.goalWeightKg, termin_celu: cfg.goalDate, korekta_garmina: cfg.garminFactor, masa_referencyjna_kg: cfg.macroWeightKg, bialko_g_na_kg: cfg.proteinPerKg, tluszcz_g_na_kg: cfg.fatPerKg, weglowodany_g_na_kg: cfg.carbsPerKg, przypomnienia: cfg.remindersOn, plan_posilkow_pn_pt: cfg.slots, plan_posilkow_weekend: cfg.weekendSlots },
  };
}
