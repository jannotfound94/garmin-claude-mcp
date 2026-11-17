import { test } from "node:test";
import assert from "node:assert/strict";
import {
  goalProgress,
  DEFAULT_CONFIG, classifyDay, computeTargets, estimateTdee, evaluateReminders, labelForTime, normalizeItem,
  overallConfidence, parseSlots, satisfiedSlots, slotKey, slotsFor, sumMacros, weightSlopePerDay, weightStats, dateOfMealId, newMealId,
} from "../src/nutrition";
import { parseAnalysis, applyBarcode, analyzeMeal, GeminiTransientError, toJsonSchema } from "../src/gemini";
import { greeting, recommend, type RecInput } from "../src/recommend";
import { loggingStreak, weekStart } from "../src/summary";

const S = (t: string): any => (parseSlots(t) as any).slots;
const cfg = { ...DEFAULT_CONFIG, slots: S("śniadanie 07:30; obiad 13:30; kolacja 19:30") };
// Konfiguracja "sprzed zmian" (białko 1,8, tłuszcz 1,0, bez korekty Garmina i bez celu wagi): testy logiki liczą na okrągłych liczbach.
const LEGACY = { ...DEFAULT_CONFIG, proteinPerKg: 1.8, fatPerKg: 1.0, garminFactor: 1, goalWeightKg: null };
const C0 = { ...LEGACY, deficitKcal: 0 };
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const ev = (o: any) => evaluateReminders({ cfg, date: "2026-11-16", weekday: "Mon", state: {}, nowIso: "2026-11-16T10:00:00Z", ...o });

test("parseSlots", () => {
  assert.deepEqual(parseSlots("Drugie śniadanie 10.15, obiad 13:30"), { slots: [{ name: "Drugie śniadanie", time: "10:15" }, { name: "obiad", time: "13:30" }] });
  assert.ok("error" in parseSlots("obiad 25:00"));
  assert.ok("error" in parseSlots("13:30"));
  assert.ok("error" in parseSlots("obiad 12:00; Obiad 13:00"));
  assert.equal(slotKey("Drugie śniadanie"), "drugiesniadani"); // ucięte do 14 znaków (limit callback_data)
  assert.ok("error" in parseSlots("Bardzo długie śniadanie A 08:00; Bardzo długie śniadanie B 09:00")); // kolizja skróconych kluczy
});

test("normalizeItem: macros override inconsistent kcal, alcohol counted, junk rejected", () => {
  const a = normalizeItem({ name: "x", kcal: 100, protein_g: 30, carbs_g: 50, fat_g: 20 })!; // 4*30+4*50+9*20=500
  assert.equal(a.kcal, 500);
  const b = normalizeItem({ name: "piwo", kcal: 150, protein_g: 1, carbs_g: 12, fat_g: 0, alcohol_g: 14 })!; // 4+48+98=150
  assert.equal(b.kcal, 150);
  const c = normalizeItem({ name: "ok", kcal: 520, protein_g: 33, carbs_g: 3, fat_g: 41 })!; // 132+12+369=513
  assert.equal(c.kcal, 520);
  assert.equal(normalizeItem({ name: "", kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }), null);
  assert.equal(normalizeItem({ name: "z", kcal: 1, protein_g: "abc", carbs_g: 1, fat_g: 1 }), null);
  assert.equal(normalizeItem({ name: "z", kcal: 1, protein_g: "1,5", carbs_g: 1, fat_g: 1 })!.protein, 1.5);
});

test("reminders: nothing before plan+3h, one after, never twice", () => {
  assert.equal(ev({ nowMin: mins("10:29"), meals: [] }).due.length, 0);
  const r = ev({ nowMin: mins("10:30"), meals: [] });
  assert.equal(r.due.length, 1);
  assert.equal(r.due[0].slot.name, "śniadanie");
  assert.equal(r.due[0].attempt, 1);
  assert.equal(ev({ nowMin: mins("10:45"), meals: [], state: { "2026-11-16|sniadanie": "sent" } }).due.length, 0);
});
test("reminders: logged meal satisfies the slot (also eaten up to 90 min early)", () => {
  const r = ev({ nowMin: mins("10:30"), meals: [{ time: "08:10" }] });
  assert.equal(r.due.length, 0);
  assert.deepEqual(r.markOk, ["2026-11-16|sniadanie"]);
  assert.equal(ev({ nowMin: mins("10:30"), meals: [{ time: "06:10" }] }).due.length, 0);
  assert.equal(ev({ nowMin: mins("10:30"), meals: [{ time: "05:55" }] }).due.length, 1); // za wcześnie na to okno
});
test("reminders: one meal satisfies only one slot", () => {
  const c2 = { ...cfg, slots: S("A 08:00; B 09:00") };
  const done = satisfiedSlots(slotsFor(c2, "Mon"), [{ time: "08:30" }], 180);
  assert.equal(done.size, 1);
});
test("reminders: snooze -> second reminder once, skip/ok final, late dinner capped at 21:45", () => {
  const st = { "2026-11-16|sniadanie": "snooze:2026-11-16T10:00:00.000Z" };
  assert.equal(ev({ nowMin: mins("11:00"), meals: [], state: st, nowIso: "2026-11-16T09:59:00.000Z" }).due.length, 0);
  const r = ev({ nowMin: mins("11:00"), meals: [], state: st, nowIso: "2026-11-16T10:01:00.000Z" });
  assert.equal(r.due[0].attempt, 2);
  assert.equal(ev({ nowMin: mins("11:00"), meals: [], state: { "2026-11-16|sniadanie": "skip" } }).due.length, 0);
  const late = { ...cfg, slots: S("kolacja 20:30") };
  assert.equal(ev({ cfg: late, nowMin: mins("21:44"), meals: [] }).due.length, 0);
  assert.equal(ev({ cfg: late, nowMin: mins("21:45"), meals: [] }).due.length, 1);
  assert.equal(ev({ cfg: { ...cfg, remindersOn: false }, nowMin: mins("12:00"), meals: [] }).due.length, 0);
});
test("weekend schedule overrides, empty falls back", () => {
  const c = { ...cfg, weekendSlots: S("brunch 10:00") };
  assert.equal(slotsFor(c, "Sat")[0].name, "brunch");
  assert.equal(slotsFor(c, "Fri")[0].name, "śniadanie");
  assert.equal(slotsFor(cfg, "Sun")[0].name, "śniadanie");
  assert.equal(labelForTime(cfg.slots, "07:50"), "śniadanie");
  assert.equal(labelForTime(cfg.slots, "16:00"), "obiad"); // w oknie obiadu (13:30 + 3 h)
  assert.equal(labelForTime(cfg.slots, "17:00"), "Przekąska");
});

test("classifyDay", () => {
  assert.equal(classifyDay([], []).type, "rest");
  assert.equal(classifyDay([{ type: "Run", category: "WORKOUT", name: "Bieg spokojny 6 km", distance: 6000 }], []).type, "easy");
  assert.equal(classifyDay([{ type: "Run", category: "WORKOUT", name: "Długi bieg 22 km", distance: 22000 }], []).type, "long");
  assert.equal(classifyDay([{ type: "Run", category: "WORKOUT", name: "Tempo", description: "Main Set\n- 5x1km" }], []).type, "quality");
  assert.equal(classifyDay([{ type: "Run", category: "WORKOUT", name: "Bieg spokojny 8 km" }], [{ type: "Run", distance: 18000, moving_time: 7000 }]).type, "long");
  assert.equal(classifyDay([{ type: "Ride", category: "WORKOUT", name: "Rower" }], [{ type: "WeightTraining" }]).type, "rest");
  assert.equal(classifyDay([{ category: "NOTE", type: "Run", name: "Długi" }], []).type, "rest");
});

test("targets: g/kg, deficit only easy/rest, carbs floor", () => {
  const t = computeTargets(C0, 80, "rest")!;
  assert.deepEqual([t.protein, t.carbs, t.fat], [144, 280, 80]);
  assert.equal(t.kcal, Math.round(144 * 4 + 280 * 4 + 80 * 9));
  const d = { ...LEGACY, deficitKcal: 400 };
  assert.equal(computeTargets(d, 80, "easy")!.carbs, Math.round(360 - 100));
  assert.equal(computeTargets(d, 80, "long")!.carbs, 560);
  assert.match(computeTargets(d, 80, "long")!.note!, /bez deficytu/);
  const big = computeTargets({ ...LEGACY, deficitKcal: 700 }, 80, "rest")!; // 280 - 175 = 105 < podłoga 2 g/kg = 160 -> 160
  assert.equal(big.carbs, 160);
  assert.ok(big.deficitApplied < 700 && big.note);
  assert.equal(computeTargets(C0, null, "rest"), null);
});

test("weight stats and TDEE calibration", () => {
  const today = "2026-11-16";
  const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  // waga spada o 0.5 kg/tydz.; jemy po 2500 kcal -> TDEE ≈ 2500 + 0.5/7*7700 = 3050
  const weights = Array.from({ length: 29 }, (_, i) => ({ date: day(28 - i), kg: 80 - (0.5 / 7) * i }));
  const slope = weightSlopePerDay(weights, today, 28)!;
  assert.ok(Math.abs(slope * 7 + 0.5) < 0.01);
  const intake = Array.from({ length: 28 }, (_, i) => ({ date: day(27 - i), kcal: 2500, meals: 3 }));
  const e: any = estimateTdee(intake, weights, today);
  assert.equal(e.ready, true);
  assert.ok(Math.abs(e.tdeeKcal - 3050) <= 2, String(e.tdeeKcal));
  assert.equal((estimateTdee(intake.slice(-10), weights, today) as any).ready, false);
  assert.equal((estimateTdee(intake, weights.slice(-3), today) as any).ready, false);
  const s = weightStats(weights, today);
  assert.equal(s.last!.date, today);
  assert.ok(s.deltaWeek! < 0);
});

test("meal ids carry the date", () => {
  const id = newMealId("2026-11-16");
  assert.equal(dateOfMealId(id), "2026-11-16");
  assert.equal(dateOfMealId("garbage"), null);
});

test("confidence weighted by kcal", () => {
  const it = (kcal: number, confidence: any) => normalizeItem({ name: "x", kcal, protein_g: kcal / 4, carbs_g: 0, fat_g: 0, confidence })!;
  assert.equal(overallConfidence([it(600, "high"), it(20, "low")]), "high");
  assert.equal(overallConfidence([it(300, "high"), it(300, "low")]), "low");
  assert.equal(sumMacros([it(100, "high"), it(50, "high")]).kcal, 150);
});

test("parseAnalysis: valid, thought parts ignored, empty/invalid throw", () => {
  const body = { is_food: true, meal_label: "Jajecznica", eaten_time: "8:05", day_offset: -1, barcode: "5900000000000", items: [{ name: "jajka", grams: 150, kcal: 220, protein_g: 18, carbs_g: 1, fat_g: 16, confidence: "medium", basis: "estimate" }], question: null, comment: "ok" };
  const a = parseAnalysis({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: JSON.stringify(body) }] } }] }, "m");
  assert.equal(a.isFood, true);
  assert.equal(a.eatenTime, "08:05");
  assert.equal(a.dayOffset, -1);
  assert.equal(a.barcode, "5900000000000");
  assert.equal(a.items.length, 1);
  assert.equal(parseAnalysis({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...body, eaten_time: null, day_offset: -1 }) }] } }] }, "m").dayOffset, 0);
  assert.equal(parseAnalysis({ candidates: [{ content: { parts: [{ text: JSON.stringify({ is_food: false, meal_label: "", items: [] }) }] } }] }, "m").isFood, false);
  assert.throws(() => parseAnalysis({ candidates: [{ finishReason: "SAFETY" }] }, "m"), /SAFETY/);
  assert.throws(() => parseAnalysis({ candidates: [{ content: { parts: [{ text: "{ucięty" }] } }] }, "m"), /JSON/);
});

test("applyBarcode only for single-item meals", async () => {
  const two = [normalizeItem({ name: "a", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 3 })!, normalizeItem({ name: "b", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 3 })!];
  assert.equal((await applyBarcode(two, "5900000000000")).used, null);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: 1, product: { product_name: "Skyr", nutriments: { "energy-kcal_100g": 63, proteins_100g: 11, carbohydrates_100g: 4, fat_100g: 0.2 } } }))) as any;
  const one = [normalizeItem({ name: "skyr", grams: 150, kcal: 120, protein_g: 10, carbs_g: 6, fat_g: 1 })!];
  const r = await applyBarcode(one, "5900000000000");
  globalThis.fetch = orig;
  assert.equal(r.used, "Skyr");
  assert.equal(r.items[0].basis, "label");
  assert.ok(Math.abs(r.items[0].protein - 16.5) < 0.01);
});

const okBody = { candidates: [{ content: { parts: [{ text: JSON.stringify({ is_food: true, meal_label: "Jajka", items: [{ name: "jajka", grams: 100, kcal: 150, protein_g: 13, carbs_g: 1, fat_g: 10, confidence: "medium", basis: "estimate" }] }) }] } }] };
const input = { note: "jajka", nowLocal: { date: "2026-11-16", time: "08:00" } };
const withFetch = async (fn: (url: string, body: any) => Response, run: () => Promise<void>) => {
  const orig = globalThis.fetch;
  const seen: { model: string; thinking: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ model: String(url).split("/models/")[1].split(":")[0], thinking: body.generationConfig.thinkingConfig });
    return fn(String(url), body);
  }) as any;
  try { await run(); } finally { globalThis.fetch = orig; }
  return seen;
};

test("analyzeMeal: model rejecting thinkingLevel is retried with thinkingBudget, then without", async () => {
  let n = 0;
  const seen = await withFetch(() => (++n < 3 ? new Response("thinking_level is not supported", { status: 400 }) : new Response(JSON.stringify(okBody))), async () => {
    const a = await analyzeMeal({ GEMINI_API_KEY: "k" } as any, input);
    assert.equal(a.model, "gemini-3.5-flash");
  });
  assert.deepEqual(seen.map((s) => s.thinking), [{ thinkingLevel: "low" }, { thinkingBudget: 1024 }, undefined]);
  assert.ok(seen.every((s) => s.model === "gemini-3.5-flash"));
});

test("analyzeMeal: 404 on primary falls back to the second model; both failing reports both errors", async () => {
  const seen = await withFetch((u) => (u.includes("gemini-3.5-flash:") ? new Response("no longer available", { status: 404 }) : new Response(JSON.stringify(okBody))), async () => {
    assert.equal((await analyzeMeal({ GEMINI_API_KEY: "k" } as any, input)).model, "gemini-3.5-flash-lite");
  });
  assert.deepEqual(seen.map((s) => s.model), ["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  await withFetch((u) => new Response(u.includes("lite") ? "lite gone" : "flash gone", { status: u.includes("lite") ? 404 : 429 }), async () => {
    await assert.rejects(analyzeMeal({ GEMINI_API_KEY: "k", GEMINI_MODEL: "a-flash", GEMINI_FALLBACK_MODEL: "b-lite" } as any, input), (e: Error) => /a-flash 429.*b-lite 404/.test(e.message));
  });
  await assert.rejects(analyzeMeal({} as any, input), /GEMINI_API_KEY/);
});

test("targets from energy base: day factor, deficit only rest/easy, carbs fill the rest, carb floor", () => {
  const base = { kcal: 3000, source: "garmin" as const };
  const e = computeTargets(C0, 107, "easy", base)!; // 3090 kcal; B 193, T 107 -> W (3090-772-963)/4
  assert.equal(e.protein, 193);
  assert.equal(e.fat, 107);
  assert.equal(e.carbs, 339);
  assert.ok(Math.abs(e.kcal - 3090) <= 3, String(e.kcal));
  assert.equal(e.source, "garmin");
  const d = { ...LEGACY, deficitKcal: 300 };
  const rest = computeTargets(d, 80, "rest", base)!; // B 144, T 80 -> 2790 - 300 = 2490
  assert.ok(Math.abs(rest.kcal - (3000 * 0.93 - 300)) <= 3, String(rest.kcal));
  assert.equal(rest.deficitApplied, 300);
  const long = computeTargets(d, 80, "long", base)!;
  assert.ok(Math.abs(long.kcal - 3600) <= 3);
  assert.equal(long.deficitApplied, 0);
  assert.match(long.note!, /bez deficytu/);
  // przy 107 kg białko i tłuszcz zabierają tyle kcal, że podłoga węglowodanów ogranicza deficyt w dzień bez biegu
  const heavy = computeTargets(d, 107, "rest", base)!;
  assert.equal(heavy.carbs, Math.round(2 * 107));
  assert.ok(heavy.deficitApplied < 300);
  assert.match(heavy.note!, /minimum/);
  // masa referencyjna 90 kg: białko/tłuszcz/podłoga liczone od niej, deficyt 300 mieści się w całości
  const ref = computeTargets({ ...d, macroWeightKg: 90 }, 107, "rest", base)!;
  assert.equal(ref.protein, Math.round(1.8 * 90));
  assert.equal(ref.fat, 90);
  assert.equal(ref.deficitApplied, 300);
  assert.ok(Math.abs(ref.kcal - (3000 * 0.93 - 300)) <= 3, String(ref.kcal));
  const tight = computeTargets({ ...LEGACY, deficitKcal: 700 }, 107, "rest", { kcal: 2500, source: "kalibracja" })!;
  assert.equal(tight.carbs, Math.round(2 * 107)); // podłoga 2 g/kg
  assert.match(tight.note!, /minimum/);
  // bez bazy: stare zachowanie z g/kg
  assert.equal(computeTargets(C0, 107, "easy")!.source, "g/kg");
});

test("explicit slot satisfies that slot regardless of the time of entry", () => {
  const slots = slotsFor(cfg, "Mon"); // śniadanie 07:30, obiad 13:30, kolacja 19:30
  assert.deepEqual([...satisfiedSlots(slots, [{ time: "15:01", slot: "śniadanie" }], 180)], [0]);
  assert.deepEqual([...satisfiedSlots(slots, [{ time: "15:01" }], 180)], [1]); // bez wskazania: najbliższe okno czasowe (obiad)
  // dwa wpisy wskazane jako śniadanie zaliczają to okno jeden raz (a nie dwa różne okna)
  assert.equal(satisfiedSlots(slots, [{ time: "09:00", slot: "śniadanie" }, { time: "08:00", slot: "Śniadanie" }], 180).size, 1);
});

test("parseAnalysis keeps meal_slot only when it matches the plan", () => {
  const mk = (slot: any) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ is_food: true, meal_label: "x", meal_slot: slot, items: [{ name: "a", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 4, confidence: "high", basis: "estimate" }] }) }] } }] });
  assert.equal(parseAnalysis(mk("Śniadanie"), "m", ["śniadanie", "obiad"]).slot, "śniadanie");
  assert.equal(parseAnalysis(mk("brunch"), "m", ["śniadanie", "obiad"]).slot, null);
  assert.equal(parseAnalysis(mk(null), "m", ["śniadanie"]).slot, null);
  assert.equal(parseAnalysis(mk("śniadanie"), "m").slot, null); // brak planu
});

test("analyzeMeal: timeout on primary falls back to the second model; message in Polish when all time out", async () => {
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const orig = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const m = String(url).split("/models/")[1].split(":")[0];
    models.push(m);
    if (m === "gemini-3.5-flash") throw timeout();
    return new Response(JSON.stringify(okBody));
  }) as any;
  try {
    assert.equal((await analyzeMeal({ GEMINI_API_KEY: "k" } as any, input)).model, "gemini-3.5-flash-lite");
    assert.deepEqual(models, ["gemini-3.5-flash", "gemini-3.5-flash-lite"]); // bez ponawiania wariantów myślenia po timeoucie
    globalThis.fetch = (async () => { throw timeout(); }) as any;
    await assert.rejects(analyzeMeal({ GEMINI_API_KEY: "k" } as any, input), (e: Error) => /brak odpowiedzi w ciągu/.test(e.message) && !/aborted/.test(e.message));
  } finally { globalThis.fetch = orig; }
});

test("targets from quiet-day baseline: planned run added, actual Garmin effort raises the target", () => {
  const base = { kcal: 3500, source: "garmin" as const, detail: { days: 14, resting: 2500, active: 1500, quietActive: 400, min: 2700, max: 5500 } };
  const quietActive = 0.85 * 400; // 340
  const C = { ...LEGACY, deficitKcal: 0, macroWeightKg: null };
  const rest = computeTargets(C, 100, "rest", base)!;
  assert.ok(Math.abs(rest.kcal - (2500 + quietActive)) <= 3, String(rest.kcal)); // 2840
  const easy = computeTargets(C, 100, "easy", base, { runKm: 5 })!; // + 0.9*100*5 = 450
  assert.ok(Math.abs(easy.kcal - (2500 + quietActive + 450)) <= 3, String(easy.kcal));
  const long = computeTargets(C, 100, "long", base, { runKm: 20 })!; // + 1800
  assert.ok(Math.abs(long.kcal - (2500 + quietActive + 1800)) <= 3, String(long.kcal));
  // bez dystansu: domyślny km dla typu dnia (easy 6)
  assert.ok(Math.abs(computeTargets(C, 100, "easy", base)!.kcal - (2500 + quietActive + 540)) <= 3);
  // niezaplanowany wysiłek: Garmin pokazuje dziś 2000 aktywnych kcal na dzień bez biegu -> cel = 2500 + 0.85*2000
  const hike = computeTargets(C, 100, "rest", base, { activeTodayKcal: 2000 })!;
  assert.ok(Math.abs(hike.kcal - (2500 + 1700)) <= 3, String(hike.kcal));
  assert.match(hike.note!, /Garmin pokazuje dziś większy wysiłek/);
  // mały wysiłek dzisiaj (cząstkowy dzień) nie obniża celu poniżej planu
  assert.ok(Math.abs(computeTargets(C, 100, "easy", base, { runKm: 5, activeTodayKcal: 100 })!.kcal - (2500 + quietActive + 450)) <= 3);
  // deficyt tylko dni bez biegu i łatwe
  const D = { ...C, deficitKcal: 300 }; // przy 500 podłoga węglowodanów (2 g/kg) ograniczyłaby deficyt
  assert.ok(Math.abs(computeTargets(D, 100, "rest", base)!.kcal - (2840 - 300)) <= 3);
  assert.equal(computeTargets(D, 100, "rest", base)!.deficitApplied, 300);
  assert.ok(Math.abs(computeTargets(D, 100, "long", base, { runKm: 20 })!.kcal - (2500 + quietActive + 1800)) <= 3);
});

test("classifyDay reports distance (larger of plan and done)", () => {
  assert.equal(classifyDay([{ type: "Run", category: "WORKOUT", name: "Bieg 5 km", distance: 5000 }], []).km, 5);
  assert.equal(classifyDay([{ type: "Run", category: "WORKOUT", name: "Bieg 5 km", distance: 5000 }], [{ type: "Run", distance: 8200 }]).km, 8.2);
  assert.equal(classifyDay([], []).km, 0);
});

test("defaults: deficit 600, goal 95 kg by the marathon, Garmin factor 0.9; macros use the lower of weight and goal", () => {
  assert.equal(DEFAULT_CONFIG.deficitKcal, 600);
  assert.equal(DEFAULT_CONFIG.goalWeightKg, 95);
  assert.equal(DEFAULT_CONFIG.goalDate, "2027-04-25");
  assert.equal(DEFAULT_CONFIG.garminFactor, 0.9);
  assert.equal(DEFAULT_CONFIG.proteinPerKg, 1.6);
  assert.equal(DEFAULT_CONFIG.fatPerKg, 0.8);
  const nodef = { ...DEFAULT_CONFIG, deficitKcal: 0 };
  const heavy = computeTargets(nodef, 107, "rest")!; // od 95 kg
  assert.equal(heavy.protein, Math.round(1.6 * 95));
  assert.equal(heavy.fat, Math.round(0.8 * 95));
  const lighter = computeTargets(nodef, 90, "rest")!; // poniżej celu: od aktualnej wagi
  assert.equal(lighter.protein, Math.round(1.6 * 90));
  // jawna masa referencyjna ma pierwszeństwo przed celem
  assert.equal(computeTargets({ ...nodef, macroWeightKg: 100 }, 107, "rest")!.protein, 160);
});

test("Garmin factor scales the Garmin-derived part only (planned run cost is weight-based); eat-back respects it", () => {
  const base = { kcal: 3500, source: "garmin" as const, detail: { days: 14, resting: 2500, active: 1500, quietActive: 400, min: 2700, max: 5500 } };
  const quiet = 2500 + 0.85 * 400; // 2840
  const f1 = computeTargets({ ...LEGACY, deficitKcal: 0, macroWeightKg: null }, 100, "easy", base, { runKm: 5 })!;
  const f9 = computeTargets({ ...LEGACY, garminFactor: 0.9, deficitKcal: 0, macroWeightKg: null }, 100, "easy", base, { runKm: 5 })!;
  assert.ok(Math.abs(f1.kcal - (quiet + 450)) <= 3, String(f1.kcal));
  assert.ok(Math.abs(f9.kcal - (0.9 * quiet + 450)) <= 3, String(f9.kcal)); // bieg 450 bez korekty
  const hike = computeTargets({ ...LEGACY, garminFactor: 0.9, deficitKcal: 0, macroWeightKg: null }, 100, "rest", base, { activeTodayKcal: 2000 })!;
  assert.ok(Math.abs(hike.kcal - 0.9 * (2500 + 0.85 * 2000)) <= 3, String(hike.kcal));
  // kalibracja z wagi nie podlega korekcie Garmina
  const cal = computeTargets({ ...LEGACY, garminFactor: 0.8, deficitKcal: 0, macroWeightKg: null }, 100, "easy", { kcal: 3000, source: "kalibracja" })!;
  assert.ok(Math.abs(cal.kcal - 3000 * 1.03) <= 3, String(cal.kcal));
});

test("goalProgress plan: linear to the goal date, required pace from today, ahead/behind", () => {
  const goalDate = "2027-04-25";
  // start 107 kg w dniu 2026-11-16, 160 dni do celu; w dniu 2026-12-16 (30 dni) plan = 107 - 12*30/160 = 104.75
  const w = [{ date: "2026-11-16", kg: 107 }, { date: "2026-12-16", kg: 104 }];
  const g = goalProgress(w, 95, "2026-12-16", goalDate);
  assert.equal(g.planKgToday, 104.8); // r1(104.75)
  assert.equal(g.aheadKg, 0.8);
  assert.equal(g.weeksLeft, 18.6); // 130 dni
  assert.equal(g.requiredKgPerWeek, r1x(9 / (130 / 7)));
  const behind = goalProgress([{ date: "2026-11-16", kg: 107 }, { date: "2026-12-16", kg: 106.5 }], 95, "2026-12-16", goalDate);
  assert.ok(behind.aheadKg! < -1.5);
  // brak terminu lub cel powyżej startu: bez planu
  assert.equal(goalProgress(w, 95, "2026-12-16", null).planKgToday, null);
  assert.equal(goalProgress([{ date: "2026-11-16", kg: 90 }], 95, "2026-12-16", goalDate).planKgToday, null);
  // po terminie
  assert.equal(goalProgress(w, 95, "2027-05-01", goalDate).requiredKgPerWeek, null);
});
const r1x = (n: number) => Math.round(n * 10) / 10;

test("goalProgress: remaining kg, trend and weeks to goal; rare weigh-ins give no trend", () => {
  const today = "2026-12-14";
  const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const w = [28, 21, 14, 7, 0].map((n, i) => ({ date: day(n), kg: 107 - 0.5 * i })); // -0.5 kg/tydz.
  const g = goalProgress(w, 95, today);
  assert.equal(g.last!.kg, 105);
  assert.equal(g.toGoKg, 10);
  assert.ok(Math.abs(g.trendKgPerWeek! + 0.5) < 0.05, String(g.trendKgPerWeek));
  assert.ok(g.weeksToGoal! >= 19 && g.weeksToGoal! <= 21, String(g.weeksToGoal));
  assert.equal(g.daysSinceWeighIn, 0);
  const rare = goalProgress([{ date: day(40), kg: 107 }, { date: day(3), kg: 106 }], 95, today);
  assert.equal(rare.trendKgPerWeek, null);
  assert.equal(rare.weeksToGoal, null);
  assert.equal(rare.daysSinceWeighIn, 3);
  assert.equal(goalProgress([], 95, today).toGoKg, null);
  assert.equal(goalProgress(w, 106, today).weeksToGoal, null); // cel już osiągnięty
});

test("analyzeMeal failure classes: transient (503/429/timeout/truncated JSON) vs permanent (404/400/blocked)", async () => {
  const orig = globalThis.fetch;
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const run = async (behave: (model: string, call: number) => Response | Error) => {
    const calls: Record<string, number> = {};
    globalThis.fetch = (async (url: any) => {
      const m = String(url).split("/models/")[1].split(":")[0];
      calls[m] = (calls[m] ?? 0) + 1;
      const r = behave(m, calls[m]);
      if (r instanceof Error) throw r;
      return r;
    }) as any;
    try { await analyzeMeal({ GEMINI_API_KEY: "k" } as any, input); return null; } catch (e) { return e as Error; }
  };
  try {
    // scenariusz z produkcji: główny model timeout, zapasowy 503
    let e = await run((m) => (m === "gemini-3.5-flash" ? timeout() : new Response("overloaded", { status: 503 })));
    assert.ok(e instanceof GeminiTransientError, String(e));
    assert.match(e!.message, /brak odpowiedzi w ciągu/);
    assert.match(e!.message, /503/);
    // 429 na obu
    e = await run(() => new Response("quota", { status: 429 }));
    assert.ok(e instanceof GeminiTransientError);
    // ucięty JSON na obu
    e = await run(() => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{ucięty" }] } }] })));
    assert.ok(e instanceof GeminiTransientError);
    // regresja: główny model odrzuca thinkingLevel (400), potem timeout; zapasowy 503 -> nadal chwilowy, nie trwały
    e = await run((m, call) => (m === "gemini-3.5-flash" ? (call === 1 ? new Response("thinking_level unsupported", { status: 400 }) : timeout()) : new Response("overloaded", { status: 503 })));
    assert.ok(e instanceof GeminiTransientError, String(e));
    // trwałe: zła nazwa modelu (404) na obu
    e = await run(() => new Response("model not found", { status: 404 }));
    assert.ok(e && !(e instanceof GeminiTransientError));
    // trwałe: wszystkie warianty 400 (zły request)
    e = await run(() => new Response("bad request", { status: 400 }));
    assert.ok(e && !(e instanceof GeminiTransientError));
    // trwałe: treść zablokowana
    e = await run(() => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] })));
    assert.ok(e && !(e instanceof GeminiTransientError));
    // 404 na głównym i 503 na zapasowym: trwały błąd konfiguracji ma pierwszeństwo (ponawianie nie naprawi nazwy modelu)
    e = await run((m) => (m === "gemini-3.5-flash" ? new Response("gone", { status: 404 }) : new Response("overloaded", { status: 503 })));
    assert.ok(e && !(e instanceof GeminiTransientError));
  } finally { globalThis.fetch = orig; }
});

// ======================= rekomendacje =======================

const baseInput = (o: Partial<RecInput> = {}): RecInput => ({
  now: { date: "2026-12-11", hour: 18, minute: 0 },
  food: { kcal: 1500, protein: 90, carbs: 150, fat: 50, mealsCount: 3, targets: { kcal: 2400, protein: 152, carbs: 280, fat: 76, deficit: 600 }, dayType: "easy", targetNote: null },
  tomorrow: { dayType: "rest", events: [], known: true },
  today: { planned: [], doneRun: false },
  weather: { today: null, tomorrow: null },
  recovery: null,
  weight: { daysSinceWeighIn: 3, aheadKg: 0, requiredKgPerWeek: 0.5, toGoKg: 10, goalKg: 95 },
  ...o,
});
const titles = (i: RecInput) => recommend(i).map((r) => r.title);
const day = (win: any): any => ({ data: "2026-12-12", dzien: "sobota", wschod: "7:40", zachod: "15:30", temp_min_c: 0, temp_max_c: 5, opady_dzien_mm: 0, ocena_dnia: win.ocena, okna: { poranek: win, wieczor: win } });
const win = (ocena: string, extra: any = {}) => ({ start: "07:00", ocena, temp_c: 3, odczuwalna_c: 1, opady_mm: 0, wiatr_kmh: 10, porywy_kmh: 15, ...extra });

test("recommend: food rules (protein gap, over target, empty log, big gap late, carbs before long run, hard day fuel)", () => {
  assert.ok(titles(baseInput()).some((t) => /Brakuje ok\. 62 g białka/.test(t)));
  assert.ok(!titles(baseInput({ now: { date: "d", hour: 10, minute: 0 } })).some((t) => /Brakuje/.test(t)), "rano nie marudzi o białku");
  assert.ok(titles(baseInput({ food: { ...baseInput().food, kcal: 2700 } })).includes("Lekko ponad cel"));
  const empty = recommend(baseInput({ food: { ...baseInput().food, mealsCount: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 }, now: { date: "d", hour: 12, minute: 5 } }));
  assert.equal(empty[0].title, "Pusto w dzienniku");
  assert.match(empty[0].text, /12:05/);
  assert.ok(titles(baseInput({ now: { date: "d", hour: 21, minute: 0 }, food: { ...baseInput().food, kcal: 900 } })).includes("Zjadłeś mało"));
  const long = titles(baseInput({ tomorrow: { dayType: "long", events: [{ name: "Długi bieg", km: 18 }], known: true } }));
  assert.ok(long.some((t) => /Jutro długi bieg: dołóż węgli/.test(t)));
  assert.ok(titles(baseInput({ food: { ...baseInput().food, dayType: "long" } })).includes("Dziś pełne paliwo"));
  assert.ok(!titles(baseInput({ food: { ...baseInput().food, dayType: "easy" } })).includes("Dziś pełne paliwo"));
  const raised = recommend(baseInput({ food: { ...baseInput().food, targetNote: "Cel podniesiony o ok. 800 kcal: Garmin pokazuje dziś większy wysiłek niż w planie." } }));
  assert.ok(raised.some((r) => r.title === "Cel podniesiony"));
  // bez celów (brak wagi) nie wymyśla liczb
  assert.ok(!titles(baseInput({ food: { ...baseInput().food, targets: null } })).some((t) => /Brakuje|ponad|Zjadłeś/.test(t)));
});

test("recommend: training and weather (tomorrow bad weather first, evening alternative, run waiting, done run, free day)", () => {
  const ev = { tomorrow: { dayType: "easy" as const, events: [{ name: "Bieg spokojny", km: 6 }], known: true } };
  const bad = recommend(baseInput({ ...ev, weather: { today: null, tomorrow: { ...day(win("zla", { powody: ["ulewny deszcz"] })), okna: { poranek: win("zla", { powody: ["ulewny deszcz"] }), wieczor: win("dobra", { start: "17:00" }) } } } }));
  assert.equal(bad[0].kind, "weather");
  assert.equal(bad[0].priority, 1);
  assert.match(bad[0].text, /ulewny deszcz/);
  assert.match(bad[0].text, /Wieczorem wygląda lepiej/);
  const ok = recommend(baseInput({ ...ev, weather: { today: null, tomorrow: day(win("dobra")) } }));
  const plan = ok.find((r) => r.title === "Jutro w planie")!;
  assert.match(plan.text, /Bieg spokojny, 6 km/);
  assert.match(plan.text, /dobra, 3°C/);
  // kilometry nie są dopisywane drugi raz, gdy nazwa treningu już je zawiera
  const dup = recommend(baseInput({ tomorrow: { dayType: "easy" as const, events: [{ name: "Bieg spokojny 6 km", km: 6 }], known: true }, weather: { today: null, tomorrow: null } })).find((r) => r.title === "Jutro w planie")!;
  assert.match(dup.text, /^Bieg spokojny 6 km\./);
  assert.ok(!/6 km, 6 km/.test(dup.text));
  const dec = recommend(baseInput({ tomorrow: { dayType: "easy" as const, events: [{ name: "Długi bieg", km: 10.5 }], known: true }, weather: { today: null, tomorrow: null } })).find((r) => r.title === "Jutro w planie")!;
  assert.match(dec.text, /^Długi bieg, 10.5 km\./);
  assert.ok(titles(baseInput()).includes("Jutro bez biegania"));
  assert.ok(!titles(baseInput({ tomorrow: { dayType: "rest", events: [], known: false } })).includes("Jutro bez biegania"), "brak danych o planie: nie twierdzimy, że jutro wolne");
  assert.ok(!titles(baseInput({ now: { date: "d", hour: 9, minute: 0 } })).includes("Jutro bez biegania"), "rano jeszcze nie zapowiada jutra");
  const waiting = recommend(baseInput({ today: { planned: [{ name: "Bieg 5 km", km: 5 }], doneRun: false }, now: { date: "d", hour: 17, minute: 0 } }));
  assert.ok(waiting.some((r) => r.title === "Dzisiejszy bieg jeszcze czeka"));
  const late = recommend(baseInput({ today: { planned: [{ name: "Bieg 5 km", km: 5 }], doneRun: false }, now: { date: "d", hour: 20, minute: 0 } }));
  assert.ok(late.some((r) => r.title === "Dzisiejszy bieg wisi" && /19:30/.test(r.text)));
  assert.ok(titles(baseInput({ today: { planned: [], doneRun: true }, now: { date: "d", hour: 15, minute: 0 } })).includes("Po biegu"));
  assert.ok(!titles(baseInput({ today: { planned: [{ name: "x", km: 5 }], doneRun: true }, now: { date: "d", hour: 20, minute: 0 } })).includes("Dzisiejszy bieg wisi"));
});

test("recommend: recovery and weight", () => {
  const weak = recommend(baseInput({ recovery: { sleepH: 4.8, bbPeak: 28, hrvStatus: "BALANCED" }, today: { planned: [{ name: "Bieg", km: 5 }], doneRun: false }, now: { date: "d", hour: 9, minute: 0 } }));
  assert.equal(weak[0].title, "Słaba regeneracja");
  assert.match(weak[0].text, /lżej albo skróć/);
  assert.ok(recommend(baseInput({ recovery: { sleepH: 7.5, bbPeak: 85, hrvStatus: "BALANCED" }, today: { planned: [{ name: "Bieg", km: 5 }], doneRun: false }, now: { date: "d", hour: 9, minute: 0 } })).some((r) => r.title === "Naładowany"));
  assert.ok(!titles(baseInput({ recovery: { sleepH: 7, bbPeak: 60, hrvStatus: null } })).some((t) => /regeneracja|Naładowany/.test(t)));
  assert.ok(titles(baseInput({ weight: { ...baseInput().weight, daysSinceWeighIn: null } })).includes("Podaj wagę"));
  assert.ok(titles(baseInput({ weight: { ...baseInput().weight, daysSinceWeighIn: 14 } })).includes("Czas na ważenie"));
  const behind = recommend(baseInput({ weight: { ...baseInput().weight, aheadKg: -2.4 } })).find((r) => r.title === "Lekko za planem")!;
  assert.match(behind.text, /2,4|2.4/);
  assert.ok(titles(baseInput({ weight: { ...baseInput().weight, aheadKg: 1.6 } })).includes("Przed planem"));
  assert.ok(recommend(baseInput({ weight: { ...baseInput().weight, daysSinceWeighIn: null } })).length <= 7);
  assert.match(greeting(8), /dzień dobry/);
  assert.match(greeting(20), /jak minął dzień/);
});

test("loggingStreak: today in progress does not break the streak; gaps do; minimum meals per day", () => {
  const counts: Record<string, number> = { "2026-12-11": 1, "2026-12-10": 3, "2026-12-09": 2, "2026-12-08": 2, "2026-12-07": 0, "2026-12-06": 4 };
  const f = (d: string) => counts[d] ?? 0;
  assert.equal(loggingStreak(f, "2026-12-11"), 3, "dzisiaj tylko 1 posiłek: liczymy od wczoraj (10, 9, 8)");
  assert.equal(loggingStreak(f, "2026-12-10"), 3);
  counts["2026-12-11"] = 2;
  assert.equal(loggingStreak(f, "2026-12-11"), 4, "dzisiaj kompletny dzień dolicza się do serii");
  assert.equal(loggingStreak(f, "2026-12-07"), 1, "pusty dzisiaj nie przerywa: liczymy od wczoraj (12-06)");
  assert.equal(loggingStreak((d) => (d === "2026-12-07" ? 0 : d === "2026-12-06" ? 0 : 3), "2026-12-07"), 0, "pusty dzisiaj i pusty wczoraj: seria przerwana");
  assert.equal(loggingStreak(() => 5, "2026-12-11"), 365, "limit zabezpieczający");
  assert.equal(loggingStreak(f, "2026-12-11", 1), 4);
});

test("weekStart returns the Monday of the week (Mon-Sun)", () => {
  assert.equal(weekStart("2026-11-16"), "2026-11-16"); // poniedziałek
  assert.equal(weekStart("2026-11-22"), "2026-11-16"); // niedziela
  assert.equal(weekStart("2026-11-18"), "2026-11-16"); // środa
  assert.equal(weekStart("2026-12-01"), "2026-11-30"); // wtorek, przełom miesięcy
});

// ---------------- Claude jako zapasowy dostawca rozpoznawania posiłków ----------------

const foodJson = { is_food: true, meal_label: "Jajecznica", items: [{ name: "jajecznica", grams: 200, kcal: 330, protein_g: 21, carbs_g: 2, fat_g: 26, confidence: "medium", basis: "estimate" }] };

function stubProviders(behave: { gemini: (model: string) => Response; claude: () => Response }) {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  const claude: { body?: any; headers?: any } = {};
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) {
      calls.push("claude");
      claude.body = JSON.parse(init.body);
      claude.headers = init.headers;
      return behave.claude();
    }
    const model = u.split("/models/")[1].split(":")[0];
    calls.push(`gemini:${model}`);
    return behave.gemini(model);
  }) as any;
  return { calls, claude, restore: () => (globalThis.fetch = orig) };
}
const claudeOk = () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "zapisz_posilek", input: foodJson }], stop_reason: "tool_use" }));
const geminiDown = () => new Response("overloaded", { status: 503 });
const gemOk = () => new Response(JSON.stringify(okBody));
const envBoth = { GEMINI_API_KEY: "gk", ANTHROPIC_API_KEY: "ak" } as any;

test("rozpoznawanie: gdy Gemini jest niedostępny, odpowiada Claude (jedna próba Gemini, potem Claude)", async () => {
  const w = stubProviders({ gemini: geminiDown, claude: claudeOk });
  try {
    const a = await analyzeMeal(envBoth, { ...input, image: { mime: "image/jpeg", b64: "AAAA" } });
    assert.equal(a.isFood, true);
    assert.equal(a.model, "claude-sonnet-5-5");
    assert.equal(a.items[0].kcal, 330);
    assert.deepEqual(w.calls, ["gemini:gemini-3.5-flash", "claude"], "Claude zaraz po pierwszej nieudanej próbie, bez czekania na drugi model Gemini");
    assert.equal(w.claude.headers["x-api-key"], "ak");
    assert.equal(w.claude.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(w.claude.body.tool_choice, { type: "tool", name: "zapisz_posilek" });
    assert.equal(w.claude.body.tools[0].input_schema.type, "object");
    assert.deepEqual(w.claude.body.tools[0].input_schema.properties.eaten_time.type, ["string", "null"]);
    assert.equal(w.claude.body.messages[0].content[0].type, "image");
    assert.equal(w.claude.body.messages[0].content[0].source.media_type, "image/jpeg");
    assert.match(w.claude.body.system, /dietetykiem sportowym/);
  } finally {
    w.restore();
  }
});

test("rozpoznawanie: sprawny Gemini nie woła Claude; FOOD_PRIMARY=claude zaczyna od Claude; brak kluczy to błąd konfiguracji", async () => {
  let w = stubProviders({ gemini: gemOk, claude: claudeOk });
  try {
    assert.equal((await analyzeMeal(envBoth, input)).model, "gemini-3.5-flash");
    assert.deepEqual(w.calls, ["gemini:gemini-3.5-flash"]);
  } finally {
    w.restore();
  }
  w = stubProviders({ gemini: gemOk, claude: claudeOk });
  try {
    const a = await analyzeMeal({ ...envBoth, FOOD_PRIMARY: "claude", CLAUDE_FOOD_MODEL: "claude-haiku-5-5" }, input);
    assert.equal(a.model, "claude-haiku-5-5");
    assert.deepEqual(w.calls, ["claude"]);
  } finally {
    w.restore();
  }
  // tylko Claude (bez klucza Gemini)
  w = stubProviders({ gemini: gemOk, claude: claudeOk });
  try {
    assert.equal((await analyzeMeal({ ANTHROPIC_API_KEY: "ak" } as any, input)).model, "claude-sonnet-5-5");
    assert.deepEqual(w.calls, ["claude"]);
  } finally {
    w.restore();
  }
  await assert.rejects(analyzeMeal({} as any, input), /GEMINI_API_KEY/);
});

test("rozpoznawanie: oba dostawcy chwilowo niedostępni to błąd do ponowienia; trwały błąd Gemini z Claude przeciążonym też; HEIC omija Claude", async () => {
  let w = stubProviders({ gemini: geminiDown, claude: () => new Response("overloaded", { status: 529 }) });
  try {
    await assert.rejects(analyzeMeal(envBoth, input), (e: any) => e instanceof GeminiTransientError && /529/.test(e.message) && /503/.test(e.message));
  } finally {
    w.restore();
  }
  // zła nazwa modelu Gemini (404) + Claude przeciążony: ponowienie ma sens
  w = stubProviders({ gemini: () => new Response("gone", { status: 404 }), claude: () => new Response("overloaded", { status: 529 }) });
  try {
    await assert.rejects(analyzeMeal(envBoth, input), (e: any) => e instanceof GeminiTransientError);
  } finally {
    w.restore();
  }
  // zły klucz Claude (401) i 404 Gemini: trwały błąd
  w = stubProviders({ gemini: () => new Response("gone", { status: 404 }), claude: () => new Response("bad key", { status: 401 }) });
  try {
    await assert.rejects(analyzeMeal(envBoth, input), (e: any) => !(e instanceof GeminiTransientError));
  } finally {
    w.restore();
  }
  // HEIC: Claude go nie obsługuje, więc przy FOOD_PRIMARY=claude odpowiada Gemini
  w = stubProviders({ gemini: gemOk, claude: claudeOk });
  try {
    const a = await analyzeMeal({ ...envBoth, FOOD_PRIMARY: "claude" }, { ...input, image: { mime: "image/heic", b64: "AAAA" } });
    assert.equal(a.model, "gemini-3.5-flash");
    assert.deepEqual(w.calls, ["gemini:gemini-3.5-flash"]);
  } finally {
    w.restore();
  }
});

test("toJsonSchema: typy małymi literami, nullable jako typ z null, zagnieżdżone tablice i enumy", () => {
  const out = toJsonSchema({ type: "OBJECT", properties: { a: { type: "STRING", nullable: true }, b: { type: "ARRAY", items: { type: "OBJECT", properties: { c: { type: "STRING", enum: ["x", "y"] } }, required: ["c"] } } }, required: ["b"] });
  assert.deepEqual(out, { type: "object", properties: { a: { type: ["string", "null"] }, b: { type: "array", items: { type: "object", properties: { c: { type: "string", enum: ["x", "y"] } }, required: ["c"] } } }, required: ["b"] });
});
