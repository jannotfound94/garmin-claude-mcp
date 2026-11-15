const BASE = "https://intervals.icu/api/v1";

export class Icu {
  constructor(
    private apiKey: string,
    readonly athlete: string,
  ) {}

  async req(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Basic ${btoa(`API_KEY:${this.apiKey}`)}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  activities(oldest: string, newest?: string) {
    const q = newest ? `&newest=${newest}` : "";
    return this.req(`/athlete/${this.athlete}/activities?oldest=${oldest}${q}`) as Promise<any[]>;
  }
  wellness(oldest: string, newest?: string) {
    const q = newest ? `&newest=${newest}` : "";
    return this.req(`/athlete/${this.athlete}/wellness?oldest=${oldest}${q}`) as Promise<any[]>;
  }
  events(oldest: string, newest: string) {
    return this.req(`/athlete/${this.athlete}/events?oldest=${oldest}&newest=${newest}`) as Promise<any[]>;
  }
  activity(id: string) {
    return this.req(`/activity/${encodeURIComponent(id)}?intervals=true`);
  }
  streams(id: string, types: string[]) {
    return this.req(`/activity/${encodeURIComponent(id)}/streams?types=${types.join(",")}`);
  }
}

// ---------- formatting helpers ----------

export function paceFromSpeed(mps: number | null | undefined): string | null {
  if (!mps || mps <= 0) return null;
  return paceFromSecs(1000 / mps);
}

export function paceFromSecs(secsPerKm: number): string {
  const s = Math.round(secsPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

export function duration(secs: number | null | undefined): string | null {
  if (secs == null) return null;
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function dropEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Partial<T>;
}

const round = (n: number | null | undefined, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Only the fields a coach needs, instead of ~150 mostly-null fields. */
export function compactActivity(a: any) {
  const moving = a.moving_time ?? null;
  const dist = a.distance ?? a.icu_distance ?? null;
  return dropEmpty({
    id: a.id,
    start: a.start_date_local,
    type: a.type,
    name: a.name,
    distance_km: round(dist != null ? dist / 1000 : null, 2),
    moving_time: duration(moving),
    elapsed_time: duration(a.elapsed_time),
    pace_moving: dist && moving ? paceFromSecs(moving / (dist / 1000)) : null,
    avg_hr: a.average_heartrate,
    max_hr: a.max_heartrate,
    cadence_spm: a.average_cadence ? Math.round(a.average_cadence * 2) : null,
    elevation_gain_m: round(a.total_elevation_gain, 0),
    training_load: a.icu_training_load,
    rpe: a.icu_rpe ?? a.perceived_exertion,
    feel: a.feel,
    paired_event_id: a.paired_event_id,
    description: a.description,
  });
}

export function compactWellness(w: any) {
  return dropEmpty({
    date: w.id,
    sleep_h: w.sleepSecs ? round(w.sleepSecs / 3600, 1) : null,
    sleep_score: w.sleepScore,
    sleep_quality: w.sleepQuality,
    resting_hr: w.restingHR,
    hrv: w.hrv,
    readiness: w.readiness,
    avg_sleeping_hr: w.avgSleepingHR,
    weight: w.weight,
    steps: w.steps,
    soreness: w.soreness,
    fatigue: w.fatigue,
    stress: w.stress,
    mood: w.mood,
    injury: w.injury,
    comments: w.comments,
  });
}

export function compactEvent(e: any) {
  return dropEmpty({
    id: e.id,
    date: String(e.start_date_local ?? "").slice(0, 10),
    category: e.category,
    type: e.type,
    name: e.name,
    distance_km: e.distance ? round(e.distance / 1000, 2) : null,
    description: e.description,
    paired_activity_id: e.paired_activity_id,
  });
}

// ---------- splits ----------

export interface Split {
  km: number;
  distance_m: number;
  moving_time: string;
  elapsed_time: string;
  pace_moving: string | null;
  avg_hr?: number;
}

export interface SplitResult {
  splits: Split[];
  stops: { count: number; total_time: string };
  walking_time: string;
}

function streamData(raw: any, type: string): number[] | null {
  if (Array.isArray(raw)) {
    const s = raw.find((x) => x?.type === type);
    return Array.isArray(s?.data) ? s.data : null;
  }
  if (raw && Array.isArray(raw[type])) return raw[type];
  return null;
}

/**
 * Per-kilometre splits from time and distance streams.
 * "Moving" = covering ground at >= 0.5 m/s. Stops = pauses >= 15 s (including paused recording).
 * "Walking" = 0.5–1.9 m/s (slower than ~8:45/km).
 */
export function computeSplits(raw: any): SplitResult | null {
  const time = streamData(raw, "time");
  const dist = streamData(raw, "distance");
  if (!time || !dist || time.length < 2 || time.length !== dist.length) return null;
  const hr = streamData(raw, "heartrate");

  const splits: Split[] = [];
  let kmStartIdx = 0;
  let kmStartDist = dist[0] ?? 0;
  let kmStartTime = time[0];
  let moving = 0;
  let hrSum = 0;
  let hrN = 0;
  let stopRun = 0;
  let stopCount = 0;
  let stopTotal = 0;
  let walking = 0;

  const closeStop = () => {
    if (stopRun >= 15) {
      stopCount++;
      stopTotal += stopRun;
    }
    stopRun = 0;
  };

  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1];
    const dd = (dist[i] ?? dist[i - 1]) - (dist[i - 1] ?? 0);
    if (dt <= 0) continue;
    const v = dd / dt;
    if (v >= 0.5 && dt <= 30) {
      moving += dt;
      if (v < 1.9) walking += dt;
      closeStop();
    } else {
      stopRun += dt;
    }
    if (hr && hr[i]) {
      hrSum += hr[i];
      hrN++;
    }
    const kmTarget = (splits.length + 1) * 1000;
    if (dist[i] - (dist[0] ?? 0) >= kmTarget) {
      splits.push(makeSplit(splits.length + 1, dist[i] - kmStartDist, moving, time[i] - kmStartTime, hrN ? hrSum / hrN : null));
      kmStartIdx = i;
      kmStartDist = dist[i];
      kmStartTime = time[i];
      moving = 0;
      hrSum = 0;
      hrN = 0;
    }
  }
  closeStop();
  const last = time.length - 1;
  const rest = dist[last] - kmStartDist;
  if (rest >= 100 && last > kmStartIdx) {
    splits.push(makeSplit(splits.length + 1, rest, moving, time[last] - kmStartTime, hrN ? hrSum / hrN : null));
  }
  return {
    splits,
    stops: { count: stopCount, total_time: duration(stopTotal) ?? "0:00" },
    walking_time: duration(walking) ?? "0:00",
  };
}

function makeSplit(km: number, d: number, moving: number, elapsed: number, hr: number | null): Split {
  const s: Split = {
    km,
    distance_m: Math.round(d),
    moving_time: duration(moving) ?? "0:00",
    elapsed_time: duration(elapsed) ?? "0:00",
    pace_moving: d > 0 && moving > 0 ? paceFromSecs(moving / (d / 1000)) : null,
  };
  if (hr) s.avg_hr = Math.round(hr);
  return s;
}

export function compactIntervals(a: any) {
  const list = a?.icu_intervals;
  if (!Array.isArray(list)) return undefined;
  return list.map((x: any) =>
    dropEmpty({
      type: x.type,
      distance_m: x.distance != null ? Math.round(x.distance) : null,
      moving_time: duration(x.moving_time),
      pace: paceFromSpeed(x.average_speed),
      avg_hr: x.average_heartrate,
    }),
  );
}
