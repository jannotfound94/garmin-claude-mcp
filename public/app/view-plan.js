// Widok "Plan": treningi z kalendarza z pogodą i trasami, prośba o plan do trenera, kilometry z ostatnich dni.
import { api } from "./api.js";
import { areaChart } from "./charts.js";
import { header } from "./view-today.js";
import { WD, addDays, card, chip, dateObj, errMsg, h, icon, iconButton, loading, n0, n1, pace, pills, rerender, toast, todayLocal, weatherChips } from "./ui.js";

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
    card({ icon: "sparkles", tone: "orange", title: "Nowy plan od trenera" }, h("div", { class: "small muted" }, "Trener (Claude) ułoży plan wg ustalonych zasad (cel maratonu, regeneracja, pogoda) i wpisze go do kalendarza. Odpowiedź zobaczysz w Ty → Trener."), weeks, note, ask),
    card({ icon: "run", tone: "orange", title: "Kilometry", range: "ostatnie 14 dni" }, areaChart({ points: km, color: "orange", unit: "km", xLabels: [{ i: 0, text: `${dateObj(addDays(today, -13)).getUTCDate()}.${String(dateObj(addDays(today, -13)).getUTCMonth() + 1).padStart(2, "0")}` }, { i: 13, text: "dziś" }], label: "Kilometry z ostatnich 14 dni" })),
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
              h("div", { class: "route" }, h("div", { class: "row between" }, h("strong", {}, `Trasa ${o.label} · ${n1(o.km)} km`), chip(o.kind === "park" ? "przez parki" : "pętla ORS", o.kind === "park" ? "good" : "")), h("div", { class: "small muted" }, `nieutwardzona ${n0(o.unpavedPct)}% · zieleń ${n1(o.greenAvg)}/10 · dwa razy tą samą drogą ${n0(o.retracePct)}%${o.via ? ` · przez ${o.via.join(", ")}` : ""}`), h("div", { class: "links" }, h("a", { href: o.mapUrl, target: "_blank", rel: "noopener" }, "Mapa"), h("a", { href: o.gpxUrl, target: "_blank", rel: "noopener" }, "Pobierz GPX"))),
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
