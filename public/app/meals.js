// Posiłki: karta kalorii z pierścieniem, dodawanie (opis i/lub zdjęcie), poprawki, karta posiłku.
import { ApiError, api } from "./api.js";
import { ring } from "./charts.js";
import { SLOT_ICON, bar, badge, card, chip, dateObj, errMsg, fmtDay, h, icon, invalidateSummary, n0, nowHm, openSheet, sleep, todayLocal, toast } from "./ui.js";

const confTone = { high: "good", medium: "warn", low: "bad" };
const confLabel = { high: "pewność: wysoka", medium: "pewność: średnia", low: "pewność: niska" };

/** Karta kalorii: pierścień z tym, co zostało, i makroskładniki z paskami. */
export function kcalCard(o, { title = "Kalorie", range, onclick } = {}) {
  const t = o.targets;
  const over = t && o.totals.kcal > t.kcal * 1.06;
  const macro = (label, v, target) => h("div", { class: "macro" }, h("div", { class: "lbl" }, h("span", {}, label), h("span", {}, h("b", {}, `${n0(v)}`), target ? ` / ${n0(target)} g` : " g")), bar(target ? (v / target) * 100 : 0, "blue"));
  const left = t ? o.left.kcal : null;
  return card(
    { icon: "meal", tone: "blue", title, range: range ?? o.dayTypeLabel, onclick },
    t
      ? h("div", { class: "kcal" }, ring({ value: o.totals.kcal, max: t.kcal, tone: over ? "warn" : "blue", center: left >= 0 ? n0(left) : `+${n0(-left)}`, sub: left >= 0 ? "kcal zostało" : "ponad cel", label: "Kalorie" }), h("div", { class: "macros" }, macro("Białko", o.totals.protein, t.protein), macro("Węgle", o.totals.carbs, t.carbs), macro("Tłuszcz", o.totals.fat, t.fat)))
      : h("div", { class: "kcal" }, ring({ value: 0, max: 1, center: n0(o.totals.kcal), sub: "kcal" }), h("div", { class: "grow small warn" }, "Brak celów: wpisz wagę w zakładce Ty → Postęp.")),
    t ? h("div", { class: "row between wrap small muted" }, h("span", {}, `Zjedzone ${n0(o.totals.kcal)} z ${n0(t.kcal)} kcal`), t.deficit > 0 ? chip(`deficyt ${n0(t.deficit)}`, "blue", "trend") : null) : null,
    t && t.note ? h("div", { class: "small warn" }, t.note) : null,
  );
}

// ---------------- zdjęcia i wysyłanie ----------------

async function fileToJpeg(file, maxDim = 1280, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
    if (!blob) throw new Error("toBlob");
    return { mime: "image/jpeg", data: await blobToB64(blob), url: URL.createObjectURL(blob) };
  } catch {
    // Przeglądarka nie zdekodowała zdjęcia (np. HEIC): wysyłamy oryginał, o ile nie jest za duży.
    if (file.size > 5 * 1024 * 1024) throw new Error("Zdjęcie jest za duże i nie da się go zmniejszyć.");
    return { mime: file.type || "image/jpeg", data: await blobToB64(file), url: URL.createObjectURL(file) };
  }
}
const blobToB64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** POST z automatycznym ponawianiem, gdy Gemini jest chwilowo przeciążony. */
export async function postWithRetry(path, body, setStatus) {
  for (let i = 0; ; i++) {
    try {
      return await api(path, { method: "POST", body, timeoutMs: 100000 });
    } catch (e) {
      if (e instanceof ApiError && e.code === "gemini_busy" && i < 3) {
        setStatus(`Gemini jest chwilowo zajęty, próbuję ponownie (${i + 1}/3)…`);
        await sleep(4000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

const statusRow = (m, spin = true) => h("div", { class: "status" }, spin ? h("div", { class: "spinner" }) : null, m);

export function openAddMeal({ date = todayLocal(), onSaved } = {}) {
  openSheet((close) => {
    let image = null;
    const text = h("textarea", { placeholder: "np. szakszuka z 2 jajek na łyżce masła + 2 kromki chleba proteinowego Grzybki", "aria-label": "Opis posiłku" });
    const time = h("input", { type: "time", value: date === todayLocal() ? nowHm() : "12:00", "aria-label": "Godzina" });
    const preview = h("div", {});
    const status = h("div", {});
    const submit = h("button", { class: "btn block" }, "Dodaj posiłek");
    const pick = (capture) => {
      const inp = h("input", { type: "file", accept: "image/*", ...(capture ? { capture: "environment" } : {}), style: { display: "none" } });
      inp.addEventListener("change", async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        try {
          image = await fileToJpeg(f);
          preview.replaceChildren(h("div", { class: "preview" }, h("img", { src: image.url, alt: "Zdjęcie posiłku" }), h("button", { class: "icon-btn", "aria-label": "Usuń zdjęcie", onclick: () => ((image = null), preview.replaceChildren()) }, icon("close", 16))));
        } catch (e) {
          toast(e.message, "error");
        }
      });
      document.body.append(inp);
      inp.click();
      setTimeout(() => inp.remove(), 60000);
    };
    submit.addEventListener("click", async () => {
      if (!text.value.trim() && !image) return toast("Napisz, co zjadłeś, albo dodaj zdjęcie.", "error");
      submit.disabled = true;
      const setStatus = (m) => status.replaceChildren(statusRow(m));
      setStatus(image ? "Analizuję zdjęcie…" : "Liczę kalorie…");
      try {
        const body = { text: text.value.trim(), ...(image ? { image: { mime: image.mime, data: image.data } } : {}), ...(date !== todayLocal() ? { date } : {}), time: time.value };
        const r = await postWithRetry("/meals", body, setStatus);
        invalidateSummary();
        toast(`Zapisano: ${r.meal.label} (${n0(r.meal.totals.kcal)} kcal)`);
        close();
        onSaved && onSaved(r);
      } catch (e) {
        status.replaceChildren(statusRow(`⚠️ ${errMsg(e)}${e.code === "network" ? " Sprawdź listę posiłków, mógł się zapisać." : ""}`, false));
        submit.disabled = false;
      }
    });
    return h(
      "div",
      { class: "form" },
      h("h3", {}, date === todayLocal() ? "Dodaj posiłek" : `Dodaj posiłek (${fmtDay(date)})`),
      text,
      preview,
      h("div", { class: "row wrap" }, h("button", { class: "btn ghost small", onclick: () => pick(true) }, icon("camera", 16), "Zdjęcie"), h("button", { class: "btn ghost small", onclick: () => pick(false) }, icon("image", 16), "Galeria"), h("div", { class: "grow" }), h("label", { class: "field", style: { width: "112px" } }, "Godzina", time)),
      h("div", { class: "small muted" }, "Możesz dodać samo zdjęcie, sam opis albo oba. Opis ma pierwszeństwo (np. „połowa porcji”, „150 g”)."),
      status,
      submit,
    );
  });
}

export function openRevise(meal, onSaved) {
  openSheet((close) => {
    const text = h("textarea", { placeholder: "np. to było 200 g, bez sosu, to skyr naturalny", "aria-label": "Poprawka" });
    const status = h("div", {});
    const submit = h("button", { class: "btn block" }, "Popraw");
    submit.addEventListener("click", async () => {
      if (!text.value.trim()) return toast("Napisz, co poprawić.", "error");
      submit.disabled = true;
      const setStatus = (m) => status.replaceChildren(statusRow(m));
      setStatus("Poprawiam…");
      try {
        const r = await postWithRetry(`/meals/${meal.id}/revise`, { text: text.value.trim() }, setStatus);
        invalidateSummary();
        toast(`Poprawiono: ${n0(r.meal.totals.kcal)} kcal`);
        close();
        onSaved(r);
      } catch (e) {
        status.replaceChildren(statusRow(`⚠️ ${errMsg(e)}`, false));
        submit.disabled = false;
      }
    });
    return h("div", { class: "form" }, h("h3", {}, `Popraw: ${meal.label}`), text, status, submit);
  });
}

export function mealCard(m, reload) {
  const items = h("div", { class: "items", hidden: true }, m.items.map((i) => h("div", { class: "it" }, h("span", {}, `${i.name}${i.grams ? ` · ${i.grams} g` : ""}${i.label ? " 🏷" : ""}${i.confidence === "low" ? " (?)" : ""}`), h("span", {}, `${n0(i.kcal)} kcal · B${n0(i.protein)} W${n0(i.carbs)} T${n0(i.fat)}`))));
  const toggle = h("button", { class: "btn ghost small", onclick: () => ((items.hidden = !items.hidden), (toggle.textContent = items.hidden ? "Składniki" : "Ukryj")) }, "Składniki");
  return h(
    "div",
    { class: "card meal" },
    h("div", { class: "head" }, badge(SLOT_ICON(m.slot, m.time), "blue"), h("div", { class: "grow" }, h("span", { class: "time" }, m.time), m.slot ? h("span", { class: "muted small", style: { marginLeft: "8px" } }, m.slot) : null), h("span", { class: "kc" }, `${n0(m.totals.kcal)} kcal`)),
    h("div", {}, m.label),
    h("div", { class: "row wrap small muted" }, h("span", {}, `B ${n0(m.totals.protein)} · W ${n0(m.totals.carbs)} · T ${n0(m.totals.fat)} g`), chip(confLabel[m.confidence] || "", confTone[m.confidence] || ""), m.source === "photo" ? chip("zdjęcie", "", "camera") : null),
    m.question ? h("div", { class: "q" }, `❓ ${m.question} (stuknij „Popraw” i odpowiedz)`) : null,
    items,
    h(
      "div",
      { class: "actions" },
      toggle,
      h("button", { class: "btn ghost small", onclick: () => openRevise(m, reload) }, icon("edit", 15), "Popraw"),
      h("button", { class: "btn ghost small", "aria-label": "Dodaj do ulubionych", onclick: async () => {
        try {
          await api(`/meals/${m.id}/favorite`, { method: "POST" });
          toast("Dodano do ulubionych ⭐");
        } catch (e) {
          toast(errMsg(e), "error");
        }
      } }, icon("star", 15)),
      h("button", { class: "btn danger small", "aria-label": "Usuń posiłek", onclick: async () => {
        if (!confirm(`Usunąć: ${m.label}?`)) return;
        try {
          await api(`/meals/${m.id}`, { method: "DELETE" });
          invalidateSummary();
          toast("Usunięto");
          reload();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      } }, icon("trash", 15)),
    ),
  );
}

export const dateLabel = (date) => (date === todayLocal() ? "Dziś" : fmtDay(date));
export { dateObj };
