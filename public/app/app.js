// Garda: aplikacja (PWA). Czysty JavaScript bez bundlera. Dane od serwera i od modelu AI wstawiamy wyłącznie jako
// tekst (textContent), nigdy jako HTML, więc nazwa produktu z "<" czy "&" niczego nie zepsuje ani nie wstrzyknie.
import { api, auth } from "./api.js";
import { openAddMeal } from "./meals.js";
import { errMsg, h, icon, rerender, setRerender, toast, todayLocal } from "./ui.js";
import { viewFood } from "./view-food.js";
import { viewPlan } from "./view-plan.js";
import { viewToday } from "./view-today.js";
import { viewYou } from "./view-you.js";

function viewLogin(message = "") {
  const pw = h("input", { type: "password", placeholder: "Hasło", autocomplete: "current-password", "aria-label": "Hasło" });
  const err = h("div", { class: "err" }, message);
  const btn = h("button", { class: "btn block" }, "Zaloguj");
  const go = async () => {
    if (!pw.value) return;
    btn.disabled = true;
    err.textContent = "";
    try {
      const r = await api("/login", { method: "POST", body: { password: pw.value } });
      auth.set(r.token);
      render();
    } catch (e) {
      err.textContent = errMsg(e);
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", go);
  pw.addEventListener("keydown", (e) => e.key === "Enter" && go());
  return h("div", { class: "login" }, h("div", { class: "box" }, h("img", { src: "icon.svg", alt: "" }), h("h1", {}, "Garda"), h("div", { class: "sub", style: { textAlign: "center" } }, "Plan treningowy, kalorie i regeneracja w jednym miejscu."), pw, err, btn));
}

const NAV = [
  { id: "dzis", label: "Dziś", icon: "home" },
  { id: "jedzenie", label: "Jedzenie", icon: "meal" },
  { id: "plus" },
  { id: "plan", label: "Plan", icon: "calendar" },
  { id: "ty", label: "Ty", icon: "user" },
];
// Stare skróty z poprzedniej wersji prowadzą do nowych zakładek profilu.
const ALIAS = { trener: ["ty", "trener"], postep: ["ty", "postep"] };

let currentView = null;

function render() {
  const app = document.getElementById("app");
  if (currentView && currentView._cleanup) currentView._cleanup();
  currentView = null;
  if (!auth.value) {
    app.replaceChildren(viewLogin());
    return;
  }
  let [section = "dzis", sub] = location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
  if (ALIAS[section]) [section, sub] = ALIAS[section];
  if (!NAV.some((n) => n.id === section)) section = "dzis";

  const nav = h("nav", { class: "nav", "aria-label": "Główna nawigacja" }, NAV.map((n) => {
    if (n.id === "plus") {
      return h("div", { class: "plus" }, h("button", { "aria-label": "Dodaj posiłek", onclick: () => openAddMeal({ date: todayLocal(), onSaved: rerender }) }, icon("plus", 28)));
    }
    const a = h("a", { href: `#/${n.id}`, class: n.id === section ? "on" : "", "aria-current": n.id === section ? "page" : null });
    a.append(icon(n.icon, 24), h("span", {}, n.label));
    return a;
  }));
  const view = h("main", { class: "view" });
  app.replaceChildren(h("div", { class: "shell" }, view, nav));
  currentView = view;
  window.scrollTo(0, 0);
  const run = { dzis: () => viewToday(view), jedzenie: () => viewFood(view), plan: () => viewPlan(view), ty: () => viewYou(view, sub) }[section];
  run().catch((e) => view.replaceChildren(h("div", { class: "card" }, `⚠️ ${errMsg(e)}`)));
  // Głęboki link z powiadomienia o posiłku: #/jedzenie?add=1 otwiera od razu okno dodawania.
  if (section === "jedzenie" && /[?&]add=1/.test(location.hash)) {
    history.replaceState(null, "", "#/jedzenie");
    openAddMeal({ date: todayLocal(), onSaved: rerender });
  }
}

setRerender(render);
window.addEventListener("hashchange", render);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "push") toast(`${m.title}: ${m.body}`.slice(0, 160), "info", 7000);
    if (m.type === "navigate") {
      const hash = new URL(m.url).hash;
      if (hash) location.hash = hash;
      else render();
    }
  });
}
window.addEventListener("janek:logout", () => {
  document.getElementById("app").replaceChildren(viewLogin("Sesja wygasła. Zaloguj się ponownie."));
});
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
