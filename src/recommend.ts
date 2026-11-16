/**
 * Rekomendacje dnia dla aplikacji: czysta funkcja z danych (jedzenie, trening jutro, pogoda, regeneracja, waga).
 * Bez AI i bez I/O, więc wynik jest powtarzalny i testowalny. Ton: kumpel-trener, do "Janka".
 */
import type { DayType } from "./nutrition";
import type { DayForecast } from "./weather";

export interface RecInput {
  now: { date: string; hour: number; minute: number };
  food: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    mealsCount: number;
    targets: { kcal: number; protein: number; carbs: number; fat: number; deficit: number } | null;
    dayType: DayType;
    targetNote: string | null;
  };
  /** known = plan z kalendarza został pobrany; bez tego nie twierdzimy, że "jutro nic nie ma". */
  tomorrow: { dayType: DayType; events: { name: string; km: number | null }[]; known: boolean };
  today: { planned: { name: string; km: number | null }[]; doneRun: boolean };
  weather: { today: DayForecast | null; tomorrow: DayForecast | null };
  recovery: { sleepH: number | null; bbPeak: number | null; hrvStatus: string | null } | null;
  weight: {
    daysSinceWeighIn: number | null;
    aheadKg: number | null;
    requiredKgPerWeek: number | null;
    toGoKg: number | null;
    goalKg: number | null;
  };
}

export interface Rec {
  kind: "food" | "training" | "weather" | "recovery" | "weight";
  icon: string;
  title: string;
  text: string;
  priority: number; // 1 = najpilniejsze
}

const PROTEIN_IDEAS: { text: string; g: number }[] = [
  { text: "200 g skyru naturalnego (ok. 22 g)", g: 22 },
  { text: "150 g twarogu półtłustego (ok. 25 g)", g: 25 },
  { text: "puszka tuńczyka w wodzie (ok. 25 g)", g: 25 },
  { text: "120 g piersi z kurczaka (ok. 28 g)", g: 28 },
  { text: "3 jajka (ok. 19 g)", g: 19 },
  { text: "szejk proteinowy (ok. 25 g)", g: 25 },
];

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (i: RecInput["now"]) => `${pad(i.hour)}:${pad(i.minute)}`;
const r0 = (n: number) => Math.round(n);
/** "Bieg spokojny 6 km" + 6 km -> bez dopisywania kilometrów drugi raz. */
const runText = (name: string, km: number | null) => (km && !new RegExp(`(^|\\D)${String(km).replace(".", "[.,]")}\\s*km`, "i").test(name) ? `${name}, ${km} km` : name);
const LABEL: Record<DayType, string> = { rest: "dzień bez biegu", easy: "łatwy bieg", quality: "akcent", long: "długi bieg" };

function proteinSuggestion(left: number): string {
  // Dwie opcje, które razem z pojedynczą porcją najlepiej pokrywają brak (najbliżej 70-110% brakującego białka).
  const sorted = [...PROTEIN_IDEAS].sort((a, b) => Math.abs(a.g - left) - Math.abs(b.g - left));
  return `${sorted[0].text} albo ${sorted[1].text}`;
}

export function greeting(hour: number): string {
  if (hour < 5) return "Jeszcze nie śpisz, Janek?";
  if (hour < 11) return "Cześć Janek, dzień dobry!";
  if (hour < 18) return "Cześć Janek!";
  return "Cześć Janek, jak minął dzień?";
}

export function recommend(i: RecInput): Rec[] {
  const out: Rec[] = [];
  const add = (r: Rec) => out.push(r);
  const t = i.food.targets;

  // ---------- jedzenie ----------
  if (i.food.mealsCount === 0 && i.now.hour >= 11) {
    add({ kind: "food", icon: "🍽", title: "Pusto w dzienniku", priority: 2, text: `Janek, jest ${hhmm(i.now)}, a nic jeszcze nie wpisałeś. Wrzuć zdjęcie albo opis, żebym miał co liczyć.` });
  }
  if (t && i.food.mealsCount > 0) {
    const left = t.kcal - i.food.kcal;
    const leftProtein = t.protein - i.food.protein;
    const leftCarbs = t.carbs - i.food.carbs;
    if (left < -150) {
      add({
        kind: "food",
        icon: "⚖️",
        title: "Lekko ponad cel",
        priority: 3,
        text: `Jesteś ${r0(-left)} kcal ponad cel. Bez dramatu: ${i.now.hour >= 19 ? "dziś już nie dokładaj, a jutro wracamy do planu." : "resztę dnia ogarnij lżej, np. warzywa i białko."}`,
      });
    } else if (i.now.hour >= 20 && left > 900) {
      add({
        kind: "food",
        icon: "🤔",
        title: "Zjadłeś mało",
        priority: 2,
        text: `Masz wpisane tylko ${r0(i.food.kcal)} z ${t.kcal} kcal. Albo świetnie się trzymasz, albo coś Ci umknęło w dzienniku. Jak to drugie, dopisz. Jak naprawdę tyle, nie głodź się przed jutrem.`,
      });
    }
    if (i.now.hour >= 16 && leftProtein >= 35 && left > -150) {
      add({ kind: "food", icon: "🥩", title: `Brakuje ok. ${r0(leftProtein)} g białka`, priority: 3, text: `Do celu zostało Ci jeszcze ok. ${r0(leftProtein)} g białka. Np. ${proteinSuggestion(leftProtein)}.` });
    }
    if ((i.tomorrow.dayType === "long" || i.tomorrow.dayType === "quality") && i.now.hour >= 15 && leftCarbs >= 50 && left > 0) {
      add({
        kind: "food",
        icon: "🍝",
        title: `Jutro ${LABEL[i.tomorrow.dayType]}: dołóż węgli`,
        priority: 2,
        text: `W limicie zostało Ci jeszcze ok. ${r0(leftCarbs)} g węglowodanów. Wykorzystaj je na kolację (np. makaron lub ryż, ok. 80 g suchego), żeby jutro mieć paliwo.`,
      });
    }
    if (t.deficit > 0 && i.food.dayType !== "rest" && i.food.dayType !== "easy") {
      add({ kind: "food", icon: "⛽", title: "Dziś pełne paliwo", priority: 5, text: "Dzień mocnego treningu, więc bez deficytu. Najedz się porządnie, redukcję robimy w spokojniejsze dni." });
    }
  }
  if (i.food.targetNote && /podniesiony/i.test(i.food.targetNote)) {
    add({ kind: "food", icon: "📈", title: "Cel podniesiony", priority: 3, text: `${i.food.targetNote} Zjedz więcej, nie trzymaj się starego limitu.` });
  }
  if (i.today.doneRun && i.now.hour <= 21) {
    add({ kind: "food", icon: "🏁", title: "Po biegu", priority: 4, text: "Bieg zaliczony, dobra robota! W ciągu 2 godzin po nim dorzuć białko i węglowodany (np. skyr z bananem albo kanapka z jajkiem)." });
  }

  // ---------- trening dziś ----------
  if (i.today.planned.length && !i.today.doneRun) {
    const p = i.today.planned[0];
    const run = runText(p.name, p.km);
    if (i.now.hour >= 19) {
      add({ kind: "training", icon: "🌙", title: "Dzisiejszy bieg wisi", priority: 2, text: `W planie było: ${run}. Po 19:30 bez biegania po ciemku, więc przesuń na jutro albo napisz trenerowi, co robimy.` });
    } else if (i.now.hour >= 16) {
      const ev = i.weather.today?.okna?.wieczor;
      add({ kind: "training", icon: "👟", title: "Dzisiejszy bieg jeszcze czeka", priority: 2, text: `${run}.${ev ? ` Pogoda wieczorem: ${ev.ocena}, ${ev.temp_c}°C. Najlepszy start ok. ${ev.start}.` : ""} Wyjdź do 19:30 i będzie git.` });
    }
  }

  // ---------- trening jutro + pogoda ----------
  const tw = i.weather.tomorrow;
  if (i.tomorrow.events.length) {
    const e = i.tomorrow.events[0];
    const run = runText(e.name, e.km);
    const win = tw ? (tw.okna?.poranek ?? tw.okna?.wieczor) : null;
    if (tw && win && win.ocena === "zla") {
      const alt = tw.okna?.wieczor && tw.okna.wieczor.ocena !== "zla" ? ` Wieczorem wygląda lepiej (${tw.okna.wieczor.ocena}, start ok. ${tw.okna.wieczor.start}).` : " Rozważ przesunięcie na lepszy dzień.";
      add({ kind: "weather", icon: "⛈", title: "Jutro słaba pogoda na bieg", priority: 1, text: `Na jutro masz: ${run}. Rano ${win.powody?.join(", ") ?? "kiepsko"}.${alt}` });
    } else {
      add({
        kind: "training",
        icon: "📅",
        title: "Jutro w planie",
        priority: 3,
        text: `${run}.${win ? ` Pogoda: ${win.ocena}, ${win.temp_c}°C (odczuwalna ${win.odczuwalna_c}°C), start najlepiej ok. ${win.start}.` : ""}${win?.ocena === "znosna" && win.powody?.length ? ` Uwaga: ${win.powody.join(", ")}.` : ""}`,
      });
    }
  } else if (i.tomorrow.known && i.now.hour >= 12) {
    add({ kind: "training", icon: "🛋", title: "Jutro bez biegania", priority: 5, text: "Jutro wolne od biegu. Dobry dzień na spacer, rozciąganie i porządne jedzenie." });
  }

  // ---------- regeneracja ----------
  const r = i.recovery;
  if (r) {
    const weak = (r.sleepH != null && r.sleepH < 5.5) || (r.bbPeak != null && r.bbPeak < 30);
    if (weak) {
      add({
        kind: "recovery",
        icon: "😴",
        title: "Słaba regeneracja",
        priority: 1,
        text: `Spałeś ${r.sleepH != null ? `${r.sleepH} godz.` : "krótko"}${r.bbPeak != null ? `, a bateria naładowała się tylko do ${r.bbPeak}/100` : ""}. ${i.today.planned.length && !i.today.doneRun ? "Dziś biegnij lżej albo skróć trening. Jeden słaby dzień to nie tragedia, ale nie forsuj." : "Daj sobie dziś spokojniej i prześpij się wcześniej."}`,
      });
    } else if (r.bbPeak != null && r.bbPeak >= 75 && (r.sleepH ?? 0) >= 7 && i.today.planned.length && !i.today.doneRun) {
      add({ kind: "recovery", icon: "🔋", title: "Naładowany", priority: 4, text: `Bateria ${r.bbPeak}/100 i ${r.sleepH} godz. snu, więc trening jak w planie. Powodzenia!` });
    }
  }

  // ---------- waga ----------
  const w = i.weight;
  if (w.daysSinceWeighIn === null) {
    add({ kind: "weight", icon: "⚖️", title: "Podaj wagę", priority: 2, text: "Nie mam jeszcze żadnej wagi, a bez niej cele i plan nie mają sensu. Wejdź w zakładkę Postęp i wpisz, ile ważysz." });
  } else if (w.daysSinceWeighIn > 10) {
    add({ kind: "weight", icon: "⚖️", title: "Czas na ważenie", priority: 3, text: `Ostatnie ważenie było ${w.daysSinceWeighIn} dni temu. Raz w tygodniu, rano, w podobnych warunkach i będziemy wiedzieć, czy to działa.` });
  } else if (w.aheadKg !== null && w.aheadKg < -1.5) {
    add({ kind: "weight", icon: "📉", title: "Lekko za planem", priority: 4, text: `Wg planu do ${w.goalKg} kg powinieneś być ${Math.abs(w.aheadKg)} kg niżej. ${w.requiredKgPerWeek ? `Potrzebne tempo to ok. ${w.requiredKgPerWeek} kg tygodniowo. ` : ""}Spokojnie: patrz na trend z kilku tygodni, nie na jedno ważenie.` });
  } else if (w.aheadKg !== null && w.aheadKg > 1) {
    add({ kind: "weight", icon: "💪", title: "Przed planem", priority: 5, text: `Jesteś ${w.aheadKg} kg do przodu względem planu. Tak trzymać, ale jedz porządnie, żeby nie zabrać sobie siły na treningi.` });
  }

  return out.sort((a, b) => a.priority - b.priority).slice(0, 7);
}
