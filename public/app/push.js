// Powiadomienia push (Web Push): rejestracja urządzenia na serwerze Garda. Działa w Chrome i w zainstalowanej aplikacji (PWA).
import { api } from "./api.js";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const b64ToBytes = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function registration() {
  return (await navigator.serviceWorker.getRegistration("./")) || navigator.serviceWorker.register("sw.js", { scope: "./" }).then(() => navigator.serviceWorker.ready);
}

/** Stan tego urządzenia: unsupported | denied | off | on. */
export async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await registration();
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub && Notification.permission === "granted" ? "on" : "off";
  } catch {
    return "off";
  }
}

export async function enablePush() {
  if (!pushSupported()) throw new Error("Ta przeglądarka nie obsługuje powiadomień. Użyj Chrome i zainstaluj aplikację (menu → Zainstaluj).");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Zgoda na powiadomienia nie została udzielona. Włącz ją w ustawieniach witryny w przeglądarce.");
  const reg = await registration();
  const { publicKey } = await api("/push/key");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
  return sub;
}

export async function disablePush() {
  const reg = await registration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  try {
    await api("/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } });
  } finally {
    await sub.unsubscribe();
  }
}

export const sendTest = () => api("/push/test", { method: "POST", body: {} });

/** Pobiera pozycję z GPS i zapisuje ją na serwerze jako punkt startu (pogoda i trasy). */
export function shareLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Ta przeglądarka nie udostępnia lokalizacji."));
    navigator.geolocation.getCurrentPosition(
      (p) => api("/location", { method: "POST", body: { lat: p.coords.latitude, lon: p.coords.longitude } }).then(resolve, reject),
      (e) => reject(new Error(e.code === 1 ? "Brak zgody na lokalizację. Włącz ją w ustawieniach witryny." : "Nie udało się ustalić lokalizacji. Spróbuj na zewnątrz.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}
