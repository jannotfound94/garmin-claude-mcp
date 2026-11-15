export const TZ = "Europe/Warsaw";

const WEEKDAYS_PL: Record<string, string> = {
  Mon: "poniedziałek",
  Tue: "wtorek",
  Wed: "środa",
  Thu: "czwartek",
  Fri: "piątek",
  Sat: "sobota",
  Sun: "niedziela",
};

export interface LocalTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  hour: number;
  minute: number;
  weekday: string; // Mon..Sun
  weekdayPl: string;
}

export function warsaw(d: Date = new Date()): LocalTime {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: p.weekday,
    weekdayPl: WEEKDAYS_PL[p.weekday] ?? p.weekday,
  };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

/** "YYYY-MM-DD HH:MM" in Warsaw time -> UTC Date. */
export function warsawToUtc(local: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) throw new Error(`Zły format czasu "${local}", oczekiwano "YYYY-MM-DD HH:MM"`);
  const asUtc = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  // Offset of Warsaw at that moment (iterate twice to settle around DST changes).
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const w = warsaw(new Date(guess));
    const wAsUtc = Date.parse(`${w.date}T${w.time}:00Z`);
    guess = guess - (wAsUtc - asUtc);
  }
  return new Date(guess);
}

export function fmtWarsaw(iso: string): string {
  const w = warsaw(new Date(iso));
  return `${w.date} ${w.time}`;
}
