// Warstwa komunikacji z serwerem: token w urządzeniu, błędy z czytelnym kodem, wylogowanie przy 401.
const KEY = "garda.token";

export const auth = {
  get token() {
    try {
      return localStorage.getItem(KEY) || "";
    } catch {
      return "";
    }
  },
  set(t) {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* tryb prywatny: aplikacja zadziała do zamknięcia karty */
    }
    auth._mem = t;
  },
  clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nic */
    }
    auth._mem = "";
  },
  _mem: "",
  get value() {
    return this.token || this._mem;
  },
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", body, timeoutMs = 70000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(auth.value ? { authorization: `Bearer ${auth.value}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(0, "network", e && e.name === "AbortError" ? "Serwer nie odpowiada na czas. Spróbuj ponownie." : "Brak połączenia z serwerem.");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* pusta odpowiedź */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") {
      auth.clear();
      window.dispatchEvent(new Event("janek:logout"));
    }
    throw new ApiError(res.status, data?.error || "error", data?.message || `Błąd ${res.status}`);
  }
  return data;
}
