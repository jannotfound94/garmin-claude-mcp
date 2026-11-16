// Proste wykresy SVG bez bibliotek. Wszystkie wartości liczbowe, więc nic z danych użytkownika nie trafia do znaczników.
const NS = "http://www.w3.org/2000/svg";

function svg(w, h) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", "100%");
  s.setAttribute("role", "img");
  return s;
}
function node(parent, tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  parent.appendChild(n);
  return n;
}
const dayNum = (d) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86400000);
const fmtShort = (n) => {
  const d = new Date(n * 86400000);
  return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Waga: punkty ważeń, prosty plan do celu i linia celu. entries: [{date, kg}], plan: {startDate, startKg, goalDate, goalKg} | null. */
export function weightChart({ entries, plan, goalKg, label }) {
  const W = 340, H = 190, L = 34, R = 10, T = 12, B = 24;
  const s = svg(W, H);
  s.setAttribute("aria-label", label || "Wykres wagi");
  const pts = entries.map((e) => ({ x: dayNum(e.date), y: e.kg }));
  const xs = [...pts.map((p) => p.x)];
  if (plan) xs.push(dayNum(plan.startDate), dayNum(plan.goalDate));
  if (!xs.length) {
    node(s, "text", { x: W / 2, y: H / 2, fill: "#8b93a7", "text-anchor": "middle", "font-size": 13 }, "Brak ważeń. Dodaj pierwsze poniżej.");
    return s;
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 14);
  const ys = [...pts.map((p) => p.y)];
  if (goalKg) ys.push(goalKg);
  if (plan) ys.push(plan.startKg);
  const lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1);
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const Y = (y) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    node(s, "line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "#252b3b", "stroke-width": 1 });
    node(s, "text", { x: L - 5, y: Y(v) + 4, fill: "#8b93a7", "text-anchor": "end", "font-size": 10 }, String(Math.round(v)));
  }
  [x0, (x0 + x1) / 2, x1].forEach((x) => node(s, "text", { x: X(x), y: H - 6, fill: "#8b93a7", "text-anchor": x === x0 ? "start" : x === x1 ? "end" : "middle", "font-size": 10 }, fmtShort(Math.round(x))));

  if (goalKg) {
    node(s, "line", { x1: L, x2: W - R, y1: Y(goalKg), y2: Y(goalKg), stroke: "#4ade80", "stroke-width": 1.2, "stroke-dasharray": "4 4" });
    node(s, "text", { x: W - R, y: Y(goalKg) - 4, fill: "#4ade80", "text-anchor": "end", "font-size": 10 }, `cel ${goalKg} kg`);
  }
  if (plan) {
    node(s, "line", { x1: X(dayNum(plan.startDate)), y1: Y(plan.startKg), x2: X(dayNum(plan.goalDate)), y2: Y(plan.goalKg), stroke: "#a78bfa", "stroke-width": 1.5, "stroke-dasharray": "6 4" });
  }
  if (pts.length > 1) node(s, "polyline", { points: pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" "), fill: "none", stroke: "#6ea8ff", "stroke-width": 2.2, "stroke-linejoin": "round" });
  pts.forEach((p, i) => node(s, "circle", { cx: X(p.x), cy: Y(p.y), r: i === pts.length - 1 ? 4.5 : 3, fill: "#6ea8ff", stroke: "#0b0d12", "stroke-width": 1.5 }));
  return s;
}

/** Tydzień: słupki zjedzonych kcal, znacznik celu i znacznik spalania z Garmina. days: [{label, kcal, targetKcal, burnedKcal, partial}]. */
export function weekChart({ days }) {
  const W = 340, H = 190, L = 34, R = 8, T = 12, B = 24;
  const s = svg(W, H);
  s.setAttribute("aria-label", "Spożycie i spalanie w ostatnim tygodniu");
  const max = Math.max(1000, ...days.map((d) => Math.max(d.kcal || 0, d.targetKcal || 0, d.burnedKcal || 0))) * 1.08;
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  const step = Math.ceil(max / 4 / 500) * 500;
  for (let v = 0; v <= max; v += step) {
    node(s, "line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "#252b3b", "stroke-width": 1 });
    node(s, "text", { x: L - 5, y: Y(v) + 4, fill: "#8b93a7", "text-anchor": "end", "font-size": 10 }, String(v));
  }
  const bw = (W - L - R) / days.length;
  days.forEach((d, i) => {
    const cx = L + bw * i + bw / 2;
    const w = bw * 0.52;
    if (d.kcal > 0) node(s, "rect", { x: cx - w / 2, y: Y(d.kcal), width: w, height: Math.max(1, Y(0) - Y(d.kcal)), rx: 4, fill: d.partial ? "#3d5a99" : "#6ea8ff" });
    if (d.targetKcal) node(s, "line", { x1: cx - w / 2 - 3, x2: cx + w / 2 + 3, y1: Y(d.targetKcal), y2: Y(d.targetKcal), stroke: "#4ade80", "stroke-width": 2.2 });
    if (d.burnedKcal) node(s, "line", { x1: cx - w / 2 - 3, x2: cx + w / 2 + 3, y1: Y(d.burnedKcal), y2: Y(d.burnedKcal), stroke: "#fbbf24", "stroke-width": 2.2, "stroke-dasharray": "3 2" });
    node(s, "text", { x: cx, y: H - 7, fill: "#8b93a7", "text-anchor": "middle", "font-size": 10 }, d.label);
  });
  return s;
}
