import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { CoachState } from "../src/state";
import { handleTelegramWebhook, webhookSecret } from "../src/telegram";
import { runDietReminders, nutritionReport } from "../src/diet";
import { handleApi, issueToken, verifyToken } from "../src/api";

// ---- in-memory Durable Object storage ----
const store = new Map<string, any>();
const storage = {
  async get(k: any) { if (Array.isArray(k)) return new Map(k.filter((x) => store.has(x)).map((x) => [x, structuredClone(store.get(x))])); return store.has(k) ? structuredClone(store.get(k)) : undefined; },
  async put(k: string, v: any) { store.set(k, structuredClone(v)); },
  async delete(k: string) { return store.delete(k); },
  async setAlarm() {}, async getAlarm() { return null; },
};
const state = new (CoachState as any)({ storage }, {});
const env: any = {
  TELEGRAM_BOT_TOKEN: "TT", TELEGRAM_CHAT_ID: "123", GEMINI_API_KEY: "GG", MCP_PASSWORD: "pw", INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "i1",
  COACH_STATE: { get: () => state, idFromName: () => "x" },
};

// ---- fetch stub ----
const sent: any[] = [];
const calls: string[] = [];
const geminiQueue: any[] = [];
let msgId = 100;
const garminDays: any[] = [];
let icuEvents: any[] = [];
let icuActs: any[] = [];
const geminiBodies: any[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  calls.push(u);
  const ok = (result: any) => new Response(JSON.stringify({ ok: true, result }));
  if (u.includes("api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3, 4]));
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop()!;
    const body = init?.body ? JSON.parse(init.body) : {};
    if (method === "sendMessage") { sent.push(body); return ok({ message_id: ++msgId }); }
    if (method === "getFile") return ok({ file_path: "photos/file_1.jpg" });
    return ok(true);
  }
  if (u.includes("generativelanguage.googleapis.com")) {
    geminiBodies.push(JSON.parse(init.body));
    const next = geminiQueue.shift();
    if (!next) throw new Error("unexpected gemini call");
    if (next.__status) return new Response("model overloaded", { status: next.__status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }] }));
  }
  if (u.includes("personal.connectapi.garmin.com")) {
    if (u.includes("/token")) {
      const b64 = (o: any) => btoa(JSON.stringify(o)).replace(/=+$/, "");
      return new Response(`${b64({ alg: "none" })}.${b64({ exp: 4102444800 })}.sig`);
    }
    if (u.includes("dailysummaries")) {
      const q = new URL(u).searchParams;
      const data = garminDays.filter((d) => d.calendarDate >= q.get("startDate")! && d.calendarDate <= q.get("endDate")!);
      return new Response(JSON.stringify({ data }));
    }
    return new Response("{}");
  }
  if (u.includes("intervals.icu")) {
    if (u.includes("/events")) return new Response(JSON.stringify(icuEvents));
    if (u.includes("/activities")) return new Response(JSON.stringify(icuActs));
    return new Response("[]");
  }
  throw new Error(`unexpected fetch ${u}`);
}) as any;

let uid = 1;
async function send(update: any) {
  const pending: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const req = new Request("https://x/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": await webhookSecret(env) },
    body: JSON.stringify({ update_id: update.update_id ?? uid++, ...update }),
  });
  const res = await handleTelegramWebhook(req, env, ctx);
  await Promise.all(pending);
  return res;
}
const now = () => Math.floor(Date.now() / 1000);
const chat = { id: 123 };
const lastText = () => sent[sent.length - 1]?.text as string;

const eggs = (extra: any = {}) => ({
  is_food: true, meal_label: "Jajecznica z chlebem", eaten_time: null, day_offset: null, barcode: null, question: "Ile oleju?", comment: null,
  items: [
    { name: "jajecznica z 3 jaj", grams: 200, kcal: 330, protein_g: 21, carbs_g: 2, fat_g: 26, confidence: "medium", basis: "estimate" },
    { name: "chleb żytni", grams: 70, kcal: 170, protein_g: 5, carbs_g: 33, fat_g: 1, confidence: "high", basis: "estimate" },
  ], ...extra,
});

test("end to end: setup, photo, correction, delete, text meal, coach passthrough", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T07:00:00Z") }); // 08:00 w Warszawie

  // stranger ignored, bad secret rejected
  assert.equal((await send({ message: { chat: { id: 999 }, date: now(), text: "/dzis" } })).status, 200);
  assert.equal(sent.length, 0);

  await send({ message: { chat, date: now(), text: "/posilki śniadanie 07:30; obiad 13:30; kolacja 19:30" } });
  assert.match(lastText(), /Masz plan pn–pt/);
  await send({ message: { chat, date: now(), text: "/waga 80,5" } });
  assert.match(lastText(), /Mam: 80,5 kg/);
  assert.match(lastText(), /Cel 95 kg zaliczony, jesteś 14,5 kg poniżej/); // w teście waga 80,5 kg jest poniżej celu

  // photo + caption
  geminiQueue.push(eggs());
  await send({ message: { chat, date: now(), caption: "3 jajka na maśle", photo: [{ file_id: "small" }, { file_id: "big" }] } });
  let meals = await state.getMeals("2026-11-16");
  assert.equal(meals.length, 1);
  assert.equal(meals[0].totals.kcal, 500);
  assert.equal(meals[0].time, "08:00");
  assert.match(lastText(), /^🍽 <b>śniadanie<\/b> · 08:00\n<i>Jajecznica z chlebem<\/i>/);
  assert.equal(sent[sent.length - 1].parse_mode, "HTML");
  assert.match(lastText(), /🔥 <b>500<\/b> \/ \d+ kcal/);
  assert.match(lastText(), /🎯 Cel uwzględnia deficyt \d+ kcal/); // domyślny deficyt 400 w dzień bez biegu/łatwy
  assert.match(lastText(), /❓ <b>Ile oleju\?<\/b>/);
  const mealMsgId = msgId;
  assert.equal(sent[sent.length - 1].reply_markup.inline_keyboard[0].length, 2);

  // retry of the same update is ignored (no 2nd Gemini call, no duplicate)
  const dupId = uid++;
  geminiQueue.push(eggs());
  await send({ update_id: dupId, message: { chat, date: now(), caption: "x", photo: [{ file_id: "p" }] } });
  await send({ update_id: dupId, message: { chat, date: now(), caption: "x", photo: [{ file_id: "p" }] } });
  assert.equal((await state.getMeals("2026-11-16")).length, 2);
  await state.deleteMeal((await state.getMeals("2026-11-16"))[1].id);
  geminiQueue.length = 0;

  // correction by replying to the bot message
  geminiQueue.push(eggs({ question: null, items: [{ name: "jajecznica z 3 jaj", grams: 200, kcal: 400, protein_g: 21, carbs_g: 2, fat_g: 34, confidence: "high", basis: "estimate" }] }));
  await send({ message: { chat, date: now(), text: "na łyżce masła więcej", reply_to_message: { message_id: mealMsgId } } });
  meals = await state.getMeals("2026-11-16");
  assert.equal(meals.length, 1, "korekta nie dubluje posiłku");
  assert.equal(meals[0].totals.kcal, 400); // 398 z makro, kcal modelu mieści się w 20% tolerancji
  assert.match(meals[0].note, /3 jajka na maśle \| na łyżce masła więcej/);
  assert.match(lastText(), /✏️ Poprawiono/);

  // Gemini failure is reported, nothing saved
  const before = (await state.getMeals("2026-11-16")).length;
  geminiQueue.length = 0;
  await send({ message: { chat, date: now(), text: "/jem pizza" } });
  assert.match(lastText(), /⚠️ Ups, coś nie pykło \(Komenda \/jem\)/);
  assert.equal((await state.getMeals("2026-11-16")).length, before);

  // natural-language text meal
  geminiQueue.push({ is_food: true, meal_label: "Banan", items: [{ name: "banan", grams: 120, kcal: 107, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, confidence: "high", basis: "estimate" }] });
  await send({ message: { chat, date: now(), text: "zjadłem banana" } });
  assert.equal((await state.getMeals("2026-11-16")).length, 2);

  // /dzis and /usun
  await send({ message: { chat, date: now(), text: "/dzis" } });
  assert.match(lastText(), /1\. <b>08:00<\/b> Jajecznica/);
  assert.match(lastText(), /2\. <b>08:00<\/b> Banan/);
  await send({ message: { chat, date: now(), text: "/usun 2" } });
  assert.equal((await state.getMeals("2026-11-16")).length, 1);

  // callback: favorite, then delete
  const m = (await state.getMeals("2026-11-16"))[0];
  await send({ callback_query: { id: "c1", data: `m:fav:${m.id}`, message: { chat, message_id: 1 } } });
  assert.equal((await state.getFavorites()).length, 1);
  await send({ callback_query: { id: "c2", data: `m:del:${m.id}`, message: { chat, message_id: 1 } } });
  assert.equal((await state.getMeals("2026-11-16")).length, 0);
  await send({ callback_query: { id: "c3", data: "f:0", message: { chat: { id: 5 }, message_id: 1 } } }); // obcy czat
  assert.equal((await state.getMeals("2026-11-16")).length, 0);
  await send({ callback_query: { id: "c4", data: "f:0", message: { chat, message_id: 1 } } });
  assert.equal((await state.getMeals("2026-11-16")).length, 1, "ulubione dodaje posiłek");

  // coach passthrough: normal text and /start are NOT swallowed by the dietitian
  await send({ message: { chat, date: now(), text: "Jak mój dzisiejszy trening?" } });
  await send({ message: { chat, date: now(), text: "/start" } });
  const conv = (await state.getMemory()).conversation;
  assert.equal(conv.length, 1);
  assert.equal(conv[0].text, "Jak mój dzisiejszy trening?");

  // album: second photo of the same group is not analysed
  geminiQueue.push(eggs());
  await send({ message: { chat, date: now(), media_group_id: "g1", photo: [{ file_id: "a" }] } });
  const n = (await state.getMeals("2026-11-16")).length;
  await send({ message: { chat, date: now(), media_group_id: "g1", photo: [{ file_id: "b" }] } });
  assert.equal((await state.getMeals("2026-11-16")).length, n);
  assert.match(lastText(), /tylko pierwsze zdjęcie/);
  mock.timers.reset();
});

test("reminders: none before plan+3h, one after, buttons work, snooze, no repeat", async () => {
  store.delete("nut:meals:2026-11-16"); store.delete("nut:rem");
  sent.length = 0;
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T09:20:00Z") }); // 10:20 w Warszawie
  await runDietReminders(env);
  assert.equal(sent.length, 0);
  mock.timers.setTime(new Date("2026-11-16T09:31:00Z").getTime()); // 10:31
  await runDietReminders(env);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /śniadanie \(plan 07:30\)/);
  const cbs = sent[0].reply_markup.inline_keyboard[0].map((b: any) => b.callback_data);
  assert.deepEqual(cbs, ["r:add:2026-11-16:sniadanie", "r:skip:2026-11-16:sniadanie", "r:later:2026-11-16:sniadanie"]);
  await runDietReminders(env);
  assert.equal(sent.length, 1, "bez powtórki");

  // snooze 1h -> second (last) reminder
  await send({ callback_query: { id: "s", data: cbs[2], message: { chat, message_id: 1 } } });
  mock.timers.setTime(new Date("2026-11-16T10:20:00Z").getTime());
  await runDietReminders(env);
  assert.equal(sent.length, 1);
  mock.timers.setTime(new Date("2026-11-16T10:35:00Z").getTime()); // 11:35
  await runDietReminders(env);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /jeszcze raz/i);
  assert.equal(sent[1].reply_markup.inline_keyboard[0].length, 2);
  mock.timers.setTime(new Date("2026-11-16T11:30:00Z").getTime());
  await runDietReminders(env);
  assert.equal(sent.length, 2, "po drugim przypomnieniu cisza");

  // meal logged in the window -> no reminder for lunch at 16:31
  await state.saveMeal({ id: "20261116.aaaaaa", date: "2026-11-16", time: "13:50", label: "Obiad", source: "text", note: "", items: [], totals: { kcal: 700, protein: 40, carbs: 80, fat: 20 }, confidence: "medium", question: null, createdAt: "x" });
  mock.timers.setTime(new Date("2026-11-16T15:31:00Z").getTime());
  await runDietReminders(env);
  assert.equal(sent.length, 2);
  mock.timers.reset();
});

test("nutritionReport shape (no Garmin)", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T15:31:00Z") });
  const r: any = await nutritionReport(env, 3);
  assert.equal(r.teraz.data, "2026-11-16");
  assert.equal(r.dni.length, 3);
  assert.equal(r.spozycie_dzis.kcal, 700);
  assert.equal(r.plan_posilkow_dzis.find((s: any) => s.posilek === "obiad").status, "zapisany");
  assert.equal(r.kalibracja_zapotrzebowania.ready, false);
  assert.match(String(r.garmin_uwagi), /nie jest podłączony/);
  assert.equal(r.typ_dnia.typ, "dzień bez biegu");
  assert.ok(r.cele_dzis.kcal > 1500);
  assert.equal(r.ustawienia.korekta_garmina, 0.9);
  assert.equal(r.waga.termin_celu, "2027-04-25");
  assert.equal(r.ustawienia.deficyt_kcal, 600);
  assert.equal(r.waga.waga_docelowa_kg, 95);
  assert.equal(r.waga.do_celu_kg, -14.5); // 80,5 - 95
  mock.timers.reset();
});

test("regression: /posilki with a slot name starting with 'sob' sets weekday plan, 'weekend' sets weekend plan", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T07:00:00Z") });
  await send({ message: { chat, date: now(), text: "/posilki sobotni obiad 13:00" } });
  let cfg = await state.getNutCfg();
  assert.deepEqual(cfg.slots.map((s: any) => s.name), ["sobotni obiad"]);
  assert.equal(cfg.weekendSlots.length, 0);
  await send({ message: { chat, date: now(), text: "/posilki weekend brunch 10:00; kolacja 19:00" } });
  cfg = await state.getNutCfg();
  assert.deepEqual(cfg.weekendSlots.map((s: any) => s.name), ["brunch", "kolacja"]);
  assert.deepEqual(cfg.slots.map((s: any) => s.name), ["sobotni obiad"]);
  await send({ message: { chat, date: now(), text: "/posilki weekend reset" } });
  assert.equal((await state.getNutCfg()).weekendSlots.length, 0);
  await send({ message: { chat, date: now(), text: "/posilki zupa 99:99" } });
  assert.match(lastText(), /Zła godzina/);
  mock.timers.reset();
});

test("meal described as 'śniadanie' but sent at 15:01 is labelled and counted as breakfast; plan is passed to the model", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-17T14:01:00Z") }); // 15:01 we wtorek
  await send({ message: { chat, date: now(), text: "/posilki śniadanie 07:30; obiad 13:30; kolacja 19:30" } });
  geminiBodies.length = 0;
  geminiQueue.push({ is_food: true, meal_label: "Szakszuka", meal_slot: "śniadanie", items: [{ name: "szakszuka", grams: 250, kcal: 330, protein_g: 18, carbs_g: 12, fat_g: 22, confidence: "medium", basis: "estimate" }] });
  await send({ message: { chat, date: now(), text: "/jem szakszuka, to było moje śniadanie" } });
  const userPart = geminiBodies[0].contents[0].parts.map((p: any) => p.text ?? "").join("\n");
  assert.match(userPart, /Plan posiłków Jana.*śniadanie, obiad, kolacja/);
  const meals = await state.getMeals("2026-11-17");
  assert.equal(meals[0].slot, "śniadanie");
  assert.match(lastText(), /^🍽 <b>śniadanie<\/b> · 15:01/);
  // correction without a slot keeps the slot
  geminiQueue.push({ is_food: true, meal_label: "Szakszuka", meal_slot: null, items: [{ name: "szakszuka", grams: 300, kcal: 380, protein_g: 20, carbs_g: 14, fat_g: 26, confidence: "high", basis: "estimate" }] });
  await send({ message: { chat, date: now(), text: "to było 300 g", reply_to_message: { message_id: msgId } } });
  assert.equal((await state.getMeals("2026-11-17"))[0].slot, "śniadanie");
  assert.match(lastText(), /^🍽 <b>śniadanie<\/b>/);
  // breakfast reminder: the slot counts as done even though the entry is at 15:01 (set earlier than reminder time via state)
  sent.length = 0;
  await state.setReminders({}, "2026-11-17");
  await runDietReminders(env);
  assert.ok(!sent.some((m) => /śniadanie \(plan/.test(m.text)), "śniadanie nie jest przypominane");
  mock.timers.reset();
});

test("model/user text with <, > and & cannot break the HTML message", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-18T10:00:00Z") });
  geminiQueue.push({ is_food: true, meal_label: "Kanapka <b>x</b> & sos", question: "Czy sos > 20 g & ostry?", items: [{ name: "a <i> & b", grams: 50, kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 4, confidence: "low", basis: "estimate" }] });
  await send({ message: { chat, date: now(), text: "/jem test" } });
  const t = lastText();
  assert.ok(t.includes("a &lt;i&gt; &amp; b"));
  assert.ok(t.includes("Kanapka &lt;b&gt;x&lt;/b&gt; &amp; sos"));
  assert.ok(t.includes("Czy sos &gt; 20 g &amp; ostry?"));
  assert.ok(!/<b>x<\/b>|<i> &/.test(t));
  assert.match(t, /\(\?\)/); // niska pewność oznaczona
  mock.timers.reset();
});

test("Garmin energy base is a median (outlier day ignored), /spalanie shows days, /cel shows components", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-18T10:00:00Z") });
  env.GARMIN_PERSONAL_API_KEY = "gk";
  garminDays.length = 0;
  for (let i = 1; i <= 14; i++) {
    const date = new Date(Date.parse("2026-11-18T12:00:00Z") - i * 86400000).toISOString().slice(0, 10);
    const active = i === 3 ? 20000 : 500; // jeden dzień z absurdalną wartością
    garminDays.push({ calendarDate: date, calories: { burnedResting: 2500, burnedActive: active, burnedTotal: 2500 + active } });
  }
  // stara wartość z poprzedniego sposobu liczenia (średnia, bez "detail") w pamięci podręcznej nie może przeżyć
  await storage.put("cache:energybase:2026-11-18", { at: Date.now(), data: JSON.stringify({ kcal: 3870, source: "garmin" }) });
  await storage.put("cache:energybase:v2:2026-11-18", { at: Date.now(), data: JSON.stringify({ kcal: 3870, source: "garmin" }) });
  await send({ message: { chat, date: now(), text: "/cel" } });
  const cel = lastText();
  assert.doesNotMatch(cel, /3870/);
  assert.match(cel, /Kcal od spokojnego dnia z Garmina: \(spoczynkowe 2500 \+ lekka aktywność 425, aktywne ×0,85\) ×0,9 = 2633/); // 500 aktywnych z najspokojniejszych dni ×0,85; dzień 20000 nie ma wpływu
  assert.match(cel, /dzień bez biegu \(ok\. 0 km\)|dzień bez biegu:/);
  await send({ message: { chat, date: now(), text: "/spalanie" } });
  const burn = lastText();
  assert.equal(sent[sent.length - 1].parse_mode, "HTML");
  assert.match(burn, /11-15: <b>22500<\/b> = 2500 \+ 20000/);
  assert.match(burn, /Spokojny dzień wg Garmina: 2500 \+ 425 = 2925 kcal/);
  assert.match(burn, /Po korekcie ×0,9 \(zegarek zawyża\): <b>2633<\/b> kcal, to baza celów/);
  assert.match(burn, /najbardziej aktywny: 19500 kcal/);
  env.GARMIN_PERSONAL_API_KEY = undefined;
  mock.timers.reset();
});

test("several commands in one message run in order; mixed text is not treated as commands", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-18T10:30:00Z") });
  await send({ message: { chat, date: now(), text: "/waga 106\n/dzis" } });
  const weights = await state.getWeights();
  assert.equal(weights[weights.length - 1].kg, 106);
  assert.match(lastText(), /^📅 <b>środa, 2026-11-18<\/b>/); // /dzis wykonane po /waga
  // nieznana komenda w grupie jest pomijana, znane się wykonują
  await send({ message: { chat, date: now(), text: "/waga 105\n/cosnieznanego" } });
  const w2 = await state.getWeights();
  assert.equal(w2[w2.length - 1].kg, 105);
  // sama nieznana komenda (np. /start) nadal idzie po staremu do trenera/ignorowania, nie do dietetyka
  const before = (await state.getMemory()).conversation.length;
  await send({ message: { chat, date: now(), text: "/start" } });
  assert.equal((await state.getMemory()).conversation.length, before);
  mock.timers.reset();
});

test("/cel cel sets the goal weight; /waga shows progress and reaching the goal", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-19T10:00:00Z") });
  await send({ message: { chat, date: now(), text: "/cel cel 100" } });
  assert.equal((await state.getNutCfg()).goalWeightKg, 100);
  assert.match(lastText(), /docelowa 100 kg/);
  await send({ message: { chat, date: now(), text: "/waga 107" } });
  assert.match(lastText(), /Do celu \(100 kg\) zostało 7 kg/);
  await send({ message: { chat, date: now(), text: "/waga 99,5" } });
  assert.match(lastText(), /Cel 100 kg zaliczony, jesteś 0,5 kg poniżej/);
  await send({ message: { chat, date: now(), text: "/cel cel 5" } });
  assert.match(lastText(), /Waga docelowa: 40–200 kg/);
  assert.equal((await state.getNutCfg()).goalWeightKg, 100);
  await send({ message: { chat, date: now(), text: "/cel cel 95" } });
  mock.timers.reset();
});

test("config: v1/v2 stored copies migrate (baked-in old defaults dropped), explicit overrides survive, only overrides are stored", async () => {
  await storage.put("nut:cfg", { slots: [{ name: "obiad", time: "13:30" }], weekendSlots: [], remindersOn: true, remindAfterMin: 180, proteinPerKg: 1.8, fatPerKg: 1.0, carbsPerKg: { rest: 3.5, easy: 4.5, quality: 6, long: 7 }, deficitKcal: 400, macroWeightKg: 95, weightFallbackKg: null });
  let c = await state.getNutCfg();
  assert.equal(c.deficitKcal, 600); // nowa domyślna, nie zapisane 400
  assert.equal(c.proteinPerKg, 1.6); // stara domyślna 1,8 odrzucona
  assert.equal(c.fatPerKg, 0.8);
  assert.equal(c.macroWeightKg, 95); // świadome ustawienie zostaje
  assert.equal(c.slots[0].name, "obiad"); // plan posiłków zostaje
  assert.equal(c.goalWeightKg, 95);
  assert.equal(c.goalDate, "2027-04-25");
  assert.equal(c.garminFactor, 0.9);
  // stan v2 (po pierwszej migracji) z wbitymi 1,8/1,0 też jest czyszczony
  await storage.put("nut:cfg", { cfgV: 2, proteinPerKg: 1.8, fatPerKg: 1.0, remindAfterMin: 120 });
  c = await state.getNutCfg();
  assert.equal(c.proteinPerKg, 1.6);
  assert.equal(c.remindAfterMin, 120);
  // świadomy wybór po migracji musi zostać, także gdy równa się starej domyślnej
  await state.patchNutCfg({ proteinPerKg: 1.8, deficitKcal: 400 });
  c = await state.getNutCfg();
  assert.equal(c.proteinPerKg, 1.8);
  assert.equal(c.deficitKcal, 400);
  const stored = store.get("nut:cfg");
  assert.equal(stored.cfgV, 3);
  assert.equal(stored.fatPerKg, undefined);
  await state.patchNutCfg({ proteinPerKg: 1.6, deficitKcal: 600 });
  await state.patchNutCfg({ remindersOn: false });
  assert.equal(store.get("nut:cfg").remindersOn, false);
  await state.patchNutCfg({ remindersOn: true });
});

test("/cel garmin, /cel termin, /cel deficyt validation; /waga shows plan and required pace", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-16T10:00:00Z") });
  await storage.put("nut:cfg", { cfgV: 3 });
  store.set("nut:weights", [{ date: "2026-11-16", kg: 107 }]);
  await send({ message: { chat, date: now(), text: "/cel garmin 0,85" } });
  assert.equal((await state.getNutCfg()).garminFactor, 0.85);
  assert.match(lastText(), /Korekta Garmina ×0,85/);
  await send({ message: { chat, date: now(), text: "/cel garmin 2" } });
  assert.match(lastText(), /Korekta Garmina: 0,7–1,1/);
  assert.equal((await state.getNutCfg()).garminFactor, 0.85);
  await send({ message: { chat, date: now(), text: "/cel deficyt 800" } });
  assert.equal((await state.getNutCfg()).deficitKcal, 800);
  await send({ message: { chat, date: now(), text: "/cel deficyt 900" } });
  assert.match(lastText(), /Deficyt: 0–800 kcal/);
  assert.equal((await state.getNutCfg()).deficitKcal, 800);
  await send({ message: { chat, date: now(), text: "/cel termin 2020-01-01" } });
  assert.match(lastText(), /Termin celu: data w przyszłości/);
  assert.equal((await state.getNutCfg()).goalDate, "2027-04-25");
  await send({ message: { chat, date: now(), text: "/cel termin 2027-06-01" } });
  assert.equal((await state.getNutCfg()).goalDate, "2027-06-01");
  await send({ message: { chat, date: now(), text: "/cel termin 2027-04-25" } });
  await send({ message: { chat, date: now(), text: "/waga 104" } });
  const t = lastText();
  assert.match(t, /Do celu \(95 kg\) zostało 9 kg/);
  assert.match(t, /📍 Wg planu \(prosto do 2027-04-25\) dziś byłoby ok\. 104,8 kg: jesteś 0,8 kg do przodu/);
  assert.match(t, /⏱ Żeby być na 95 kg 2027-04-25, trzeba ok\. 0,5 kg tygodniowo \(zostało 18,6 tyg\.\)/);
  await send({ message: { chat, date: now(), text: "/cel deficyt 600\n/cel garmin 0,9" } });
  assert.equal((await state.getNutCfg()).deficitKcal, 600);
  assert.equal((await state.getNutCfg()).garminFactor, 0.9);
  mock.timers.reset();
});

const OVERLOADED = { __status: 503 };
const eggMeal = { is_food: true, meal_label: "Fritata", items: [{ name: "fritata z 4 jaj", grams: 300, kcal: 520, protein_g: 36, carbs_g: 8, fat_g: 38, confidence: "medium", basis: "estimate" }] };

test("Gemini overloaded: job is queued, retried by the alarm without Jan resending, meal saved once", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-01T10:00:00Z") });
  state.env = env; // budzik wykonuje się w obiekcie z własnym env
  store.delete("nut:jobs"); store.delete("nut:meals:2026-12-01");
  sent.length = 0;
  // pierwsza próba: oba modele 503 (po 1 odpowiedzi na model)
  geminiQueue.length = 0;
  geminiQueue.push(OVERLOADED, OVERLOADED);
  await send({ message: { chat, date: now(), text: "/jem 40 g fety i cztery jajka L, garść pomidorków, czyli frittata" } });
  assert.match(lastText(), /^⏳ Gemini jest chwilowo przeciążony/);
  assert.equal((await state.getMeals("2026-12-01")).length, 0);
  let jobs = await state.dietJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].attempts, 1);
  assert.equal(jobs[0].nextAt, Date.now() + 60_000);
  assert.equal(jobs[0].text, "40 g fety i cztery jajka L, garść pomidorków, czyli frittata");

  // budzik przed terminem nic nie robi
  await state.alarm();
  assert.equal((await state.dietJobs()).length, 1);
  assert.equal((await state.getMeals("2026-12-01")).length, 0);

  // po minucie: znów 503 -> kolejne ponowienie (po 2,5 min), bez nowej wiadomości o przeciążeniu
  mock.timers.setTime(new Date("2026-12-01T10:01:01Z").getTime());
  geminiQueue.push(OVERLOADED, OVERLOADED);
  const before = sent.length;
  await state.alarm();
  jobs = await state.dietJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].attempts, 2);
  assert.equal(jobs[0].nextAt, Date.now() + 150_000);
  assert.equal(sent.length, before, "tylko jedna wiadomość o przeciążeniu");

  // po kolejnych 2,5 min Gemini wraca: posiłek zapisany raz, wiadomość z posiłkiem, kolejka pusta
  mock.timers.setTime(new Date("2026-12-01T10:03:40Z").getTime());
  geminiQueue.push(eggMeal);
  await state.alarm();
  const meals = await state.getMeals("2026-12-01");
  assert.equal(meals.length, 1);
  assert.equal(meals[0].label, "Fritata");
  assert.equal(meals[0].note, "40 g fety i cztery jajka L, garść pomidorków, czyli frittata");
  assert.match(lastText(), /Ten posiłek: 520 kcal/);
  assert.equal((await state.dietJobs()).length, 0);
  // ponowne uruchomienie budzika nie dubluje wpisu
  await state.alarm();
  assert.equal((await state.getMeals("2026-12-01")).length, 1);
  // ponowienia dostały większy budżet czasu niż pierwsza próba
  mock.timers.reset();
});

test("Gemini keeps failing: after 3 retries Jan gets one final error message and the queue is empty; permanent errors are not queued", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-02T10:00:00Z") });
  state.env = env;
  store.delete("nut:jobs"); sent.length = 0; geminiQueue.length = 0;
  geminiQueue.push(OVERLOADED, OVERLOADED);
  await send({ message: { chat, date: now(), text: "/jem jajka" } });
  assert.match(lastText(), /^⏳/);
  for (const [i, min] of [[1, 2], [2, 5], [3, 12]] as const) {
    mock.timers.setTime(new Date(`2026-12-02T10:${String(min).padStart(2, "0")}:00Z`).getTime());
    geminiQueue.push(OVERLOADED, OVERLOADED);
    await state.alarm();
  }
  assert.equal((await state.dietJobs()).length, 0);
  assert.match(lastText(), /^⚠️ Gemini nadal nie odpowiada mimo kilku prób \(Zapis posiłku\)/);
  assert.equal((await state.getMeals("2026-12-02")).length, 0);
  const waiting = sent.filter((m) => /^⏳/.test(m.text)).length;
  assert.equal(waiting, 1);

  // błąd trwały (zła nazwa modelu na obu): komunikat od razu, bez kolejki
  sent.length = 0; geminiQueue.length = 0;
  geminiQueue.push({ __status: 404 }, { __status: 404 });
  await send({ message: { chat, date: now(), text: "/jem jajka" } });
  assert.match(lastText(), /^⚠️ Ups, coś nie pykło \(Komenda \/jem\)/);
  assert.equal((await state.dietJobs()).length, 0);
  mock.timers.reset();
});

test("photo job is retried with the stored file id and caption", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-03T10:00:00Z") });
  state.env = env;
  store.delete("nut:jobs"); sent.length = 0; geminiQueue.length = 0;
  geminiQueue.push(OVERLOADED, OVERLOADED);
  await send({ message: { chat, date: now(), caption: "to frittata", photo: [{ file_id: "small" }, { file_id: "BIGPHOTO" }] } });
  const jobs = await state.dietJobs();
  assert.equal(jobs[0].kind, "photo");
  assert.equal(jobs[0].fileId, "BIGPHOTO");
  assert.equal(jobs[0].text, "to frittata");
  mock.timers.setTime(new Date("2026-12-03T10:01:05Z").getTime());
  geminiQueue.push(eggMeal);
  await state.alarm();
  const m = (await state.getMeals("2026-12-03"))[0];
  assert.equal(m.source, "photo");
  assert.equal(m.photoFileId, "BIGPHOTO");
  assert.equal(m.note, "to frittata");
  mock.timers.reset();
});

// ======================= API aplikacji =======================

async function api(path: string, opts: { method?: string; body?: any; token?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  const res = await handleApi(new Request(`https://x.workers.dev${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), env);
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}
let TOKEN = "";

test("API auth: login, wrong password, lockout after 8 failures, token tampering and expiry", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-10T10:00:00Z") });
  store.delete("auth");
  assert.equal((await api("/api/summary", { token: null })).status, 401);
  assert.equal((await api("/api/summary", { token: "garbage" })).status, 401);
  for (let i = 0; i < 8; i++) assert.equal((await api("/api/login", { method: "POST", body: { password: "zle" }, token: null })).status, 401);
  const locked = await api("/api/login", { method: "POST", body: { password: "pw" }, token: null });
  assert.equal(locked.status, 429); // nawet poprawne hasło jest odrzucone podczas blokady
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  mock.timers.setTime(new Date("2026-12-10T10:16:00Z").getTime()); // po 15 minutach blokada mija
  const ok = await api("/api/login", { method: "POST", body: { password: "pw" }, token: null });
  assert.equal(ok.status, 200);
  TOKEN = ok.body.token;
  assert.match(TOKEN, /^\d{10}\.[0-9a-f]{64}$/);
  assert.equal((await api("/api/me")).status, 200);
  assert.equal(store.get("auth"), undefined, "udane logowanie czyści licznik");
  // podrobiony i zmieniony token
  const [exp, sig] = TOKEN.split(".");
  assert.equal(await verifyToken(env, `${Number(exp) + 1000}.${sig}`), false);
  assert.equal(await verifyToken(env, `${exp}.${"0".repeat(64)}`), false);
  // token podpisany innym hasłem (zmiana MCP_PASSWORD) przestaje działać
  assert.equal(await verifyToken({ ...env, MCP_PASSWORD: "inne" }, TOKEN), false);
  // po wygaśnięciu (30 dni)
  mock.timers.setTime(new Date("2027-01-15T10:00:00Z").getTime());
  assert.equal((await api("/api/me")).status, 401);
  assert.equal(await issueToken(env).then((t) => verifyToken(env, t)), true);
  mock.timers.reset();
});

test("API weight, settings and validation", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-11T10:00:00Z") });
  TOKEN = await issueToken(env);
  store.delete("nut:weights"); store.set("nut:cfg", { cfgV: 3 });
  assert.equal((await api("/api/weight", { method: "POST", body: { kg: "abc" } })).status, 400);
  assert.equal((await api("/api/weight", { method: "POST", body: { kg: 300 } })).status, 400);
  assert.equal((await api("/api/weight", { method: "POST", body: { kg: 107, date: "2026-11-16" } })).status, 201);
  const w = await api("/api/weight", { method: "POST", body: { kg: "106,2" } });
  assert.equal(w.status, 201);
  assert.equal(w.body.progress.last.kg, 106.2);
  const g = await api("/api/weight");
  assert.equal(g.body.entries.length, 2);
  assert.equal(g.body.goalKg, 95);
  assert.equal(g.body.plan.startKg, 107);
  assert.equal(g.body.plan.goalDate, "2027-04-25");
  assert.ok(g.body.progress.requiredKgPerWeek > 0.4);

  const s0 = await api("/api/settings");
  assert.equal(s0.body.settings.deficitKcal, 600);
  assert.equal(s0.body.settings.garminFactor, 0.9);
  const s1 = await api("/api/settings", { method: "PATCH", body: { deficitKcal: 500, garminFactor: 0.85, slotsText: "śniadanie 07:30; obiad 13:30", remindersOn: false } });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.settings.deficitKcal, 500);
  assert.equal(s1.body.settings.slotsText, "śniadanie 07:30; obiad 13:30");
  assert.equal(s1.body.settings.remindersOn, false);
  assert.equal((await state.getNutCfg()).slots[1].time, "13:30");
  for (const bad of [{ deficitKcal: 900 }, { garminFactor: 2 }, { goalDate: "2020-01-01" }, { slotsText: "obiad 99:99" }, { goalWeightKg: 10 }, { proteinPerKg: 0.1 }]) {
    const r = await api("/api/settings", { method: "PATCH", body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await state.getNutCfg()).deficitKcal, 500, "zły patch nic nie zmienia");
  const s2 = await api("/api/settings", { method: "PATCH", body: { goalDate: null, goalWeightKg: null, deficitKcal: 600, garminFactor: 0.9, remindersOn: true } });
  assert.equal(s2.body.settings.goalDate, null);
  await api("/api/settings", { method: "PATCH", body: { goalDate: "2027-04-25", goalWeightKg: 95, slotsText: "" } });
  mock.timers.reset();
});

test("API meals: add by text, list, revise, favorite, delete; image validation; Gemini busy -> 503", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-11T10:00:00Z") }); // 11:00 w Warszawie
  TOKEN = await issueToken(env);
  store.delete("nut:meals:2026-12-11"); store.delete("nut:favs"); geminiQueue.length = 0;
  assert.equal((await api("/api/meals", { method: "POST", body: {} })).status, 400);
  assert.equal((await api("/api/meals", { method: "POST", body: { image: { mime: "application/pdf", data: "x".repeat(200) } } })).status, 400);
  assert.equal((await api("/api/meals", { method: "POST", body: { text: "jajka", time: "23:59" } })).status, 400, "godzina z przyszłości");
  assert.equal((await api("/api/meals", { method: "POST", body: { text: "jajka", date: "2026-11-01" } })).status, 400, "za stary wpis");

  geminiQueue.push({ is_food: true, meal_label: "Jajecznica", question: "Ile oleju?", items: [{ name: "jajecznica z 3 jaj", grams: 200, kcal: 330, protein_g: 21, carbs_g: 2, fat_g: 26, confidence: "medium", basis: "estimate" }] });
  const added = await api("/api/meals", { method: "POST", body: { text: "jajecznica z 3 jaj", time: "08:15" } });
  assert.equal(added.status, 201);
  assert.equal(added.body.meal.time, "08:15");
  assert.equal(added.body.meal.totals.kcal, 330);
  assert.equal(added.body.overview.meals.length, 1);
  assert.ok(added.body.overview.targets.kcal > 1500);
  const id = added.body.meal.id;

  geminiQueue.push({ is_food: true, meal_label: "Jajecznica", items: [{ name: "jajecznica z 3 jaj", grams: 200, kcal: 400, protein_g: 21, carbs_g: 2, fat_g: 34, confidence: "high", basis: "estimate" }] });
  const rev = await api(`/api/meals/${id}/revise`, { method: "POST", body: { text: "na łyżce masła więcej" } });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.meal.totals.kcal, 400);
  assert.equal(rev.body.overview.meals.length, 1, "korekta nie dubluje");
  assert.equal((await api(`/api/meals/${id}/revise`, { method: "POST", body: { text: " " } })).status, 400);
  assert.equal((await api("/api/meals/20261211.ffffff/revise", { method: "POST", body: { text: "x" } })).status, 404);

  assert.equal((await api(`/api/meals/${id}/favorite`, { method: "POST" })).status, 200);
  const favs = await api("/api/favorites");
  assert.equal(favs.body.favorites[0].name, "Jajecznica");
  const logged = await api("/api/favorites/0/log", { method: "POST" });
  assert.equal(logged.status, 201);
  assert.equal(logged.body.overview.meals.length, 2);
  assert.equal((await api("/api/favorites/9/log", { method: "POST" })).status, 404);

  const day = await api("/api/meals?date=2026-12-11");
  assert.equal(day.body.meals.length, 2);
  assert.equal(day.body.totals.kcal, 800);
  assert.equal((await api("/api/meals?date=zla")).status, 400);

  const del = await api(`/api/meals/${logged.body.meal.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(del.body.overview.meals.length, 1);
  assert.equal((await api(`/api/meals/${logged.body.meal.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await api("/api/favorites/0", { method: "DELETE" })).status, 200);

  // zdjęcie: poprawne trafia do Gemini jako inlineData
  geminiBodies.length = 0;
  geminiQueue.push(eggMeal);
  const photo = await api("/api/meals", { method: "POST", body: { image: { mime: "image/jpeg", data: "A".repeat(500) }, text: "frittata" } });
  assert.equal(photo.status, 201);
  assert.equal(photo.body.meal.source, "photo");
  assert.equal(geminiBodies[0].contents[0].parts[0].inlineData.mimeType, "image/jpeg");

  // Gemini przeciążony: 503 z czytelnym kodem, nic nie zapisane
  const before = (await state.getMeals("2026-12-11")).length;
  geminiQueue.push(OVERLOADED, OVERLOADED);
  const busy = await api("/api/meals", { method: "POST", body: { text: "kanapka" } });
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error, "gemini_busy");
  assert.equal((await state.getMeals("2026-12-11")).length, before);
  // nie-jedzenie: 422
  geminiQueue.push({ is_food: false, meal_label: "", items: [] });
  assert.equal((await api("/api/meals", { method: "POST", body: { text: "buty" } })).status, 422);
  mock.timers.reset();
});

test("API summary: food, plan today/tomorrow, recovery, recommendations; sources failing do not break it", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-11T16:30:00Z") }); // 17:30, piątek
  TOKEN = await issueToken(env);
  env.GARMIN_PERSONAL_API_KEY = undefined;
  icuEvents = [
    { id: 1, category: "WORKOUT", type: "Run", name: "Długi bieg 18 km", start_date_local: "2026-12-12T00:00:00", distance: 18000, description: "Warmup\n- 1km" },
    { id: 2, category: "NOTE", type: "Run", name: "Notatka", start_date_local: "2026-12-12T00:00:00" },
    { id: 3, category: "WORKOUT", type: "Run", name: "Bieg spokojny 5 km", start_date_local: "2026-12-11T00:00:00", distance: 5000 },
  ];
  icuActs = [];
  store.delete("nut:meals:2026-12-11");
  await state.saveMeal({ id: "20261211.aaaaaa", date: "2026-12-11", time: "09:00", label: "Owsianka", source: "text", note: "", items: [], totals: { kcal: 600, protein: 25, carbs: 90, fat: 15 }, confidence: "high", question: null, createdAt: "x" });
  const r = await api("/api/summary");
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.now.date, "2026-12-11");
  assert.match(b.greeting, /Janek/);
  assert.equal(b.marathon.goal, "poniżej 4:30:00");
  assert.equal(b.food.totals.kcal, 600);
  assert.equal(b.food.meals.length, 1);
  assert.ok(Array.isArray(b.weight.series));
  assert.ok(b.weight.series.length >= 1 && b.weight.plan.goalKg === 95, "seria wagi i plan do karty wagi");
  assert.equal(b.training.today.planned.length, 1);
  assert.equal(b.training.today.planned[0].km, 5);
  assert.equal(b.training.tomorrow.planned.length, 1, "NOTE jest pomijana");
  assert.equal(b.training.tomorrow.planned[0].name, "Długi bieg 18 km");
  assert.equal(b.training.tomorrow.dayType, "long");
  const kinds = b.recommendations.map((x: any) => x.title);
  assert.ok(kinds.some((t: string) => /Jutro długi bieg: dołóż węgli|Brakuje/.test(t)), kinds.join(" | "));
  assert.ok(b.recommendations.some((x: any) => x.kind === "training" && /czeka/.test(x.title)), "dzisiejszy bieg jeszcze nie zrobiony");
  assert.ok(b.recommendations.length <= 7);
  assert.deepEqual(b.errors, []);
  // dane do kart: tydzień z planem, km z 14 dni, seria zapisów
  assert.equal(b.training.week.length, 7);
  assert.equal(b.training.week[0].date, "2026-12-07"); // poniedziałek tygodnia z piątku 2026-12-11
  assert.equal(b.training.week[4].isToday, true);
  assert.equal(b.training.week[4].planned, true);
  assert.equal(b.training.week[5].plannedKm, 18);
  assert.equal(b.training.weekPlannedKm, 23); // 5 km w piątek + 18 km w sobotę
  assert.equal(b.training.weekKm, 0);
  assert.equal(b.training.activityDays.length, 14);
  assert.equal(b.training.activityDays[13].date, "2026-12-11");
  assert.equal(typeof b.logging.streak, "number");
  assert.equal(b.logging.last7.length, 7);
  assert.equal(b.logging.last7[6].isToday, true);
  assert.equal(b.logging.last7[6].weekday, "Pt");
  // bieg zrobiony dzisiaj: rekomendacja po biegu, brak przypomnienia o zaległym biegu
  icuActs = [{ id: "i1", type: "Run", start_date_local: "2026-12-11T08:00:00", distance: 5100, moving_time: 1900, name: "Bieg" }];
  const r2 = await api("/api/summary");
  assert.equal(r2.body.training.today.done.length, 1);
  assert.equal(r2.body.training.weekKm, 5.1);
  assert.equal(r2.body.training.activityDays[13].km, 5.1);
  assert.equal(r2.body.training.last14Km, 5.1);
  assert.equal(r2.body.training.week[4].doneKm, 5.1);
  assert.ok(r2.body.recommendations.some((x: any) => x.title === "Po biegu"));
  assert.ok(!r2.body.recommendations.some((x: any) => /czeka/.test(x.title)));
  // awaria intervals.icu nie wywala całego podsumowania
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any, i: any) => (String(u).includes("intervals.icu") ? new Response("boom", { status: 500 }) : (orig as any)(u, i))) as any;
  const r3 = await api("/api/summary");
  globalThis.fetch = orig;
  assert.equal(r3.status, 200);
  assert.ok(r3.body.errors.some((e: string) => /^plan:/.test(e)));
  assert.ok(!r3.body.recommendations.some((x: any) => x.title === "Jutro bez biegania"), "awaria planu nie oznacza wolnego jutra");
  assert.equal(r3.body.food.totals.kcal, 600);
  icuEvents = []; icuActs = [];
  mock.timers.reset();
});

test("API week, plan, routes (no key), coach chat and plan request", async () => {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-11T10:00:00Z") });
  TOKEN = await issueToken(env);
  icuEvents = [{ id: 7, category: "WORKOUT", type: "Run", name: "Bieg 6 km", start_date_local: "2026-12-13T00:00:00", distance: 6000, moving_time: 2400 }];
  const week = await api("/api/week");
  assert.equal(week.status, 200);
  assert.equal(week.body.days.length, 7);
  assert.equal(week.body.days[6].date, "2026-12-11");
  assert.ok(week.body.days.some((d: any) => d.kcal > 0));
  const plan = await api("/api/plan");
  assert.equal(plan.body.upcoming[0].km, 6);
  assert.equal(plan.body.upcoming[0].minutes, 40);
  icuEvents = [];

  delete env.ORS_API_KEY;
  assert.equal((await api("/api/routes", { method: "POST", body: { km: 8 } })).status, 501);
  assert.equal((await api("/api/routes", { method: "POST", body: { km: 100 } })).status, 400);

  const before = (await state.getMemory()).conversation.length;
  assert.equal((await api("/api/coach", { method: "POST", body: { text: "  " } })).status, 400);
  assert.equal((await api("/api/coach", { method: "POST", body: { text: "Janek tu, jaki plan na weekend?" } })).status, 201);
  const chat = await api("/api/coach");
  assert.equal(chat.body.messages.length, before + 1);
  assert.equal(chat.body.messages[chat.body.messages.length - 1].text, "Janek tu, jaki plan na weekend?");
  assert.equal(chat.body.awaiting, true);
  await state.logOutgoing("Plan jest w kalendarzu, miłego biegania!");
  assert.equal((await api("/api/coach")).body.awaiting, false);
  assert.ok((await state.getMemory()).pending.includes("NOWA_WIADOMOSC_OD_JANA"), "trener zostaje obudzony");

  const pl = await api("/api/coach/plan", { method: "POST", body: { weeks: 3, note: "bez wtorku" } });
  assert.equal(pl.status, 201);
  const last = (await state.getMemory()).conversation.at(-1)!;
  assert.match(last.text, /plan treningowy na najbliższe 3 tygodnie/);
  assert.match(last.text, /bez wtorku/);

  assert.equal((await api("/api/nope")).status, 404);
  mock.timers.reset();
});
