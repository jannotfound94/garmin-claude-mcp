import { daysBetween } from "./time";

/**
 * Dietetyk: czysta logika (bez I/O), żeby dała się testować. Przechowywanie jest w state.ts,
 * rozpoznawanie zdjęć w gemini.ts, obsługa Telegrama w diet.ts.
 */

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}
export type Confidence = "high" | "medium" | "low";
export interface FoodItem extends Macros {
  name: string;
  grams: number | null;
  confidence: Confidence;
  basis: "label" | "estimate"; // label: z etykiety / bazy produktu; estimate: oszacowanie ze zdjęcia
}
/** Rodzaj posiłku wybrany w aplikacji. Przekąska i deser to dodatki poza planem: nie zaliczają żadnego okna z planu. */
export type MealKind = "sniadanie" | "przekaska" | "obiad" | "kolacja" | "deser";
export const MEAL_KINDS: Record<MealKind, string> = { sniadanie: "Śniadanie", przekaska: "Przekąska", obiad: "Obiad", kolacja: "Kolacja", deser: "Deser" };
export const isMealKind = (v: unknown): v is MealKind => typeof v === "string" && Object.prototype.hasOwnProperty.call(MEAL_KINDS, v);
const EXTRA_KINDS = new Set<string>(["przekaska", "deser"]);

export interface Meal {
  id: string; // "YYYYMMDD.abc123": data jest zaszyta w id
  date: string; // YYYY-MM-DD (czas warszawski)
  time: string; // HH:MM
  label: string;
  source: "photo" | "text" | "favorite";
  note: string;
  items: FoodItem[];
  totals: Macros;
  confidence: Confidence;
  question: string | null;
  /** Nazwa okna z planu posiłków, jeśli Jan wyraźnie napisał, który to posiłek ("to było śniadanie"). */
  slot?: string | null;
  /** Rodzaj wskazany przez Jana w aplikacji (patrz MealKind). */
  kind?: MealKind | null;
  photoFileId?: string;
  createdAt: string; // ISO UTC
}
/** Zadanie rozpoznania posiłku ponawiane w tle, gdy Gemini jest chwilowo niedostępny. */
export interface DietJob {
  id: string;
  kind: "photo" | "text" | "correct";
  at: number; // unix (s) wiadomości, od której zaczęło się zadanie
  text?: string; // opis, podpis pod zdjęciem albo poprawka
  fileId?: string; // zdjęcie w Telegramie (pobierane przy każdej próbie)
  mealId?: string; // przy poprawce
  attempts: number; // ile razy już ponawiano
  nextAt: number; // kiedy następna próba (ms)
}
export interface Slot {
  name: string;
  time: string; // HH:MM
}
export type DayType = "rest" | "easy" | "quality" | "long";
export const DAY_TYPE_PL: Record<DayType, string> = {
  rest: "dzień bez biegu",
  easy: "łatwy bieg",
  quality: "akcent (tempo/interwały)",
  long: "długi bieg",
};

export type NotifyChannel = "app" | "telegram" | "both";

export interface NutritionConfig {
  slots: Slot[]; // pn-pt (i każdy dzień, gdy weekendSlots puste)
  weekendSlots: Slot[];
  remindersOn: boolean;
  remindAfterMin: number; // po ilu minutach od planowanej godziny przypomnieć
  proteinPerKg: number;
  fatPerKg: number;
  carbsPerKg: Record<DayType, number>;
  deficitKcal: number; // stosowany tylko w dni "rest" i "easy"
  /**
   * Masa, od której liczone są gramy na kg (białko, tłuszcz, podłoga węglowodanów). Null = aktualna waga.
   * Przy nadwadze gramy na kg od całej masy dają tyle białka i tłuszczu, że deficyt się nie mieści: wtedy ustaw masę bliżej docelowej.
   */
  macroWeightKg: number | null;
  /** Docelowa waga. Gdy nie ma jawnej masy referencyjnej, gramy na kg liczone są od niższej z wagi i celu. */
  goalWeightKg: number | null;
  /** Którędy trafiają do Janka wiadomości trenera i przypomnienia: aplikacja (push), Telegram albo oba. */
  notifyChannel: NotifyChannel;
  /** Do kiedy ma być waga docelowa (YYYY-MM-DD), np. start maratonu. Null = bez terminu. */
  goalDate: string | null;
  /**
   * Korekta danych z Garmina: mnoży spoczynkowe i aktywne spalanie wzięte z zegarka (po osobnym ×0,85 dla aktywnych).
   * Zegarki zawyżają spalanie, więc domyślnie 0,9. Po kalibracji z wagi (ok. 3–4 tygodni danych) Garmin przestaje być potrzebny.
   */
  garminFactor: number;
  weightFallbackKg: number | null;
}

export const DEFAULT_CONFIG: NutritionConfig = {
  slots: [],
  weekendSlots: [],
  remindersOn: true,
  remindAfterMin: 180,
  proteinPerKg: 1.6, // dla Janka w redukcji: od 95 kg to ok. 150 g
  fatPerKg: 0.8,
  carbsPerKg: { rest: 3.5, easy: 4.5, quality: 6, long: 7 },
  deficitKcal: 600, // Janek redukuje masę ciała 107 -> 95 kg (patrz TRENER.md); /cel deficyt 0 wyłącza
  macroWeightKg: null,
  goalWeightKg: 95,
  notifyChannel: "both", // do czasu włączenia powiadomień w aplikacji działa tak, jak dotąd: Telegram
  goalDate: "2027-04-25", // start Energa Gdańsk Maraton
  garminFactor: 0.9,
  weightFallbackKg: null,
};

export const KCAL_PER_KG_BODY = 7700;
const MIN_PER_DAY_CUTOFF = 21 * 60 + 45; // ostatnie przypomnienie najpóźniej o 21:45 (scheduler śpi od 22:00)
const EARLY_WINDOW_MIN = 90; // posiłek zjedzony do 90 min przed planem nadal "zalicza" okno

// ---------------- liczby ----------------

export const r0 = (n: number) => Math.round(n);
export const r1 = (n: number) => Math.round(n * 10) / 10;

export function sumMacros(items: Macros[]): Macros {
  const t = items.reduce(
    (a, i) => ({ kcal: a.kcal + i.kcal, protein: a.protein + i.protein, carbs: a.carbs + i.carbs, fat: a.fat + i.fat }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return { kcal: r0(t.kcal), protein: r0(t.protein), carbs: r0(t.carbs), fat: r0(t.fat) };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Walidacja pozycji z modelu. Modele czasem zwracają kcal niezgodne z makroskładnikami;
 * gdy rozjazd przekracza 20%, ufamy makro (4/4/9), bo to one są zwykle odczytane lub policzone staranniej.
 */
export function normalizeItem(raw: any): FoodItem | null {
  const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 80) : "";
  const protein = num(raw?.protein_g ?? raw?.protein);
  const carbs = num(raw?.carbs_g ?? raw?.carbs);
  const fat = num(raw?.fat_g ?? raw?.fat);
  let kcal = num(raw?.kcal);
  if (!name || protein === null || carbs === null || fat === null) return null;
  const p = clamp(protein, 0, 400);
  const c = clamp(carbs, 0, 800);
  const f = clamp(fat, 0, 400);
  const alcohol = clamp(num(raw?.alcohol_g) ?? 0, 0, 300); // 7 kcal/g, nie ma własnej kolumny
  const fromMacros = 4 * p + 4 * c + 9 * f + 7 * alcohol;
  if (kcal === null || kcal < 0) kcal = fromMacros;
  else if (fromMacros > 20 && Math.abs(kcal - fromMacros) / Math.max(kcal, fromMacros) > 0.2) kcal = fromMacros;
  const grams = num(raw?.grams);
  const conf: Confidence = raw?.confidence === "high" || raw?.confidence === "low" ? raw.confidence : "medium";
  return {
    name,
    grams: grams !== null && grams > 0 ? r0(clamp(grams, 1, 5000)) : null,
    kcal: r0(clamp(kcal, 0, 4000)),
    protein: r1(p),
    carbs: r1(c),
    fat: r1(f),
    confidence: conf,
    basis: raw?.basis === "label" ? "label" : "estimate",
  };
}

export function overallConfidence(items: FoodItem[]): Confidence {
  if (!items.length) return "low";
  const total = items.reduce((a, i) => a + i.kcal, 0) || 1;
  // Waży pewność kaloriami: niepewna przyprawa nie obniża oceny całego talerza.
  const lowShare = items.filter((i) => i.confidence === "low").reduce((a, i) => a + i.kcal, 0) / total;
  const highShare = items.filter((i) => i.confidence === "high").reduce((a, i) => a + i.kcal, 0) / total;
  if (lowShare > 0.3) return "low";
  if (highShare > 0.7) return "high";
  return "medium";
}

// ---------------- czas ----------------

export const hhmmToMin = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
};
export const minToHhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export const validHhmm = (t: string) => {
  const m = hhmmToMin(t);
  return Number.isFinite(m) && m >= 0 && m < 24 * 60;
};
export const normHhmm = (t: string) => minToHhmm(hhmmToMin(t));

/** "sniadanie", "Drugie śniadanie" -> "drugiesniadanie" (do callback_data i porównań). */
export function slotKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 14);
}

export function slotsFor(cfg: NutritionConfig, weekday: string): Slot[] {
  const weekend = weekday === "Sat" || weekday === "Sun";
  const list = weekend && cfg.weekendSlots.length ? cfg.weekendSlots : cfg.slots;
  return [...list].sort((a, b) => hhmmToMin(a.time) - hhmmToMin(b.time));
}

/** "śniadanie 07:30; obiad 13:30, kolacja 19:30" -> sloty. Zwraca błąd tekstem, gdy format zły. */
export function parseSlots(input: string): { slots: Slot[] } | { error: string } {
  const parts = input
    .split(/[;,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { error: "Podaj posiłki, np. śniadanie 07:30; obiad 13:30; kolacja 19:30" };
  const slots: Slot[] = [];
  for (const p of parts) {
    const m = /^(.*?)\s*(\d{1,2})[:.](\d{2})$/.exec(p);
    if (!m || !m[1].trim()) return { error: `Nie rozumiem "${p}". Format: nazwa GG:MM, np. obiad 13:30` };
    const time = `${m[2].padStart(2, "0")}:${m[3]}`;
    if (!validHhmm(time)) return { error: `Zła godzina w "${p}".` };
    slots.push({ name: m[1].trim().slice(0, 30), time });
  }
  if (slots.length > 10) return { error: "Maksymalnie 10 posiłków dziennie." };
  const keys = new Set(slots.map((s) => slotKey(s.name)));
  if (keys.size !== slots.length) return { error: "Nazwy posiłków muszą się różnić." };
  return { slots };
}

/** Nazwa najbliższego posiłku z planu dla godziny jedzenia; poza oknami: "Przekąska". */
export function labelForTime(slots: Slot[], time: string, remindAfterMin = DEFAULT_CONFIG.remindAfterMin): string {
  const t = hhmmToMin(time);
  let best: { name: string; d: number } | null = null;
  for (const s of slots) {
    const d = t - hhmmToMin(s.time);
    if (d >= -EARLY_WINDOW_MIN && d <= remindAfterMin && (!best || Math.abs(d) < best.d)) best = { name: s.name, d: Math.abs(d) };
  }
  return best?.name ?? "Przekąska";
}

// ---------------- przypomnienia ----------------

export type ReminderState = "sent" | "sent2" | "ok" | "skip" | `snooze:${string}`;
export interface DueReminder {
  slot: Slot;
  key: string; // klucz w mapie stanu: "YYYY-MM-DD|slotKey"
  attempt: 1 | 2;
}

/**
 * Które okna posiłków mają zapisany posiłek. Posiłek z jawnie podanym oknem ("to było śniadanie") zalicza właśnie je,
 * bez względu na godzinę wpisu. Pozostałe zaliczają najbliższe okno czasowe (każdy posiłek najwyżej jedno).
 */
export function satisfiedSlots(slots: Slot[], meals: Pick<Meal, "time" | "slot" | "kind">[], remindAfterMin: number): Set<number> {
  const used = new Set<number>();
  const byTime: Pick<Meal, "time" | "slot" | "kind">[] = [];
  for (const m of meals) {
    if (m.kind && EXTRA_KINDS.has(m.kind)) continue; // przekąska i deser nie zastępują posiłku z planu
    const i = m.slot ? slots.findIndex((s, idx) => !used.has(idx) && slotKey(s.name) === slotKey(m.slot!)) : -1;
    if (i >= 0) used.add(i);
    else byTime.push(m);
  }
  byTime.sort((a, b) => hhmmToMin(a.time) - hhmmToMin(b.time));
  for (const m of byTime) {
    const t = hhmmToMin(m.time);
    let best = -1;
    let bestD = Infinity;
    slots.forEach((s, i) => {
      const d = t - hhmmToMin(s.time);
      if (d >= -EARLY_WINDOW_MIN && d <= remindAfterMin && !used.has(i) && Math.abs(d) < bestD) {
        best = i;
        bestD = Math.abs(d);
      }
    });
    if (best >= 0) used.add(best);
  }
  return used;
}

export const reminderDueMin = (slot: Slot, remindAfterMin: number) =>
  Math.min(hhmmToMin(slot.time) + remindAfterMin, MIN_PER_DAY_CUTOFF);

/**
 * Decyduje, o co przypomnieć teraz. Zwraca też okna, które mają już posiłek ("ok"), żeby nie liczyć ich ponownie.
 * Pierwszy raz sprawdzamy w momencie plan+remindAfter (nie później niż 21:45), po "Za godzinę" jeszcze raz, i na tym koniec.
 */
export function evaluateReminders(args: {
  cfg: NutritionConfig;
  date: string;
  nowMin: number;
  weekday: string;
  meals: Pick<Meal, "time" | "slot" | "kind">[];
  state: Record<string, string>;
  nowIso: string;
}): { due: DueReminder[]; markOk: string[] } {
  const { cfg, date, nowMin, weekday, meals, state, nowIso } = args;
  const out = { due: [] as DueReminder[], markOk: [] as string[] };
  if (!cfg.remindersOn) return out;
  const slots = slotsFor(cfg, weekday);
  const done = satisfiedSlots(slots, meals, cfg.remindAfterMin);
  slots.forEach((slot, i) => {
    const key = `${date}|${slotKey(slot.name)}`;
    const st = state[key];
    if (st === "ok" || st === "skip" || st === "sent2") return;
    if (st === "sent") return; // jedno przypomnienie, dopóki Jan nie wybierze "Za godzinę"
    const satisfied = done.has(i);
    if (st && st.startsWith("snooze:")) {
      if (nowIso < st.slice(7)) return;
      if (satisfied) out.markOk.push(key);
      else out.due.push({ slot, key, attempt: 2 });
      return;
    }
    if (nowMin < reminderDueMin(slot, cfg.remindAfterMin)) return;
    if (satisfied) out.markOk.push(key);
    else out.due.push({ slot, key, attempt: 1 });
  });
  return out;
}

// ---------------- typ dnia i cele ----------------

const QUALITY_RE = /interwa|tempo|akcent|prog|rytm|fartlek|tempowy|threshold|\d+\s*x\s*\d|\bx\s*\d+\s*(m|km|min)/i;
const LONG_RE = /d[łl]ugi|long\b|d[łl]uga/i;
const LONG_KM = 16;
const LONG_MIN = 100 * 60;

/**
 * Typ dnia z planu i z tego, co faktycznie zrobiono (bierze cięższy). Wejście: surowe obiekty z intervals.icu.
 * Nie-biegowe aktywności (spacer, siłownia) nie zmieniają typu dnia.
 */
export function classifyDay(events: any[], activities: any[]): { type: DayType; why: string; km: number } {
  const rank: Record<DayType, number> = { rest: 0, easy: 1, quality: 2, long: 3 };
  let best: { type: DayType; why: string } = { type: "rest", why: "brak biegu w planie i w aktywnościach" };
  const consider = (type: DayType, why: string) => {
    if (rank[type] > rank[best.type]) best = { type, why };
  };
  const isRun = (x: any) => /run/i.test(String(x?.type ?? ""));
  let plannedKm = 0;
  let actualKm = 0;
  for (const e of events) {
    if (e?.category && e.category !== "WORKOUT") continue;
    if (!isRun(e)) continue;
    const km = (e.distance ?? 0) / 1000;
    plannedKm += km;
    const secs = e.moving_time ?? 0;
    const text = `${e.name ?? ""} ${e.description ?? ""}`;
    if (km >= LONG_KM || secs >= LONG_MIN || LONG_RE.test(e.name ?? "")) consider("long", `plan: ${e.name ?? "bieg"}`);
    else if (QUALITY_RE.test(text)) consider("quality", `plan: ${e.name ?? "bieg"}`);
    else consider("easy", `plan: ${e.name ?? "bieg"}`);
  }
  for (const a of activities) {
    if (!isRun(a)) continue;
    const km = (a.distance ?? a.icu_distance ?? 0) / 1000;
    actualKm += km;
    const secs = a.moving_time ?? 0;
    if (km >= LONG_KM || secs >= LONG_MIN) consider("long", `wykonany bieg ${r1(km)} km`);
    else if (km >= 1) consider("easy", `wykonany bieg ${r1(km)} km`);
  }
  // Dystans: większy z planu i z tego, co zrobiono (bieg zrobiony dłużej niż w planie liczy się naprawdę).
  return { ...best, km: r1(Math.max(plannedKm, actualKm)) };
}

export type TargetSource = "kalibracja" | "garmin" | "g/kg";
/** Kontekst dnia: dystans biegu (plan lub wykonany) i aktywne kcal Garmina zebrane dotąd dzisiaj. */
export interface TargetCtx {
  runKm?: number | null;
  activeTodayKcal?: number | null;
}
export const RUN_KCAL_PER_KG_KM = 0.9; // koszt netto biegu (z zapasem na zawyżanie przez zegarki)
export const DEFAULT_RUN_KM: Record<DayType, number> = { rest: 0, easy: 6, quality: 8, long: 18 };
export interface Targets extends Macros {
  dayType: DayType;
  deficitApplied: number;
  source: TargetSource;
  note: string | null;
}
export interface EnergyBase {
  kcal: number; // dzienne zapotrzebowanie "przeciętnego" dnia
  source: Exclude<TargetSource, "g/kg">;
  /** Tylko dla źródła "garmin": z czego policzono (mediany dzienne), do wglądu w /cel i /spalanie. */
  detail?: { days: number; resting: number; active: number; quietActive: number; min: number; max: number };
}

/** Zapotrzebowanie danego typu dnia względem średniej z tygodnia z ok. 3 biegami (dzień bez biegu poniżej, długi bieg wyraźnie powyżej). */
export const GARMIN_ACTIVE_HAIRCUT = 0.85; // aktywne kcal Garmina bywają zawyżone o 10–30%
export const DAY_FACTOR: Record<DayType, number> = { rest: 0.93, easy: 1.03, quality: 1.08, long: 1.2 };
export const MIN_CARBS_PER_KG = 2; // poniżej tego (g na kg masy referencyjnej) biegaczowi nie schodzimy nawet w deficycie

/**
 * Cele dnia. Gdy znamy rzeczywiste zapotrzebowanie (kalibracja z wagi albo średnia spalania z Garmina), kcal wynika
 * z niego (typ dnia ×  współczynnik, minus deficyt w dni bez biegu i łatwe), białko i tłuszcz idą z g/kg, a węglowodany
 * dopełniają resztę. Bez tych danych cele liczone są czysto z g/kg (węglowodany wg typu dnia). Deficyt zawsze kosztem
 * węglowodanów, nigdy białka, i nigdy w dni akcentów i długich biegów.
 */
export function computeTargets(cfg: NutritionConfig, weightKg: number | null, dayType: DayType, base?: EnergyBase | null, ctx?: TargetCtx): Targets | null {
  if (!weightKg || weightKg < 30 || weightKg > 250) return null;
  const refKg = cfg.macroWeightKg ?? (cfg.goalWeightKg ? Math.min(weightKg, cfg.goalWeightKg) : weightKg); // masa, od której liczymy gramy na kg
  const protein = cfg.proteinPerKg * refKg;
  const fat = cfg.fatPerKg * refKg;
  const deficitDay = dayType === "rest" || dayType === "easy";
  const floorCarbs = MIN_CARBS_PER_KG * refKg;
  let note: string | null = null;
  let carbs: number;
  let deficit = 0;

  if (base && base.kcal > 0) {
    let kcal: number;
    let raised = 0;
    if (base.source === "garmin" && base.detail) {
      // Od spokojnego dnia (spoczynkowe + lekka aktywność) w górę: bieg z planu doliczany z góry, a gdy Garmin pokazuje dziś
      // więcej wysiłku niż w planie (spacer, góry, dłuższy bieg), cel rośnie do faktycznego spalania.
      const f = cfg.garminFactor;
      const runKcal = RUN_KCAL_PER_KG_KM * weightKg * (ctx?.runKm ?? DEFAULT_RUN_KM[dayType]);
      const planned = f * (base.detail.resting + GARMIN_ACTIVE_HAIRCUT * base.detail.quietActive) + runKcal;
      const actual = ctx?.activeTodayKcal != null ? f * (base.detail.resting + GARMIN_ACTIVE_HAIRCUT * ctx.activeTodayKcal) : 0;
      kcal = Math.max(planned, actual);
      raised = Math.max(0, actual - planned);
    } else kcal = base.kcal * DAY_FACTOR[dayType];
    if (cfg.deficitKcal > 0) {
      if (deficitDay) {
        deficit = cfg.deficitKcal;
        kcal -= deficit;
      } else note = "Dzień mocnego treningu: bez deficytu, pełne paliwo.";
    }
    if (raised > 50) note = `Cel podniesiony o ok. ${r0(raised)} kcal: Garmin pokazuje dziś większy wysiłek niż w planie.`;
    carbs = (kcal - 4 * protein - 9 * fat) / 4;
    if (carbs < floorCarbs) {
      deficit = Math.max(0, deficit - (floorCarbs - carbs) * 4);
      carbs = floorCarbs;
      note = "Deficyt ograniczony: węglowodany nie schodzą poniżej minimum (2 g/kg). Obniż białko/tłuszcz lub ustaw masę referencyjną: /cel masa.";
    }
    return {
      kcal: r0(4 * protein + 4 * carbs + 9 * fat),
      protein: r0(protein),
      carbs: r0(carbs),
      fat: r0(fat),
      dayType,
      deficitApplied: r0(deficit),
      source: base.source,
      note,
    };
  }

  carbs = cfg.carbsPerKg[dayType] * refKg;
  if (cfg.deficitKcal > 0) {
    if (deficitDay) {
      const cut = Math.min(cfg.deficitKcal / 4, Math.max(0, carbs - floorCarbs));
      carbs -= cut;
      deficit = r0(cut * 4);
      if (deficit < cfg.deficitKcal) note = "Deficyt ograniczony: węglowodany nie schodzą poniżej minimum (2 g/kg).";
    } else note = "Dzień mocnego treningu: bez deficytu, pełne paliwo.";
  }
  const kcal = 4 * protein + 4 * carbs + 9 * fat;
  return { kcal: r0(kcal), protein: r0(protein), carbs: r0(carbs), fat: r0(fat), dayType, deficitApplied: deficit, source: "g/kg", note };
}

// ---------------- waga i kalibracja ----------------

export interface Weight {
  date: string;
  kg: number;
}

export function weightStats(weights: Weight[], today: string) {
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1] ?? null;
  const within = (days: number) => sorted.filter((w) => daysBetween(w.date, today) <= days && daysBetween(w.date, today) >= 0);
  const avg = (ws: Weight[]) => (ws.length ? r1(ws.reduce((a, w) => a + w.kg, 0) / ws.length) : null);
  const w7 = within(6);
  const prev7 = sorted.filter((w) => daysBetween(w.date, today) >= 7 && daysBetween(w.date, today) <= 13);
  const a7 = avg(w7);
  const ap = avg(prev7);
  return {
    last,
    avg7: a7,
    avgPrev7: ap,
    deltaWeek: a7 !== null && ap !== null ? r1(a7 - ap) : null,
    count28: within(27).length,
  };
}

/**
 * Postęp do wagi docelowej: ile zostało, tempo z regresji (jeśli są dane), prognoza oraz plan liniowy do terminu
 * (od pierwszego zapisanego ważenia do wagi docelowej w dniu goalDate) i tempo potrzebne od dziś.
 */
export function goalProgress(weights: Weight[], goalKg: number | null, today: string, goalDate: string | null = null) {
  const s = weightStats(weights, today);
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0] ?? null;
  const slope = weightSlopePerDay(weights, today, 28);
  const trend = slope === null ? null : r1(slope * 7); // kg na tydzień
  const toGo = s.last && goalKg ? r1(s.last.kg - goalKg) : null;
  const weeksToGoal = toGo !== null && toGo > 0 && trend !== null && trend < -0.05 ? Math.ceil(toGo / -trend) : null;

  let planKgToday: number | null = null;
  let aheadKg: number | null = null; // dodatnie = lżej niż w planie
  let requiredKgPerWeek: number | null = null;
  let weeksLeft: number | null = null;
  if (goalDate) {
    const daysLeft = daysBetween(today, goalDate);
    weeksLeft = daysLeft > 0 ? r1(daysLeft / 7) : 0;
    if (s.last && goalKg && daysLeft > 0 && s.last.kg > goalKg) requiredKgPerWeek = r1((s.last.kg - goalKg) / (daysLeft / 7));
    if (first && goalKg && first.kg > goalKg) {
      const total = daysBetween(first.date, goalDate);
      if (total > 0) {
        const frac = Math.min(1, Math.max(0, daysBetween(first.date, today) / total));
        planKgToday = r1(first.kg - (first.kg - goalKg) * frac);
        if (s.last) aheadKg = r1(planKgToday - s.last.kg);
      }
    }
  }
  return {
    last: s.last,
    daysSinceWeighIn: s.last ? daysBetween(s.last.date, today) : null,
    goalKg,
    toGoKg: toGo,
    trendKgPerWeek: trend,
    weeksToGoal,
    goalDate,
    weeksLeft,
    planKgToday,
    aheadKg,
    requiredKgPerWeek,
  };
}

/** Nachylenie regresji liniowej wagi (kg/dzień) na oknie; null gdy za mało pomiarów lub za krótki zakres. */
export function weightSlopePerDay(weights: Weight[], today: string, windowDays: number): number | null {
  const pts = weights
    .map((w) => ({ x: -daysBetween(w.date, today), y: w.kg }))
    .filter((p) => p.x <= 0 && p.x >= -windowDays);
  if (pts.length < 4) return null;
  const span = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
  if (span < 14) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  return sxx === 0 ? null : sxy / sxx;
}

export interface DayIntake {
  date: string;
  kcal: number;
  meals: number;
}

/** Dzień uznajemy za zalogowany kompletnie, gdy ma min. 2 posiłki i min. 1000 kcal (inaczej: prawdopodobnie brakuje wpisów). */
export const isLoggedDay = (d: DayIntake) => d.meals >= 2 && d.kcal >= 1000;

/**
 * Rzeczywiste zapotrzebowanie (TDEE) z bilansu: średnie spożycie − tempo zmiany wagi × 7700 kcal/kg.
 * Działa dopiero po ~3 tygodniach (min. 14 zalogowanych dni z 28 i 4 ważenia w ≥14-dniowym zakresie).
 * Uwaga: niedoszacowanie porcji i niezalogowane przekąski zaniżają wynik.
 */
export function estimateTdee(intake: DayIntake[], weights: Weight[], today: string) {
  const logged = intake.filter((d) => daysBetween(d.date, today) <= 27 && daysBetween(d.date, today) >= 1 && isLoggedDay(d));
  const slope = weightSlopePerDay(weights, today, 28);
  if (logged.length < 14 || slope === null) {
    return { ready: false as const, loggedDays: logged.length, needed: "min. 14 zalogowanych dni i 4 ważenia w ciągu ≥14 dni (z ostatnich 28 dni)" };
  }
  const avgKcal = logged.reduce((a, d) => a + d.kcal, 0) / logged.length;
  return {
    ready: true as const,
    loggedDays: logged.length,
    avgIntakeKcal: r0(avgKcal),
    weightTrendKgPerWeek: r1(slope * 7),
    tdeeKcal: r0(avgKcal - slope * KCAL_PER_KG_BODY),
  };
}

// ---------------- formatowanie ----------------

export const fmtMacros = (m: Macros) => `${r0(m.kcal)} kcal · B ${r0(m.protein)} · W ${r0(m.carbs)} · T ${r0(m.fat)}`;

export const CONFIDENCE_PL: Record<Confidence, string> = { high: "wysoka", medium: "średnia", low: "niska" };

export function newMealId(date: string): string {
  const rnd = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${date.replaceAll("-", "")}.${rnd}`;
}

/** "20261116.ab12cd" -> "2026-11-16" (null, gdy id ma zły format). */
export function dateOfMealId(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})\.[0-9a-f]{6}$/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
