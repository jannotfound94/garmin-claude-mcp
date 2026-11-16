import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, classifyDay, computeTargets, estimateTdee, evaluateReminders, labelForTime, normalizeItem,
  overallConfidence, parseSlots, satisfiedSlots, slotKey, slotsFor, sumMacros, weightSlopePerDay, weightStats, dateOfMealId, newMealId,
} from "../src/nutrition";
import { parseAnalysis, applyBarcode, analyzeMeal } from "../src/gemini";

const S = (t: string): any => (parseSlots(t) as any).slots;
const cfg = { ...DEFAULT_CONFIG, slots: S("śniadanie 07:30; obiad 13:30; kolacja 19:30") };
const C0 = { ...DEFAULT_CONFIG, deficitKcal: 0 };
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
  const d = { ...DEFAULT_CONFIG, deficitKcal: 400 };
  assert.equal(computeTargets(d, 80, "easy")!.carbs, Math.round(360 - 100));
  assert.equal(computeTargets(d, 80, "long")!.carbs, 560);
  assert.match(computeTargets(d, 80, "long")!.note!, /bez deficytu/);
  const big = computeTargets({ ...DEFAULT_CONFIG, deficitKcal: 700 }, 80, "rest")!; // 280 - 175 = 105 < podłoga 2 g/kg = 160 -> 160
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
  const d = { ...DEFAULT_CONFIG, deficitKcal: 300 };
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
  const tight = computeTargets({ ...DEFAULT_CONFIG, deficitKcal: 700 }, 107, "rest", { kcal: 2500, source: "kalibracja" })!;
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
  const C = { ...DEFAULT_CONFIG, deficitKcal: 0, macroWeightKg: null };
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
