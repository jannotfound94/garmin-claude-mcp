// Wykresy SVG bez bibliotek: pierścienie celów, wykres obszarowy, waga względem planu, tydzień. Wszystkie wartości
// liczbowe, więc nic z danych użytkownika nie trafia do znaczników. Paleta: pomarańcz = ruch, niebieski = dane i jedzenie.
const NS = "http://www.w3.org/2000/svg";
export const COLOR = { orange: "#FF6B1A", orange2: "#FF8F4D", blue: "#3B8CFF", blue2: "#78B0FF", good: "#3DD68C", warn: "#FFC53D", bad: "#FF5C5C", line: "#263040", track: "#1C2430", muted: "#8C97AB", text: "#F3F5F9" };

function svg(w, h, label) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", "100%");
  s.setAttribute("role", "img");
  if (label) s.setAttribute("aria-label", label);
  return s;
}
function node(parent, tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  parent.appendChild(n);
  return n;
}
// Północ UTC daje całkowity numer dnia; zaokrąglanie z godziny 12:00 przesuwałoby datę o jeden dzień.
const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const fmtShort = (n) => {
  const d = new Date(n * 86400000);
  return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const grad = (s, id, color, top = 0.38) => {
  const defs = node(s, "defs");
  const g = node(defs, "linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  node(g, "stop", { offset: "0%", "stop-color": color, "stop-opacity": top });
  node(g, "stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 });
};

/** Pierścień celu (jak pierścienie w dashboardach sportowych). tone: orange | blue | good | warn | bad. */
export function ring({ value, max, size = 112, stroke = 11, tone = "blue", center, sub, label }) {
  const s = svg(size, size, label);
  s.setAttribute("width", String(size));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  node(s, "circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: COLOR.track, "stroke-width": stroke });
  if (frac > 0) {
    node(s, "circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: COLOR[tone] || COLOR.blue, "stroke-width": stroke, "stroke-linecap": "round", "stroke-dasharray": `${c * frac} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})` });
  }
  if (center != null) node(s, "text", { x: size / 2, y: sub ? size / 2 + 2 : size / 2 + 7, "text-anchor": "middle", fill: COLOR.text, "font-size": size * 0.22, "font-weight": 800 }, String(center));
  if (sub) node(s, "text", { x: size / 2, y: size / 2 + size * 0.17, "text-anchor": "middle", fill: COLOR.muted, "font-size": size * 0.11 }, String(sub));
  return s;
}

/** Wykres obszarowy z gradientem (np. kilometry z ostatnich 14 dni). points: [{v}], xLabels: [{i, text}]. */
export function areaChart({ points, color = "orange", unit = "", xLabels = [], yMax, label }) {
  const W = 340, H = 150, L = 8, R = 36, T = 14, B = 22;
  const s = svg(W, H, label || "Wykres");
  const max = yMax || Math.max(1, ...points.map((p) => p.v)) * 1.2;
  const X = (i) => L + (i / Math.max(1, points.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  const col = COLOR[color];
  grad(s, `g-${color}`, col);
  [0, 0.5, 1].forEach((f) => {
    const v = max * f;
    node(s, "line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: COLOR.line, "stroke-width": 1, ...(f ? { "stroke-dasharray": "3 4" } : {}) });
    node(s, "text", { x: W - R + 6, y: Y(v) + 4, fill: COLOR.muted, "font-size": 10 }, `${(Math.round(v * 10) / 10 || 0).toLocaleString("pl-PL")}${f === 1 ? ` ${unit}` : ""}`);
  });
  const line = points.map((p, i) => `${X(i)},${Y(p.v)}`).join(" ");
  node(s, "polygon", { points: `${X(0)},${Y(0)} ${line} ${X(points.length - 1)},${Y(0)}`, fill: `url(#g-${color})` });
  node(s, "polyline", { points: line, fill: "none", stroke: col, "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round" });
  const last = points[points.length - 1];
  if (last) node(s, "circle", { cx: X(points.length - 1), cy: Y(last.v), r: 4.5, fill: col, stroke: "#0D1117", "stroke-width": 2 });
  xLabels.forEach(({ i, text }) => node(s, "text", { x: X(i), y: H - 6, fill: COLOR.muted, "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle", "font-size": 10 }, text));
  return s;
}

/** Waga: punkty ważeń (niebieskie), plan do celu (pomarańczowy, kreskowany) i linia celu. */
export function weightChart({ entries, plan, goalKg, label, height = 190 }) {
  const W = 340, H = height, L = 34, R = 10, T = 12, B = 24;
  const s = svg(W, H, label || "Wykres wagi");
  const pts = entries.map((e) => ({ x: dayNum(e.date), y: e.kg }));
  const xs = pts.map((p) => p.x);
  if (plan) xs.push(dayNum(plan.startDate), dayNum(plan.goalDate));
  if (!xs.length) {
    node(s, "text", { x: W / 2, y: H / 2, fill: COLOR.muted, "text-anchor": "middle", "font-size": 13 }, "Brak ważeń. Dodaj pierwsze poniżej.");
    return s;
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 14);
  const ys = pts.map((p) => p.y);
  if (goalKg) ys.push(goalKg);
  if (plan) ys.push(plan.startKg);
  const lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1);
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const Y = (y) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    node(s, "line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: COLOR.line, "stroke-width": 1 });
    node(s, "text", { x: L - 5, y: Y(v) + 4, fill: COLOR.muted, "text-anchor": "end", "font-size": 10 }, String(Math.round(v)));
  }
  [x0, (x0 + x1) / 2, x1].forEach((x) => node(s, "text", { x: X(x), y: H - 6, fill: COLOR.muted, "text-anchor": x === x0 ? "start" : x === x1 ? "end" : "middle", "font-size": 10 }, fmtShort(Math.round(x))));
  if (goalKg) {
    node(s, "line", { x1: L, x2: W - R, y1: Y(goalKg), y2: Y(goalKg), stroke: COLOR.good, "stroke-width": 1.2, "stroke-dasharray": "4 4" });
    node(s, "text", { x: L + 4, y: Y(goalKg) - 5, fill: COLOR.good, "text-anchor": "start", "font-size": 10 }, `cel ${goalKg} kg`);
  }
  if (plan) node(s, "line", { x1: X(dayNum(plan.startDate)), y1: Y(plan.startKg), x2: X(dayNum(plan.goalDate)), y2: Y(plan.goalKg), stroke: COLOR.orange, "stroke-width": 1.8, "stroke-dasharray": "6 4" });
  if (pts.length > 1) node(s, "polyline", { points: pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" "), fill: "none", stroke: COLOR.blue, "stroke-width": 2.4, "stroke-linejoin": "round" });
  pts.forEach((p, i) => node(s, "circle", { cx: X(p.x), cy: Y(p.y), r: i === pts.length - 1 ? 5 : 3, fill: COLOR.blue, stroke: "#0D1117", "stroke-width": 1.5 }));
  return s;
}

/** Tydzień: słupki zjedzonych kcal (niebieskie), znacznik celu (zielony) i spalania z Garmina (pomarańczowy). */
export function weekChart({ days }) {
  const W = 340, H = 190, L = 34, R = 8, T = 12, B = 24;
  const s = svg(W, H, "Spożycie i spalanie w ostatnim tygodniu");
  const max = Math.max(1000, ...days.map((d) => Math.max(d.kcal || 0, d.targetKcal || 0, d.burnedKcal || 0))) * 1.08;
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  const step = Math.ceil(max / 4 / 500) * 500;
  for (let v = 0; v <= max; v += step) {
    node(s, "line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: COLOR.line, "stroke-width": 1 });
    node(s, "text", { x: L - 5, y: Y(v) + 4, fill: COLOR.muted, "text-anchor": "end", "font-size": 10 }, String(v));
  }
  const bw = (W - L - R) / days.length;
  days.forEach((d, i) => {
    const cx = L + bw * i + bw / 2;
    const w = bw * 0.52;
    if (d.kcal > 0) node(s, "rect", { x: cx - w / 2, y: Y(d.kcal), width: w, height: Math.max(1, Y(0) - Y(d.kcal)), rx: 4, fill: d.partial ? "#2A4F8F" : COLOR.blue });
    if (d.targetKcal) node(s, "line", { x1: cx - w / 2 - 3, x2: cx + w / 2 + 3, y1: Y(d.targetKcal), y2: Y(d.targetKcal), stroke: COLOR.good, "stroke-width": 2.4 });
    if (d.burnedKcal) node(s, "line", { x1: cx - w / 2 - 3, x2: cx + w / 2 + 3, y1: Y(d.burnedKcal), y2: Y(d.burnedKcal), stroke: COLOR.orange, "stroke-width": 2.4, "stroke-dasharray": "3 2" });
    node(s, "text", { x: cx, y: H - 7, fill: COLOR.muted, "text-anchor": "middle", "font-size": 10 }, d.label);
  });
  return s;
}
