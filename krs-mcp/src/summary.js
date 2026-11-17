// Defensywne wyciąganie kluczowych pól z odpisu KRS. Struktura odpisów różni się
// między formami prawnymi, więc każde pole jest opcjonalne; pełny JSON zawsze
// można pobrać narzędziem krs_odpis (tryb "raw").
const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const val = (x) => (x && typeof x === "object" && "nazwa" in x ? x.nazwa : x);
// odpis aktualny: obiekt; odpis pełny: tablica wpisów historycznych (ostatni = aktualny)
const first = (x) => (Array.isArray(x) ? x[x.length - 1] : x);

function osoba(p) {
  if (!p || typeof p !== "object") return p;
  const nazwisko = [val(p.nazwisko?.nazwiskoICzlon) ?? val(p.nazwisko), val(p.nazwisko?.nazwiskoIICzlon)].filter(Boolean).join("-");
  const imiona = [val(p.imiona?.imie), val(p.imiona?.imieDrugie)].filter(Boolean).join(" ");
  const name = [imiona, nazwisko].filter(Boolean).join(" ");
  return {
    nazwa: name || val(p.nazwa) || undefined,
    pesel: p.identyfikator?.pesel || undefined,
    funkcja: val(p.funkcjaWOrganie) || undefined,
    zawieszony: p.czyZawieszona ?? undefined,
  };
}

export function summarize(json) {
  const o = json?.odpis;
  const d = o?.dane;
  if (!d) return { uwaga: "Nietypowa struktura odpisu – użyj trybu raw", naglowek: o?.naglowekA ?? null };
  const d1 = d.dzial1 ?? {};
  const dp = d1.danePodmiotu ?? {};
  const capital = d1.kapital ?? {};
  const org = d.dzial2?.reprezentacja ?? {};
  const wspolnicy = d1.wspolnicySpzoo ?? d1.wspolnicy ?? [];
  const akcjonariusze = d1.akcje?.akcjonariusze ?? [];

  const out = {
    krs: o.naglowekA?.numerKRS ?? dp.numerKRS,
    rejestr: o.naglowekA?.rejestr,
    stan_na_dzien: o.naglowekA?.stanZDnia,
    data_ostatniego_wpisu: o.naglowekA?.dataCzasOstatniegoWpisu ?? o.naglowekA?.dataOstatniegoWpisu,
    nazwa: first(dp.nazwa),
    forma_prawna: first(dp.formaPrawna),
    nip: first(dp.identyfikatory)?.nip,
    regon: first(dp.identyfikatory)?.regon,
    siedziba: first(d1.siedzibaIAdres)?.siedziba,
    adres: first(d1.siedzibaIAdres)?.adres,
    adres_www: first(d1.siedzibaIAdres)?.adresStronyInternetowej,
    email: first(d1.siedzibaIAdres)?.adresPocztyElektronicznej,
    kapital_zakladowy: first(capital.wysokoscKapitaluZakladowego),
    kapital_wplacony: first(capital.wplaconyKapitalZakladowy),
    organ_reprezentacji: first(org)?.nazwaOrganu,
    sposob_reprezentacji: first(org.sposobReprezentacji)?.opis ?? first(org.sposobReprezentacji),
    zarzad: [].concat(first(org.sklad) ?? []).map(osoba),
    wspolnicy: (Array.isArray(wspolnicy) ? wspolnicy : []).map((w) => ({
      nazwa: w.nazwa ?? osoba(w)?.nazwa,
      krs: w.identyfikator?.krs,
      udzialy: w.posiadaneUdzialy ?? w.udzialy,
    })),
    akcjonariusze: Array.isArray(akcjonariusze) ? akcjonariusze : undefined,
    pkd_przewazajace: first(d.dzial3?.przedmiotDzialalnosci?.przedmiotPrzewazajacejDzialalnosci),
    prokurenci: (d.dzial2?.prokurenci ?? []).map?.(osoba),
  };
  // usuń puste klucze
  return JSON.parse(JSON.stringify(out, (_, v) => (v === undefined || v === null || v === "" ? undefined : v)));
}
