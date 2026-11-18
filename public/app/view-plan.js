// Widok "Plan": treningi z kalendarza z pogodą i trasami, prośba o plan do trenera, kilometry z ostatnich dni.
import { api } from "./api.js";
import { shareLocation } from "./push.js";
import { areaChart } from "./charts.js";
import { header } from "./view-today.js";
import { WD, addDays, card, chip, dateObj, errMsg, h, icon, iconButton, loading, n0, n1, pace, pills, rerender, toast, todayLocal, weatherChips } from "./ui.js";

// Starsza wersja aplikacji na Androida (APK) nie umiała otworzyć pliku GPX i przycisk nic nie robił. Nowa ustawia
// window.gardaNative; w starej (WebView bez znacznika) zamiast ciszy mówimy, co zrobić.
const OLD_APK_GPX = "Ta wersja aplikacji nie otwiera plików GPX. Zainstaluj najnowszą wersję aplikacji (GitHub → Releases) albo otwórz Garda w przeglądarce Chrome.";
function gpxClick(ev) {
  if (/; wv\)/.test(navigator.userAgent) && !window.gardaNative) {
    ev.preventDefault();
    toast(OLD_APK_GPX, "error", 9000);
  }
}

export async function viewPlan(root) {
  root.append(header("Plan", ""), loading("Pobieram plan z intervals.icu…"));
  let d;
  try {
    d = await api("/plan");
  } catch (e) {
    root.replaceChildren(header("Plan", ""), h("div", { class: "card" }, `⚠️ ${errMsg(e)}`, h("button", { class: "btn", onclick: rerender }, "Spróbuj ponownie")));
    return;
  }
  let filter = "all";
  const FILTERS = [{ id: "all", label: "Wszystkie treningi" }, { id: "run", label: "Tylko biegi" }];
  const pillHost = h("div", {});
  const drawPills = () =>
    pillHost.replaceChildren(
      pills(FILTERS, filter, (id) => {
        filter = id;
        drawPills();
        draw();
      }),
    );
  const list = h("div", { class: "wk", style: { gap: "12px" } });

  const draw = () => {
    const items = d.upcoming.filter((p) => filter === "all" || /run/i.test(p.type));
    if (!items.length) {
      list.replaceChildren(h("div", { class: "card" }, h("div", { class: "muted" }, filter === "run" ? "Brak biegów w najbliższych dwóch tygodniach." : "W kalendarzu nie ma jeszcze treningów na najbliższe dwa tygodnie. Poproś trenera o plan powyżej.")));
      return;
    }
    list.replaceChildren(...items.map((p) => planCard(p, d.weather.find((x) => x.data === p.date))));
  };

  // km z ostatnich 14 dni na wykres
  const today = todayLocal();
  const km = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(today, -13 + i);
    return { v: Math.round(d.recent.filter((a) => a.date === date && /run/i.test(a.type)).reduce((s, a) => s + (a.km || 0), 0) * 10) / 10 };
  });

  const weeks = h("select", { "aria-label": "Na ile tygodni" }, [1, 2, 3, 4].map((w) => h("option", { value: w, ...(w === 2 ? { selected: true } : {}) }, `${w} ${w === 1 ? "tydzień" : "tygodnie"}`)));
  const note = h("input", { type: "text", placeholder: "Uwagi dla trenera (opcjonalnie), np. w piątek nie mogę" });
  const ask = h("button", { class: "btn block" }, icon("sparkles", 18), "Poproś trenera o plan");
  ask.addEventListener("click", async () => {
    ask.disabled = true;
    try {
      const r = await api("/coach/plan", { method: "POST", body: { weeks: Number(weeks.value), note: note.value.trim() } });
      toast(r.message, "info", 6000);
      location.hash = "#/ty/trener";
    } catch (e) {
      toast(errMsg(e), "error");
      ask.disabled = false;
    }
  });

  root.replaceChildren(
    header("Plan treningowy", `Ostatnie 7 dni: ${n1(d.runKmLast7)} km · 14 dni: ${n1(d.runKmLast14)} km`, iconButton("refresh", "Odśwież", rerender)),
    textRouteCard(),
    card({ icon: "sparkles", tone: "orange", title: "Nowy plan od trenera" }, h("div", { class: "small muted" }, "Trener (Claude) ułoży plan wg ustalonych zasad (cel maratonu, regeneracja, pogoda) i wpisze go do kalendarza. Odpowiedź zobaczysz w Ty → Trener."), weeks, note, ask),
    card({ icon: "run", tone: "orange", title: "Kilometry", range: "ostatnie 14 dni" }, areaChart({ points: km, color: "orange", unit: "km", xLabels: [{ i: 0, text: `${dateObj(addDays(today, -13)).getUTCDate()}.${String(dateObj(addDays(today, -13)).getUTCMonth() + 1).padStart(2, "0")}` }, { i: 13, text: "dziś" }], label: "Kilometry z ostatnich 14 dni" })),
    h("button", { class: "btn ghost block", onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; try { const r = await shareLocation(); toast(r.location ? `Zapisano lokalizację${r.location.odDomuKm != null ? ` (${n1(r.location.odDomuKm)} km od domu)` : ""} ✅` : "Zapisano lokalizację ✅"); rerender(); } catch (e) { toast(e.message || "Błąd lokalizacji.", "error", 6000); b.disabled = false; } } }, icon("pin", 17), "Użyj mojej lokalizacji (pogoda i trasy stąd)"),
    pillHost,
    list,
    d.recent.length
      ? card({ icon: "watch", tone: "orange", title: "Ostatnie aktywności", range: "z Garmina" }, ...d.recent.slice(0, 8).map((a) => h("div", { class: "line" }, icon("run", 18), h("div", { class: "grow" }, h("strong", {}, a.name), h("div", { class: "small muted" }, `${WD[dateObj(a.date).getUTCDay()]} ${a.date.slice(8)}.${a.date.slice(5, 7)} ${a.time}`)), h("span", { class: "small muted" }, [a.km ? `${n1(a.km)} km` : null, a.minutes ? `${a.minutes} min` : null, pace(a.paceMinPerKm), a.avgHr ? `${a.avgHr} bpm` : null].filter(Boolean).join(" · ")))))
      : null,
    d.errors.length ? h("div", { class: "sub" }, `Część danych niedostępna: ${d.errors.join("; ")}`) : null,
  );
  drawPills();
  draw();
}

function planCard(p, weatherDay) {
  const routes = h("div", { class: "wk" });
  const descr = p.description ? h("div", { class: "descr", hidden: true }, p.description) : null;
  const x = dateObj(p.date);
  const isRun = /run/i.test(p.type) && p.km && p.km >= 2;
  const routeBtn = isRun
    ? h("button", { class: "btn ghost small", onclick: async () => {
        routeBtn.disabled = true;
        routes.replaceChildren(h("div", { class: "status" }, h("div", { class: "spinner" }), "Szukam pętli przez parki i ścieżki…"));
        try {
          const r = await api("/routes", { method: "POST", body: { km: p.km }, timeoutMs: 90000 });
          routes.replaceChildren(
            ...(r.note ? [h("div", { class: "small muted" }, r.note)] : []),
            ...r.options.map((o) =>
              h("div", { class: "route" }, h("div", { class: "row between" }, h("strong", {}, `Trasa ${o.label} · ${n1(o.km)} km`), chip(o.kind === "park" ? "przez parki" : "pętla ORS", o.kind === "park" ? "good" : "")), h("div", { class: "small muted" }, `nieutwardzona ${n0(o.unpavedPct)}% · zieleń ${n1(o.greenAvg)}/10 · dwa razy tą samą drogą ${n0(o.retracePct)}%${o.via ? ` · przez ${o.via.join(", ")}` : ""}`), h("div", { class: "links" }, h("a", { href: o.mapUrl }, "Mapa"), h("a", { href: o.gpxUrl, onclick: gpxClick }, "Otwórz GPX w aplikacji"))),
            ),
          );
        } catch (e) {
          routes.replaceChildren(h("div", { class: "status" }, `⚠️ ${errMsg(e)}`));
        }
        routeBtn.disabled = false;
      } }, icon("route", 16), "Zaproponuj trasy")
    : null;
  return h(
    "div",
    { class: "card plancard" },
    h("div", { class: "pdate" }, h("div", { class: "d" }, h("span", {}, WD[x.getUTCDay()]), h("b", {}, String(x.getUTCDate()))), h("div", { class: "grow" }, h("h3", { style: { fontSize: "17px", fontWeight: 800 } }, p.name), h("div", { class: "small muted" }, [p.km ? `${n1(p.km)} km` : null, p.minutes ? `${p.minutes} min` : null].filter(Boolean).join(" · ")))),
    weatherDay ? weatherChips(weatherDay) : null,
    descr,
    h("div", { class: "actions" }, descr ? h("button", { class: "btn ghost small", onclick: (e) => ((descr.hidden = !descr.hidden), (e.currentTarget.lastChild.textContent = descr.hidden ? "Kroki treningu" : "Ukryj")) }, icon("calendar", 16), h("span", {}, "Kroki treningu")) : null, routeBtn),
    routes,
  );
}

// ---------------- Trasa z opisu ----------------

const KIND_PL = { start: "start", place: "miejsce", street: "ulica", address: "adres", park: "park", bridge: "most", area: "okolica" };

function textRouteCard() {
  const text = h("textarea", { placeholder: "np. z domu nad Wisłę przez Fort Sokolnickiego, plaża Żoliborz, ulica Kaniowa, park przy Cytadeli i do domu\nalbo luźniej: 10 km, najpierw po tej stronie Wisły, Gdańskim na drugą stronę, powrót kładką", "aria-label": "Opis trasy", maxlength: 800, rows: 4 });
  const out = h("div", { class: "wk" });
  const go = h("button", { class: "btn block" }, icon("route", 18), "Wyznacz trasę z opisu");
  go.addEventListener("click", async () => {
    const t = text.value.trim();
    if (t.length < 8) return toast("Opisz trasę: miejsca po kolei i/lub dystans.", "error");
    go.disabled = true;
    out.replaceChildren(h("div", { class: "status" }, h("div", { class: "spinner" }), "Rozumiem opis, szukam miejsc i wyznaczam trasę…"));
    try {
      const r = await api("/routes/text", { method: "POST", body: { text: t }, timeoutMs: 90000 });
      out.replaceChildren(
        ...(r.warnings || []).map((w) => h("div", { class: "small warn" }, `⚠️ ${w}`)),
        h("div", { class: "route" }, h("strong", {}, "Rozpoznane punkty"), h("ol", { class: "pts" }, r.points.map((p) => h("li", {}, h("span", {}, p.name), h("span", { class: "small muted" }, ` · ${KIND_PL[p.kind] || p.kind}${p.found && p.found !== p.name ? ` → ${p.found}` : ""}${p.confidence === "low" ? " (niepewnie)" : ""}`)))), h("div", { class: "small muted" }, "Jeśli coś jest źle, doprecyzuj w opisie (dzielnica, ulica, pełna nazwa) i wyznacz jeszcze raz.")),
        ...r.options.map((o) =>
          h("div", { class: "route" }, h("div", { class: "row between" }, h("strong", {}, `Trasa ${o.label} · ${n1(o.km)} km`), chip("wg opisu", "good")), h("div", { class: "small muted" }, `nieutwardzona ${n0(o.unpavedPct)}% · zieleń ${n1(o.greenAvg)}/10 · dwa razy tą samą drogą ${n0(o.retracePct)}%`), h("div", { class: "links" }, h("a", { href: o.mapUrl }, "Mapa"), h("a", { href: o.gpxUrl, onclick: gpxClick }, "Otwórz GPX w aplikacji"))),
        ),
      );
    } catch (e) {
      out.replaceChildren(h("div", { class: "status" }, `⚠️ ${errMsg(e)}`));
    }
    go.disabled = false;
  });
  return card({ icon: "route", tone: "orange", title: "Trasa z opisu" }, h("div", { class: "small muted" }, "Opisz własnymi słowami (możesz podyktować klawiaturą): miejsca po kolei albo dystans i ogólny przebieg. Trasa pójdzie dokładnie przez wskazane miejsca."), text, go, out);
}
