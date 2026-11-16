// Widok "Ty": profil z zakładkami Postęp, Aktywności, Trener i Ustawienia.
import { api, auth } from "./api.js";
import { disablePush, enablePush, pushState, pushSupported, sendTest, shareLocation } from "./push.js";
import { ring, weekChart, weightChart } from "./charts.js";
import { header } from "./view-today.js";
import { WD, aheadLabel, badge, card, chip, dateObj, empty, errMsg, getSummary, h, icon, iconButton, loading, n0, n1, pace, rerender, stat, todayLocal, toast } from "./ui.js";

const SUBS = [
  { id: "postep", label: "Postęp", icon: "chart" },
  { id: "aktywnosci", label: "Aktywności", icon: "run" },
  { id: "trener", label: "Trener", icon: "chat" },
  { id: "ustawienia", label: "Ustawienia", icon: "settings" },
];

const daysTo = (iso) => Math.max(0, Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${todayLocal()}T12:00:00Z`)) / 86400000));

export async function viewYou(root, sub = "postep") {
  const tab = SUBS.find((s) => s.id === sub) || SUBS[0];
  const stats = h("div", { class: "rings three" });
  const profile = h(
    "div",
    { class: "profile" },
    h("div", { class: "who" }, h("div", { class: "avatar" }, "J"), h("div", {}, h("h1", {}, "Janek"), h("div", { class: "sub" }, `Maraton za ${daysTo("2027-04-25")} dni · cel poniżej 4:30`))),
    ...(tab.id === "trener" ? [] : [stats]),
    ...(tab.id === "trener" ? [] : [h("div", { class: "btns" }, h("button", { class: "btn ghost", onclick: () => (location.hash = "#/ty/trener") }, icon("chat", 17), "Do trenera"), h("button", { class: "btn ghost", onclick: () => (location.hash = "#/ty/ustawienia") }, icon("settings", 17), "Ustawienia"))]),
  );
  const tabs = h("nav", { class: "tabs", "aria-label": "Sekcje profilu" }, SUBS.map((s) => {
    const a = h("a", { href: `#/ty/${s.id}`, class: s.id === tab.id ? "on" : "", "aria-current": s.id === tab.id ? "page" : null });
    a.append(icon(s.icon, 22), h("span", {}, s.label));
    return a;
  }));
  const body = h("div", { class: "wk", style: { gap: "12px" } });
  root.replaceChildren(h("div", { class: "topbar" }, h("span", {}), iconButton("refresh", "Odśwież", rerender)), profile, tabs, body);

  // statystyki profilu: nie blokują zakładki
  getSummary().then((d) => {
    const cell = (value, label) => h("div", { class: "ringbox" }, h("div", { class: "num", style: { fontSize: "26px" } }, value), h("span", { class: "small muted" }, label));
    stats.replaceChildren(cell(d.weight.last ? `${n1(d.weight.last.kg)}` : "–", "waga (kg)"), cell(d.weight.goalKg ? `${n1(d.weight.goalKg)}` : "–", "cel (kg)"), cell(String(d.logging.streak), "seria zapisów"));
  }).catch(() => {});

  if (tab.id === "postep") await progress(body);
  else if (tab.id === "aktywnosci") await activities(body);
  else if (tab.id === "trener") await coachChat(body, root);
  else settings(body);
}

// ---------------- Postęp ----------------

async function progress(body) {
  body.append(loading());
  let wt, wk, sm;
  try {
    [wt, wk, sm] = await Promise.all([api("/weight"), api("/week"), getSummary()]);
  } catch (e) {
    body.replaceChildren(h("div", { class: "card" }, `⚠️ ${errMsg(e)}`, h("button", { class: "btn", onclick: rerender }, "Spróbuj ponownie")));
    return;
  }
  const p = wt.progress;
  const tr = sm.training;
  const start = wt.plan ? wt.plan.startKg : null;
  const donePct = start && p.last && wt.goalKg && start > wt.goalKg ? Math.max(0, Math.min(100, Math.round(((start - p.last.kg) / (start - wt.goalKg)) * 100))) : 0;
  const logged = sm.logging.last7.filter((x) => x.logged).length;

  // waga
  const kg = h("input", { type: "number", step: "0.1", inputmode: "decimal", placeholder: "np. 106,5", "aria-label": "Waga w kg" });
  const addW = h("button", { class: "btn" }, "Zapisz");
  addW.addEventListener("click", async () => {
    if (!kg.value) return toast("Wpisz wagę.", "error");
    addW.disabled = true;
    try {
      await api("/weight", { method: "POST", body: { kg: kg.value } });
      toast("Zapisano wagę ⚖️");
      rerender();
    } catch (e) {
      toast(errMsg(e), "error");
      addW.disabled = false;
    }
  });

  body.replaceChildren(
    card(
      { icon: "target", tone: "orange", title: "Cele", range: "ten tydzień i droga do wagi" },
      h("div", { class: "rings three" },
        h("div", { class: "ringbox" }, ring({ value: tr.weekKm, max: tr.weekPlannedKm || Math.max(10, tr.weekKm), size: 96, stroke: 10, tone: "orange", center: n1(tr.weekKm), sub: tr.weekPlannedKm ? `z ${n1(tr.weekPlannedKm)} km` : "km", label: "Kilometry w tym tygodniu" }), h("span", { class: "t" }, "Biegi")),
        h("div", { class: "ringbox" }, ring({ value: logged, max: 7, size: 96, stroke: 10, tone: "blue", center: `${logged}/7`, sub: "dni", label: "Dni z zapisanym jedzeniem" }), h("span", { class: "t" }, "Jedzenie")),
        h("div", { class: "ringbox" }, ring({ value: donePct, max: 100, size: 96, stroke: 10, tone: "good", center: `${donePct}%`, sub: "do celu", label: "Postęp do wagi docelowej" }), h("span", { class: "t" }, "Waga")),
      ),
    ),
    card(
      { icon: "scale", tone: "blue", title: "Waga", range: wt.goalDate ? `cel ${n1(wt.goalKg)} kg do ${wt.goalDate.slice(8)}.${wt.goalDate.slice(5, 7)}.${wt.goalDate.slice(0, 4)}` : "" },
      weightChart({ entries: wt.entries, plan: wt.plan, goalKg: wt.goalKg }),
      h("div", { class: "chips" }, chip("ważenia", "blue"), chip("plan do celu", "orange"), chip("cel", "good")),
      h("div", { class: "stats2" }, stat(p.last ? n1(p.last.kg) : "–", "kg", { label: "Ostatnia" }), stat(p.toGoKg != null ? n1(p.toGoKg) : "–", "kg", { label: "Do celu" })),
      p.planKgToday != null ? h("div", { class: "small" }, `Wg planu dziś ok. ${n1(p.planKgToday)} kg: `, aheadLabel(p.aheadKg), p.requiredKgPerWeek ? `. Potrzebne tempo: ok. ${n1(p.requiredKgPerWeek)} kg tygodniowo.` : ".") : null,
      p.trendKgPerWeek != null ? h("div", { class: "small muted" }, `Trend z ostatnich tygodni: ${n1(p.trendKgPerWeek)} kg tygodniowo.`) : null,
      h("div", { class: "small muted" }, "Waga skacze o 1–2 kg z dnia na dzień. Najlepiej ważyć się raz w tygodniu, rano, w podobnych warunkach."),
      h("div", { class: "row" }, h("div", { class: "grow" }, kg), addW),
    ),
    card(
      { icon: "meal", tone: "blue", title: "Ostatnie 7 dni", range: "jedzenie i spalanie" },
      weekChart({ days: wk.days.map((x) => ({ label: WD[dateObj(x.date).getUTCDay()], kcal: x.kcal, targetKcal: x.targetKcal, burnedKcal: x.burnedKcal, partial: x.partial })) }),
      h("div", { class: "chips" }, chip("zjedzone", "blue"), chip("cel", "good"), chip("spalone (Garmin)", "orange")),
      wk.avgKcal != null ? h("div", { class: "small" }, `Średnio z zapisanych dni (${wk.loggedDays}): ${n0(wk.avgKcal)} kcal, ${n0(wk.avgProtein)} g białka.`) : h("div", { class: "small muted" }, "Za mało zapisanych dni na średnią (dzień liczy się od 2 posiłków i 1000 kcal)."),
      h("div", { class: "small muted" }, "Spalanie z Garmina jest zawyżone, więc bilans traktuj orientacyjnie; najlepszą miarą jest trend wagi."),
    ),
  );
}

// ---------------- Aktywności ----------------

async function activities(body) {
  body.append(loading("Pobieram aktywności…"));
  let d;
  try {
    d = await api("/plan");
  } catch (e) {
    body.replaceChildren(h("div", { class: "card" }, `⚠️ ${errMsg(e)}`));
    return;
  }
  if (!d.recent.length) return body.replaceChildren(empty("Brak aktywności z ostatnich 14 dni."));
  body.replaceChildren(
    h("div", { class: "stats2" }, card({ icon: "run", tone: "orange", title: "7 dni" }, stat(n1(d.runKmLast7), "km")), card({ icon: "run", tone: "orange", title: "14 dni" }, stat(n1(d.runKmLast14), "km"))),
    ...d.recent.map((a) =>
      h("div", { class: "card" }, h("div", { class: "row" }, badge("run", "orange"), h("div", { class: "grow" }, h("strong", {}, a.name), h("div", { class: "small muted" }, `${WD[dateObj(a.date).getUTCDay()]} ${a.date.slice(8)}.${a.date.slice(5, 7)} · ${a.time}`)), stat(a.km != null ? n1(a.km) : "–", "km")), h("div", { class: "chips" }, a.minutes ? chip(`${a.minutes} min`, "", "clock") : null, a.paceMinPerKm ? chip(pace(a.paceMinPerKm), "orange", "run") : null, a.avgHr ? chip(`${a.avgHr} bpm`, "", "pulse") : null)),
    ),
  );
}

// ---------------- Trener ----------------

async function coachChat(body, root) {
  const list = h("div", { class: "chat" });
  const status = h("div", { class: "sub", style: { textAlign: "center" } });
  const ta = h("textarea", { placeholder: "Napisz do trenera…", rows: 1, "aria-label": "Wiadomość do trenera" });
  const send = h("button", { class: "btn", "aria-label": "Wyślij" }, icon("send", 18));
  const composer = h("div", { class: "composer" }, h("div", { class: "inner" }, ta, send));
  root.classList.add("has-composer");
  document.body.append(composer);
  let timer = null;
  let stopped = false;
  root._cleanup = () => {
    stopped = true;
    clearTimeout(timer);
    composer.remove();
    root.classList.remove("has-composer");
  };
  body.append(h("div", { class: "sub" }, "Ta sama rozmowa co na Telegramie. Trener (Claude) zna Twój plan, dane z Garmina i jedzenie."), list, status);
  const hm = (iso) => new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  async function refresh(scroll) {
    try {
      const r = await api("/coach");
      list.replaceChildren(...(r.messages.length ? r.messages.map((m) => h("div", { class: `bubble ${m.from === "jan" ? "me" : "coach"}` }, m.text, h("time", {}, hm(m.at)))) : [empty("Napisz pierwszą wiadomość.")]));
      status.textContent = r.awaiting ? "Trener pracuje nad odpowiedzią, zwykle do kilku minut…" : "";
      if (scroll) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      clearTimeout(timer);
      if (r.awaiting && !stopped) timer = setTimeout(() => refresh(true), 8000);
    } catch (e) {
      status.textContent = errMsg(e);
    }
  }
  send.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api("/coach", { method: "POST", body: { text } });
      ta.value = "";
      await refresh(true);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    send.disabled = false;
  });
  await refresh(false);
}

// ---------------- Ustawienia ----------------

function settings(body) {
  body.append(loading());
  api("/settings").then(({ settings: s }) => {
    const f = {
      deficitKcal: h("input", { type: "number", inputmode: "numeric", value: s.deficitKcal, min: 0, max: 800 }),
      garminFactor: h("input", { type: "number", step: "0.01", inputmode: "decimal", value: s.garminFactor }),
      goalWeightKg: h("input", { type: "number", step: "0.1", inputmode: "decimal", value: s.goalWeightKg ?? "" }),
      goalDate: h("input", { type: "date", value: s.goalDate || "" }),
      macroWeightKg: h("input", { type: "number", step: "0.1", inputmode: "decimal", value: s.macroWeightKg ?? "", placeholder: "auto" }),
      proteinPerKg: h("input", { type: "number", step: "0.1", inputmode: "decimal", value: s.proteinPerKg }),
      fatPerKg: h("input", { type: "number", step: "0.1", inputmode: "decimal", value: s.fatPerKg }),
      remindAfterMin: h("input", { type: "number", inputmode: "numeric", value: s.remindAfterMin }),
      slotsText: h("input", { type: "text", value: s.slotsText, placeholder: "śniadanie 07:30; obiad 13:30; kolacja 19:30" }),
      weekendSlotsText: h("input", { type: "text", value: s.weekendSlotsText, placeholder: "puste = jak w tygodniu" }),
    };
    const remind = h("input", { type: "checkbox", checked: s.remindersOn });
    const channel = h("select", { "aria-label": "Kanał powiadomień" }, [["both", "Aplikacja i Telegram"], ["app", "Tylko aplikacja"], ["telegram", "Tylko Telegram"]].map(([v, t]) => h("option", { value: v, ...(v === s.notifyChannel ? { selected: true } : {}) }, t)));
    const save = h("button", { class: "btn block" }, "Zapisz ustawienia");
    const field = (label, el, hint) => h("label", { class: "field" }, label, el, hint ? h("span", { class: "small" }, hint) : null);
    save.addEventListener("click", async () => {
      const num = (el) => (el.value === "" ? null : Number(el.value));
      save.disabled = true;
      try {
        await api("/settings", { method: "PATCH", body: { deficitKcal: num(f.deficitKcal), garminFactor: num(f.garminFactor), goalWeightKg: num(f.goalWeightKg), goalDate: f.goalDate.value || null, macroWeightKg: num(f.macroWeightKg), proteinPerKg: num(f.proteinPerKg), fatPerKg: num(f.fatPerKg), remindAfterMin: num(f.remindAfterMin), remindersOn: remind.checked, notifyChannel: channel.value, slotsText: f.slotsText.value, weekendSlotsText: f.weekendSlotsText.value } });
        toast("Zapisano ustawienia ✅");
        rerender();
      } catch (e) {
        toast(errMsg(e), "error", 6000);
        save.disabled = false;
      }
    });
    body.replaceChildren(
      card(
        { icon: "settings", tone: "blue", title: "Cele i żywienie" },
        h("div", { class: "form" },
          h("div", { class: "two" }, field("Deficyt (kcal)", f.deficitKcal, "tylko dni bez biegu i łatwe"), field("Korekta Garmina", f.garminFactor, "0,9 = zegarek zawyża o 10%")),
          h("div", { class: "two" }, field("Waga docelowa (kg)", f.goalWeightKg), field("Termin celu", f.goalDate)),
          h("div", { class: "two" }, field("Masa referencyjna (kg)", f.macroWeightKg, "puste = niższa z wagi i celu"), field("Białko (g/kg)", f.proteinPerKg)),
          h("div", { class: "two" }, field("Tłuszcz (g/kg)", f.fatPerKg), field("Przypomnienie po (min)", f.remindAfterMin)),
          field("Pory posiłków (pn–pt)", f.slotsText, "nazwa GG:MM, rozdzielone średnikiem"),
          field("Pory posiłków (weekend)", f.weekendSlotsText),
          field("Gdzie wysyłać wiadomości trenera i przypomnienia", channel, "„Tylko aplikacja” wybierz dopiero po udanym teście powiadomień poniżej"),
          h("label", { class: "check" }, remind, "Przypomnienia o posiłkach"),
          save,
        ),
      ),
      pushCard(),
      card({ icon: "user", tone: "orange", title: "Konto" }, h("button", { class: "btn danger", onclick: () => { auth.clear(); rerender(); } }, icon("logout", 17), "Wyloguj"), h("div", { class: "small muted" }, "Garda v2 · kalorie liczy serwer, zdjęcia rozpoznaje Gemini, plan układa trener (Claude).")),
    );
  }).catch((e) => body.replaceChildren(h("div", { class: "card" }, `⚠️ ${errMsg(e)}`)));
}

// ---------------- Powiadomienia na tym urządzeniu ----------------

function pushCard() {
  const status = h("div", { class: "small muted" }, "Sprawdzam…");
  const btns = h("div", { class: "btns" });
  const loc = h("button", { class: "btn ghost" }, icon("pin", 17), "Użyj mojej lokalizacji");
  loc.addEventListener("click", async () => {
    loc.disabled = true;
    try {
      const r = await shareLocation();
      toast(r.location ? `Zapisano lokalizację${r.location.odDomuKm != null ? ` (${n1(r.location.odDomuKm)} km od domu)` : ""} ✅` : "Zapisano lokalizację ✅");
    } catch (e) {
      toast(e.message || "Błąd lokalizacji.", "error", 6000);
    }
    loc.disabled = false;
  });
  const draw = async () => {
    const st = await pushState();
    const act = (label, ic, fn, cls = "btn") => {
      const b = h("button", { class: cls }, icon(ic, 17), label);
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (e) {
          toast(e.message || "Coś poszło nie tak.", "error", 7000);
        }
        draw();
      });
      return b;
    };
    if (st === "unsupported") {
      status.textContent = "Ta przeglądarka nie obsługuje powiadomień. Otwórz Garda w Chrome i zainstaluj ją (menu ⋮ → Zainstaluj aplikację).";
      btns.replaceChildren();
    } else if (st === "denied") {
      status.textContent = "Powiadomienia są zablokowane. Odblokuj je w ustawieniach witryny w przeglądarce (ikona kłódki przy adresie → Powiadomienia).";
      btns.replaceChildren();
    } else if (st === "on") {
      status.textContent = "Powiadomienia włączone na tym urządzeniu. Dostaniesz wiadomości trenera i przypomnienia o posiłkach z przyciskami „Dodam / Pominąłem / Za godzinę”.";
      btns.replaceChildren(act("Wyślij test", "bell", async () => { await sendTest(); toast("Wysłano. Powinno pojawić się za chwilę."); }), act("Wyłącz", "close", async () => { await disablePush(); toast("Wyłączono powiadomienia na tym urządzeniu."); }, "btn ghost"));
    } else {
      status.textContent = "Wyłączone. Włącz, aby dostawać wiadomości trenera i przypomnienia o posiłkach w telefonie. Najlepiej w aplikacji zainstalowanej z Chrome.";
      btns.replaceChildren(act("Włącz powiadomienia", "bell", async () => { await enablePush(); toast("Włączone ✅ Wyślij teraz test."); }));
    }
  };
  draw();
  return card({ icon: "bell", tone: "blue", title: "Powiadomienia i lokalizacja" }, status, btns, h("div", { class: "small muted" }, "Lokalizacja służy do pogody i tras z miejsca, w którym jesteś (zamiast udostępniania jej w Telegramie)."), h("div", { class: "btns" }, loc));
}
