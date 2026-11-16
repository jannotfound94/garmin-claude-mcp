/**
 * Rozpoznawanie posiłków przez Gemini (darmowy klucz z Google AI Studio). Model tylko rozpoznaje składniki
 * i szacuje gramaturę/makro; sumy, cele i bilans liczy kod (nutrition.ts), nie model.
 */
import { type FoodItem, normalizeItem, validHhmm, normHhmm } from "./nutrition";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const BUDGET_MS = 22_000;
const MIN_ATTEMPT_MS = 4_000;
export const DEFAULT_MODEL = "gemini-3.5-flash";
export const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";

export interface MealAnalysis {
  isFood: boolean;
  label: string;
  eatenTime: string | null; // HH:MM, gdy Jan podał w notatce
  dayOffset: 0 | -1;
  items: FoodItem[];
  barcode: string | null;
  question: string | null;
  comment: string | null;
  model: string;
}

export interface AnalyzeInput {
  image?: { mime: string; b64: string };
  note?: string;
  /** Poprawka istniejącego posiłku: model dostaje poprzednią wersję i uwagę Jana. */
  previous?: { label: string; note: string; items: FoodItem[] };
  nowLocal: { date: string; time: string };
}

const SYSTEM = `Jesteś dietetykiem sportowym, który liczy kalorie i makroskładniki posiłków biegacza (kuchnia polska, typowe polskie porcje i produkty).
Zasady:
1. Rozpoznaj każdy składnik i napój. Gramaturę podawaj dla postaci, w jakiej jest zjadany (gotowy, nie surowy). Skalę bierz z talerza, sztućców, opakowań, dłoni.
2. Uwzględnij ukryte kalorie: tłuszcz do smażenia, masło, oliwę, sosy, dressingi, cukier w napojach, alkohol (podaj alcohol_g; 7 kcal/g).
3. Gdy widać etykietę lub opakowanie z wartościami odżywczymi, użyj ich (basis="label") i przelicz na zjedzoną porcję. Gdy widać kod kreskowy, wpisz jego cyfry w barcode.
4. Notatka Jana ma pierwszeństwo przed zdjęciem ("połowa porcji", "bez sosu", "150 g", "to skyr naturalny"). Jeśli podaje gramaturę lub produkt, trzymaj się tego.
5. Nie zaniżaj. Przy niepewności wybierz realistyczną wartość środkową, nie optymistyczną. Pewność (confidence) oceniaj osobno dla każdej pozycji: high tylko gdy gramatura i produkt są jednoznaczne (etykieta, podana waga), low gdy zgadujesz.
6. kcal pozycji ma być spójne z makro (białko i węglowodany po 4, tłuszcz 9, alkohol 7 kcal/g).
7. "question": jedno krótkie pytanie po polsku, tylko jeśli odpowiedź zmieniłaby wynik o więcej niż ok. 100 kcal (np. "To ryż czy kasza? Ile mniej więcej łyżek oleju?"). Inaczej null.
8. "eaten_time" (HH:MM) i "day_offset" (0 lub -1 dla "wczoraj") tylko wtedy, gdy Jan wyraźnie napisał, kiedy jadł. Inaczej null.
9. Jeśli na zdjęciu nie ma jedzenia ani napoju, ustaw is_food=false i items=[].
10. "meal_label": krótka nazwa dania (np. "owsianka z bananem i orzechami"). "comment": opcjonalnie jedno zdanie istotnej uwagi, inaczej null.
Zwracasz wyłącznie JSON zgodny ze schematem.`;

const N = (extra: Record<string, unknown> = {}) => ({ type: "NUMBER", ...extra });
const SCHEMA = {
  type: "OBJECT",
  properties: {
    is_food: { type: "BOOLEAN" },
    meal_label: { type: "STRING" },
    eaten_time: { type: "STRING", nullable: true },
    day_offset: { type: "INTEGER", nullable: true },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          grams: N({ nullable: true }),
          kcal: N(),
          protein_g: N(),
          carbs_g: N(),
          fat_g: N(),
          alcohol_g: N({ nullable: true }),
          confidence: { type: "STRING", enum: ["high", "medium", "low"] },
          basis: { type: "STRING", enum: ["label", "estimate"] },
        },
        required: ["name", "kcal", "protein_g", "carbs_g", "fat_g", "confidence", "basis"],
      },
    },
    barcode: { type: "STRING", nullable: true },
    question: { type: "STRING", nullable: true },
    comment: { type: "STRING", nullable: true },
  },
  required: ["is_food", "meal_label", "items"],
};

/** base64 bez przepełnienia stosu na dużych zdjęciach. */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function userText(input: AnalyzeInput): string {
  const lines = [`Teraz jest ${input.nowLocal.date} ${input.nowLocal.time} (czas polski).`];
  if (input.previous) {
    lines.push(
      "POPRAWKA istniejącego wpisu. Poprzednia wersja:",
      JSON.stringify({ meal_label: input.previous.label, items: input.previous.items.map(({ name, grams, kcal, protein, carbs, fat }) => ({ name, grams, kcal, protein_g: protein, carbs_g: carbs, fat_g: fat })) }),
      `Uwaga Jana: "${input.note ?? ""}". Zwróć PEŁNĄ, poprawioną listę pozycji (nie tylko zmiany). Zmień tylko to, czego dotyczy uwaga.`,
    );
    if (input.previous.note) lines.push(`Pierwotna notatka Jana: "${input.previous.note}".`);
  } else if (input.note?.trim()) {
    lines.push(`Notatka Jana: "${input.note.trim()}".`);
  } else if (input.image) {
    lines.push("Jan nie dodał notatki.");
  }
  if (!input.image) lines.push("Brak zdjęcia: policz posiłek wyłącznie z opisu Jana.");
  return lines.join("\n");
}

/**
 * Ustawienia "myślenia": modele 3.x używają thinkingLevel, 2.5 thinkingBudget. Modele "thinking" wliczają myślenie
 * do limitu tokenów, więc ograniczamy je, żeby JSON nie został ucięty. Które ustawienie przyjmie dany model,
 * wychodzi w praktyce: odrzucone (400) kończy się próbą następnego wariantu, a ostatni nie ustawia niczego.
 */
const THINKING_VARIANTS: (Record<string, unknown> | null)[] = [{ thinkingLevel: "low" }, { thinkingBudget: 1024 }, null];

function buildBody(input: AnalyzeInput, thinking: Record<string, unknown> | null) {
  const parts: any[] = [];
  if (input.image) parts.push({ inlineData: { mimeType: input.image.mime, data: input.image.b64 } });
  parts.push({ text: userText(input) });
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 8192,
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
}

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

async function callModel(apiKey: string, model: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new GeminiHttpError(res.status, `Gemini ${model} ${res.status}: ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini ${model}: odpowiedź nie jest JSON-em`);
  }
}

/** Parsuje odpowiedź API do MealAnalysis; rzuca, gdy model nic sensownego nie zwrócił. */
export function parseAnalysis(resp: any, model: string): MealAnalysis {
  const cand = resp?.candidates?.[0];
  const textOut = (cand?.content?.parts ?? [])
    .filter((p: any) => typeof p?.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
  if (!textOut) {
    const why = resp?.promptFeedback?.blockReason ?? cand?.finishReason ?? "pusta odpowiedź";
    throw new Error(`Gemini ${model}: brak wyniku (${why})`);
  }
  let j: any;
  try {
    j = JSON.parse(textOut);
  } catch {
    throw new Error(`Gemini ${model}: niepoprawny JSON (${cand?.finishReason ?? "?"})`);
  }
  const items = (Array.isArray(j.items) ? j.items : []).map(normalizeItem).filter(Boolean) as FoodItem[];
  const eaten = typeof j.eaten_time === "string" && validHhmm(j.eaten_time) ? normHhmm(j.eaten_time) : null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
  const barcode = typeof j.barcode === "string" && /^\d{8,14}$/.test(j.barcode.replace(/\s/g, "")) ? j.barcode.replace(/\s/g, "") : null;
  return {
    isFood: j.is_food === true && items.length > 0,
    label: str(j.meal_label) ?? items[0]?.name ?? "posiłek",
    eatenTime: eaten,
    dayOffset: j.day_offset === -1 && eaten ? -1 : 0,
    items,
    barcode,
    question: str(j.question),
    comment: str(j.comment),
    model,
  };
}

export async function analyzeMeal(env: Env, input: AnalyzeInput): Promise<MealAnalysis> {
  if (!env.GEMINI_API_KEY) throw new Error("Brak GEMINI_API_KEY");
  const models = [env.GEMINI_MODEL || DEFAULT_MODEL, env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL].filter((m, i, a) => a.indexOf(m) === i);
  const errors: Record<string, string> = {};
  const fail = () => new Error(Object.values(errors).join(" | ").slice(0, 700) || "Gemini: przekroczony limit czasu");
  // Praca w tle po odpowiedzi do Telegrama (waitUntil) ma w Cloudflare ok. 30 s. Wspólny budżet czasu dla wszystkich
  // prób gwarantuje, że błąd zdąży dojść do Jana zamiast zostać ucięty razem z procesem.
  const deadline = Date.now() + BUDGET_MS;
  for (const model of models) {
    for (const thinking of THINKING_VARIANTS) {
      const left = deadline - Date.now();
      if (left < MIN_ATTEMPT_MS) throw fail();
      try {
        const resp = await callModel(env.GEMINI_API_KEY, model, buildBody(input, thinking), left);
        return parseAnalysis(resp, model);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 400 przy ustawieniu myślenia = model go zwykle nie obsługuje: ten sam model, następny wariant
        // (prawdziwie zły request padnie we wszystkich wariantach, to tylko kilka szybkich prób).
        if (thinking && e instanceof GeminiHttpError && e.status === 400) {
          errors[model] = msg.slice(0, 300);
          continue;
        }
        errors[model] = msg.slice(0, 300);
        break; // limit (429), 5xx, 404 (nazwa modelu), pusty wynik: następny model
      }
    }
  }
  throw fail();
}

/** Szybki test z panelu /setup: czy klucz i model działają (bez zdjęcia). */
export async function pingGemini(env: Env): Promise<string> {
  const a = await analyzeMeal(env, { note: "dwa jajka sadzone na maśle i kromka chleba żytniego", nowLocal: { date: "2026-01-01", time: "08:00" } });
  const t = a.items.reduce((s, i) => s + i.kcal, 0);
  return `model ${a.model}: ${a.items.length} pozycji, ${t} kcal`;
}

// ---------------- Open Food Facts (kod kreskowy) ----------------

export interface OffProduct {
  name: string;
  per100: { kcal: number; protein: number; carbs: number; fat: number };
  servingG: number | null;
}

export async function lookupBarcode(code: string): Promise<OffProduct | null> {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,nutriments,serving_quantity`, {
      headers: { "User-Agent": "personal-diet-tracker/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (j?.status !== 1) return null;
    const n = j.product?.nutriments ?? {};
    const kcal = Number(n["energy-kcal_100g"]);
    const protein = Number(n["proteins_100g"]);
    const carbs = Number(n["carbohydrates_100g"]);
    const fat = Number(n["fat_100g"]);
    if (![kcal, protein, carbs, fat].every(Number.isFinite)) return null;
    const serving = Number(j.product?.serving_quantity);
    return {
      name: String(j.product?.product_name ?? "produkt").slice(0, 80),
      per100: { kcal, protein, carbs, fat },
      servingG: Number.isFinite(serving) && serving > 0 ? serving : null,
    };
  } catch {
    return null;
  }
}

/**
 * Posiłek z jednego produktu z kodem kreskowym: wartości z bazy (na 100 g) × gramatura, zamiast szacunku modelu.
 * Przy wielu pozycjach nie ruszamy niczego: nie wiadomo, której dotyczy kod.
 */
export async function applyBarcode(items: FoodItem[], barcode: string | null): Promise<{ items: FoodItem[]; used: string | null }> {
  if (!barcode || items.length !== 1) return { items, used: null };
  const p = await lookupBarcode(barcode);
  if (!p) return { items, used: null };
  const it = items[0];
  const grams = it.grams ?? p.servingG;
  if (!grams) return { items, used: null };
  const k = grams / 100;
  const upd = normalizeItem({
    name: it.name,
    grams,
    kcal: p.per100.kcal * k,
    protein_g: p.per100.protein * k,
    carbs_g: p.per100.carbs * k,
    fat_g: p.per100.fat * k,
    confidence: it.confidence,
    basis: "label",
  });
  return upd ? { items: [upd], used: p.name } : { items, used: null };
}
