// Zapisuje capacitor.config.json z adresu aplikacji (APP_URL), np. https://garmin-claude-mcp.twoja-nazwa.workers.dev/app/
// APK jest cienkim opakowaniem: ładuje aplikację z Twojego serwera, więc poprawki interfejsu nie wymagają nowego APK.
import { writeFileSync } from "node:fs";

const raw = (process.env.APP_URL || "").trim();
let url;
try {
  url = new URL(raw);
} catch {
  console.error(`APP_URL jest pusty albo niepoprawny: "${raw}". Ustaw zmienną repozytorium APP_URL (Settings → Secrets and variables → Actions → Variables) na adres aplikacji, np. https://garmin-claude-mcp.twoja-nazwa.workers.dev/app/`);
  process.exit(1);
}
if (url.protocol !== "https:") {
  console.error("APP_URL musi zaczynać się od https:// (dane zdrowotne nie mogą iść niezaszyfrowanym połączeniem).");
  process.exit(1);
}
if (!url.pathname.startsWith("/app")) url.pathname = "/app/";
if (!url.pathname.endsWith("/")) url.pathname += "/";
url.search = "";
url.hash = "";

const config = {
  appId: "pl.janek.garda",
  appName: "Garda",
  webDir: "www",
  backgroundColor: "#0b0d12",
  server: {
    url: url.toString(),
    cleartext: false,
    // Mapy i pliki GPX z tras otwierają się w przeglądarce telefonu, nie wewnątrz aplikacji.
    allowNavigation: [url.host],
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#0b0d12",
  },
};
writeFileSync("capacitor.config.json", JSON.stringify(config, null, 2) + "\n");
console.log(`capacitor.config.json zapisany, adres aplikacji: ${config.server.url}`);
