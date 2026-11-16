/**
 * Dietetyk w Telegramie: zdjęcie/opis posiłku -> Gemini -> zapis w Durable Object -> odpowiedź z przyciskami.
 * Do zadań Claude'a (podsumowania, rozmowa) służy getNutrition w index.ts, który korzysta z nutritionReport().
 */
import { GarminPersonal } from "./garmin";
import { Icu } from "./icu";
import { analyzeMeal, applyBarcode, toBase64 } from "./gemini";
import {
  CONFIDENCE_PL,
  DAY_TYPE_PL,
  type DayType,
  type EnergyBase,
  type Macros,
  type Meal,
  type NutritionConfig,
  type Targets,
  classifyDay,
  computeTargets,
  estimateTdee,
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
import { addDays, warsaw } from "./time";

export function garminClient(env: Env): GarminPersonal | null {
  if (!env.GARMIN_PERSONAL_API_KEY) return null;
  const state = coach(env);
  return new GarminPersonal(env.GARMIN_PERSONAL_API_KEY, () => state.getGarminToken(), (t) => state.setGarminToken(t));
}

const weekdayOf = (date: string) => warsaw(new Date(`${date}T12:00:00Z`)).weekday;
const chatId = (env: Env) => env.TELEGRAM_CHAT_ID;

async function say(env: Env, text: string, buttons?: { text: string; callback_data: string }[][]): Promise<number | null> {
  const res = await tg(env, "sendMessage", {
    chat_id: chatId(env),
    text: text.slice(0, 4000),
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
  cfg: NutritionConfig;
}

/** Gramy aktywnych kalorii Garmina liczone z tym współczynnikiem: bywają zawyżone o 10–30%. */
const GARMIN_ACTIVE_HAIRCUT = 0.85;

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

  const cached = await st.getCache(`energybase:${today}`, 6 * 3600_000);
  if (cached) return JSON.parse(cached) as EnergyBase;
  const g = garminClient(env);
  if (!g) return null;
  const rows = Object.entries(await g.energy(addDays(today, -14), addDays(today, -1)))
    .map(([, e]) => e)
    .filter((e) => e.total && e.total > 0 && e.resting != null && e.active != null);
  if (rows.length < 5) return null;
  const avg = (f: (e: (typeof rows)[number]) => number) => rows.reduce((a, e) => a + f(e), 0) / rows.length;
  const base: EnergyBase = { kcal: r0(avg((e) => e.resting!) + GARMIN_ACTIVE_HAIRCUT * avg((e) => e.active!)), source: "garmin" };
  await st.setCache(`energybase:${today}`, JSON.stringify(base));
  return base;
}

/** Typ dnia z planu i aktywności (intervals.icu, cache 20 min) + cele z zapotrzebowania i masy ciała. */
export async function dayInfo(env: Env, date: string): Promise<DayInfo> {
  const st = coach(env);
  const [cfg, weights] = await Promise.all([st.getNutCfg(), st.getWeights()]);
  const weightKg = weightStats(weights, date).last?.kg ?? cfg.weightFallbackKg;
  let cls: { type: DayType; why: string } | null = null;
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
  // Garmin nie ma własnego limitu czasu, a siedzimy w budżecie ~30 s pracy w tle: po 6 s cele liczą się z g/kg.
  const base = await Promise.race([energyBase(env, date), new Promise<null>((r) => setTimeout(() => r(null), 6000))]).catch(() => null);
  return { date, dayType: cls!.type, dayTypeWhy: cls!.why, weightKg, targets: computeTargets(cfg, weightKg, cls!.type, base), base, cfg };
}

const sign = (n: number) => (n > 0 ? `+${r0(n)}` : `${r0(n)}`);

function vsTarget(have: Macros, t: Targets | null): string {
  if (!t) return `Dziś: ${fmtMacros(have)}`;
  return `Dziś: ${r0(have.kcal)}/${t.kcal} kcal · B ${r0(have.protein)}/${t.protein} · W ${r0(have.carbs)}/${t.carbs} · T ${r0(have.fat)}/${t.fat} (${DAY_TYPE_PL[t.dayType]})`;
}

// ---------------- komunikaty ----------------

function mealMessage(meal: Meal, slotName: string, dayTotals: Macros, info: DayInfo | null, extra: string[] = []): string {
  const lines = [`🍽 ${slotName} · ${meal.time} — ${meal.label}`];
  for (const it of meal.items) {
    lines.push(
      `• ${it.name}${it.grams ? ` ${it.grams} g` : ""} — ${it.kcal} kcal · B ${r0(it.protein)} · W ${r0(it.carbs)} · T ${r0(it.fat)}` +
        `${it.basis === "label" ? " 🏷" : ""}${it.confidence === "low" ? " (?)" : ""}`,
    );
  }
  lines.push(`Razem: ${fmtMacros(meal.totals)} · pewność: ${CONFIDENCE_PL[meal.confidence]}`);
  lines.push(vsTarget(dayTotals, info?.targets ?? null));
  if (info && !info.targets) lines.push("Cele pojawią się po wpisaniu wagi: /waga 82,5");
  lines.push(...extra);
  if (meal.question) lines.push(`❓ ${meal.question}`);
  lines.push("Poprawka? Odpowiedz na tę wiadomość (np. „to było 200 g”).");
  return lines.join("\n");
}

const mealButtons = (id: string) => [
  [
    { text: "🗑 Usuń", callback_data: `m:del:${id}` },
    { text: "⭐ Ulubione", callback_data: `m:fav:${id}` },
  ],
];

// ---------------- zapis posiłku ----------------

async function slotNamesFor(env: Env, date: string): Promise<string[]> {
  const cfg = await coach(env).getNutCfg();
  return slotsFor(cfg, weekdayOf(date)).map((x) => x.name);
}

interface MealCtx {
  source: Meal["source"];
  note: string;
  photoFileId?: string;
  msgUnix: number;
}

async function storeAndAnnounce(env: Env, a: Awaited<ReturnType<typeof analyzeMeal>>, c: MealCtx) {
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
  await announce(env, meal, slotName, [
    ...(used ? [`🏷 Wartości z bazy Open Food Facts: ${used}`] : []),
    ...(a.comment ? [`💬 ${a.comment}`] : []),
    ...(date !== at.date ? [`📅 Zapisano na ${date}.`] : []),
  ]);
}

async function announce(env: Env, meal: Meal, slotName: string, extra: string[] = []) {
  const st = coach(env);
  const day = sumMacros((await st.getMeals(meal.date)).map((m) => m.totals));
  const info = await dayInfo(env, meal.date).catch(() => null);
  const id = await say(env, mealMessage(meal, slotName, day, info, extra), mealButtons(meal.id));
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

const FAIL_HINT = "Spróbuj jeszcze raz za chwilę albo wpisz posiłek tekstem: /jem 2 jajka, kromka chleba, masło";

async function guard(env: Env, what: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.error(`diet:${what}`, e);
    const msg = String(e instanceof Error ? e.message : e).replace(/key=[^&\s]+/g, "key=…").slice(0, 180);
    await say(env, `⚠️ ${what} się nie udało: ${msg}\n${FAIL_HINT}`).catch(() => {});
  }
}

async function needGemini(env: Env): Promise<boolean> {
  if (env.GEMINI_API_KEY) return false;
  await say(env, "Rozpoznawanie posiłków nie jest jeszcze włączone: brakuje sekretu GEMINI_API_KEY (instrukcja w SETUP-DIETETYK.md).");
  return true;
}

async function logPhoto(env: Env, msg: any) {
  if (await needGemini(env)) return;
  await tg(env, "sendChatAction", { chat_id: chatId(env), action: "typing" }).catch(() => {});
  const fileId: string = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const note = String(msg.caption ?? "").trim();
  const image = await downloadTelegramFile(env, fileId);
  const now = warsaw(new Date(msg.date * 1000));
  const a = await analyzeMeal(env, { image, note, nowLocal: now, slotNames: await slotNamesFor(env, now.date) });
  if (!a.isFood) {
    await say(env, "Nie widzę na zdjęciu jedzenia ani napoju. Jeśli to jednak posiłek, dopisz opis (/jem ...).");
    return;
  }
  await storeAndAnnounce(env, a, { source: "photo", note, photoFileId: fileId, msgUnix: msg.date });
}

async function logText(env: Env, msg: any, text: string) {
  if (await needGemini(env)) return;
  await tg(env, "sendChatAction", { chat_id: chatId(env), action: "typing" }).catch(() => {});
  const at = warsaw(new Date(msg.date * 1000));
  const a = await analyzeMeal(env, { note: text, nowLocal: at, slotNames: await slotNamesFor(env, at.date) });
  if (!a.isFood) {
    await say(env, "Nie wyłapałem z opisu żadnego jedzenia. Napisz np.: /jem owsianka 60 g z mlekiem i bananem");
    return;
  }
  await storeAndAnnounce(env, a, { source: "text", note: text, msgUnix: msg.date });
}

async function correctMeal(env: Env, mealId: string, text: string, msg: any) {
  if (await needGemini(env)) return;
  const st = coach(env);
  const meal = await st.findMeal(mealId);
  if (!meal) {
    await say(env, "Nie znajduję tego posiłku (może został usunięty).");
    return;
  }
  await tg(env, "sendChatAction", { chat_id: chatId(env), action: "typing" }).catch(() => {});
  const a = await analyzeMeal(env, {
    note: text,
    previous: { label: meal.label, note: meal.note, items: meal.items },
    nowLocal: warsaw(new Date(msg.date * 1000)),
    slotNames: await slotNamesFor(env, meal.date),
  });
  if (!a.isFood) {
    await say(env, "Nie zrozumiałem poprawki, nic nie zmieniłem. Napisz np.: „to było 200 g”, „bez sosu”, „to skyr naturalny”.");
    return;
  }
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
  await announce(env, updated, updated.slot ?? labelForTime(slotsFor(cfg, weekdayOf(updated.date)), updated.time, cfg.remindAfterMin), [
    "✏️ Poprawiono.",
    ...(used ? [`🏷 Wartości z bazy Open Food Facts: ${used}`] : []),
  ]);
}

// ---------------- komendy ----------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const HELP = `🍽 Dietetyk: jak używać
• Zdjęcie posiłku (+ opcjonalnie podpis jako notatka) zapisuje posiłek.
• /jem 2 jajka, kromka chleba: posiłek z samego opisu (działa też „zjadłem …”).
• Odpowiedz na wiadomość z posiłkiem, żeby go poprawić.
• /dzis (lub /dzis wczoraj): posiłki, cele, bilans · /usun 2: usuń posiłek nr 2 z /dzis
• /waga 82,5: waga · /ulubione: szybkie dodawanie
• /posilki: plan posiłków i przypomnień · /cel: cele i ustawienia · /przypomnienia on|off`;

async function cmdToday(env: Env, arg: string) {
  const st = coach(env);
  const date = norm(arg).startsWith("wczoraj") ? addDays(warsaw().date, -1) : warsaw().date;
  const meals = await st.getMeals(date);
  const info = await dayInfo(env, date);
  const total = sumMacros(meals.map((m) => m.totals));
  const lines = [`📅 ${date} (${warsaw(new Date(`${date}T12:00:00Z`)).weekdayPl}) · ${DAY_TYPE_PL[info.dayType]}`];
  if (!meals.length) lines.push("Brak zapisanych posiłków.");
  meals.forEach((m, i) => lines.push(`${i + 1}. ${m.time} ${m.label} — ${fmtMacros(m.totals)}${m.confidence === "low" ? " (?)" : ""}`));
  lines.push("", vsTarget(total, info.targets));
  if (info.targets) {
    const t = info.targets;
    lines.push(`Zostało: ${sign(t.kcal - total.kcal)} kcal · B ${sign(t.protein - total.protein)} · W ${sign(t.carbs - total.carbs)} · T ${sign(t.fat - total.fat)}`);
    if (t.note) lines.push(`ℹ️ ${t.note}`);
  } else lines.push("Brak celów: wpisz wagę (/waga 82,5).");
  try {
    const g = garminClient(env);
    const e = g ? (await g.energy(date, date))[date] : null;
    if (e?.total) {
      lines.push(
        `⌚ Garmin: spalone ${r0(e.total)} kcal (spoczynkowe ${r0(e.resting ?? 0)} + aktywne ${r0(e.active ?? 0)})` +
          `${date === warsaw().date ? ", dzień jeszcze trwa" : ""}. Kalorie aktywne bywają zawyżone.`,
      );
    }
  } catch {
    /* Garmin opcjonalny */
  }
  await say(env, lines.join("\n"));
}

async function cmdDelete(env: Env, arg: string) {
  const st = coach(env);
  const n = Number(arg.trim());
  const meals = await st.getMeals(warsaw().date);
  if (!Number.isInteger(n) || n < 1 || n > meals.length) {
    await say(env, `Podaj numer posiłku z /dzis (1–${meals.length || "?"}), np. /usun 2`);
    return;
  }
  const m = meals[n - 1];
  await st.deleteMeal(m.id);
  await say(env, `🗑 Usunięto: ${m.time} ${m.label} (${m.totals.kcal} kcal).`);
}

async function cmdWeight(env: Env, arg: string) {
  const kg = Number(arg.trim().replace(",", ".").replace(/kg$/i, ""));
  if (!Number.isFinite(kg) || kg < 30 || kg > 250) {
    await say(env, "Podaj wagę w kg, np. /waga 82,5");
    return;
  }
  const st = coach(env);
  const today = warsaw().date;
  await st.addWeight({ date: today, kg: r1(kg) });
  const s = weightStats(await st.getWeights(), today);
  const trend = s.deltaWeek !== null ? ` · średnia 7 dni ${s.avg7} kg (${s.deltaWeek > 0 ? "+" : ""}${s.deltaWeek} kg do poprzedniego tygodnia)` : s.avg7 !== null ? ` · średnia 7 dni ${s.avg7} kg` : "";
  await say(env, `⚖️ Zapisano ${r1(kg)} kg${trend}.\nDzienna waga się waha o 1–2 kg, patrz na średnią tygodniową.`);
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
  await say(env, `✅ Zapisano plan ${weekend ? "na weekend" : "pn–pt"}: ${parsed.slots.map((s) => `${s.name} ${s.time}`).join("; ")}.\nPrzypomnę, jeśli nie będzie wpisu ${cfg.remindAfterMin / 60} h po planowanej godzinie.`);
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
      if (x >= 0 && x <= 700) await st.patchNutCfg({ deficitKcal: r0(x) });
      else err = "Deficyt: 0–700 kcal (dotyczy tylko dni bez biegu i łatwych).";
    } else if (what === "przypomnienie") {
      if (x >= 30 && x <= 360) await st.patchNutCfg({ remindAfterMin: r0(x) });
      else err = "Przypomnienie: 30–360 minut po planie.";
    } else if (what === "wegle" && DAY_KEYS[a ?? ""] && v(b) >= 2 && v(b) <= 10) {
      const cur = await st.getNutCfg();
      await st.patchNutCfg({ carbsPerKg: { ...cur.carbsPerKg, [DAY_KEYS[a]]: v(b) } });
    } else {
      err = "Użycie: /cel bialko 1,8 · /cel tluszcz 1 · /cel deficyt 300 · /cel wegle lekki 4,5 (wolny|lekki|akcent|dlugi) · /cel przypomnienie 180";
    }
    if (err) {
      await say(env, `⚠️ ${err}`);
      return;
    }
  }
  const cfg = await st.getNutCfg();
  const w = weightStats(await st.getWeights(), warsaw().date).last?.kg ?? cfg.weightFallbackKg;
  const lines = [`🎯 Cele (waga ${w ?? "brak: /waga 82,5"} kg)`, `Białko ${cfg.proteinPerKg} g/kg · tłuszcz ${cfg.fatPerKg} g/kg · deficyt ${cfg.deficitKcal} kcal (tylko dni bez biegu i łatwe)`];
  const base = await energyBase(env, warsaw().date).catch(() => null);
  lines.push(
    base
      ? `Kcal z ${base.source === "kalibracja" ? "kalibracji (waga i spożycie)" : "średniego spalania z Garmina (14 dni, kalorie aktywne ×0,85)"}: ok. ${base.kcal} kcal na przeciętny dzień`
      : "Kcal z g/kg (brak danych o spalaniu: Garmin lub ≥ 3 tygodnie zapisów i wagi)",
  );
  for (const t of ["rest", "easy", "quality", "long"] as DayType[]) {
    const x = computeTargets(cfg, w, t, base);
    lines.push(`• ${DAY_TYPE_PL[t]}: ${x ? `${x.kcal} kcal · B ${x.protein} · W ${x.carbs} (${r1(x.carbs / (w ?? 1))} g/kg) · T ${x.fat}` : "brak wagi"}`);
  }
  await say(env, lines.join("\n"));
}

async function cmdFavorites(env: Env, arg: string) {
  const st = coach(env);
  const favs = await st.getFavorites();
  const del = /^usun\s+(\d+)/.exec(norm(arg));
  if (del) {
    const ok = await st.removeFavorite(Number(del[1]) - 1);
    await say(env, ok ? "Usunięto z ulubionych." : "Nie ma takiego numeru.");
    return;
  }
  if (!favs.length) {
    await say(env, "Brak ulubionych. Po zapisaniu posiłku stuknij ⭐ Ulubione pod wiadomością.");
    return;
  }
  const kb = favs.map((f, i) => [{ text: `${f.name} · ${sumMacros(f.items).kcal} kcal`.slice(0, 60), callback_data: `f:${i}` }]);
  await say(env, "⭐ Stuknij, żeby dodać (teraz). Usuwanie: /ulubione usun 2", kb);
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
  await say(env, on ? "🔔 Przypomnienia włączone." : "🔕 Przypomnienia wyłączone (np. na urlop). Włączysz: /przypomnienia on");
}

const COMMANDS: Record<string, (env: Env, arg: string, msg: any) => Promise<void>> = {
  dieta: async (env) => void (await say(env, HELP)),
  dzis: (env, arg) => cmdToday(env, arg),
  usun: (env, arg) => cmdDelete(env, arg),
  waga: (env, arg) => cmdWeight(env, arg),
  posilki: (env, arg) => cmdSlots(env, arg),
  cel: (env, arg) => cmdGoals(env, arg),
  ulubione: (env, arg) => cmdFavorites(env, arg),
  przypomnienia: (env, arg) => cmdReminders(env, arg),
  jem: async (env, arg, msg) => {
    if (!arg.trim()) await say(env, "Napisz, co zjadłeś, np. /jem owsianka 60 g z mlekiem i bananem");
    else await logText(env, msg, arg.trim());
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
      ctx.waitUntil(say(env, "📎 W albumie przetwarzam tylko pierwsze zdjęcie. Resztę wyślij osobno lub dopisz /jem …").catch(() => {}));
      return true;
    }
    ctx.waitUntil(guard(env, "Rozpoznanie zdjęcia", () => logPhoto(env, msg)));
    return true;
  }
  if (!text) return false;

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
      ctx.waitUntil(guard(env, "Poprawka posiłku", () => correctMeal(env, mealId, text, msg)));
      return true;
    }
  }
  if (NATURAL_MEAL.test(text)) {
    ctx.waitUntil(guard(env, "Zapis posiłku", () => logText(env, msg, text)));
    return true;
  }
  return false;
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
      const fav = (await st.getFavorites())[Number(act)];
      if (!fav) return void (await answer("Nie znaleziono"));
      await answer("Dodaję…");
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
      await announce(env, meal, labelForTime(slotsFor(cfg, now.weekday), now.time, cfg.remindAfterMin));
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
        await answer("Pominięte");
        await stripButtons();
      } else if (act === "later") {
        await st.setReminders({ [key]: `snooze:${new Date(Date.now() + 60 * 60_000).toISOString()}` }, today);
        await answer("Przypomnę za godzinę");
        await stripButtons();
      } else {
        await answer("Wyślij zdjęcie lub opis 📸");
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
        ? `🍽 Nie widzę wpisu: ${d.slot.name} (plan ${d.slot.time}). Wyślij zdjęcie lub krótki opis albo wybierz poniżej.`
        : `🍽 Jeszcze raz o posiłku „${d.slot.name}” (plan ${d.slot.time}): zdjęcie, opis albo „Pominąłem”.`;
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
      ? { kcal: info.targets.kcal, bialko_g: info.targets.protein, weglowodany_g: info.targets.carbs, tluszcz_g: info.targets.fat, zrodlo_kcal: info.targets.source === "g/kg" ? "g/kg masy ciała (brak danych o spalaniu)" : info.targets.source === "garmin" ? `średnie spalanie z Garmina 14 dni (aktywne ×0,85): ${info.base?.kcal} kcal/dzień` : `kalibracja z wagi i spożycia: ${info.base?.kcal} kcal/dzień`, uwaga: info.targets.note }
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
      return { ostatnia: s.last, srednia_7_dni: s.avg7, zmiana_tydzien_do_tygodnia_kg: s.deltaWeek, pomiary_28_dni: s.count28 };
    })(),
    kalibracja_zapotrzebowania: estimateTdee(intake, weights, today),
    garmin_uwagi: energyError ?? "Spalone = spoczynkowe + aktywne. Kalorie aktywne Garmina bywają zawyżone o 10–30%. Dzisiejsza wartość jest cząstkowa do końca dnia.",
    ustawienia: { deficyt_kcal: cfg.deficitKcal, bialko_g_na_kg: cfg.proteinPerKg, tluszcz_g_na_kg: cfg.fatPerKg, weglowodany_g_na_kg: cfg.carbsPerKg, przypomnienia: cfg.remindersOn, plan_posilkow_pn_pt: cfg.slots, plan_posilkow_weekend: cfg.weekendSlots },
  };
}
