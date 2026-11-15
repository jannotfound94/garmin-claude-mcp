import { DurableObject } from "cloudflare:workers";
import { fmtWarsaw } from "./time";
import type { GarminPendingMfa, GarminTokens } from "./garmin";

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

  // ---------- Garmin Connect tokens (kept apart from the memory the agent sees) ----------

  async getGarmin(): Promise<GarminTokens | null> {
    return (await this.ctx.storage.get<GarminTokens>("garmin")) ?? null;
  }
  async setGarmin(t: GarminTokens | null) {
    if (t) await this.ctx.storage.put("garmin", t);
    else await this.ctx.storage.delete("garmin");
  }
  async getGarminPending(): Promise<GarminPendingMfa | null> {
    const p = await this.ctx.storage.get<GarminPendingMfa>("garminPending");
    return p && Date.now() - p.createdAt < 10 * 60_000 ? p : null;
  }
  async setGarminPending(p: GarminPendingMfa | null) {
    if (p) await this.ctx.storage.put("garminPending", p);
    else await this.ctx.storage.delete("garminPending");
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
