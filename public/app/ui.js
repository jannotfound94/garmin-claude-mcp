// Wspólne elementy interfejsu: budowanie DOM (bezpieczne: dane tylko jako tekst), formatowanie, karty w stylu dashboardu,
// arkusze dolne, toasty i prosty cache podsumowania.
import { ApiError, api } from "./api.js";
import { icon } from "./icons.js";

export { icon };

// ---------------- czas i liczby ----------------

export const pad = (n) => String(n).padStart(2, "0");
export const WD = ["Nd", "Pn", "Wt", "Śr", "Cz", "Pt", "So"];
export const dateObj = (d) => new Date(`${d}T12:00:00Z`);
export const fmtDay = (d) => {
  const x = dateObj(d);
  return `${WD[x.getUTCDay()]} ${x.getUTCDate()}.${pad(x.getUTCMonth() + 1)}`;
};
export const n0 = (n) => (n == null || Number.isNaN(n) ? "–" : Math.round(n).toLocaleString("pl-PL"));
export const n1 = (n) => (n == null || Number.isNaN(n) ? "–" : (Math.round(n * 10) / 10).toLocaleString("pl-PL"));
export const todayLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
export const nowHm = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
export const addDays = (d, n) => {
  const x = dateObj(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pace = (p) => (p ? `${Math.floor(p)}:${pad(Math.round((p % 1) * 60))}/km` : "");
export const errMsg = (e) => (e instanceof ApiError ? e.message : "Coś poszło nie tak.");

// ---------------- DOM ----------------

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
/** Tworzy element. Teksty jako dzieci trafiają do węzłów tekstowych, więc są bezpieczne. */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else if (k === "disabled") el.disabled = Boolean(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return append(el, kids);
}

// ---------------- rerender i cache ----------------

let rerenderFn = () => {};
export const setRerender = (fn) => (rerenderFn = fn);
export const rerender = () => rerenderFn();

let summaryCache = { at: 0, data: null };
/** Podsumowanie dnia jest ciężkie (Garmin, plan, pogoda), więc krótko je pamiętamy. force = pobierz na nowo. */
export async function getSummary(force = false) {
  if (!force && summaryCache.data && Date.now() - summaryCache.at < 90_000) return summaryCache.data;
  const data = await api("/summary");
  summaryCache = { at: Date.now(), data };
  return data;
}
export const invalidateSummary = () => (summaryCache = { at: 0, data: null });

// ---------------- toasty i arkusze ----------------

export function toast(msg, kind = "info", ms = 3800) {
  const t = h("div", { class: `toast ${kind === "error" ? "error" : ""}` }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

export function openSheet(build) {
  const bg = h("div", { class: "sheet-bg", onclick: (e) => e.target === bg && close() });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, h("div", { class: "grab" }));
  const close = () => bg.remove();
  append(sheet, [build(close)]);
  bg.append(sheet);
  document.body.append(bg);
  return close;
}

// ---------------- elementy dashboardu ----------------

/** Ikona w obramowanym kwadracie (jak w nagłówkach kart). tone: orange | blue. */
export function badge(name, tone = "orange") {
  return h("span", { class: `badge ${tone}` }, icon(name, 17));
}

/**
 * Karta modułu: nagłówek (ikona, tytuł, zakres czasu, strzałka) i treść. Gdy podano onclick, cała karta jest przyciskiem
 * przejścia do szczegółów.
 */
export function card({ icon: ic, tone = "orange", title, range, onclick, cls = "" }, ...body) {
  const head = h("div", { class: "ch" }, ic ? badge(ic, tone) : null, h("h3", {}, title), h("span", { class: "grow" }), range ? h("span", { class: "range" }, range) : null, onclick ? icon("right", 18) : null);
  const el = h("section", { class: `card ${cls}` }, head, ...body);
  if (onclick) {
    el.classList.add("tap");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.addEventListener("click", (e) => {
      if (e.target.closest("button, a, input, select, textarea")) return;
      onclick();
    });
    el.addEventListener("keydown", (e) => (e.key === "Enter" ? onclick() : null));
  }
  return el;
}

export const chip = (text, tone = "", ic = null) => h("span", { class: `chip ${tone}` }, ic ? icon(ic, 13) : null, text);

export function bar(pct, tone = "blue") {
  return h("div", { class: `bar ${tone}` }, h("i", { style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
}

/** Duża liczba z jednostką i opcjonalnym znacznikiem zmiany. */
export function stat(value, unit, { label, delta, tone = "" } = {}) {
  return h("div", { class: "stat" }, label ? h("div", { class: "lbl" }, label) : null, h("div", { class: "row base" }, h("span", { class: `num ${tone}` }, value), unit ? h("span", { class: "unit" }, unit) : null, delta ? h("span", { class: `delta ${delta.tone || ""}` }, delta.text) : null));
}

export const loading = (text = "Ładuję…") => h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "spinner" }), h("span", { class: "muted" }, text)));
export const empty = (text) => h("div", { class: "empty" }, text);

export function iconButton(name, label, onclick) {
  return h("button", { class: "icon-btn", "aria-label": label, onclick }, icon(name, 20));
}

export function pills(options, selected, onPick) {
  return h("div", { class: "pills" }, options.map((o) => h("button", { class: `pill ${o.id === selected ? "on" : ""}`, onclick: () => onPick(o.id) }, o.label)));
}

// ---------------- pogoda i rekomendacje ----------------

export const verdictTone = (v) => (v === "dobra" ? "good" : v === "znosna" ? "warn" : "bad");

/** Ikona pogody dla okna biegowego: opady, wiatr albo ogólnie słońce/chmura zależnie od oceny. */
export function weatherIconName(w) {
  const why = (w.powody || []).join(" ");
  if (/deszcz|ulew|śnieg|burza|marzn/i.test(why) || w.opady_mm >= 0.3) return "rain";
  if (/wiatr/i.test(why) || w.porywy_kmh >= 40) return "wind";
  return w.ocena === "dobra" ? "sun" : "cloud";
}

export function weatherChips(day) {
  if (!day || !day.okna) return null;
  const names = { poranek: "rano", poludnie: "południe", wieczor: "wieczór" };
  return h("div", { class: "chips" }, Object.entries(day.okna).map(([k, w]) => h("span", { class: `chip ${verdictTone(w.ocena)}`, title: (w.powody || []).join(", ") }, icon(weatherIconName(w), 14), `${names[k] || k} ${w.start} · ${w.temp_c}°C`)));
}

const RECO_ICON = { food: "apple", training: "run", weather: "cloud", recovery: "moon", weight: "scale" };
export const recoIcon = (r) => (r.kind === "weather" ? "rain" : r.kind === "recovery" && /Naładowany/.test(r.title) ? "battery" : RECO_ICON[r.kind] || "info");
export const recoTone = (r) => (r.kind === "food" || r.kind === "weight" ? "blue" : "orange");

/** Różnica do planu wagi: dodatnia = lżej niż w planie. */
export function aheadLabel(ahead) {
  if (ahead == null) return "";
  if (Math.abs(ahead) < 0.2) return h("strong", { class: "pos" }, "zgodnie z planem");
  return h("strong", { class: ahead > 0 ? "pos" : "warn" }, ahead > 0 ? `${n1(ahead)} kg do przodu` : `${n1(-ahead)} kg do planu`);
}

export function workoutLine(p) {
  return h("div", { class: "line" }, icon("run", 18), h("div", { class: "grow" }, h("strong", {}, p.name)), h("span", { class: "muted small" }, [p.km ? `${n1(p.km)} km` : null, p.minutes ? `${p.minutes} min` : null].filter(Boolean).join(" · ")));
}

export const SLOT_ICON = (slot, time) => {
  const s = String(slot || "").toLowerCase();
  if (/śniad|sniad/.test(s) && !/drugie/.test(s)) return "sunrise";
  if (/kolac/.test(s)) return "moon";
  if (/obiad|lunch/.test(s)) return "plate";
  if (/przek|podwiecz|drugie/.test(s)) return "apple";
  const hour = Number(String(time || "12:00").slice(0, 2));
  return hour < 10 ? "sunrise" : hour < 16 ? "plate" : hour < 21 ? "moon" : "apple";
};
