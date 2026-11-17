/**
 * Rozpoznawanie posiłków przez Gemini (darmowy klucz z Google AI Studio). Model tylko rozpoznaje składniki
 * i szacuje gramaturę/makro; sumy, cele i bilans liczy kod (nutrition.ts), nie model.
 */
import { type FoodItem, normalizeItem, normHhmm, slotKey, validHhmm } from "./nutrition";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const BUDGET_MS = 26_000; // praca w tle po odpowiedzi do Telegrama ma w Cloudflare ok. 30 s
const MIN_ATTEMPT_MS = 4_000;
const ATTEMPT_CAP_MS = 15_000; // pojedyncza próba niebędąca ostatnią: zostaw czas na model zapasowy
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
  /** Okno z planu posiłków, jeśli Jan wyraźnie napisał, który to posiłek (dokładnie jedna z podanych nazw). */
  slot: string | null;
  model: string;
}

export interface AnalyzeInput {
  image?: { mime: string; b64: string };
  note?: string;
  /** Poprawka istniejącego posiłku: model dostaje poprzednią wersję i uwagę Jana. */
  previous?: { label: string; note: string; items: FoodItem[] };
  nowLocal: { date: string; time: string };
  /** Nazwy posiłków z planu Jana (np. śniadanie, obiad); model może wskazać jedną, gdy Jan sam to napisze. */
  slotNames?: string[];
  /** Budżet czasu na wszystkie próby i limit pojedynczej próby (ms). Zadania ponawiane w tle mogą mieć więcej niż domyślne ok. 26 s. */
  budgetMs?: number;
  attemptCapMs?: number;
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
11. "meal_slot": gdy podano plan posiłków Jana i Jan wyraźnie napisał, który to był posiłek ("to było moje śniadanie", "na kolację"), wpisz dokładnie jedną nazwę z planu. Inaczej null. Nie zgaduj z godziny ani z zawartości talerza.
12. "question" i "comment" pisz luźno i krótko, po imieniu do Janka, jak kumpel-trener (bez formalności i bez moralizowania).
Zwracasz wyłącznie JSON zgodny ze schematem.`;

const N = (extra: Record<string, unknown> = {}) => ({ type: "NUMBER", ...extra });
const SCHEMA = {
  type: "OBJECT",
  properties: {
    is_food: { type: "BOOLEAN" },
    meal_label: { type: "STRING" },
    eaten_time: { type: "STRING", nullable: true },
    meal_slot: { type: "STRING", nullable: true },
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
  if (input.slotNames?.length) lines.push(`Plan posiłków Jana (dozwolone wartości meal_slot): ${input.slotNames.join(", ")}.`);
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

/**
 * Chwilowa awaria po stronie Gemini (przeciążenie 503, limit 429, timeout, ucięty JSON): warto spróbować ponownie za moment.
 * Błędy trwałe (zły klucz, zła nazwa modelu, zablokowana treść) są zwykłym Error.
 */
export class GeminiTransientError extends Error {}

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

async function callModel(apiKey: string, model: string, body: unknown, timeoutMs: number): Promise<any> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new GeminiHttpError(0, `Gemini ${model}: brak odpowiedzi w ciągu ${Math.round(timeoutMs / 1000)} s`);
    }
    throw e;
  }
  if (!res.ok) throw new GeminiHttpError(res.status, `Gemini ${model} ${res.status}: ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini ${model}: odpowiedź nie jest JSON-em`);
  }
}

/** Parsuje odpowiedź API do MealAnalysis; rzuca, gdy model nic sensownego nie zwrócił. */
export function parseAnalysis(resp: any, model: string, slotNames: string[] = []): MealAnalysis {
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
  return analysisFromJson(j, model, slotNames);
}

/** Wspólne dla wszystkich dostawców: znormalizowany wynik z JSON-a zgodnego ze schematem. */
export function analysisFromJson(j: any, model: string, slotNames: string[] = []): MealAnalysis {
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
    // Tylko dokładna nazwa z planu (porównanie bez diakrytyków i wielkości liter); nic spoza planu.
    slot: (typeof j.meal_slot === "string" && slotNames.find((n) => slotKey(n) === slotKey(j.meal_slot))) || null,
    model,
  };
}

function isTransient(e: unknown): boolean {
  if (e instanceof GeminiHttpError) return e.status === 0 || e.status === 429 || e.status >= 500;
  return e instanceof Error && /niepoprawny JSON/.test(e.message);
}

// ---------------- Claude (zapasowy dostawca rozpoznawania posiłków) ----------------

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
const CLAUDE_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Schemat Gemini (typy wielkimi literami, nullable) -> zwykły JSON Schema dla Claude. */
export function toJsonSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const o: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "nullable") continue;
    o[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v);
  }
  if (s.nullable && typeof o.type === "string") o.type = [o.type, "null"];
  return o;
}

class ClaudeHttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

async function callClaude(env: Env, input: AnalyzeInput, timeoutMs: number): Promise<MealAnalysis> {
  const model = env.CLAUDE_FOOD_MODEL || DEFAULT_CLAUDE_MODEL;
  const content: any[] = [];
  if (input.image) content.push({ type: "image", source: { type: "base64", media_type: input.image.mime, data: input.image.b64 } });
  content.push({ type: "text", text: userText(input) });
  let res: Response;
  let text: string;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: 0.2,
        system: SYSTEM,
        tools: [{ name: "zapisz_posilek", description: "Zapisz rozpoznany posiłek zgodnie ze schematem.", input_schema: toJsonSchema(SCHEMA) }],
        tool_choice: { type: "tool", name: "zapisz_posilek" },
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ClaudeHttpError(0, `Claude ${model}: brak odpowiedzi w ciągu ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  }
  if (!res.ok) throw new ClaudeHttpError(res.status, `Claude ${model} ${res.status}: ${text.slice(0, 200)}`);
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new ClaudeHttpError(502, `Claude ${model}: odpowiedź nie jest JSON-em`);
  }
  const tool = (j.content ?? []).find((c: any) => c?.type === "tool_use" && c.input && typeof c.input === "object");
  if (!tool) throw new Error(`Claude ${model}: brak wyniku (${j.stop_reason ?? "pusta odpowiedź"})`);
  return analysisFromJson(tool.input, model, input.slotNames);
}

const claudeTransient = (e: unknown) => e instanceof ClaudeHttpError && (e.status === 0 || e.status === 429 || e.status === 529 || e.status >= 500);

/**
 * Rozpoznanie posiłku z kolejnością dostawców: Gemini (model główny), Claude (jeśli jest ANTHROPIC_API_KEY), Gemini (zapasowy).
 * Ustawienie FOOD_PRIMARY=claude zaczyna od Claude. Gdy jest zapasowy dostawca, pierwsza próba jest krótsza, żeby
 * nie czekać na przeciążony model. Wynik jest "chwilowy" (do ponowienia w tle), jeśli którakolwiek próba zawiodła chwilowo.
 */
export async function analyzeMeal(env: Env, input: AnalyzeInput): Promise<MealAnalysis> {
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY);
  if (!hasGemini && !hasClaude) throw new Error("Brak GEMINI_API_KEY");
  const gem = hasGemini ? [env.GEMINI_MODEL || DEFAULT_MODEL, env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL].filter((m, i, a) => a.indexOf(m) === i) : [];
  type Step = { kind: "gemini"; model: string } | { kind: "claude" };
  const g = gem.map((model): Step => ({ kind: "gemini", model }));
  const c: Step[] = hasClaude ? [{ kind: "claude" }] : [];
  const steps: Step[] = env.FOOD_PRIMARY === "claude" ? [...c, ...g] : [...g.slice(0, 1), ...c, ...g.slice(1)];
  const errors: string[] = [];
  let transientSeen = false;
  let permanentSeen = false;
  const fail = () => {
    const msg = errors.join(" | ").slice(0, 700) || "Rozpoznawanie: przekroczony limit czasu";
    // Bez zapasowego dostawcy trwały błąd konfiguracji (zła nazwa modelu, zły request) ma pierwszeństwo: ponawianie go nie naprawi.
    // Z Claude jako drugim dostawcą ponowienie ma sens, jeśli choć jedna próba padła chwilowo.
    if (!errors.length) return new GeminiTransientError(msg);
    if (permanentSeen && (!hasClaude || !transientSeen)) return new Error(msg);
    return transientSeen ? new GeminiTransientError(msg) : new Error(msg);
  };
  // Pierwsza próba idzie w tle po odpowiedzi do Telegrama (waitUntil, ok. 30 s w Cloudflare), więc wspólny budżet czasu dla
  // wszystkich prób gwarantuje, że wynik lub błąd zdąży dojść do Jana. Zadania ponawiane w tle dostają większy budżet.
  const deadline = Date.now() + (input.budgetMs ?? BUDGET_MS);
  const cap = input.attemptCapMs ?? ATTEMPT_CAP_MS;
  for (const [si, step] of steps.entries()) {
    const isLast = si === steps.length - 1;
    const stepCap = (left: number) => (isLast ? left : Math.min(left, si === 0 && steps.length > 1 ? Math.min(cap, 14_000) : cap));
    if (step.kind === "claude") {
      const left = deadline - Date.now();
      if (left < MIN_ATTEMPT_MS) throw fail();
      if (input.image && !CLAUDE_IMAGES.has(input.image.mime)) {
        errors.push(`Claude: format zdjęcia ${input.image.mime} nie jest obsługiwany`);
        continue;
      }
      try {
        return await callClaude(env, input, stepCap(left));
      } catch (e) {
        errors.push((e instanceof Error ? e.message : String(e)).slice(0, 250));
        if (claudeTransient(e) || (e instanceof Error && /niepoprawny JSON|nie jest JSON/.test(e.message))) transientSeen = true;
        else permanentSeen = true;
      }
      continue;
    }
    let stopped = false; // pętla wariantów przerwana innym błędem niż 400 przy ustawieniu myślenia
    for (const thinking of THINKING_VARIANTS) {
      const left = deadline - Date.now();
      if (left < MIN_ATTEMPT_MS) throw fail();
      try {
        const resp = await callModel(env.GEMINI_API_KEY!, step.model, buildBody(input, thinking), stepCap(left));
        return parseAnalysis(resp, step.model, input.slotNames);
      } catch (e) {
        errors.push((e instanceof Error ? e.message : String(e)).slice(0, 250));
        // 400 przy ustawieniu myślenia = model go zwykle nie obsługuje: ten sam model, następny wariant.
        if (thinking && e instanceof GeminiHttpError && e.status === 400) continue;
        if (isTransient(e)) transientSeen = true;
        else permanentSeen = true;
        stopped = true;
        break; // limit (429), 5xx, 404 (nazwa modelu), pusty wynik: następny model
      }
    }
    // Wszystkie warianty zwróciły 400: prawdziwie zły request dla tego modelu (inny dostawca może go jeszcze obsłużyć).
    if (!stopped) permanentSeen = true;
  }
  throw fail();
}

/**
 * Ogólne pytanie do Gemini z odpowiedzią JSON wg schematu (np. rozbiór opisu trasy). Te same modele, warianty myślenia
 * i klasyfikacja błędów co w analyzeMeal: chwilowa awaria to GeminiTransientError, reszta to zwykły Error.
 */
export async function askGeminiJson(env: Env, o: { system: string; user: string; schema: unknown; budgetMs?: number; maxOutputTokens?: number }): Promise<any> {
  if (!env.GEMINI_API_KEY) throw new Error("Brak GEMINI_API_KEY");
  const models = [env.GEMINI_MODEL || DEFAULT_MODEL, env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL].filter((m, i, a) => a.indexOf(m) === i);
  const errors: string[] = [];
  let permanent = false;
  const fail = () => {
    const msg = errors.join(" | ").slice(0, 600) || "Gemini: przekroczony limit czasu";
    return permanent ? new Error(msg) : new GeminiTransientError(msg);
  };
  const deadline = Date.now() + (o.budgetMs ?? 25_000);
  for (const [mi, model] of models.entries()) {
    const isLast = mi === models.length - 1;
    for (const thinking of THINKING_VARIANTS) {
      const left = deadline - Date.now();
      if (left < MIN_ATTEMPT_MS) throw fail();
      const body = {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: [{ role: "user", parts: [{ text: o.user }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: o.schema, temperature: 0.1, maxOutputTokens: o.maxOutputTokens ?? 2048, ...(thinking ? { thinkingConfig: thinking } : {}) },
      };
      try {
        const resp = await callModel(env.GEMINI_API_KEY, model, body, isLast ? left : Math.min(left, ATTEMPT_CAP_MS));
        const cand = resp?.candidates?.[0];
        const out = (cand?.content?.parts ?? []).filter((p: any) => typeof p?.text === "string" && !p.thought).map((p: any) => p.text).join("");
        if (!out) throw new Error(`Gemini ${model}: brak wyniku (${resp?.promptFeedback?.blockReason ?? cand?.finishReason ?? "pusta odpowiedź"})`);
        try {
          return JSON.parse(out);
        } catch {
          throw new Error(`Gemini ${model}: niepoprawny JSON (${cand?.finishReason ?? "?"})`);
        }
      } catch (e) {
        errors.push((e instanceof Error ? e.message : String(e)).slice(0, 250));
        if (thinking && e instanceof GeminiHttpError && e.status === 400) continue;
        if (!isTransient(e)) permanent = true;
        break;
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
