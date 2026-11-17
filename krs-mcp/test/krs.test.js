import test from "node:test";
import assert from "node:assert/strict";
import { normalizeKrs, odpis, biuletyn, KrsError } from "../src/krs-client.js";
import { summarize } from "../src/summary.js";

const sample = {
  odpis: {
    naglowekA: { rejestr: "P", numerKRS: "0000123456", stanZDnia: "01.01.2026" },
    dane: {
      dzial1: {
        danePodmiotu: {
          formaPrawna: "SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
          identyfikatory: { nip: "1234567890", regon: "123456789" },
          nazwa: "TEST SP. Z O.O.",
        },
        siedzibaIAdres: { siedziba: { miejscowosc: "WARSZAWA" }, adres: { ulica: "PROSTA" } },
        kapital: { wysokoscKapitaluZakladowego: { wartosc: "5000,00", waluta: "PLN" } },
        wspolnicySpzoo: [{ nazwa: "ABC SP. Z O.O.", posiadaneUdzialy: "100 UDZIAŁÓW" }],
      },
      dzial2: { reprezentacja: { nazwaOrganu: "ZARZĄD", sposobReprezentacji: "DWÓCH CZŁONKÓW ŁĄCZNIE" } },
    },
  },
};

test("normalizeKrs", () => {
  assert.equal(normalizeKrs("19193"), "0000019193");
  assert.equal(normalizeKrs("KRS 0000019193"), "0000019193");
  assert.throws(() => normalizeKrs("abc"), KrsError);
  assert.throws(() => normalizeKrs("12345678901"), KrsError);
});

test("summarize wyciąga kluczowe pola", () => {
  const s = summarize(sample);
  assert.equal(s.krs, "0000123456");
  assert.equal(s.nazwa, "TEST SP. Z O.O.");
  assert.equal(s.nip, "1234567890");
  assert.equal(s.wspolnicy[0].nazwa, "ABC SP. Z O.O.");
});

test("summarize nie wywala się na nietypowej strukturze", () => {
  assert.ok(summarize({}).uwaga);
});

test("odpis buduje poprawny URL i obsługuje 404", async () => {
  let url;
  const ok = async (u) => ((url = u), { ok: true, status: 200, json: async () => sample });
  await odpis("aktualny", "123456", "P", { fetchImpl: ok });
  assert.match(url, /OdpisAktualny\/0000123456\?rejestr=P&format=json$/);
  const nf = async () => ({ ok: false, status: 404 });
  await assert.rejects(odpis("pelny", "1", "P", { fetchImpl: nf }), /404/);
});

test("biuletyn waliduje datę", () => {
  assert.throws(() => biuletyn("17.11.2026"), KrsError);
});
