// Post przerywany: odliczanie postu (nie jem) i okna jedzenia, przyciski "Skończyłem jeść" / "Zaczynam jeść".
// Czas liczy serwer (powiadomienia dochodzą też przy zamkniętej aplikacji); tu tylko pokazujemy odliczanie.
import { api } from "./api.js";
import { ring } from "./charts.js";
import { card, chip, errMsg, h, icon, n1, openSheet, todayLocal, toast } from "./ui.js";

const HOUR = 3600_000;
const warsawDate = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(ms));
const warsawTime = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

/** "dziś 12:00", "wczoraj 20:00", "jutro 04:00" w czasie polskim. */
export function whenLabel(ms, nowMs = Date.now()) {
  const d = dayDiff(warsawDate(ms), warsawDate(nowMs));
  const day = d === 0 ? "dziś" : d === -1 ? "wczoraj" : d === 1 ? "jutro" : warsawDate(ms).slice(5).split("-").reverse().join(".");
  return `${day} ${warsawTime(ms)}`;
}
/** 4 h 28 min */
export function durLabel(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
const clock = (ms) => {
  const m = Math.max(0, Math.ceil(ms / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

function timeSheet({ title, text, confirm, onConfirm }) {
  openSheet((close) => {
    const t = h("input", { type: "time", value: warsawTime(Date.now()), "aria-label": "Godzina" });
    const go = h("button", { class: "btn block" }, confirm);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await onConfirm(t.value);
        close();
      } catch (e) {
        toast(errMsg(e), "error", 6000);
        go.disabled = false;
      }
    });
    return h("div", { class: "form" }, h("h3", {}, title), h("div", { class: "small muted" }, text), h("label", { class: "field" }, "Godzina", t), go);
  });
}

export function fastingCard(root) {
  const body = h("div", {}, h("div", { class: "small muted" }, "Ładuję…"));
  const wrap = card({ icon: "clock", tone: "blue", title: "Post przerywany", range: "16:8", cls: "fastcard" }, body);
  let data = null;
  let timer = null;

  const call = async (path, payload) => {
    data = await api(`/fasting/${path}`, { method: "POST", body: payload || {} });
    draw();
  };

  const finishNow = () => call("finish-eating").then(() => toast("Post się zaczął ⏱ Powodzenia!")).catch((e) => toast(errMsg(e), "error"));
  const finishAt = () =>
    timeSheet({ title: "Kiedy skończyłeś jeść?", text: "Wpisz godzinę ostatniego jedzenia (z dzisiaj, a jeśli jest późniejsza niż teraz, z wczoraj).", confirm: "Zacznij post od tej godziny", onConfirm: async (at) => { await call("finish-eating", { at }); toast("Post liczy się od wybranej godziny ⏱"); } });
  const restartAt = () =>
    timeSheet({ title: "Jadłeś dłużej?", text: "Post liczy się od nowa, od podanej godziny (domyślnie od teraz).", confirm: "Zacznij post od tej godziny", onConfirm: async (at) => { await call("finish-eating", { at, restart: true }); toast("Post liczy się od nowa ⏱"); } });
  const startEating = (elapsed, goalMs) => {
    const doIt = async () => {
      try {
        await call("start-eating");
        toast("Okno jedzenia otwarte 🍽");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    };
    if (elapsed >= goalMs - 60_000) return doIt();
    openSheet((close) =>
      h("div", { class: "form" }, h("h3", {}, "Przerwać post?"), h("div", { class: "small muted" }, `Post trwa dopiero ${durLabel(elapsed)} z ${durLabel(goalMs)}. Zapiszę go jako przerwany.`), h("button", { class: "btn block", onclick: () => { close(); doIt(); } }, "Tak, zaczynam jeść"), h("button", { class: "btn ghost block", onclick: close }, "Jednak dalej poszczę")),
    );
  };

  function draw() {
    if (!data) return;
    const now = Date.now() + (data.now - clientNowAtLoad); // zegar serwera (bez rozjazdu z telefonem)
    const s = data.state;
    const { stats } = data;
    const kids = [];
    if (!s) {
      wrap.querySelector(".range") && (wrap.querySelector(".range").textContent = `${data.goalHours}:${data.windowHours}`);
      kids.push(h("div", { class: "small muted" }, "Zegar jeszcze nie liczy. Gdy skończysz jeść, naciśnij przycisk, a od tej chwili odliczę post."));
      kids.push(h("button", { class: "btn block", onclick: finishNow }, icon("moon", 18), "Skończyłem jeść"));
      kids.push(h("button", { class: "linkbtn", onclick: finishAt }, "skończyłem o innej godzinie…"));
    } else {
      const total = s.end - s.start;
      const elapsed = Math.min(total, Math.max(0, now - s.start));
      const left = Math.max(0, s.end - now);
      const isFast = s.phase === "fast";
      const tone = isFast ? "blue" : "orange";
      const info = h(
        "div",
        { class: "grow fastinfo" },
        h("div", {}, chip(isFast ? "Post" : "Okno", isFast ? "" : "good", isFast ? "moon" : "meal")),
        h("div", { class: "small" }, isFast ? "Nie jesz od " : "Jesz od ", h("b", {}, whenLabel(s.start, now))),
        h("div", { class: "small" }, isFast ? "Koniec postu: " : "Okno zamyka się: ", h("b", {}, whenLabel(s.end, now))),
        h("div", { class: "small muted" }, `Minęło ${durLabel(elapsed)} z ${Math.round((total / HOUR) * 10) / 10} h`),
      );
      kids.push(h("div", { class: "fastrow" }, ring({ value: elapsed, max: total, size: 150, stroke: 11, tone, center: clock(left), sub: isFast ? "do końca postu" : "do końca okna", label: isFast ? "Czas do końca postu" : "Czas do końca okna jedzenia" }), info));
      if (isFast) {
        kids.push(h("button", { class: "btn outline-orange block", onclick: () => startEating(elapsed, s.goalHours * HOUR) }, icon("meal", 18), "Zaczynam jeść"));
        if (elapsed < 3 * HOUR) kids.push(h("button", { class: "linkbtn", onclick: restartAt }, "jadłem dłużej, zacznij post od innej godziny…"));
      } else {
        kids.push(h("button", { class: "btn block", onclick: finishNow }, icon("moon", 18), "Skończyłem jeść"));
        kids.push(h("button", { class: "linkbtn", onclick: finishAt }, "skończyłem o innej godzinie…"));
      }
      const r = wrap.querySelector(".range");
      if (r) r.textContent = `${s.goalHours}:${24 - s.goalHours}`;
    }
    if (stats.count) {
      const max = Math.max(data.goalHours + 4, ...stats.recent.map((x) => x.hours));
      kids.push(
        h(
          "div",
          { class: "faststats" },
          h("div", { class: "row wrap small muted" }, stats.streak ? chip(`seria ${stats.streak}`, "good", "flame") : null, h("span", {}, `średnio ${n1(stats.avg7Hours)} h`), h("span", {}, `ostatni ${n1(stats.lastHours)} h ${stats.lastReached ? "✅" : "⏳"}`)),
          h("div", { class: "fbars", "aria-label": "Ostatnie posty w godzinach" }, stats.recent.map((x) => h("div", { class: `fbar ${x.reached ? "ok" : ""}`, title: `${x.hours} h`, style: { height: `${Math.max(8, Math.round((x.hours / max) * 100))}%` } }))),
        ),
      );
    }
    body.replaceChildren(...kids);
  }

  let clientNowAtLoad = Date.now();
  const load = async () => {
    try {
      data = await api("/fasting");
      clientNowAtLoad = Date.now();
      draw();
    } catch (e) {
      body.replaceChildren(h("div", { class: "small muted" }, `⚠️ ${errMsg(e)}`));
    }
  };
  load();
  timer = setInterval(() => {
    if (!wrap.isConnected) return;
    if (data?.state && Date.now() + (data.now - clientNowAtLoad) >= data.state.end) load(); // faza się skończyła: pobierz nową
    else draw();
  }, 15000);
  const prev = root._cleanup;
  root._cleanup = () => {
    clearInterval(timer);
    prev && prev();
  };
  return wrap;
}

/** Po dodaniu wieczornego posiłku (kolacja albo po 18:00) pyta, czy to koniec jedzenia, i zaczyna post jednym kliknięciem. */
export async function askFastAfterMeal(meal) {
  try {
    const key = `garda.fastAsk.${todayLocal()}`;
    if (meal.date !== todayLocal() || localStorage.getItem(key)) return;
    if (!(meal.kind === "kolacja" || String(meal.time) >= "18:00")) return;
    const d = await api("/fasting");
    if (d.state && d.state.phase !== "window") return;
    openSheet((close) =>
      h(
        "div",
        { class: "form" },
        h("h3", {}, "To już koniec jedzenia?"),
        h("div", { class: "small muted" }, `Jeśli tak, zacznę odliczać post (${d.goalHours} h).`),
        h("button", { class: "btn block", onclick: async () => {
          try {
            await api("/fasting/finish-eating", { method: "POST", body: {} });
            try { localStorage.setItem(key, "1"); } catch { /* nic */ }
            toast("Post się zaczął ⏱");
          } catch (e) {
            toast(errMsg(e), "error");
          }
          close();
        } }, "Tak, zaczynam post"),
        h("button", { class: "btn ghost block", onclick: close }, "Jeszcze jem"),
      ),
    );
  } catch {
    /* pytanie jest dodatkiem: błąd sieci nie może psuć dodawania posiłku */
  }
}
