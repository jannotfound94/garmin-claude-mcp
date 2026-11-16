import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR, advance, clampHours, fastStats, finishEating, phaseMs, startEating, startPhase, transitionMessage } from "../src/fasting";

const T0 = Date.parse("2026-12-01T19:00:00Z");

test("fazy: post 16 h, okno 8 h; długość postu ograniczona do 10-22 h", () => {
  assert.equal(phaseMs("fast", 16), 16 * HOUR);
  assert.equal(phaseMs("window", 16), 8 * HOUR);
  assert.equal(phaseMs("window", 18), 6 * HOUR);
  assert.equal(clampHours(3), 10);
  assert.equal(clampHours(40), 22);
  assert.equal(clampHours("abc"), 16);
  assert.equal(clampHours(16.4), 16);
});

test("po końcu postu okno startuje samo od planowego końca, po końcu okna samo post", () => {
  const fast = startPhase("fast", T0, 16);
  // przed końcem: bez zmian
  const none = advance(fast, T0 + 15 * HOUR, 16);
  assert.equal(none.state, fast);
  assert.equal(none.transitions.length, 0);
  // 20 minut po końcu postu
  const a = advance(fast, T0 + 16 * HOUR + 20 * 60_000, 16);
  assert.equal(a.state.phase, "window");
  assert.equal(a.state.start, T0 + 16 * HOUR, "okno liczy się od planowego końca postu, nie od chwili sprawdzenia");
  assert.equal(a.state.end, T0 + 24 * HOUR);
  assert.deepEqual(a.transitions, [{ from: "fast", at: T0 + 16 * HOUR }]);
  assert.equal(a.finished.length, 1);
  assert.equal(a.finished[0].reached, true);
  assert.equal(a.finished[0].by, "auto");
  // po końcu okna znów post
  const b = advance(a.state, T0 + 24 * HOUR + 5 * 60_000, 16);
  assert.equal(b.state.phase, "fast");
  assert.equal(b.state.start, T0 + 24 * HOUR);
  assert.equal(b.finished.length, 0, "okno nie trafia do historii postów");
});

test("po długiej nieobecności nadrabia przejścia (do kilku dni), a potem zaczyna od nowa", () => {
  const fast = startPhase("fast", T0, 16);
  const two = advance(fast, T0 + 49 * HOUR, 16); // dwie pełne doby i godzina
  assert.equal(two.transitions.length, 4);
  assert.equal(two.finished.length, 2);
  assert.equal(two.state.phase, "fast");
  const far = advance(fast, T0 + 30 * 24 * HOUR, 16);
  assert.equal(far.reset, true);
  assert.equal(far.state.phase, "window");
  assert.equal(far.state.start, T0 + 30 * 24 * HOUR);
});

test("Skończyłem jeść: zaczyna post (też wstecz), w trakcie postu nic nie zmienia, restart liczy od nowa", () => {
  const now = T0;
  const w = startPhase("window", now - 3 * HOUR, 16);
  const a = finishEating(w, now, 16);
  assert.equal(a.changed, true);
  assert.equal(a.state.phase, "fast");
  assert.equal(a.state.start, now);
  const back = finishEating(w, now, 16, now - 2 * HOUR);
  assert.equal(back.state.start, now - 2 * HOUR);
  assert.equal(finishEating(null, now, 16).state.phase, "fast");
  // godzina z przyszłości jest ucinana do teraz
  assert.equal(finishEating(w, now, 16, now + HOUR).state.start, now);
  const running = startPhase("fast", now - 2 * HOUR, 16);
  assert.equal(finishEating(running, now, 16).changed, false);
  const re = finishEating(running, now, 16, now - 30 * 60_000, true);
  assert.equal(re.changed, true);
  assert.equal(re.state.start, now - 30 * 60_000);
});

test("Zaczynam jeść: kończy post wcześniej, zapisuje go jako przerwany, pomija przypadkowe kliknięcia", () => {
  const fast = startPhase("fast", T0 - 9 * HOUR, 16);
  const r = startEating(fast, T0, 16);
  assert.equal(r.state.phase, "window");
  assert.equal(r.state.start, T0);
  assert.equal(r.state.end, T0 + 8 * HOUR);
  assert.equal(r.record?.reached, false);
  assert.equal(r.record?.by, "manual");
  assert.equal(Math.round((r.record!.end - r.record!.start) / HOUR), 9);
  // tuż przed celem (minuta różnicy) liczy się jako osiągnięty
  const almost = startEating(startPhase("fast", T0 - 16 * HOUR + 30_000, 16), T0, 16);
  assert.equal(almost.record?.reached, true);
  // przypadkowe kliknięcie zaraz po starcie: bez zapisu
  assert.equal(startEating(startPhase("fast", T0 - 2 * 60_000, 16), T0, 16).record, null);
  // w oknie nic się nie zmienia
  const win = startPhase("window", T0 - HOUR, 16);
  assert.equal(startEating(win, T0, 16).changed, false);
});

test("statystyki: seria osiągniętych, średnia z 7, ostatni post", () => {
  const rec = (h: number, reached: boolean, i: number) => ({ start: i * 100 * HOUR, end: i * 100 * HOUR + h * HOUR, goalHours: 16, reached, by: "auto" as const });
  const s = fastStats([rec(16, true, 1), rec(12, false, 2), rec(16, true, 3), rec(17, true, 4)]);
  assert.equal(s.streak, 2);
  assert.equal(s.lastHours, 17);
  assert.equal(s.lastReached, true);
  assert.equal(s.avg7Hours, 15.3);
  assert.equal(s.count, 4);
  assert.equal(fastStats([]).lastHours, null);
  assert.equal(fastStats([rec(10, false, 1)]).streak, 0);
});

test("teksty powiadomień", () => {
  const win = startPhase("window", T0 + 16 * HOUR, 16);
  const m1 = transitionMessage({ from: "fast", at: win.start }, win, "04:00");
  assert.match(m1.body, /Post zakończony/);
  assert.match(m1.body, /16 h/);
  assert.match(m1.body, /8 h/);
  const fast = startPhase("fast", T0 + 24 * HOUR, 16);
  const m2 = transitionMessage({ from: "window", at: fast.start }, fast, "12:00");
  assert.match(m2.body, /Okno jedzenia się zamknęło/);
  assert.match(m2.body, /12:00/);
});
