# Aplikacja Janek Trener: uruchomienie krok po kroku

Aplikacja to druga „twarz” tego samego systemu co bot na Telegramie: ten sam serwer, te same dane, ta sama logika. Pokazuje podsumowanie dnia z rekomendacjami, tracker jedzenia (zdjęcie lub opis), plan treningowy z trasami, wykres wagi względem planu i rozmowę z trenerem. Ciemny motyw, wygląda i działa jak zwykła aplikacja.

> Telegram dalej działa równolegle (przypomnienia o posiłkach wciąż przychodzą tam). Aplikacja nie zastępuje go na siłę.

## Co jest w środku

| Zakładka | Co robi |
| --- | --- |
| **Dziś** | Powitanie, odliczanie do maratonu, **rekomendacje na dziś i jutro** (jedzenie, trening, pogoda, regeneracja, waga), kalorie i makro względem celu, spalanie z Garmina, trening dziś i jutro z pogodą, regeneracja (sen, bateria, HRV), waga względem planu |
| **Jedzenie** | Dziennik: przeglądanie dni, dodawanie posiłku **opisem, zdjęciem lub obojgiem**, poprawianie, ulubione jednym stuknięciem, usuwanie |
| **Plan** | Treningi z kalendarza (intervals.icu) na dwa tygodnie, pogoda do każdego, **propozycje tras** (dwie pętle przez parki i ścieżki, mapa i GPX), przycisk **„Poproś trenera o plan”** |
| **Trener** | Rozmowa z trenerem (Claude), ta sama co na Telegramie. Odpowiedź przychodzi po kilku minutach |
| **Postęp** | Wykres wagi z planem do celu, tydzień (zjedzone vs cel vs spalone), ustawienia (deficyt, korekta Garmina, waga docelowa, pory posiłków) |

Skąd co się bierze: kalorie i makro liczy serwer (zdjęcia rozpoznaje Gemini), plan treningowy układa trener (Claude) i zapisuje w intervals.icu, dane o regeneracji i spalaniu idą z Garmin Connect, pogoda z Open-Meteo.

## Krok 1. Wejdź do aplikacji w przeglądarce (2 minuty)

1. Scal zmiany do głównej gałęzi (Pull request → Merge) i poczekaj minutę na wdrożenie.
2. Otwórz na telefonie adres serwera z końcówką `/app/`:
   ```
   https://garmin-claude-mcp.TWOJA-NAZWA.workers.dev/app/
   ```
   (Adres znajdziesz w Cloudflare: Workers & Pages → `garmin-claude-mcp`. To ten sam, którego używasz do `/setup`.)
3. Zaloguj się **tym samym hasłem** co do `/setup` (`MCP_PASSWORD`). Sesja trwa 30 dni.
4. **Zainstaluj jak aplikację** (bez żadnego APK): w Chrome na Androidzie menu ⋮ → **„Zainstaluj aplikację”** (albo „Dodaj do ekranu głównego”). Pojawi się ikona i pełny ekran bez paska przeglądarki.

To już w pełni działająca aplikacja. Krok 2 daje „prawdziwy” plik APK, jeśli go chcesz.

## Krok 2. Plik APK (opcjonalnie, ok. 15 minut)

APK budujemy w chmurze GitHuba, nie na Twoim komputerze. Jest to cienkie opakowanie: ładuje aplikację z Twojego serwera, więc **zmiany w wyglądzie nie wymagają nowego APK**.

1. Na GitHubie w repozytorium: **Settings → Secrets and variables → Actions → zakładka Variables → New repository variable**:
   - nazwa: `APP_URL`
   - wartość: adres z kroku 1, z `https://` i końcówką `/app/`
2. Zakładka **Actions → „Build APK (Janek Trener)” → Run workflow → Run workflow**.
3. Poczekaj ok. 10–15 minut (przy pierwszym uruchomieniu GitHub pobiera narzędzia Androida). Zielony znaczek = gotowe.
4. Wejdź w zakładkę **Releases** (prawa strona strony głównej repozytorium) i na telefonie pobierz plik `janek-trener-….apk`.
5. Otwórz pobrany plik. Android poprosi o zezwolenie przeglądarce na **instalację z nieznanych źródeł**: zezwól tylko dla tej instalacji. Google Play Protect może ostrzec, bo aplikacja nie jest ze sklepu: to normalne dla własnego APK.
6. Uruchom aplikację i zaloguj się hasłem. Zdjęcia posiłków zrobisz aparatem w aplikacji (Android zapyta o zgodę na aparat).

**Aktualizacje APK:** zwykle niepotrzebne, bo interfejs ładuje się z serwera. Gdy jednak zbudujesz nowy APK, instalujesz go nad starym (podpis jest zapamiętany w pamięci podręcznej GitHuba). Jeśli Android napisze, że aplikacja koliduje z istniejącym pakietem, odinstaluj starą wersję i zainstaluj nową: nic nie tracisz, bo wszystkie dane są na serwerze.

> **Uczciwie:** workflow budujący APK napisałem i sprawdziłem na tyle, na ile się dało bez Androida (konfiguracja, generowanie projektu, ikony, poprawki manifestu), ale **nie uruchomiłem pełnej kompilacji**. Przy pierwszym uruchomieniu coś może wymagać drobnej poprawki. Jeśli przebieg zrobi się czerwony, wklej mi komunikat błędu z logów, a poprawię.

## Jak korzystać

- **Dodaj posiłek:** zakładka Jedzenie → ＋ (albo przycisk na ekranie Dziś). Zdjęcie z aparatu lub z galerii, opis tekstem, godzina (gdy dopisujesz coś z wcześniej). Jeśli Gemini jest chwilowo przeciążony, aplikacja sama ponowi próbę kilka razy.
- **Popraw posiłek:** „✏️ Popraw” pod posiłkiem i napisz, co zmienić („to było 200 g”, „bez sosu”).
- **Plan:** zakładka Plan → „Poproś trenera o plan”. Trener układa plan wg zasad (cel maratonu poniżej 4:30, regeneracja, pogoda) i wpisuje go do kalendarza. Odpowiedź zobaczysz w zakładce Trener.
- **Trasy:** przy zaplanowanym biegu stuknij „Zaproponuj trasy”. Potrzebny jest klucz `ORS_API_KEY` i adres domowy ustawiony na stronie `/setup` (jak dla trasy na Telegramie).
- **Waga:** zakładka Postęp → wpisz wagę (najlepiej raz w tygodniu, rano). Wykres pokazuje plan od pierwszego ważenia do wagi docelowej 95 kg w dniu maratonu.

## Bezpieczeństwo

- Logowanie hasłem `MCP_PASSWORD`, token ważny 30 dni, zapisany tylko w Twoim telefonie. Po **8 błędnych próbach** logowanie blokuje się na 15 minut.
- Zmiana `MCP_PASSWORD` w Cloudflare **natychmiast wylogowuje** wszystkie urządzenia.
- Cała komunikacja idzie przez HTTPS. Pliki aplikacji mają restrykcyjną politykę bezpieczeństwa (skrypty i dane tylko z Twojego serwera).
- To dane o zdrowiu, więc hasło ma być długie i losowe (`openssl rand -hex 32`, jak przy konfiguracji serwera).
- Repozytorium jest publiczne: widać w nim kod, ale nie widać Twoich danych ani haseł (te są w Cloudflare). Plik APK z Releases zawiera tylko adres serwera, bez żadnych danych logowania.

## Czego jeszcze nie ma w wersji 1

- Powiadomienia push w aplikacji (przypomnienia o posiłkach przychodzą dalej na Telegram).
- Praca offline: powłoka aplikacji się otwiera, ale dane wymagają internetu.
- Ręczne dopisywanie kalorii liczbami (jest rozpoznawanie z opisu i zdjęcia oraz poprawki).
- Wersja na iPhone'a (APK to tylko Android; w Safari działa wersja webowa z kroku 1).

## Rozwiązywanie problemów

- **„Zaloguj się ponownie” po wejściu:** sesja wygasła (30 dni) albo zmieniłeś hasło. Zaloguj się jeszcze raz.
- **Ekran „Za dużo prób”:** odczekaj 15 minut.
- **Puste rekomendacje lub brak planu:** w polu pod ekranem widać „Część danych niedostępna” z powodem (np. intervals.icu nie odpowiada); reszta nadal działa.
- **„Gemini jest chwilowo przeciążony”:** aplikacja ponawia sama do trzech razy. Jeśli nie pomoże, spróbuj za kilka minut.
- **Trasy: „brak punktu startu” albo „brak klucza”:** ustaw adres domowy i `ORS_API_KEY` według `SETUP-TRENER.md`.
- **APK: budowanie nie przechodzi:** w zakładce Actions otwórz przebieg, skopiuj komunikat błędu z czerwonego kroku i wklej mi.
