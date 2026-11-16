import { DurableObject } from "cloudflare:workers";
import { fmtWarsaw } from "./time";
import type { GarminToken } from "./garmin";
import type { LatLon, RouteProposal } from "./routes";
import { DEFAULT_CONFIG, type Meal, type NutritionConfig, type Weight, dateOfMealId } from "./nutrition";

export interface Favorite {
  name: string;
  items: Meal["items"];
}

/**
 * The coach's memory. One Durable Object instance ("jan") holds everything, so updates from the
 * Telegram webhook, the cron scheduler and the agent's tools never overwrite each other.
 */

export interface Msg {
  at: string; // ISO UTC
  from: "jan" | "trener";
  text: string;
}
export interface Note {
  id: number;
  date: string;
  text: string;
}
export interface CheckIn {
  id: number;
  at: string; // ISO UTC
  reason: string;
}
export interface FireLog {
  at: string;
  reasons: string[];
  ok: boolean;
  info: string;
}

export interface CoachMemory {
  notes: Note[];
  openItems: Note[];
  checkIns: CheckIn[];
  conversation: Msg[];
  lastHandledAt: string | null;
  knownActivities: string[];
  activitiesSeeded?: boolean;
  reviewedActivities: string[];
  pulses: Record<string, string>; // pulse name -> local date it last fired
  pending: string[]; // wake reasons waiting to be sent
  lastWakeReasons: string[];
  fires: FireLog[];
  nextId: number;
}

export interface MemoryOps {
  addNotes?: string[];
  removeNoteIds?: number[];
  addOpenItems?: string[];
  resolveOpenItemIds?: number[];
  addCheckIns?: { at: string; reason: string }[]; // at: ISO UTC
  removeCheckInIds?: number[];
  reviewedActivities?: string[];
  markHandled?: boolean;
}

const MAX_CONVERSATION = 80;
const MAX_IDS = 60;
const MESSAGE_DEBOUNCE_MS = 20_000;
const RETRY_MS = 10 * 60_000;

function empty(): CoachMemory {
  return {
    notes: [],
    openItems: [],
    checkIns: [],
    conversation: [],
    lastHandledAt: null,
    knownActivities: [],
    activitiesSeeded: false,
    reviewedActivities: [],
    pulses: {},
    pending: [],
    lastWakeReasons: [],
    fires: [],
    nextId: 1,
  };
}

export class CoachState extends DurableObject<Env> {
  private async load(): Promise<CoachMemory> {
    const m = await this.ctx.storage.get<CoachMemory>("memory");
    return { ...empty(), ...(m ?? {}) };
  }
  private async save(m: CoachMemory) {
    await this.ctx.storage.put("memory", m);
  }

  async getMemory(): Promise<CoachMemory> {
    return this.load();
  }

  async addIncoming(text: string, at: string) {
    const m = await this.load();
    m.conversation.push({ at, from: "jan", text });
    m.conversation = m.conversation.slice(-MAX_CONVERSATION);
    if (!m.pending.includes("NOWA_WIADOMOSC_OD_JANA")) m.pending.push("NOWA_WIADOMOSC_OD_JANA");
    await this.save(m);
    // Debounce: several quick messages -> one wake-up.
    await this.ctx.storage.setAlarm(Date.now() + MESSAGE_DEBOUNCE_MS);
  }

  async logOutgoing(text: string) {
    const m = await this.load();
    const now = new Date().toISOString();
    m.conversation.push({ at: now, from: "trener", text });
    m.conversation = m.conversation.slice(-MAX_CONVERSATION);
    await this.save(m);
  }

  async applyOps(ops: MemoryOps, handledUpTo: string | null): Promise<CoachMemory> {
    const m = await this.load();
    const today = fmtWarsaw(new Date().toISOString()).slice(0, 10);
    for (const t of ops.addNotes ?? []) m.notes.push({ id: m.nextId++, date: today, text: t });
    if (ops.removeNoteIds?.length) m.notes = m.notes.filter((n) => !ops.removeNoteIds!.includes(n.id));
    for (const t of ops.addOpenItems ?? []) m.openItems.push({ id: m.nextId++, date: today, text: t });
    if (ops.resolveOpenItemIds?.length) m.openItems = m.openItems.filter((n) => !ops.resolveOpenItemIds!.includes(n.id));
    for (const c of ops.addCheckIns ?? []) m.checkIns.push({ id: m.nextId++, at: c.at, reason: c.reason });
    if (ops.removeCheckInIds?.length) m.checkIns = m.checkIns.filter((c) => !ops.removeCheckInIds!.includes(c.id));
    for (const id of ops.reviewedActivities ?? []) if (!m.reviewedActivities.includes(id)) m.reviewedActivities.push(id);
    m.reviewedActivities = m.reviewedActivities.slice(-MAX_IDS);
    if (ops.markHandled) m.lastHandledAt = handledUpTo ?? new Date().toISOString();
    await this.save(m);
    return m;
  }

  // ---------- scheduler support ----------

  async setKnownActivities(ids: string[]) {
    const m = await this.load();
    m.knownActivities = ids.slice(-MAX_IDS);
    m.activitiesSeeded = true;
    await this.save(m);
  }

  async markPulse(name: string, localDate: string) {
    const m = await this.load();
    m.pulses[name] = localDate;
    await this.save(m);
  }

  /** Removes and returns check-ins that are due. */
  async takeDueCheckIns(nowIso: string): Promise<CheckIn[]> {
    const m = await this.load();
    const due = m.checkIns.filter((c) => c.at <= nowIso);
    if (!due.length) return [];
    m.checkIns = m.checkIns.filter((c) => c.at > nowIso);
    await this.save(m);
    return due;
  }

  async queueWake(reasons: string[], delayMs = 0) {
    if (!reasons.length) return;
    const m = await this.load();
    for (const r of reasons) if (!m.pending.includes(r)) m.pending.push(r);
    await this.save(m);
    const existing = await this.ctx.storage.getAlarm();
    const at = Date.now() + delayMs;
    if (existing == null || existing > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const m = await this.load();
    if (!m.pending.length) return;
    const reasons = m.pending;
    const res = await fireRoutine(this.env, reasons);
    m.fires.push({ at: new Date().toISOString(), reasons, ok: res.ok, info: res.info });
    m.fires = m.fires.slice(-20);
    if (res.ok) {
      m.pending = [];
      m.lastWakeReasons = reasons;
    } else if (res.retry) {
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    } else {
      m.pending = []; // not configured / permanent error: drop, visible on /setup
    }
    await this.save(m);
  }

  // ---------- Garmin Personal API bearer token cache ----------

  async getGarminToken(): Promise<GarminToken | null> {
    return (await this.ctx.storage.get<GarminToken>("garminToken")) ?? null;
  }
  async setGarminToken(t: GarminToken | null) {
    if (t) await this.ctx.storage.put("garminToken", t);
    else await this.ctx.storage.delete("garminToken");
  }

  // ---------- small time-limited cache (e.g. park data from Overpass) ----------

  /** Values are JSON strings (keeps the RPC types simple). */
  async getCache(key: string, maxAgeMs: number): Promise<string | null> {
    const v = await this.ctx.storage.get<{ at: number; data: string }>(`cache:${key}`);
    return v && Date.now() - v.at < maxAgeMs ? v.data : null;
  }
  async setCache(key: string, data: string) {
    await this.ctx.storage.put(`cache:${key}`, { at: Date.now(), data });
  }

  // ---------- running routes ----------

  async getRouteSettings(): Promise<{ home: (LatLon & { label: string }) | null; last: (LatLon & { at: string }) | null; origin: string | null }> {
    const [home, last, origin] = await Promise.all([
      this.ctx.storage.get<LatLon & { label: string }>("home"),
      this.ctx.storage.get<LatLon & { at: string }>("lastLocation"),
      this.ctx.storage.get<string>("origin"),
    ]);
    return { home: home ?? null, last: last ?? null, origin: origin ?? null };
  }
  async setHome(h: LatLon & { label: string }) {
    await this.ctx.storage.put("home", h);
  }
  async setLastLocation(l: LatLon & { at: string }) {
    await this.ctx.storage.put("lastLocation", l);
  }
  async clearLastLocation() {
    await this.ctx.storage.delete("lastLocation");
  }
  async setOrigin(origin: string) {
    if ((await this.ctx.storage.get<string>("origin")) !== origin) await this.ctx.storage.put("origin", origin);
  }
  async saveProposal(p: RouteProposal) {
    const list = (await this.ctx.storage.get<RouteProposal[]>("proposals")) ?? [];
    list.push(p);
    await this.ctx.storage.put("proposals", list.slice(-6));
  }
  async getProposal(id: string): Promise<RouteProposal | null> {
    const list = (await this.ctx.storage.get<RouteProposal[]>("proposals")) ?? [];
    return list.find((p) => p.id === id) ?? null;
  }
  async listProposals(): Promise<RouteProposal[]> {
    return (await this.ctx.storage.get<RouteProposal[]>("proposals")) ?? [];
  }
  async markChosen(id: string, label: string) {
    const list = (await this.ctx.storage.get<RouteProposal[]>("proposals")) ?? [];
    const p = list.find((x) => x.id === id);
    if (p) p.chosen = label;
    await this.ctx.storage.put("proposals", list);
  }

  // ---------- dietetyk (posiłki, waga, ulubione, przypomnienia) ----------
  // Posiłki leżą pod kluczem na dzień ("nut:meals:YYYY-MM-DD"), żeby wartość nigdy nie urosła ponad limit.

  async getNutCfg(): Promise<NutritionConfig> {
    const c = await this.ctx.storage.get<Partial<NutritionConfig>>("nut:cfg");
    return { ...DEFAULT_CONFIG, ...c, carbsPerKg: { ...DEFAULT_CONFIG.carbsPerKg, ...c?.carbsPerKg } };
  }
  async patchNutCfg(patch: Partial<NutritionConfig>): Promise<NutritionConfig> {
    const next = { ...(await this.getNutCfg()), ...patch };
    await this.ctx.storage.put("nut:cfg", next);
    return next;
  }

  async getMeals(date: string): Promise<Meal[]> {
    return (await this.ctx.storage.get<Meal[]>(`nut:meals:${date}`)) ?? [];
  }
  async getMealsRange(dates: string[]): Promise<Record<string, Meal[]>> {
    const out: Record<string, Meal[]> = {};
    const got = await this.ctx.storage.get<Meal[]>(dates.map((d) => `nut:meals:${d}`));
    for (const d of dates) out[d] = got.get(`nut:meals:${d}`) ?? [];
    return out;
  }
  async findMeal(id: string): Promise<Meal | null> {
    const date = dateOfMealId(id);
    return date ? ((await this.getMeals(date)).find((m) => m.id === id) ?? null) : null;
  }
  async saveMeal(meal: Meal) {
    const list = await this.getMeals(meal.date);
    const i = list.findIndex((m) => m.id === meal.id);
    if (i >= 0) list[i] = meal;
    else list.push(meal);
    list.sort((a, b) => a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt));
    await this.ctx.storage.put(`nut:meals:${meal.date}`, list);
  }
  async deleteMeal(id: string): Promise<boolean> {
    const date = dateOfMealId(id);
    if (!date) return false;
    const list = await this.getMeals(date);
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    await this.ctx.storage.put(`nut:meals:${date}`, next);
    return true;
  }

  async addWeight(w: Weight) {
    const list = ((await this.ctx.storage.get<Weight[]>("nut:weights")) ?? []).filter((x) => x.date !== w.date);
    list.push(w);
    list.sort((a, b) => a.date.localeCompare(b.date));
    await this.ctx.storage.put("nut:weights", list.slice(-400));
  }
  async getWeights(): Promise<Weight[]> {
    return (await this.ctx.storage.get<Weight[]>("nut:weights")) ?? [];
  }

  async getFavorites(): Promise<Favorite[]> {
    return (await this.ctx.storage.get<Favorite[]>("nut:favs")) ?? [];
  }
  async addFavorite(f: Favorite): Promise<void> {
    const list = (await this.getFavorites()).filter((x) => x.name.toLowerCase() !== f.name.toLowerCase());
    list.push(f);
    await this.ctx.storage.put("nut:favs", list.slice(-30));
  }
  async removeFavorite(index: number): Promise<boolean> {
    const list = await this.getFavorites();
    if (index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    await this.ctx.storage.put("nut:favs", list);
    return true;
  }

  /** Stan przypomnień: "YYYY-MM-DD|slot" -> sent | sent2 | ok | skip | snooze:ISO. Stare dni są usuwane. */
  async getReminders(): Promise<Record<string, string>> {
    return (await this.ctx.storage.get<Record<string, string>>("nut:rem")) ?? {};
  }
  async setReminders(patch: Record<string, string>, today: string) {
    const cur = await this.getReminders();
    const next: Record<string, string> = {};
    const oldest = prevDay(today);
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (k.slice(0, 10) >= oldest) next[k] = v;
    await this.ctx.storage.put("nut:rem", next);
  }

  /** Wiadomość bota z posiłkiem -> id posiłku (odpowiedź Jana na nią = korekta). */
  async rememberMealMessage(messageId: number, mealId: string) {
    const map = (await this.ctx.storage.get<Record<string, string>>("nut:msgmap")) ?? {};
    map[String(messageId)] = mealId;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete map[k];
    await this.ctx.storage.put("nut:msgmap", map);
  }
  async mealForMessage(messageId: number): Promise<string | null> {
    return ((await this.ctx.storage.get<Record<string, string>>("nut:msgmap")) ?? {})[String(messageId)] ?? null;
  }

  /** Deduplikacja aktualizacji Telegrama (ponowienia) i albumów zdjęć. True = nowe. */
  async firstSeen(kind: "update" | "group", id: string): Promise<boolean> {
    const key = `nut:seen:${kind}`;
    const seen = (await this.ctx.storage.get<string[]>(key)) ?? [];
    if (seen.includes(id)) return false;
    seen.push(id);
    await this.ctx.storage.put(key, seen.slice(-60));
    return true;
  }

  /** Manual wake-up from the setup page. */
  async wakeNow(reason: string) {
    await this.queueWake([reason], 0);
  }
}

export async function fireRoutine(env: Env, reasons: string[]): Promise<{ ok: boolean; retry: boolean; info: string }> {
  if (!env.ROUTINE_FIRE_URL || !env.ROUTINE_FIRE_TOKEN) {
    return { ok: false, retry: false, info: "Brak ROUTINE_FIRE_URL lub ROUTINE_FIRE_TOKEN" };
  }
  const text =
    `Powody pobudki (${fmtWarsaw(new Date().toISOString())} czasu polskiego): ${reasons.join("; ")}. ` +
    `Szczegóły i wiadomości Jana pobierz przez getCoachContext.`;
  try {
    const res = await fetch(env.ROUTINE_FIRE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ROUTINE_FIRE_TOKEN}`,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    const body = (await res.text()).slice(0, 300);
    if (res.ok) return { ok: true, retry: false, info: body };
    return { ok: false, retry: res.status === 429 || res.status >= 500, info: `${res.status}: ${body}` };
  } catch (e) {
    return { ok: false, retry: true, info: String(e) };
  }
}

function prevDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
