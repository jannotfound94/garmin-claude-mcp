// Statyczne kontrole aplikacji (public/app): składnia plików JS oraz to, że każda użyta ikona istnieje w zestawie icons.js.
// Brakująca ikona renderowałaby się jako pusty obrazek, a błąd byłby niezauważalny, więc łapiemy to w testach.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../public/app/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
let failed = false;

for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", new URL(f, dir).pathname], { stdio: "pipe" });
  } catch (e) {
    console.error(`Błąd składni w ${f}:\n${e.stderr}`);
    failed = true;
  }
}

const iconsSrc = readFileSync(new URL("icons.js", dir), "utf8");
const defined = new Set([...iconsSrc.matchAll(/^ {2}(\w+): '/gm)].map((m) => m[1]));
const patterns = [/\bicon\("(\w+)"/g, /\bbadge\("(\w+)"/g, /\biconButton\("(\w+)"/g, /\bicon: "(\w+)"/g, /\bic\b[^,\n]*"(\w+)"\)/g];
const used = new Map();
for (const f of files) {
  if (f === "icons.js") continue;
  const src = readFileSync(new URL(f, dir), "utf8");
  for (const re of patterns) for (const m of src.matchAll(re)) used.set(m[1], [...(used.get(m[1]) ?? []), f]);
}
// Mapy ikon w ui.js (pogoda, posiłki, rekomendacje) zwracają nazwy jako literały.
const ui = readFileSync(new URL("ui.js", dir), "utf8");
for (const m of ui.matchAll(/(?:return|:)\s*"(sun|cloud|rain|wind|sunrise|moon|plate|apple|battery|scale|run|info|meal)"/g)) used.set(m[1], [...(used.get(m[1]) ?? []), "ui.js"]);

const missing = [...used.keys()].filter((n) => !defined.has(n));
if (missing.length) {
  console.error(`Brakujące ikony: ${missing.map((n) => `${n} (${[...new Set(used.get(n))].join(", ")})`).join("; ")}`);
  failed = true;
}
// Nagłówek Permissions-Policy nie może wyłączać funkcji, których aplikacja używa (z "geolocation=()" przeglądarka nawet nie pyta o zgodę).
const headers = readFileSync(new URL("../_headers", dir), "utf8");
for (const [api, usedBy] of [["geolocation", "push.js"], ["camera", "meals.js"]]) {
  const uses = readFileSync(new URL(usedBy, dir), "utf8").includes(api === "camera" ? "capture" : "navigator.geolocation");
  const m = new RegExp(`${api}=\\(([^)]*)\\)`).exec(headers);
  if (uses && (!m || !/self/.test(m[1]))) {
    console.error(`Permissions-Policy w public/_headers blokuje ${api}, a aplikacja go używa (${usedBy}). Ustaw ${api}=(self).`);
    failed = true;
  }
}
console.log(`Aplikacja: ${files.length} plików JS, ${defined.size} ikon, ${used.size} użytych nazw${failed ? ": BŁĘDY" : ": OK"}`);
process.exit(failed ? 1 : 0);
