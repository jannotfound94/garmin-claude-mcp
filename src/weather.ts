/**
 * Weather for running decisions, from Open-Meteo (https://open-meteo.com): free API, no key,
 * non-commercial use (< 10,000 calls/day), data under CC BY 4.0. Hourly forecast in Europe/Warsaw time.
 *
 * Each hour is judged as a possible run start ("dobra" / "znosna" / "zla"); a time window (morning,
 * midday, evening) gets the verdict of its best start hour, so the coach can say "leave at 8:00".
 * The thresholds are rules of thumb for an amateur runner, not meteorology; they live in one place
 * (assessHour) so they are easy to tune.
 */

import { warsaw } from "./time";

const API = "https://api.open-meteo.com/v1/forecast";

export type Verdict = "dobra" | "znosna" | "zla";
const RANK: Record<Verdict, number> = { dobra: 0, znosna: 1, zla: 2 };

export interface Hour {
  time: string; // "YYYY-MM-DDTHH:MM" local
  temp: number;
  feels: number;
  precip: number; // mm in that hour
  pop: number | null; // precipitation probability, %
  code: number; // WMO weather code
  wind: number; // km/h
  gust: number; // km/h
  isDay: boolean;
}

export const WINDOWS: Record<string, number[]> = {
  poranek: [6, 7, 8], // start hours 6:00-8:00
  poludnie: [11, 12, 13],
  wieczor: [16, 17, 18], // start before 19:00; the evening run must end by ~19:30
};

const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const FREEZING_RAIN = new Set([56, 57, 66, 67]);
const THUNDER = new Set([95, 96, 99]);

export function assessHour(h: Hour): { verdict: Verdict; reasons: string[] } {
  const bad: string[] = [];
  const meh: string[] = [];

  if (THUNDER.has(h.code)) bad.push("burza");
  if (FREEZING_RAIN.has(h.code)) bad.push("marznący deszcz, gołoledź");

  if (h.precip >= 1.5) bad.push("ulewny deszcz");
  else if (h.precip >= 0.3) meh.push(SNOW.has(h.code) ? "śnieg" : "deszcz");
  else if ((h.pop ?? 0) >= 70 && h.precip >= 0.1) meh.push("możliwy deszcz");
  else if (SNOW.has(h.code) && h.precip > 0) meh.push("śnieg");

  if (h.gust >= 55) bad.push("bardzo silny wiatr");
  else if (h.gust >= 40 || h.wind >= 30) meh.push("silny wiatr");

  if (h.feels <= -10) bad.push("mróz");
  else if (h.feels <= -3) meh.push("zimno");
  if (h.feels >= 30) bad.push("upał");
  else if (h.feels >= 25) meh.push("ciepło");

  if (h.temp <= 1 && h.precip > 0 && !FREEZING_RAIN.has(h.code)) meh.push("ryzyko śliskiej nawierzchni");
  if (h.code === 45 || h.code === 48) meh.push("mgła");

  if (bad.length) return { verdict: "zla", reasons: [...bad, ...meh] };
  if (meh.length) return { verdict: "znosna", reasons: meh };
  return { verdict: "dobra", reasons: [] };
}

const hhmm = (t: string) => t.slice(11, 16);
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface WindowForecast {
  start: string; // best start time in the window
  ocena: Verdict;
  powody?: string[];
  temp_c: number;
  odczuwalna_c: number;
  opady_mm: number;
  prawdop_opadow_proc?: number;
  wiatr_kmh: number;
  porywy_kmh: number;
  ciemno?: boolean;
}

function bestOf(hours: Hour[]): WindowForecast | null {
  if (!hours.length) return null;
  const scored = hours.map((h) => ({ h, a: assessHour(h) }));
  // Best verdict first, then less precipitation, then less wind.
  scored.sort((x, y) => RANK[x.a.verdict] - RANK[y.a.verdict] || x.h.precip - y.h.precip || x.h.gust - y.h.gust);
  const { h, a } = scored[0];
  return {
    start: hhmm(h.time),
    ocena: a.verdict,
    ...(a.reasons.length ? { powody: a.reasons } : {}),
    temp_c: Math.round(h.temp),
    odczuwalna_c: Math.round(h.feels),
    opady_mm: r1(h.precip),
    ...(h.pop != null ? { prawdop_opadow_proc: Math.round(h.pop) } : {}),
    wiatr_kmh: Math.round(h.wind),
    porywy_kmh: Math.round(h.gust),
    ...(h.isDay ? {} : { ciemno: true }),
  };
}

export interface DayForecast {
  data: string;
  dzien: string;
  wschod: string;
  zachod: string;
  temp_min_c: number;
  temp_max_c: number;
  opady_dzien_mm: number;
  ocena_dnia: Verdict; // the better of morning and evening: the run can happen in either
  okna: Record<string, WindowForecast>;
}

/** Parses the Open-Meteo response into hourly records. */
export function parseHours(json: any): Hour[] {
  const h = json?.hourly;
  if (!h?.time) throw new Error("Open-Meteo: brak danych godzinowych");
  return (h.time as string[]).map((time, i) => ({
    time,
    temp: Number(h.temperature_2m?.[i] ?? 0),
    feels: Number(h.apparent_temperature?.[i] ?? h.temperature_2m?.[i] ?? 0),
    precip: Number(h.precipitation?.[i] ?? 0),
    pop: h.precipitation_probability?.[i] == null ? null : Number(h.precipitation_probability[i]),
    code: Number(h.weather_code?.[i] ?? 0),
    wind: Number(h.wind_speed_10m?.[i] ?? 0),
    gust: Number(h.wind_gusts_10m?.[i] ?? 0),
    isDay: Number(h.is_day?.[i] ?? 1) === 1,
  }));
}

export function summarize(json: any, windows: string[] = Object.keys(WINDOWS)): DayForecast[] {
  const hours = parseHours(json);
  const daily = json?.daily ?? {};
  const days: DayForecast[] = [];
  for (let d = 0; d < (daily.time?.length ?? 0); d++) {
    const date: string = daily.time[d];
    const dayHours = hours.filter((h) => h.time.startsWith(date));
    if (!dayHours.length) continue;
    const okna: Record<string, WindowForecast> = {};
    for (const name of windows) {
      const w = bestOf(dayHours.filter((h) => WINDOWS[name].includes(Number(h.time.slice(11, 13)))));
      if (w) okna[name] = w;
    }
    const runWindows = [okna.poranek, okna.wieczor].filter(Boolean) as WindowForecast[];
    const ocena_dnia = runWindows.length
      ? runWindows.reduce((a, b) => (RANK[a.ocena] <= RANK[b.ocena] ? a : b)).ocena
      : "dobra";
    days.push({
      data: date,
      dzien: warsaw(new Date(`${date}T12:00:00Z`)).weekdayPl,
      wschod: String(daily.sunrise?.[d] ?? "").slice(11, 16),
      zachod: String(daily.sunset?.[d] ?? "").slice(11, 16),
      temp_min_c: Math.round(Math.min(...dayHours.map((h) => h.temp))),
      temp_max_c: Math.round(Math.max(...dayHours.map((h) => h.temp))),
      opady_dzien_mm: r1(dayHours.reduce((s, h) => s + h.precip, 0)),
      ocena_dnia,
      okna,
    });
  }
  return days;
}

export async function fetchForecast(lat: number, lon: number, days = 4, windows?: string[]): Promise<DayForecast[]> {
  const q = new URLSearchParams({
    latitude: lat.toFixed(2), // ~1 km is plenty for a 2 km weather grid, and reveals less
    longitude: lon.toFixed(2),
    hourly: "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,is_day",
    daily: "sunrise,sunset",
    timezone: "Europe/Warsaw",
    forecast_days: String(Math.min(Math.max(days, 1), 7)),
    wind_speed_unit: "kmh",
  });
  // Cached at the edge for 15 minutes: the coach is woken several times a day.
  const res = await fetch(`${API}?${q}`, { cf: { cacheTtl: 900, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return summarize(await res.json(), windows);
}
