// Widok "Jedzenie": pasek dni, podsumowanie z pierścieniem, ulubione i lista posiłków.
import { api } from "./api.js";
import { dateLabel, kcalCard, mealCard, openAddMeal } from "./meals.js";
import { WD, addDays, badge, card, dateObj, empty, errMsg, h, icon, invalidateSummary, loading, n0, pad, rerender, todayLocal, toast } from "./ui.js";
import { header } from "./view-today.js";

export async function viewFood(root) {
  let date = todayLocal();
  const holder = h("div", { class: "wk", style: { gap: "12px" } });
  root.append(holder);

  async function load() {
    holder.replaceChildren(header("Jedzenie", ""), loading());
    let o, favs;
    try {
      [o, favs] = await Promise.all([api(`/meals?date=${date}`), api("/favorites")]);
    } catch (e) {
      holder.replaceChildren(header("Jedzenie", ""), h("div", { class: "card" }, `⚠️ ${errMsg(e)}`, h("button", { class: "btn", onclick: load }, "Spróbuj ponownie")));
      return;
    }
    const today = todayLocal();
    const days = Array.from({ length: 15 }, (_, i) => addDays(today, -14 + i));
    const strip = h("div", { class: "datestrip", role: "tablist", "aria-label": "Wybór dnia" }, days.map((d) => {
      const x = dateObj(d);
      return h("button", { class: `dsd ${d === date ? "on" : ""}`, role: "tab", "aria-selected": d === date ? "true" : "false", onclick: () => ((date = d), load()) }, h("span", {}, WD[x.getUTCDay()]), h("b", {}, String(x.getUTCDate())));
    }));
    const x = dateObj(date);
    const out = [header("Jedzenie", `${dateLabel(date)} · ${x.getUTCDate()}.${pad(x.getUTCMonth() + 1)}.${x.getUTCFullYear()}`), strip, kcalCard(o, { title: "Podsumowanie dnia" })];
    const add = h("button", { class: "btn outline-orange block", onclick: () => openAddMeal({ date, onSaved: load }) }, icon("plus", 18), "Dodaj posiłek");

    if (favs.favorites.length && date === today) {
      out.push(
        card({ icon: "star", tone: "blue", title: "Ulubione", range: "dodaj jednym stuknięciem" }, h("div", { class: "chips" }, favs.favorites.map((f) => h("button", { class: "chip blue", onclick: async () => {
          try {
            await api(`/favorites/${f.index}/log`, { method: "POST" });
            invalidateSummary();
            toast(`Dodano: ${f.name}`);
            load();
          } catch (e) {
            toast(errMsg(e), "error");
          }
        } }, `${f.name} · ${n0(f.kcal)} kcal`)))),
      );
    }
    out.push(add);
    if (!o.meals.length) out.push(empty("Na razie pusto. Dodaj pierwszy posiłek: opisem lub zdjęciem."));
    for (const m of o.meals) out.push(mealCard(m, load));
    if (o.garmin && o.garmin.total) {
      out.push(card({ icon: "watch", tone: "orange", title: "Spalone (Garmin)", range: o.garmin.partial ? "dzień trwa" : "" }, h("div", { class: "row between wrap" }, h("span", { class: "num" }, n0(o.garmin.total), h("span", { class: "unit" }, " kcal")), h("span", { class: "small muted" }, `spoczynkowe ${n0(o.garmin.resting)} + aktywne ${n0(o.garmin.active)}`))));
    }
    holder.replaceChildren(...out);
    requestAnimationFrame(() => (strip.scrollLeft = strip.scrollWidth));
  }
  await load();
}
