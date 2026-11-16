// Janek Trener: aplikacja (PWA). Czysty JavaScript bez bundlera. Dane od serwera i od modelu AI wstawiamy wyłącznie jako
// tekst (textContent), nigdy jako HTML, więc nazwa produktu z "<" czy "&" niczego nie zepsuje ani nie wstrzyknie.
import { ApiError, api, auth } from "./api.js";
import { weekChart, weightChart } from "./charts.js";

// ---------------- pomocnicze ----------------

const pad = (n) => String(n).padStart(2, "0");
const WD = ["Nd", "Pn", "Wt", "Śr", "Cz", "Pt", "So"];
const dateObj = (d) => new Date(`${d}T12:00:00Z`);
const fmtDay = (d) => {
  const x = dateObj(d);
  return `${WD[x.getUTCDay()]} ${x.getUTCDate()}.${pad(x.getUTCMonth() + 1)}`;
};
const n0 = (n) => (n == null || Number.isNaN(n) ? "–" : Math.round(n).toLocaleString("pl-PL"));
const n1 = (n) => (n == null || Number.isNaN(n) ? "–" : (Math.round(n * 10) / 10).toLocaleString("pl-PL"));
const todayLocal = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const nowHm = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const addDays = (d, n) => {
  const x = dateObj(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = (p) => (p ? `${Math.floor(p)}:${pad(Math.round((p % 1) * 60))}/km` : "");

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
/** Tworzy element. Teksty jako dzieci trafiają do węzłów tekstowych, więc są bezpieczne. */
function h(tag, props = {}, ...kids) {
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

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/></svg>',
  food: '<svg viewBox="0 0 24 24"><path d="M6 3v8a2 2 0 0 0 2 2v8"/><path d="M10 3v8"/><path d="M6 7h4"/><path d="M17 3c-2 2-3 5-3 8h3v10"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v11H9.5L5 20v-3.5H4z"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3.5-4 3 2.5L19 8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
};
const icon = (name) => {
  const s = document.createElement("span");
  s.innerHTML = ICONS[name]; // stałe, własne znaczniki (nie dane użytkownika)
  s.style.display = "contents";
  return s;
};

function toast(msg, kind = "info", ms = 3800) {
  const t = h("div", { class: `toast ${kind === "error" ? "error" : ""}` }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
const errMsg = (e) => (e instanceof ApiError ? e.message : "Coś poszło nie tak.");

function openSheet(build) {
  const bg = h("div", { class: "sheet-bg", onclick: (e) => e.target === bg && close() });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, h("div", { class: "grab" }));
  const close = () => bg.remove();
  append(sheet, [build(close)]);
  bg.append(sheet);
  document.body.append(bg);
  return close;
}

const loading = (text = "Ładuję…") => h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "spinner" }), h("span", { class: "muted" }, text)));
const empty = (text) => h("div", { class: "empty" }, text);
const verdictClass = (v) => (v === "dobra" ? "good" : v === "znosna" ? "ok" : "bad");
const confLabel = { high: "pewność: wysoka", medium: "pewność: średnia", low: "pewność: niska" };

function bar(pct, cls = "") {
  return h("div", { class: `bar ${cls}` }, h("i", { style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
}
function topbar(title, sub, ...right) {
  return h("div", { class: "topbar" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "row" }, ...right));
}
function refreshBtn(fn) {
  const b = h("button", { class: "icon-btn", "aria-label": "Odśwież", onclick: fn });
  b.append(icon("refresh"));
  return b;
}

// ---------------- wspólne bloki ----------------

function kcalCard(o, { title = "Jedzenie" } = {}) {
  const t = o.targets;
  const pct = t ? (o.totals.kcal / t.kcal) * 100 : 0;
  const over = t && o.totals.kcal > t.kcal * 1.06;
  const macro = (label, v, target) => h("div", { class: "macro" }, h("div", { class: "lbl" }, h("span", {}, label), h("span", {}, target ? `${n0(target)} g` : "")), h("div", { class: "val" }, `${n0(v)} g`), bar(target ? (v / target) * 100 : 0, label === "Białko" ? "green" : ""));
  return h(
    "div",
    { class: "card" },
    h("h2", {}, title, h("span", { class: "chip" }, o.dayTypeLabel || "")),
    t
      ? [
          h("div", { class: "row between" }, h("div", {}, h("span", { class: "big" }, n0(o.totals.kcal)), h("span", { class: "muted" }, ` / ${n0(t.kcal)} kcal`)), h("div", { class: `small ${over ? "warn" : "muted"}` }, o.left.kcal >= 0 ? `zostało ${n0(o.left.kcal)}` : `ponad o ${n0(-o.left.kcal)}`)),
          bar(pct, over ? "amber" : "green"),
          h("div", { class: "macros" }, macro("Białko", o.totals.protein, t.protein), macro("Węgle", o.totals.carbs, t.carbs), macro("Tłuszcz", o.totals.fat, t.fat)),
          t.deficit > 0 ? h("div", { class: "small muted" }, `🎯 Cel uwzględnia deficyt ${n0(t.deficit)} kcal (redukcja)`) : null,
          t.note ? h("div", { class: "small warn" }, t.note) : null,
        ]
      : [h("div", { class: "row between" }, h("div", {}, h("span", { class: "big" }, n0(o.totals.kcal)), h("span", { class: "muted" }, " kcal")), null), h("div", { class: "small warn" }, "Brak celów: wpisz wagę w zakładce Postęp.")],
  );
}

/** Różnica do planu wagi: dodatnia = lżej niż w planie. */
function aheadLabel(ahead) {
  if (ahead == null) return "";
  if (Math.abs(ahead) < 0.2) return h("strong", { class: "pos" }, "zgodnie z planem");
  return h("strong", { class: ahead > 0 ? "pos" : "warn" }, ahead > 0 ? `${n1(ahead)} kg do przodu` : `${n1(-ahead)} kg do planu`);
}

function weatherChips(day) {
  if (!day || !day.okna) return null;
  const names = { poranek: "rano", poludnie: "południe", wieczor: "wieczór" };
  const chips = Object.entries(day.okna).map(([k, w]) => h("span", { class: `chip ${verdictClass(w.ocena)}`, title: (w.powody || []).join(", ") }, `${names[k] || k} ${w.start} · ${w.temp_c}°C · ${w.ocena}`));
  return h("div", { class: "chips" }, chips);
}

function workoutLine(p) {
  return h("div", { class: "row between wrap" }, h("div", { class: "grow" }, h("strong", {}, p.name)), h("span", { class: "muted small" }, [p.km ? `${n1(p.km)} km` : null, p.minutes ? `${p.minutes} min` : null].filter(Boolean).join(" · ")));
}

// ---------------- dodawanie posiłku ----------------

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
async function postWithRetry(path, body, setStatus) {
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

function openAddMeal({ date, onSaved }) {
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
          preview.replaceChildren(
            h("div", { class: "preview" }, h("img", { src: image.url, alt: "Zdjęcie posiłku" }), h("button", { class: "icon-btn", style: { width: "30px", height: "30px" }, "aria-label": "Usuń zdjęcie", onclick: () => { image = null; preview.replaceChildren(); } }, "✕")),
          );
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
      const setStatus = (m) => status.replaceChildren(h("div", { class: "status" }, h("div", { class: "spinner" }), m));
      setStatus(image ? "Analizuję zdjęcie…" : "Liczę kalorie…");
      try {
        const body = { text: text.value.trim(), ...(image ? { image: { mime: image.mime, data: image.data } } : {}), ...(date !== todayLocal() ? { date } : {}), time: time.value };
        const r = await postWithRetry("/meals", body, setStatus);
        toast(`Zapisano: ${r.meal.label} (${n0(r.meal.totals.kcal)} kcal)`);
        close();
        onSaved && onSaved(r);
      } catch (e) {
        status.replaceChildren(h("div", { class: "status" }, `⚠️ ${errMsg(e)}${e.code === "network" ? " Sprawdź listę posiłków, mógł się zapisać." : ""}`));
        submit.disabled = false;
      }
    });
    return h(
      "div",
      { class: "form" },
      h("h3", {}, date === todayLocal() ? "Dodaj posiłek" : `Dodaj posiłek (${fmtDay(date)})`),
      text,
      preview,
      h("div", { class: "row wrap" }, h("button", { class: "btn ghost small", onclick: () => pick(true) }, "📷 Zrób zdjęcie"), h("button", { class: "btn ghost small", onclick: () => pick(false) }, "🖼 Z galerii"), h("div", { class: "grow" }), h("label", { class: "field", style: { width: "110px" } }, "Godzina", time)),
      h("div", { class: "small muted" }, "Możesz dodać samo zdjęcie, sam opis albo oba. Opis ma pierwszeństwo (np. „połowa porcji”, „150 g”)."),
      status,
      submit,
    );
  });
}

function openRevise(meal, onSaved) {
  openSheet((close) => {
    const text = h("textarea", { placeholder: "np. to było 200 g, bez sosu, to skyr naturalny", "aria-label": "Poprawka" });
    const status = h("div", {});
    const submit = h("button", { class: "btn block" }, "Popraw");
    submit.addEventListener("click", async () => {
      if (!text.value.trim()) return toast("Napisz, co poprawić.", "error");
      submit.disabled = true;
      const setStatus = (m) => status.replaceChildren(h("div", { class: "status" }, h("div", { class: "spinner" }), m));
      setStatus("Poprawiam…");
      try {
        const r = await postWithRetry(`/meals/${meal.id}/revise`, { text: text.value.trim() }, setStatus);
        toast(`Poprawiono: ${n0(r.meal.totals.kcal)} kcal`);
        close();
        onSaved(r);
      } catch (e) {
        status.replaceChildren(h("div", { class: "status" }, `⚠️ ${errMsg(e)}`));
        submit.disabled = false;
      }
    });
    return h("div", { class: "form" }, h("h3", {}, `Popraw: ${meal.label}`), text, status, submit);
  });
}

// ---------------- widok: Dziś ----------------

async function viewToday(root, nav) {
  root.append(topbar("Dziś", "", refreshBtn(() => nav())), loading("Zbieram dane z Garmina, planu i pogody…"));
  let d;
  try {
    d = await api("/summary");
  } catch (e) {
    root.replaceChildren(topbar("Dziś", "", refreshBtn(() => nav())), h("div", { class: "card" }, h("div", {}, `⚠️ ${errMsg(e)}`), h("button", { class: "btn", onclick: () => nav() }, "Spróbuj ponownie")));
    return;
  }
  const out = [];
  out.push(topbar(d.greeting, `${d.now.weekdayPl}, ${fmtDay(d.now.date)} · ${d.now.time}`, refreshBtn(() => nav())));
  out.push(h("div", { class: "card hero" }, h("div", { class: "big" }, `Maraton za ${d.marathon.daysLeft} dni`), h("div", { class: "muted" }, `25.04.2027 · cel ${d.marathon.goal} (${d.marathon.pace})`)));

  for (const r of d.recommendations) {
    out.push(h("div", { class: `card reco p${r.priority}` }, h("div", { class: "ic" }, r.icon), h("div", {}, h("h3", {}, r.title), h("p", {}, r.text))));
  }
  if (!d.recommendations.length) out.push(h("div", { class: "card" }, h("div", { class: "muted" }, "Na razie nic do dodania, jedziesz zgodnie z planem. 👌")));

  if (d.food) {
    out.push(kcalCard(d.food));
    out.push(h("button", { class: "btn block", onclick: () => openAddMeal({ date: d.now.date, onSaved: () => nav() }) }, "＋ Dodaj posiłek"));
    if (d.food.garmin && d.food.garmin.total) {
      const g = d.food.garmin;
      const diff = d.food.totals.kcal - g.total;
      out.push(
        h(
          "div",
          { class: "card" },
          h("h2", {}, "Spalone (Garmin)", g.partial ? h("span", { class: "chip low" }, "dzień trwa") : null),
          h("div", { class: "row between" }, h("div", {}, h("span", { class: "big" }, n0(g.total)), h("span", { class: "muted" }, " kcal")), h("div", { class: "small muted" }, `spoczynkowe ${n0(g.resting)} + aktywne ${n0(g.active)}`)),
          !g.partial && d.food.meals.length ? h("div", { class: "small" }, `Zjedzone minus spalone: `, h("strong", { class: diff <= 0 ? "pos" : "warn" }, `${diff > 0 ? "+" : ""}${n0(diff)} kcal`)) : null,
          h("div", { class: "small muted" }, "Zegarek zawyża spalanie (zwłaszcza aktywne), więc to wartość orientacyjna; cele liczymy z korektą."),
        ),
      );
    }
  }

  const tr = d.training;
  const todayBits = [];
  tr.today.planned.forEach((p) => todayBits.push(workoutLine(p)));
  tr.today.done.forEach((a) => todayBits.push(h("div", { class: "row between wrap" }, h("div", { class: "grow" }, "✅ ", h("strong", {}, a.name)), h("span", { class: "muted small" }, [a.km ? `${n1(a.km)} km` : null, a.minutes ? `${a.minutes} min` : null, pace(a.paceMinPerKm)].filter(Boolean).join(" · ")))));
  out.push(
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Trening"),
      h("h3", {}, "Dziś"),
      todayBits.length ? todayBits : h("div", { class: "muted" }, "Nic w planie."),
      d.weather.today ? weatherChips(d.weather.today) : null,
      h("hr"),
      h("h3", {}, `Jutro${tr.tomorrow.dayTypeLabel ? ` · ${tr.tomorrow.dayTypeLabel}` : ""}`),
      tr.tomorrow.planned.length ? tr.tomorrow.planned.map(workoutLine) : h("div", { class: "muted" }, "Wolne od biegania."),
      d.weather.tomorrow ? weatherChips(d.weather.tomorrow) : null,
      h("button", { class: "btn ghost", onclick: () => (location.hash = "#/plan") }, "Cały plan i trasy →"),
    ),
  );

  if (d.recovery) {
    const r = d.recovery;
    out.push(
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Regeneracja"),
        h("div", { class: "chips" },
          r.sleepH != null ? h("span", { class: `chip ${r.sleepH < 5.5 ? "bad" : r.sleepH < 7 ? "ok" : "good"}` }, `😴 sen ${n1(r.sleepH)} h${r.sleepScore ? ` (${r.sleepScore}/100)` : ""}`) : null,
          r.bbPeak != null ? h("span", { class: `chip ${r.bbPeak < 30 ? "bad" : r.bbPeak < 60 ? "ok" : "good"}` }, `🔋 bateria ${r.bbPeak} → ${r.bbNow ?? "?"}`) : null,
          r.hrv != null ? h("span", { class: "chip" }, `❤️ HRV ${r.hrv}${r.hrvStatus ? ` · ${String(r.hrvStatus).toLowerCase()}` : ""}`) : null,
          r.restingHr != null ? h("span", { class: "chip" }, `tętno spocz. ${r.restingHr}`) : null,
          r.steps != null ? h("span", { class: "chip" }, `👣 ${n0(r.steps)} kroków`) : null,
        ),
      ),
    );
  }

  const w = d.weight;
  out.push(
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Waga i cel", h("a", { href: "#/postep", class: "small", style: { color: "var(--accent)", textDecoration: "none", textTransform: "none", letterSpacing: 0 } }, "Postęp →")),
      w.last
        ? [
            h("div", { class: "row between" }, h("div", {}, h("span", { class: "big" }, n1(w.last.kg)), h("span", { class: "muted" }, " kg")), h("div", { class: "small muted" }, w.goalKg ? `cel ${n1(w.goalKg)} kg · zostało ${n1(w.toGoKg)} kg` : "")),
            w.planKgToday != null ? h("div", { class: "small" }, `Wg planu dziś ok. ${n1(w.planKgToday)} kg: `, aheadLabel(w.aheadKg)) : null,
            w.requiredKgPerWeek ? h("div", { class: "small muted" }, `Potrzebne tempo do ${w.goalDate}: ok. ${n1(w.requiredKgPerWeek)} kg tygodniowo.`) : null,
          ]
        : h("div", { class: "muted" }, "Brak ważeń. Dodaj pierwsze w zakładce Postęp."),
    ),
  );
  if (d.errors.length) out.push(h("div", { class: "sub" }, `Część danych niedostępna: ${d.errors.join("; ")}`));
  root.replaceChildren(...out);
}

// ---------------- widok: Jedzenie ----------------

async function viewFood(root) {
  let date = todayLocal();
  const holder = h("div", { class: "view-inner", style: { display: "flex", flexDirection: "column", gap: "12px" } });
  root.append(holder);
  const fab = h("button", { class: "fab", "aria-label": "Dodaj posiłek", onclick: () => openAddMeal({ date, onSaved: load }) }, "＋");
  document.body.append(fab);
  root._cleanup = () => fab.remove();

  async function load() {
    holder.replaceChildren(topbar("Jedzenie", ""), loading());
    let o, favs;
    try {
      [o, favs] = await Promise.all([api(`/meals?date=${date}`), api("/favorites")]);
    } catch (e) {
      holder.replaceChildren(topbar("Jedzenie", ""), h("div", { class: "card" }, `⚠️ ${errMsg(e)}`, h("button", { class: "btn", onclick: load }, "Spróbuj ponownie")));
      return;
    }
    const nav = h(
      "div",
      { class: "datenav" },
      h("button", { class: "icon-btn", "aria-label": "Poprzedni dzień", onclick: () => ((date = addDays(date, -1)), load()) }, "‹"),
      h("div", { style: { textAlign: "center" } }, h("strong", {}, date === todayLocal() ? "Dziś" : fmtDay(date)), h("div", { class: "sub" }, `${dateObj(date).getUTCDate()}.${pad(dateObj(date).getUTCMonth() + 1)}.${dateObj(date).getUTCFullYear()}`)),
      h("button", { class: "icon-btn", "aria-label": "Następny dzień", disabled: date >= todayLocal(), onclick: () => ((date = addDays(date, 1)), load()) }, "›"),
    );
    const out = [nav, kcalCard(o, { title: "Podsumowanie dnia" })];
    if (favs.favorites.length && date === todayLocal()) {
      out.push(
        h("div", { class: "card" }, h("h2", {}, "⭐ Ulubione (dodaj jednym stuknięciem)"), h("div", { class: "chips" }, favs.favorites.map((f) => h("button", { class: "chip", style: { cursor: "pointer" }, onclick: async () => {
          try {
            await api(`/favorites/${f.index}/log`, { method: "POST" });
            toast(`Dodano: ${f.name}`);
            load();
          } catch (e) {
            toast(errMsg(e), "error");
          }
        } }, `${f.name} · ${n0(f.kcal)} kcal`)))),
      );
    }
    if (!o.meals.length) out.push(empty("Na razie pusto. Stuknij ＋, żeby dodać posiłek."));
    for (const m of o.meals) out.push(mealCard(m, load));
    if (o.garmin && o.garmin.total) out.push(h("div", { class: "small muted" }, `⌚ Garmin: spalone ${n0(o.garmin.total)} kcal (spoczynkowe ${n0(o.garmin.resting)} + aktywne ${n0(o.garmin.active)})${o.garmin.partial ? ", dzień trwa" : ""}.`));
    holder.replaceChildren(...out);
  }
  await load();
}

function mealCard(m, reload) {
  const items = h("div", { class: "items", hidden: true }, m.items.map((i) => h("div", { class: "it" }, h("span", {}, `${i.name}${i.grams ? ` · ${i.grams} g` : ""}${i.label ? " 🏷" : ""}${i.confidence === "low" ? " (?)" : ""}`), h("span", {}, `${n0(i.kcal)} kcal · B${n0(i.protein)} W${n0(i.carbs)} T${n0(i.fat)}`))));
  const toggle = h("button", { class: "btn ghost small", onclick: () => ((items.hidden = !items.hidden), (toggle.textContent = items.hidden ? "Składniki" : "Ukryj")) }, "Składniki");
  return h(
    "div",
    { class: "card meal" },
    h("div", { class: "head" }, h("div", { class: "grow" }, h("span", { class: "time" }, m.time), m.slot ? h("span", { class: "chip", style: { marginLeft: "8px" } }, m.slot) : null), h("span", { class: "kc" }, `${n0(m.totals.kcal)} kcal`)),
    h("div", {}, m.label),
    h("div", { class: "row wrap small muted" }, h("span", {}, `B ${n0(m.totals.protein)} · W ${n0(m.totals.carbs)} · T ${n0(m.totals.fat)} g`), h("span", { class: `chip ${m.confidence === "high" ? "good" : m.confidence === "low" ? "bad" : "ok"}` }, confLabel[m.confidence] || ""), m.source === "photo" ? h("span", { class: "chip" }, "📷") : null),
    m.question ? h("div", { class: "q" }, `❓ ${m.question} (stuknij „Popraw” i odpowiedz)`) : null,
    items,
    h(
      "div",
      { class: "actions" },
      toggle,
      h("button", { class: "btn ghost small", onclick: () => openRevise(m, reload) }, "✏️ Popraw"),
      h("button", { class: "btn ghost small", onclick: async () => {
        try {
          await api(`/meals/${m.id}/favorite`, { method: "POST" });
          toast("Dodano do ulubionych ⭐");
        } catch (e) {
          toast(errMsg(e), "error");
        }
      } }, "⭐"),
      h("button", { class: "btn danger small", onclick: async () => {
        if (!confirm(`Usunąć: ${m.label}?`)) return;
        try {
          await api(`/meals/${m.id}`, { method: "DELETE" });
          toast("Usunięto");
          reload();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      } }, "🗑"),
    ),
  );
}

// ---------------- widok: Plan ----------------

async function viewPlan(root, nav) {
  root.append(topbar("Plan", "", refreshBtn(() => nav())), loading("Pobieram plan z intervals.icu…"));
  let d;
  try {
    d = await api("/plan");
  } catch (e) {
    root.replaceChildren(topbar("Plan", ""), h("div", { class: "card" }, `⚠️ ${errMsg(e)}`, h("button", { class: "btn", onclick: () => nav() }, "Spróbuj ponownie")));
    return;
  }
  const out = [topbar("Plan treningowy", `Ostatnie 7 dni: ${n1(d.runKmLast7)} km · 14 dni: ${n1(d.runKmLast14)} km`, refreshBtn(() => nav()))];

  const weeks = h("select", { "aria-label": "Na ile tygodni" }, [1, 2, 3, 4].map((w) => h("option", { value: w, ...(w === 2 ? { selected: true } : {}) }, `${w} ${w === 1 ? "tydzień" : "tygodnie"}`)));
  const note = h("input", { type: "text", placeholder: "Uwagi dla trenera (opcjonalnie), np. w piątek nie mogę" });
  const ask = h("button", { class: "btn block" }, "🤖 Poproś trenera o plan");
  ask.addEventListener("click", async () => {
    ask.disabled = true;
    try {
      const r = await api("/coach/plan", { method: "POST", body: { weeks: Number(weeks.value), note: note.value.trim() } });
      toast(r.message, "info", 6000);
      location.hash = "#/trener";
    } catch (e) {
      toast(errMsg(e), "error");
      ask.disabled = false;
    }
  });
  out.push(h("div", { class: "card" }, h("h2", {}, "Nowy plan"), h("div", { class: "small muted" }, "Trener (Claude) ułoży plan wg ustalonych zasad (cel maratonu, regeneracja, pogoda) i wpisze go do kalendarza. Odpowiedź przyjdzie w zakładce Trener."), weeks, note, ask));

  const days = new Map();
  for (const p of d.upcoming) (days.get(p.date) || days.set(p.date, []).get(p.date)).push(p);
  if (!days.size) out.push(h("div", { class: "card" }, h("div", { class: "muted" }, "W kalendarzu nie ma jeszcze treningów na najbliższe dwa tygodnie. Poproś trenera o plan powyżej.")));
  for (const [date, items] of days) {
    const wd = d.weather.find((x) => x.data === date);
    for (const p of items) out.push(planCard(p, wd));
  }
  if (d.recent.length) {
    out.push(
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Ostatnie aktywności"),
        d.recent.slice(0, 8).map((a) => h("div", { class: "row between wrap" }, h("div", { class: "grow" }, h("strong", {}, a.name), h("div", { class: "small muted" }, `${fmtDay(a.date)} ${a.time}`)), h("span", { class: "small muted" }, [a.km ? `${n1(a.km)} km` : null, a.minutes ? `${a.minutes} min` : null, pace(a.paceMinPerKm), a.avgHr ? `${a.avgHr} bpm` : null].filter(Boolean).join(" · ")))),
      ),
    );
  }
  if (d.errors.length) out.push(h("div", { class: "sub" }, `Część danych niedostępna: ${d.errors.join("; ")}`));
  root.replaceChildren(...out);
}

function planCard(p, weatherDay) {
  const routes = h("div", { class: "wk" });
  const descr = p.description ? h("div", { class: "descr", hidden: true }, p.description) : null;
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
              h("div", { class: "route" }, h("div", { class: "row between" }, h("strong", {}, `Trasa ${o.label} · ${n1(o.km)} km`), h("span", { class: "chip" }, o.kind === "park" ? "przez parki" : "pętla ORS")), h("div", { class: "small muted" }, `nieutwardzona ${n0(o.unpavedPct)}% · zieleń ${n1(o.greenAvg)}/10 · dwa razy tą samą drogą ${n0(o.retracePct)}%${o.via ? ` · przez ${o.via.join(", ")}` : ""}`), h("div", { class: "links" }, h("a", { href: o.mapUrl, target: "_blank", rel: "noopener" }, "Mapa"), h("a", { href: o.gpxUrl, target: "_blank", rel: "noopener" }, "Pobierz GPX"))),
            ),
          );
        } catch (e) {
          routes.replaceChildren(h("div", { class: "status" }, `⚠️ ${errMsg(e)}`));
        }
        routeBtn.disabled = false;
      } }, "🗺 Zaproponuj trasy")
    : null;
  return h(
    "div",
    { class: "card" },
    h("div", { class: "row between wrap" }, h("div", { class: "date" }, fmtDay(p.date)), h("div", { class: "muted small" }, [p.km ? `${n1(p.km)} km` : null, p.minutes ? `${p.minutes} min` : null].filter(Boolean).join(" · "))),
    h("h3", {}, p.name),
    weatherDay ? weatherChips(weatherDay) : null,
    descr,
    h("div", { class: "actions" }, descr ? h("button", { class: "btn ghost small", onclick: (e) => ((descr.hidden = !descr.hidden), (e.target.textContent = descr.hidden ? "Kroki treningu" : "Ukryj")) }, "Kroki treningu") : null, routeBtn),
    routes,
  );
}

// ---------------- widok: Trener ----------------

async function viewCoach(root) {
  const list = h("div", { class: "chat" });
  const status = h("div", { class: "sub", style: { textAlign: "center" } });
  root.classList.add("has-composer");
  root.append(topbar("Trener", "Ta sama rozmowa co na Telegramie"), list, status);
  const ta = h("textarea", { placeholder: "Napisz do trenera…", rows: 1, "aria-label": "Wiadomość do trenera" });
  const send = h("button", { class: "btn" }, "Wyślij");
  const composer = h("div", { class: "composer" }, h("div", { class: "inner" }, ta, send));
  document.body.append(composer);
  let timer = null;
  let stopped = false;
  root._cleanup = () => {
    stopped = true;
    clearTimeout(timer);
    composer.remove();
    root.classList.remove("has-composer");
  };

  const hm = (iso) => new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  async function refresh(scroll) {
    try {
      const r = await api("/coach");
      list.replaceChildren(...(r.messages.length ? r.messages.map((m) => h("div", { class: `bubble ${m.from === "jan" ? "me" : "coach"}` }, m.text, h("time", {}, hm(m.at)))) : [empty("Napisz pierwszą wiadomość. Trener (Claude) zna Twój plan, dane z Garmina i jedzenie.")]));
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
  await refresh(true);
}

// ---------------- widok: Postęp ----------------

async function viewProgress(root, nav) {
  root.append(topbar("Postęp", "", refreshBtn(() => nav())), loading());
  let wt, wk, st;
  try {
    [wt, wk, st] = await Promise.all([api("/weight"), api("/week"), api("/settings")]);
  } catch (e) {
    root.replaceChildren(topbar("Postęp", ""), h("div", { class: "card" }, `⚠️ ${errMsg(e)}`, h("button", { class: "btn", onclick: () => nav() }, "Spróbuj ponownie")));
    return;
  }
  const out = [topbar("Postęp", "Waga, tydzień i ustawienia", refreshBtn(() => nav()))];

  // waga
  const p = wt.progress;
  const kg = h("input", { type: "number", step: "0.1", inputmode: "decimal", placeholder: "np. 106,5", "aria-label": "Waga w kg" });
  const addW = h("button", { class: "btn" }, "Zapisz wagę");
  addW.addEventListener("click", async () => {
    if (!kg.value) return toast("Wpisz wagę.", "error");
    addW.disabled = true;
    try {
      await api("/weight", { method: "POST", body: { kg: kg.value } });
      toast("Zapisano wagę ⚖️");
      nav();
    } catch (e) {
      toast(errMsg(e), "error");
      addW.disabled = false;
    }
  });
  out.push(
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Waga"),
      weightChart({ entries: wt.entries, plan: wt.plan, goalKg: wt.goalKg }),
      h("div", { class: "chips" }, h("span", { class: "chip", style: { color: "#6ea8ff" } }, "● ważenia"), h("span", { class: "chip", style: { color: "#a78bfa" } }, "┅ plan do celu"), h("span", { class: "chip", style: { color: "#4ade80" } }, "┅ cel")),
      h("div", { class: "macros" },
        h("div", { class: "macro" }, h("div", { class: "lbl" }, "Ostatnia"), h("div", { class: "val" }, p.last ? `${n1(p.last.kg)} kg` : "–")),
        h("div", { class: "macro" }, h("div", { class: "lbl" }, "Do celu"), h("div", { class: "val" }, p.toGoKg != null ? `${n1(p.toGoKg)} kg` : "–")),
        h("div", { class: "macro" }, h("div", { class: "lbl" }, "Tempo"), h("div", { class: "val" }, p.trendKgPerWeek != null ? `${n1(p.trendKgPerWeek)} kg/tydz.` : "brak danych")),
      ),
      p.planKgToday != null ? h("div", { class: "small" }, `Wg planu dziś ok. ${n1(p.planKgToday)} kg: `, aheadLabel(p.aheadKg), p.requiredKgPerWeek ? `. Potrzebne tempo: ok. ${n1(p.requiredKgPerWeek)} kg tygodniowo.` : ".") : null,
      h("div", { class: "small muted" }, "Waga skacze o 1–2 kg z dnia na dzień. Najlepiej ważyć się raz w tygodniu, rano, w podobnych warunkach."),
      h("div", { class: "row" }, h("div", { class: "grow" }, kg), addW),
    ),
  );

  // tydzień
  out.push(
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Ostatnie 7 dni"),
      weekChart({ days: wk.days.map((x) => ({ label: WD[dateObj(x.date).getUTCDay()], kcal: x.kcal, targetKcal: x.targetKcal, burnedKcal: x.burnedKcal, partial: x.partial })) }),
      h("div", { class: "chips" }, h("span", { class: "chip", style: { color: "#6ea8ff" } }, "▮ zjedzone"), h("span", { class: "chip", style: { color: "#4ade80" } }, "— cel"), h("span", { class: "chip", style: { color: "#fbbf24" } }, "┅ spalone (Garmin)")),
      wk.avgKcal != null ? h("div", { class: "small" }, `Średnio z zapisanych dni (${wk.loggedDays}): ${n0(wk.avgKcal)} kcal, ${n0(wk.avgProtein)} g białka.`) : h("div", { class: "small muted" }, "Za mało zapisanych dni na średnią (dzień liczy się od 2 posiłków i 1000 kcal)."),
      h("div", { class: "small muted" }, "Spalanie z Garmina jest zawyżone, więc bilans traktuj orientacyjnie; najlepszą miarą jest trend wagi."),
    ),
  );

  // ustawienia
  const s = st.settings;
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
  const save = h("button", { class: "btn block" }, "Zapisz ustawienia");
  const field = (label, el, hint) => h("label", { class: "field" }, label, el, hint ? h("span", { class: "small" }, hint) : null);
  save.addEventListener("click", async () => {
    const num = (el) => (el.value === "" ? null : Number(el.value));
    save.disabled = true;
    try {
      await api("/settings", {
        method: "PATCH",
        body: {
          deficitKcal: num(f.deficitKcal),
          garminFactor: num(f.garminFactor),
          goalWeightKg: num(f.goalWeightKg),
          goalDate: f.goalDate.value || null,
          macroWeightKg: num(f.macroWeightKg),
          proteinPerKg: num(f.proteinPerKg),
          fatPerKg: num(f.fatPerKg),
          remindAfterMin: num(f.remindAfterMin),
          remindersOn: remind.checked,
          slotsText: f.slotsText.value,
          weekendSlotsText: f.weekendSlotsText.value,
        },
      });
      toast("Zapisano ustawienia ✅");
      nav();
    } catch (e) {
      toast(errMsg(e), "error", 6000);
      save.disabled = false;
    }
  });
  out.push(
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Ustawienia"),
      h("div", { class: "form" },
        h("div", { class: "two" }, field("Deficyt (kcal)", f.deficitKcal, "tylko dni bez biegu i łatwe"), field("Korekta Garmina", f.garminFactor, "0,9 = zegarek zawyża o 10%")),
        h("div", { class: "two" }, field("Waga docelowa (kg)", f.goalWeightKg), field("Termin celu", f.goalDate)),
        h("div", { class: "two" }, field("Masa referencyjna (kg)", f.macroWeightKg, "puste = niższa z wagi i celu"), field("Białko (g/kg)", f.proteinPerKg)),
        h("div", { class: "two" }, field("Tłuszcz (g/kg)", f.fatPerKg), field("Przypomnienie po (min)", f.remindAfterMin)),
        field("Pory posiłków (pn–pt)", f.slotsText, "nazwa GG:MM, rozdzielone średnikiem"),
        field("Pory posiłków (weekend)", f.weekendSlotsText),
        h("label", { class: "check" }, remind, "Przypomnienia o posiłkach (Telegram)"),
        save,
      ),
    ),
  );

  out.push(
    h("div", { class: "card" }, h("h2", {}, "Konto"), h("button", { class: "btn danger", onclick: () => {
      auth.clear();
      render();
    } }, "Wyloguj"), h("div", { class: "small muted" }, "Aplikacja Janek Trener v1 · dane liczy serwer, zdjęcia rozpoznaje Gemini, plan układa trener (Claude).")),
  );
  root.replaceChildren(...out);
}

// ---------------- logowanie i szkielet ----------------

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
  return h("div", { class: "login" }, h("div", { class: "box" }, h("img", { src: "icon.svg", alt: "" }), h("h1", {}, "Janek Trener"), h("div", { class: "sub", style: { textAlign: "center" } }, "Plan treningowy, kalorie i regeneracja w jednym miejscu."), pw, err, btn));
}

const TABS = [
  { id: "dzis", label: "Dziś", icon: "home", view: viewToday },
  { id: "jedzenie", label: "Jedzenie", icon: "food", view: viewFood },
  { id: "plan", label: "Plan", icon: "plan", view: viewPlan },
  { id: "trener", label: "Trener", icon: "chat", view: viewCoach },
  { id: "postep", label: "Postęp", icon: "chart", view: viewProgress },
];

let currentView = null;

function render() {
  const app = document.getElementById("app");
  if (currentView && currentView._cleanup) currentView._cleanup();
  currentView = null;
  if (!auth.value) {
    app.replaceChildren(viewLogin());
    return;
  }
  const id = (location.hash.replace(/^#\/?/, "") || "dzis").split("?")[0];
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  const nav = h("nav", { class: "nav", "aria-label": "Główna nawigacja" }, TABS.map((t) => {
    const a = h("a", { href: `#/${t.id}`, class: t.id === tab.id ? "on" : "", "aria-current": t.id === tab.id ? "page" : null });
    a.append(icon(t.icon), h("span", {}, t.label));
    return a;
  }));
  const view = h("main", { class: "view" });
  app.replaceChildren(h("div", { class: "shell" }, view, nav));
  currentView = view;
  window.scrollTo(0, 0);
  tab.view(view, render).catch((e) => {
    view.replaceChildren(h("div", { class: "card" }, `⚠️ ${errMsg(e)}`));
  });
}

window.addEventListener("hashchange", render);
window.addEventListener("janek:logout", () => {
  document.getElementById("app").replaceChildren(viewLogin("Sesja wygasła. Zaloguj się ponownie."));
});
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
