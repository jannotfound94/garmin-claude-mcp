// Klient Otwartego API KRS (https://api-krs.ms.gov.pl). Bez zależności poza fetch.
export const BASE_URL = process.env.KRS_API_BASE || "https://api-krs.ms.gov.pl/api/krs";

export class KrsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Normalizuje numer KRS do 10 cyfr (z zerami wiodącymi). */
export function normalizeKrs(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (!digits || digits.length > 10) {
    throw new KrsError(`Nieprawidłowy numer KRS: "${input}" (oczekiwano do 10 cyfr)`);
  }
  return digits.padStart(10, "0");
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new KrsError(`Błąd połączenia z API KRS: ${e.message}`);
  }
  if (res.status === 404) throw new KrsError("Nie znaleziono podmiotu / danych dla podanych parametrów (HTTP 404)", 404);
  if (res.status === 429) throw new KrsError("Przekroczono limit zapytań API KRS (HTTP 429) – spróbuj za chwilę", 429);
  if (!res.ok) throw new KrsError(`API KRS zwróciło HTTP ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new KrsError("API KRS zwróciło odpowiedź, która nie jest poprawnym JSON-em");
  }
}

/** rejestr: "P" (przedsiębiorców) lub "S" (stowarzyszenia i inne organizacje). */
export function odpis(kind, krs, rejestr = "P", opts) {
  const endpoint = kind === "pelny" ? "OdpisPelny" : "OdpisAktualny";
  const url = `${BASE_URL}/${endpoint}/${normalizeKrs(krs)}?rejestr=${rejestr}&format=json`;
  return getJson(url, opts);
}

/** Biuletyn zmian z danego dnia (YYYY-MM-DD). */
export function biuletyn(date, opts) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new KrsError(`Data musi mieć format YYYY-MM-DD, otrzymano "${date}"`);
  return getJson(`${BASE_URL}/Biuletyn/${date}`, opts);
}
