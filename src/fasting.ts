/**
 * Post przerywany (np. 16:8): na przemian "post" (nie jesz) i "okno" (jesz). Janek naciska "Skończyłem jeść", żeby
 * zacząć post, albo "Zaczynam jeść", żeby go zakończyć wcześniej. Gdy czas fazy minie, kolejna zaczyna się sama
 * (po poście okno, po oknie post) i przychodzi powiadomienie. Czysta logika bez wejścia/wyjścia, żeby dało się ją testować.
 */
export type Phase = "fast" | "window";
export interface FastState {
  phase: Phase;
  start: number; // ms
  end: number; // planowany koniec fazy, ms
  goalHours: number; // cel postu obowiązujący przy starcie fazy
}
export interface FastRecord {
  start: number;
  end: number;
  goalHours: number;
  reached: boolean;
  by: "auto" | "manual";
}
export interface Transition {
  from: Phase; // faza, która się skończyła
  at: number; // ms
}

export const HOUR = 3600_000;
export const MIN_FAST_H = 10;
export const MAX_FAST_H = 22;
export const DEFAULT_FAST_H = 16;
const MAX_CATCHUP = 8; // tyle przejść nadrabiamy po długiej przerwie, potem zaczynamy od nowa
export const MIN_FAST_RECORD_MS = 10 * 60_000; // krótsze "posty" to przypadkowe kliknięcia

export const clampHours = (h: unknown) => {
  const n = Math.round(Number(h));
  return Number.isFinite(n) ? Math.min(MAX_FAST_H, Math.max(MIN_FAST_H, n)) : DEFAULT_FAST_H;
};
export const phaseMs = (phase: Phase, fastHours: number) => (phase === "fast" ? fastHours : 24 - fastHours) * HOUR;

export function startPhase(phase: Phase, at: number, fastHours: number): FastState {
  return { phase, start: at, end: at + phaseMs(phase, fastHours), goalHours: fastHours };
}

/** Doprowadza stan do chwili `now`: każda zakończona faza uruchamia następną od momentu jej planowego końca. */
export function advance(st: FastState, now: number, fastHours: number): { state: FastState; transitions: Transition[]; finished: FastRecord[]; reset: boolean } {
  let s = st;
  const transitions: Transition[] = [];
  const finished: FastRecord[] = [];
  for (let i = 0; i < MAX_CATCHUP && now >= s.end; i++) {
    transitions.push({ from: s.phase, at: s.end });
    if (s.phase === "fast") finished.push({ start: s.start, end: s.end, goalHours: s.goalHours, reached: true, by: "auto" });
    s = startPhase(s.phase === "fast" ? "window" : "fast", s.end, fastHours);
  }
  if (now >= s.end) return { state: startPhase("window", now, fastHours), transitions, finished, reset: true };
  return { state: s, transitions, finished, reset: false };
}

/**
 * "Skończyłem jeść": zaczyna post (od `at`, domyślnie od teraz). Gdy post już trwa, nic nie zmienia, chyba że
 * `restart` ("jadłem dłużej, niż wynikało z okna"): wtedy post liczy się od nowa, od `at`.
 */
export function finishEating(st: FastState | null, now: number, fastHours: number, at = now, restart = false): { state: FastState; changed: boolean } {
  if (st?.phase === "fast" && !restart) return { state: st, changed: false };
  return { state: startPhase("fast", Math.min(at, now), fastHours), changed: true };
}

/** "Zaczynam jeść": kończy post wcześniej (zapisuje go w historii) i otwiera okno. Gdy okno już trwa, nic nie zmienia. */
export function startEating(st: FastState | null, now: number, fastHours: number): { state: FastState; record: FastRecord | null; changed: boolean } {
  if (st?.phase === "window") return { state: st, record: null, changed: false };
  let record: FastRecord | null = null;
  if (st && now - st.start >= MIN_FAST_RECORD_MS) {
    record = { start: st.start, end: now, goalHours: st.goalHours, reached: now - st.start >= st.goalHours * HOUR - 60_000, by: "manual" };
  }
  return { state: startPhase("window", now, fastHours), record, changed: true };
}

export const recordHours = (r: FastRecord) => Math.round(((r.end - r.start) / HOUR) * 10) / 10;

export interface FastStats {
  lastHours: number | null;
  lastReached: boolean | null;
  avg7Hours: number | null;
  streak: number; // ile ostatnich postów z rzędu osiągnęło cel
  count: number;
  recent: { start: number; end: number; hours: number; goalHours: number; reached: boolean }[]; // najnowsze na końcu, do 7
}

export function fastStats(records: FastRecord[]): FastStats {
  const sorted = [...records].sort((a, b) => a.end - b.end);
  const last7 = sorted.slice(-7);
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0 && sorted[i].reached; i--) streak++;
  const last = sorted[sorted.length - 1];
  return {
    lastHours: last ? recordHours(last) : null,
    lastReached: last ? last.reached : null,
    avg7Hours: last7.length ? Math.round((last7.reduce((s, r) => s + (r.end - r.start) / HOUR, 0) / last7.length) * 10) / 10 : null,
    streak,
    count: sorted.length,
    recent: last7.map((r) => ({ start: r.start, end: r.end, hours: recordHours(r), goalHours: r.goalHours, reached: r.reached })),
  };
}

/** Teksty powiadomień o przejściu między fazami (hm to "GG:MM" czasu polskiego końca nowej fazy). */
export function transitionMessage(t: Transition, next: FastState, endHm: string): { title: string; body: string } {
  if (t.from === "fast") {
    return {
      title: "Post przerywany · okno otwarte",
      body: `Post zakończony: ${next.goalHours} h za Tobą 💪 Możesz jeść. Okno trwa ${Math.round((next.end - next.start) / HOUR)} h, do ${endHm}.`,
    };
  }
  return {
    title: "Post przerywany · zaczyna się post",
    body: `Okno jedzenia się zamknęło. Post trwa do ${endHm} (${next.goalHours} h). Jeśli jeszcze jesz, otwórz aplikację i wybierz „Zaczynam jeść”.`,
  };
}
