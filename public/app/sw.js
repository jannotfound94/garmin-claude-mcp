// Service worker: powłoka aplikacji działa offline, dane (/api) zawsze z sieci.
const CACHE = "garda-app-v3";
const SHELL = ["./", "style.css", "app.js", "api.js", "charts.js", "icons.js", "ui.js", "meals.js", "view-today.js", "view-food.js", "view-plan.js", "view-you.js", "push.js", "fasting.js", "icon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/app/")) return; // /api i reszta: sieć
  // Najpierw sieć (świeża wersja po wdrożeniu), a gdy jej brak, kopia z pamięci.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./"))),
  );
});

// ---------------- Powiadomienia push ----------------
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "Garda", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Gdy aplikacja jest otwarta na pierwszym planie, pokazujemy komunikat w niej (a przypomnienia o posiłku i tak jako powiadomienie).
      if (d.kind !== "reminder" && wins.some((w) => w.visibilityState === "visible")) {
        wins.forEach((w) => w.postMessage({ type: "push", title: d.title, body: d.body, url: d.url }));
        return;
      }
      await self.registration.showNotification(d.title || "Garda", {
        body: d.body || "",
        icon: "icon-192.png",
        badge: "icon-192.png",
        tag: d.tag || undefined,
        renotify: Boolean(d.tag),
        actions: (d.actions || []).slice(0, 3),
        data: { url: d.url || "/app/", rt: d.rt || null },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const { url, rt } = n.data || {};
  n.close();
  if ((e.action === "skip" || e.action === "later") && rt) {
    // Bez otwierania aplikacji: serwer zapisuje decyzję na podstawie podpisanego tokenu.
    e.waitUntil(
      fetch("/api/reminder-action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: rt, action: e.action }) })
        .then((r) => (r.ok ? null : self.registration.showNotification("Garda", { body: "Nie udało się zapisać odpowiedzi. Otwórz aplikację.", tag: "rem-fail" })))
        .catch(() => self.registration.showNotification("Garda", { body: "Brak połączenia, odpowiedź nie została zapisana.", tag: "rem-fail" })),
    );
    return;
  }
  const target = new URL(url || "/app/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const w = wins.find((c) => c.url.startsWith(self.location.origin + "/app/"));
      if (w) {
        await w.focus();
        w.postMessage({ type: "navigate", url: target });
      } else await self.clients.openWindow(target);
    })(),
  );
});
