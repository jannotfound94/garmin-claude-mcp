import { fastingCard } from "./fasting.js";
import { pushState, pushSupported } from "./push.js";
// Widok "Dziś": dashboard z kart. Post przerywany, wskazówki, kalorie, tydzień biegowy, trening dziś i jutro, seria zapisów,
// spalanie z Garmina, regeneracja, waga i źródła danych.
import { areaChart, ring, weightChart } from "./charts.js";
import { kcalCard, openAddMeal } from "./meals.js";
import { badge, card, chip, errMsg, fmtDay, getSummary, h, icon, iconButton, loading, n0, n1, pace, recoIcon, recoTone, rerender, stat, weatherChips, workoutLine } from "./ui.js";

const go = (hash) => () => (location.hash = hash);

export function header(title, sub, ...right) {
  return h("div", { class: "topbar" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "row" }, ...right));
}
const avatarBtn = () => h("button", { class: "avatar", "aria-label": "Ty: postęp i ustawienia", onclick: go("#/ty") }, "J");

export async function viewToday(root) {
  // Zegar postu przerywanego ładuje się osobno i od razu, bez czekania na resztę danych.
  const fast = fastingCard(root);
  root.append(header("Dziś", "", avatarBtn()), fast, loading("Zbieram dane z Garmina, planu i pogody…"));
  let d;
  try {
    d = await getSummary(true);
  } catch (e) {
    root.replaceChildren(header("Dziś", "", iconButton("refresh", "Odśwież", rerender), avatarBtn()), fast, h("div", { class: "card" }, h("div", {}, `⚠️ ${errMsg(e)}`), h("button", { class: "btn", onclick: rerender }, "Spróbuj ponownie")));
    return;
  }
  const out = [];
  out.push(header(d.greeting, `${d.now.weekdayPl} ${d.now.date.slice(8)}.${d.now.date.slice(5, 7)} · ${d.now.time}`, iconButton("refresh", "Odśwież", async () => { await getSummary(true).catch(() => {}); rerender(); }), avatarBtn()));

  // Zegar postu przerywanego jest pierwszą kartą (zamiast "priorytetu dnia").
  out.push(fast);

  // Baner zachęcający do włączenia powiadomień (znika po włączeniu lub po zamknięciu).
  const banner = h("div", {});
  out.push(banner);
  pushBanner(banner);

  // ----- wskazówki (dawny "priorytet" jest teraz pierwszą wskazówką) -----
  if (d.recommendations.length) {
    out.push(card({ icon: "sparkles", tone: "blue", title: "Wskazówki", range: `${d.recommendations.length}` }, ...d.recommendations.map((r) => h("div", { class: "reco-row" }, badge(recoIcon(r), recoTone(r)), h("div", {}, h("h4", {}, r.title), h("p", {}, r.text))))));
  }

  // ----- kalorie -----
  if (d.food) {
    const kc = kcalCard(d.food, { title: "Kalorie dziś", onclick: go("#/jedzenie") });
    kc.append(h("button", { class: "btn outline-orange block", onclick: () => openAddMeal({ date: d.now.date, onSaved: rerender }) }, icon("plus", 18), "Dodaj posiłek"));
    out.push(kc);
  }

  // ----- tydzień biegowy -----
  const tr = d.training;
  const left = tr.weekPlannedKm != null ? Math.max(0, tr.weekPlannedKm - tr.weekKm) : null;
  const pts = tr.activityDays.map((x) => ({ v: x.km }));
  out.push(
    card(
      { icon: "run", tone: "orange", title: "W tym tygodniu", range: "Pn–Nd", onclick: go("#/plan") },
      h("div", { class: "stats2" },
        stat(n1(tr.weekKm), "km", { label: "Przebiegnięte" }),
        stat(tr.weekPlannedKm != null ? n1(tr.weekPlannedKm) : "–", "km", { label: "Plan tygodnia", delta: left != null ? { text: left === 0 ? "wykonany" : `zostało ${n1(left)}`, tone: left === 0 ? "good" : "" } : null }),
      ),
      h("div", { class: "weekdots" }, tr.week.map((w) => h("div", { class: "wd" }, h("div", { class: `dot ${w.doneKm >= 1 ? "done" : w.planned ? "plan" : ""} ${w.isToday ? "today" : ""}` }, w.doneKm >= 1 ? icon("check", 14) : null), h("span", {}, w.weekday)))),
      areaChart({ points: pts, color: "orange", unit: "km", xLabels: [{ i: 0, text: fmtDay(tr.activityDays[0].date) }, { i: 13, text: "dziś" }], label: "Kilometry z ostatnich 14 dni" }),
      h("div", { class: "small muted" }, `Ostatnie 14 dni: ${n1(tr.last14Km)} km`),
    ),
  );

  // ----- dziś i jutro -----
  const todayBits = [...tr.today.planned.map(workoutLine), ...tr.today.done.map((a) => h("div", { class: "line" }, icon("check", 18), h("div", { class: "grow" }, h("strong", {}, a.name)), h("span", { class: "muted small" }, [a.km ? `${n1(a.km)} km` : null, a.minutes ? `${a.minutes} min` : null, pace(a.paceMinPerKm)].filter(Boolean).join(" · "))))];
  out.push(
    card(
      { icon: "calendar", tone: "orange", title: "Dziś i jutro", range: tr.tomorrow.dayTypeLabel ? `jutro: ${tr.tomorrow.dayTypeLabel}` : "", onclick: go("#/plan") },
      h("div", { class: "wk" }, h("strong", {}, "Dziś"), todayBits.length ? todayBits : h("div", { class: "muted" }, "Nic w planie."), d.weather.today ? weatherChips(d.weather.today) : null),
      h("hr"),
      h("div", { class: "wk" }, h("strong", {}, "Jutro"), tr.tomorrow.planned.length ? tr.tomorrow.planned.map(workoutLine) : h("div", { class: "muted" }, "Wolne od biegania."), d.weather.tomorrow ? weatherChips(d.weather.tomorrow) : null),
    ),
  );

  // ----- seria zapisów -----
  const lg = d.logging;
  out.push(
    card(
      { icon: "flame", tone: "orange", title: "Seria zapisów", range: "min. 2 posiłki dziennie", onclick: go("#/jedzenie") },
      h("div", { class: "streak" }, h("div", { class: "flame" }, icon("flame", 46)), h("div", {}, h("div", { class: "num" }, lg.streak, h("span", { class: "unit" }, ` ${lg.streak === 1 ? "dzień" : "dni"}`)), h("div", { class: "small muted" }, lg.streak ? "z rzędu z zapisanym jedzeniem" : "Zapisz dziś min. 2 posiłki, żeby zacząć serię"))),
      h("div", { class: "weekdots" }, lg.last7.map((x) => h("div", { class: "wd" }, h("div", { class: `dot ${x.logged ? "logged" : ""} ${x.isToday ? "today" : ""}` }, x.logged ? icon("check", 14) : null), h("span", {}, x.weekday)))),
    ),
  );

  // ----- spalanie z Garmina -----
  const g = d.food && d.food.garmin;
  if (g && g.total) {
    const diff = d.food.totals.kcal - g.total;
    out.push(
      card(
        { icon: "watch", tone: "orange", title: "Spalone (Garmin)", range: g.partial ? "dzień trwa" : "cały dzień" },
        h("div", { class: "row between wrap" }, stat(n0(g.total), "kcal"), h("div", { class: "small muted" }, `spoczynkowe ${n0(g.resting)} + aktywne ${n0(g.active)}`)),
        !g.partial && d.food.meals.length ? h("div", { class: "small" }, "Zjedzone minus spalone: ", h("strong", { class: diff <= 0 ? "pos" : "warn" }, `${diff > 0 ? "+" : ""}${n0(diff)} kcal`)) : null,
        h("div", { class: "small muted" }, "Zegarek zawyża spalanie (zwłaszcza aktywne), więc to wartość orientacyjna. Cele liczymy z korektą."),
      ),
    );
  }

  // ----- regeneracja -----
  if (d.recovery) {
    const r = d.recovery;
    const sleepTone = r.sleepH == null ? "blue" : r.sleepH < 5.5 ? "bad" : r.sleepH < 7 ? "warn" : "good";
    const bbTone = r.bbPeak == null ? "blue" : r.bbPeak < 30 ? "bad" : r.bbPeak < 60 ? "warn" : "good";
    out.push(
      card(
        { icon: "moon", tone: "blue", title: "Regeneracja", range: "dziś rano" },
        h("div", { class: "rings three" },
          h("div", { class: "ringbox" }, ring({ value: r.sleepH || 0, max: 8, size: 92, stroke: 9, tone: sleepTone, center: r.sleepH != null ? `${n1(r.sleepH)}h` : "–", label: "Sen" }), h("span", { class: "t" }, "Sen"), r.sleepScore ? h("span", { class: "small muted" }, `${r.sleepScore}/100`) : null),
          h("div", { class: "ringbox" }, ring({ value: r.bbPeak || 0, max: 100, size: 92, stroke: 9, tone: bbTone, center: r.bbPeak != null ? String(r.bbPeak) : "–", label: "Bateria" }), h("span", { class: "t" }, "Bateria"), r.bbNow != null ? h("span", { class: "small muted" }, `teraz ${r.bbNow}`) : null),
          h("div", { class: "ringbox" }, ring({ value: r.hrv || 0, max: Math.max(100, (r.hrv || 0) * 1.3), size: 92, stroke: 9, tone: "blue", center: r.hrv != null ? String(r.hrv) : "–", label: "HRV" }), h("span", { class: "t" }, "HRV"), r.hrvStatus ? h("span", { class: "small muted" }, String(r.hrvStatus).toLowerCase()) : null),
        ),
        h("div", { class: "chips" }, r.restingHr != null ? chip(`tętno spoczynkowe ${r.restingHr}`, "", "pulse") : null, r.steps != null ? chip(`${n0(r.steps)} kroków`, "", "run") : null),
      ),
    );
  }

  // ----- waga -----
  const w = d.weight;
  out.push(
    card(
      { icon: "scale", tone: "blue", title: "Waga i cel", range: w.goalDate ? `do ${w.goalDate.slice(8)}.${w.goalDate.slice(5, 7)}.${w.goalDate.slice(0, 4)}` : "", onclick: go("#/ty/postep") },
      w.last
        ? [
            h("div", { class: "row between wrap" }, stat(n1(w.last.kg), "kg", { delta: w.planKgToday != null && w.aheadKg != null ? { text: Math.abs(w.aheadKg) < 0.2 ? "wg planu" : w.aheadKg > 0 ? `${n1(w.aheadKg)} kg do przodu` : `${n1(-w.aheadKg)} kg za planem`, tone: w.aheadKg >= -0.2 ? "good" : "warn" } : null }), h("div", { class: "small muted" }, w.goalKg ? `cel ${n1(w.goalKg)} kg · zostało ${n1(w.toGoKg)} kg` : "")),
            weightChart({ entries: w.series, plan: w.plan, goalKg: w.goalKg, height: 150 }),
            w.requiredKgPerWeek ? h("div", { class: "small muted" }, `Potrzebne tempo do celu: ok. ${n1(w.requiredKgPerWeek)} kg tygodniowo.`) : null,
          ]
        : h("div", { class: "muted" }, "Brak ważeń. Dodaj pierwsze w zakładce Ty → Postęp."),
    ),
  );

  // ----- źródła danych -----
  const bad = (re) => d.errors.some((e) => re.test(e));
  const src = (name, detail, ok) => h("div", { class: `src ${ok ? "" : "bad"}` }, icon(ok ? "check" : "close", 18), h("div", {}, h("strong", {}, name), h("div", { class: "small muted" }, detail)));
  out.push(
    card(
      { icon: "info", tone: "blue", title: "Źródła danych" },
      h("div", { class: "sources" },
        src("Garmin Connect", "sen, regeneracja, spalanie", !bad(/^Garmin:/) && Boolean(d.recovery || (d.food && d.food.garmin))),
        src("intervals.icu", "plan i aktywności", !bad(/^(plan|aktywności):/)),
        src("Open-Meteo", "pogoda na dni biegowe", !bad(/^pogoda:/) && Boolean(d.weather.today || d.weather.tomorrow)),
        src("Gemini", "rozpoznawanie posiłków", true),
      ),
      d.errors.length ? h("div", { class: "small muted" }, d.errors.join(" · ")) : null,
    ),
  );

  root.replaceChildren(...out);
}

const BANNER_KEY = "garda.pushBannerOff";
async function pushBanner(host) {
  try {
    if (localStorage.getItem(BANNER_KEY) || !pushSupported() || (await pushState()) !== "off") return;
  } catch {
    return;
  }
  const close = () => {
    try { localStorage.setItem(BANNER_KEY, "1"); } catch { /* nic */ }
    host.replaceChildren();
  };
  host.replaceChildren(card({ icon: "bell", tone: "blue", title: "Powiadomienia" }, h("div", { class: "small muted" }, "Włącz powiadomienia, żeby wiadomości trenera i przypomnienia o posiłkach przychodziły tu, a nie w Telegramie."), h("div", { class: "btns" }, h("button", { class: "btn", onclick: () => (location.hash = "#/ty/ustawienia") }, icon("bell", 17), "Włącz"), h("button", { class: "btn ghost", onclick: close }, "Później"))));
}
