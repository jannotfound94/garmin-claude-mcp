// Jeden spójny system ikon: siatka 24 px, kreska 1,75, zaokrąglone zakończenia i łączenia, bez wypełnień.
// Wszystkie ikony rysowane od zera na tej samej siatce, więc wyglądają jak jedna rodzina (nawigacja, jedzenie, trening, pogoda).
// Znaczniki to stałe, własne ciągi (nie dane użytkownika), więc użycie innerHTML jest bezpieczne.
const P = {
  // nawigacja
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  pin: '<path d="M12 21s6.5-5.6 6.5-11A6.5 6.5 0 0 0 5.5 10C5.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.4"/>',
  home: '<path d="M4 11.2 12 4.5l8 6.7"/><path d="M6 10v9.5h12V10"/><path d="M10 19.5v-5h4v5"/>',
  meal: '<path d="M6.5 3.5v5.2a2.5 2.5 0 0 0 5 0V3.5"/><path d="M9 3.5v17"/><path d="M16.5 20.5V3.5c-2 1.4-3 3.8-3 6.5v3.5h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10.5h16M8.5 3.5v4M15.5 3.5v4"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.6-3.6 3.5-5.5 7-5.5s6.4 1.9 7 5.5"/>',
  // trening
  run: '<path d="M3.5 6.5h4.3l.4 3c.2 1.6 1.6 2.8 3.2 2.8h1.7c1.6 0 3 .6 4.2 1.6l1.8 1.4c.7.5 1 1.2 1 2v1.2H3.5z"/><path d="M3.5 20.5h17"/><path d="M10.2 9.2l1.5 1.1M12.4 8.2l1.5 1.1"/>',
  route: '<circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="6.5" r="2"/><path d="M8.5 17.5h6a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6h6"/>',
  flame: '<path d="M12 3.5c.6 3-1 4.2-2.4 5.8C8.3 10.8 7 12.4 7 14.8a5 5 0 0 0 10 0c0-1.9-.9-3.3-2-4.4-.2 1.2-.8 1.9-1.6 2.3.5-3-.2-6.2-1.4-9.2z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>',
  bolt: '<path d="M13 3.5 6.5 13.5H12l-1 7L17.5 10.5H12z"/>',
  watch: '<rect x="7.5" y="6.5" width="9" height="11" rx="3"/><path d="M9.5 6.5l.7-3h3.6l.7 3M9.5 17.5l.7 3h3.6l.7-3"/>',
  // ciało i regeneracja
  scale: '<rect x="4" y="4.5" width="16" height="15" rx="4"/><path d="M8.5 9.5a4 4 0 0 1 7 0"/><path d="M12 9.6l1.4-1.8"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 15l3.2-4.2 3 2.4L19 7.5"/>',
  trend: '<path d="M4 8l5.5 5.5 3-3L20 18"/><path d="M15 18h5v-5"/>',
  pulse: '<path d="M3.5 12.5h3.6l2-5 3.4 10 2.4-6.5 1.2 1.5h4.4"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  battery: '<rect x="3.5" y="8" width="15" height="8.5" rx="2.2"/><path d="M21 11v2.5"/><path d="M7 11.2v3M10.5 11.2v3"/>',
  // posiłki
  sunrise: '<path d="M4 17.5h16M7 17.5a5 5 0 0 1 10 0M12 6v2.5M5.6 10l1.6 1.4M18.4 10l-1.6 1.4"/>',
  plate: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.8"/>',
  apple: '<path d="M12 8.2c-1.4-1-4.5-1.3-5.8 1.4-1.2 2.5.2 6.6 2.5 8.4 1 .8 2.1.5 3.3 0 1.2.5 2.3.8 3.3 0 2.3-1.8 3.7-5.9 2.5-8.4-1.3-2.7-4.4-2.4-5.8-1.4z"/><path d="M12 8.2c0-1.7.7-3 2-3.9"/>',
  // pogoda
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/>',
  cloud: '<path d="M7.5 18.5a3.5 3.5 0 0 1-.3-7 5 5 0 0 1 9.6 1.2A3 3 0 0 1 16.5 18.5z"/>',
  rain: '<path d="M7.5 15a3.5 3.5 0 0 1-.3-7 5 5 0 0 1 9.6 1.2A3 3 0 0 1 16.5 15z"/><path d="M8.5 18l-.8 2M12.5 18l-.8 2M16.5 18l-.8 2"/>',
  wind: '<path d="M4 9.5h9.5a2.5 2.5 0 1 0-2.5-2.5M4 14h12.5a2.5 2.5 0 1 1-2.5 2.5M4 11.8h6"/>',
  droplet: '<path d="M12 4c3 3.6 5.2 6.5 5.2 9.2a5.2 5.2 0 0 1-10.4 0C6.8 10.5 9 7.6 12 4z"/>',
  // akcje
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.2-2h5.6L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.3"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 16.5 9 12.5l3.5 3 2.5-2 5 4"/>',
  star: '<path d="m12 4.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.6l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>',
  trash: '<path d="M5 7h14M9.5 7V5h5v2M7 7l.8 12h8.4L17 7M10.5 11v5M13.5 11v5"/>',
  edit: '<path d="M4.5 19.5l.8-4L16.4 4.4a1.8 1.8 0 0 1 2.5 0l.7.7a1.8 1.8 0 0 1 0 2.5L8.5 18.7z"/><path d="M14.5 6.3l3.2 3.2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4"/><path d="M19.5 4.5v4h-4"/>',
  settings: '<path d="M5 8h9M18 8h1M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>',
  chat: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
  send: '<path d="M20 4.5 10 14"/><path d="M20 4.5 14.5 20l-4.5-6-6-4.5z"/>',
  sparkles: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>',
  logout: '<path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10"/><path d="M14 8l4 4-4 4M18 12H9.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>',
  left: '<path d="m14.5 6-6 6 6 6"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
};

export const ICON_NAMES = Object.keys(P);

/** Ikona jako element SVG. size w px, kolor z currentColor. */
export function icon(name, size = 22) {
  const body = P[name];
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.75");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  if (body) s.innerHTML = body;
  else console.error(`Brak ikony: ${name}`); // brakująca ikona to błąd w kodzie, nie ma jej po cichu pomijać
  return s;
}
