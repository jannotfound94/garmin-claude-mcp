# Aplikacja Garda: uruchomienie krok po kroku

Aplikacja to druga „twarz” tego samego systemu co bot na Telegramie: ten sam serwer, te same dane, ta sama logika. Pokazuje podsumowanie dnia z rekomendacjami, tracker jedzenia (zdjęcie lub opis), plan treningowy z trasami, wykres wagi względem planu i rozmowę z trenerem. Ciemny motyw, wygląda i działa jak zwykła aplikacja.

> Telegram dalej działa równolegle (przypomnienia o posiłkach wciąż przychodzą tam). Aplikacja nie zastępuje go na siłę.

## Co jest w środku

Dolna nawigacja ma pięć pozycji: **Dziś**, **Jedzenie**, pomarańczowy przycisk **＋** (dodaj posiłek z dowolnego ekranu), **Plan** i **Ty**.

| Miejsce | Co robi |
| --- | --- |
| **Dziś** | Dashboard z kart: **priorytet dnia** i wskazówki (jedzenie, trening, pogoda, regeneracja, waga), kalorie z pierścieniem i makro, **kilometry w tym tygodniu względem planu** z wykresem 14 dni, trening dziś i jutro z pogodą, **seria dni z zapisanym jedzeniem**, spalanie z Garmina, regeneracja (sen, bateria, HRV), waga względem planu, źródła danych |
| **Jedzenie** | Pasek dni (14 dni wstecz), podsumowanie dnia, ulubione jednym stuknięciem, dodawanie posiłku **opisem, zdjęciem lub obojgiem**, poprawianie i usuwanie |
| **＋** | Szybkie dodanie posiłku z dowolnego ekranu |
| **Plan** | Treningi z kalendarza (intervals.icu) na dwa tygodnie, filtr (wszystkie / tylko biegi), pogoda do każdego, **propozycje tras** (dwie pętle przez parki i ścieżki, mapa i GPX), przycisk **„Poproś trenera o plan”** |
| **Ty** | Profil z zakładkami: **Postęp** (pierścienie celów, wykres wagi z planem do celu, wykres tygodnia), **Aktywności** (ostatnie biegi z Garmina), **Trener** (rozmowa, ta sama co na Telegramie, odpowiedź po kilku minutach) i **Ustawienia** (deficyt, korekta Garmina, waga docelowa, pory posiłków) |

Wygląd: ciemny motyw w kolorach **niebieskim i pomarańczowym** (pomarańcz to ruch i główna akcja, niebieski to jedzenie i dane), karty modułowe z dużymi liczbami i jeden spójny zestaw ikon. Inspiracją układu był ekran postępów ze Stravy, ale nic z niego nie jest kopiowane.

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
2. Zakładka **Actions → „Build APK (Garda)” → Run workflow → Run workflow**.
3. Poczekaj ok. 10–15 minut (przy pierwszym uruchomieniu GitHub pobiera narzędzia Androida). Zielony znaczek = gotowe.
4. Wejdź w zakładkę **Releases** (prawa strona strony głównej repozytorium) i na telefonie pobierz plik `garda-….apk`.
5. Otwórz pobrany plik. Android poprosi o zezwolenie przeglądarce na **instalację z nieznanych źródeł**: zezwól tylko dla tej instalacji. Google Play Protect może ostrzec, bo aplikacja nie jest ze sklepu: to normalne dla własnego APK.
6. Uruchom aplikację i zaloguj się hasłem. Zdjęcia posiłków zrobisz aparatem w aplikacji (Android zapyta o zgodę na aparat).

**Aktualizacje APK:** zwykle niepotrzebne, bo interfejs ładuje się z serwera. Gdy jednak zbudujesz nowy APK, instalujesz go nad starym (podpis jest zapamiętany w pamięci podręcznej GitHuba). Jeśli Android napisze, że aplikacja koliduje z istniejącym pakietem, odinstaluj starą wersję i zainstaluj nową: nic nie tracisz, bo wszystkie dane są na serwerze.

> **Uczciwie:** workflow budujący APK napisałem i sprawdziłem na tyle, na ile się dało bez Androida (konfiguracja, generowanie projektu, ikony, poprawki manifestu), ale **nie uruchomiłem pełnej kompilacji**. Przy pierwszym uruchomieniu coś może wymagać drobnej poprawki. Jeśli przebieg zrobi się czerwony, wklej mi komunikat błędu z logów, a poprawię.

## Krok 3. Powiadomienia w telefonie (zamiast Telegrama)

Wiadomości trenera (poranny przegląd, podsumowania biegów, wieczorne podsumowanie, odpowiedzi) i przypomnienia o posiłkach z przyciskami „Dodam / Pominąłem / Za godzinę” mogą przychodzić jako powiadomienia z aplikacji. Zasady i godziny są te same co na Telegramie.

1. Otwórz aplikację w **Chrome na telefonie** i zainstaluj ją (menu ⋮ → „Zainstaluj aplikację”). Powiadomienia działają w zainstalowanej aplikacji z Chrome; wersja APK nie jest do tego potrzebna.
2. Ty → Ustawienia → karta **Powiadomienia i lokalizacja** → „Włącz powiadomienia” i zaakceptuj zgodę. Potem „Wyślij test”: powiadomienie powinno pojawić się po kilku sekundach.
3. Zostaw kanał **„Aplikacja i Telegram”** na 1–2 tygodnie. Jeśli wszystko dociera, wybierz „Tylko aplikacja”. Serwer nie pozwoli wybrać tej opcji, dopóki żadne urządzenie nie ma włączonych powiadomień.
4. Dopiero potem możesz przestać używać Telegrama. **Nie usuwaj** sekretów `TELEGRAM_*` ani webhooka od razu: Telegram zostaje kanałem zapasowym. Jeśli powiadomienie do aplikacji nie zostanie dostarczone (np. telefon wygasił subskrypcję), serwer sam wyśle wiadomość na Telegram, więc trener nigdy „nie zamilknie”. Każda wiadomość trenera jest też zawsze zapisana w Ty → Trener.

Lokalizacja: przycisk **„Użyj mojej lokalizacji”** (zakładka Plan lub ta sama karta w ustawieniach) zastępuje udostępnianie lokalizacji na Telegramie. Pogoda i trasy startują wtedy z miejsca, w którym jesteś (przez 3 godziny), w przeciwnym razie z domu. Pliki GPX nadal są linkami w aplikacji.

Jeśli powiadomienia nie przychodzą: sprawdź zgodę (ikona kłódki przy adresie → Powiadomienia), oszczędzanie baterii dla Chrome oraz czy kanał nie jest ustawiony na „Tylko Telegram”.

### Wersja APK: lokalizacja i przycisk „wstecz”

APK od wersji z tą poprawką prosi o zgodę na lokalizację (przy pierwszym „Użyj mojej lokalizacji”). Jeśli wcześniej odmówiłeś, włącz ją w Ustawienia telefonu → Aplikacje → Garda → Uprawnienia → Lokalizacja. Przycisk „wstecz” cofa po ekranach aplikacji i mapie trasy, a na ekranie startowym chowa aplikację. „Otwórz GPX w aplikacji” nie pobiera pliku do katalogu Pobrane, tylko od razu pokazuje listę aplikacji, w których można go otworzyć (np. Locus, OsmAnd; Garmin Connect, jeśli zgłasza się do plików GPX na Twoim telefonie). Jeśli Garmin Connect nie ma na liście, kurs dodasz w Garmin Connect w przeglądarce (Szkolenia → Kursy → Importuj). Nowe APK instaluje się nad starym (ten sam podpis), bez odinstalowywania.

## Trasa z opisu słownego

Plan → „Trasa z opisu”: wpisz albo podyktuj (mikrofon klawiatury Gboard) opis trasy, np.:

- szczegółowo: „z domu nad Wisłę przez Fort Sokolnickiego, plaża Żoliborz, ulica Kaniowa, park przy Cytadeli i do domu”,
- luźno: „10 km, najpierw po tej stronie Wisły, Gdańskim na drugą stronę, powrót kładką”.

Gemini rozbija opis na miejsca po kolei, miejsca są wyszukiwane na mapie (OpenStreetMap i geokoder OpenRouteService), a trasa idzie dokładnie przez nie. Przy podanym dystansie trasa jest wydłużana objazdem, najlepiej w miejscu wskazanym w opisie („po tej stronie Wisły” = przed pierwszym miejscem). Sprawdź listę „Rozpoznane punkty” i numerowane punkty na mapie: niepewnie rozpoznane są oznaczone. Miejsca, których nie da się potwierdzić na mapie po nazwie, są pomijane z wyraźnym ostrzeżeniem (zamiast zgadywania innego miejsca), a gdy trasa omija wskazany punkt albo w dużej części biegnie tą samą drogą, dostajesz ostrzeżenie. Jeśli coś jest źle, doprecyzuj opis (dzielnica, ulica, pełna nazwa) i wyznacz jeszcze raz. Trener ma do tego narzędzie `proposeRouteFromText`. Wymaga sekretów `ORS_API_KEY` i `GEMINI_API_KEY`.

## Post przerywany

Pierwsza karta na ekranie „Dziś” to zegar postu przerywanego (domyślnie 16:8). **Post** to czas, gdy nie jesz, **okno** to czas, gdy jesz.

- „Skończyłem jeść” startuje post i odlicza 16 godzin. „Skończyłem o innej godzinie…” pozwala wpisać godzinę wstecz.
- „Zaczynam jeść” kończy post wcześniej (zapisze go jako przerwany) i otwiera okno.
- Gdy czas fazy minie, następna zaczyna się sama (po poście okno 8 godzin, po oknie post) i przychodzi powiadomienie, tą samą drogą co wiadomości trenera (aplikacja i/lub Telegram). Powiadomienie jest wysyłane z serwera, więc dociera także przy zamkniętej aplikacji.
- Po dodaniu kolacji lub posiłku po 18:00 aplikacja pyta „To już koniec jedzenia?” i jednym kliknięciem zaczyna post.
- Karta pokazuje serię osiągniętych postów, średnią z ostatnich siedmiu i wykres ostatnich postów.
- „zacząłem jeść o innej godzinie…” pozwala wpisać godzinę, o której faktycznie zacząłeś jeść. W trakcie postu kończy go o tej godzinie; w trakcie okna przesuwa jego początek (np. post skończył się o 8:00 i okno ruszyło samo, a Ty zacząłeś jeść o 10:45), a poprzedni post w historii dostaje właściwy koniec.
- Długość postu zmienisz w Ty → Ustawienia („Post przerywany”), od 10 do 22 godzin. Okno to reszta doby.

## Waga z inteligentnej wagi

Waga (Mi Scale 2) → Zepp Life → Google Fit → **intervals.icu** (Ustawienia → Połączenia → Google Fit, Wellness) → Garda. Serwer sprawdza intervals.icu co kilkanaście minut oraz przy otwarciu aplikacji i dopisuje wagę (a jeśli jest, także procent tkanki tłuszczowej) z ostatnich dwóch tygodni. Po pierwszym pomiarze dnia możesz dostać powiadomienie „Waga zapisana”. Waga wpisana ręcznie w aplikacji zawsze wygrywa i automat jej nie nadpisuje. Procent tłuszczu pokazuje się w Ty → Postęp jako osobny wykres (pomiar orientacyjny, liczy się kierunek zmian). Jeśli waga nie pojawia się w Gardzie, sprawdź najpierw, czy jest w intervals.icu w Wellness pod właściwą datą.

## Kilka zdjęć jednego posiłku

W oknie „Dodaj posiłek” możesz dodać do 4 zdjęć jednego posiłku (przycisk „Zdjęcie” dodaje kolejne, „Galeria” pozwala zaznaczyć kilka naraz). Model dostaje wszystkie razem i liczy jeden posiłek, a wartości z zdjęcia opakowania lub etykiety (np. fety) mają pierwszeństwo przed zgadywaniem porcji. Zdjęcia w HEIC obsługuje tylko Gemini (patrz SETUP-DIETETYK.md).

## Przycisk „wstecz” i okna

Przycisk „wstecz” w telefonie najpierw zamyka otwarte okno (np. dodawanie posiłku), a dopiero potem cofa ekran. Dotyczy aplikacji w Chrome i w APK. Pliki GPX z mapy i z Planu otwierają się z listą aplikacji tylko w nowym APK (zmiana w kodzie natywnym), więc po scaleniu zbuduj APK od nowa: Actions → Build APK (Garda) → Run workflow.

## Jak korzystać

- **Dodaj posiłek:** pomarańczowy przycisk ＋ na dole (działa na każdym ekranie). Zdjęcie z aparatu lub z galerii, opis tekstem, godzina (gdy dopisujesz coś z wcześniej). Jeśli Gemini jest chwilowo przeciążony, aplikacja sama ponowi próbę kilka razy.
- **Popraw posiłek:** „✏️ Popraw” pod posiłkiem i napisz, co zmienić („to było 200 g”, „bez sosu”).
- **Plan:** zakładka Plan → „Poproś trenera o plan”. Trener układa plan wg zasad (cel maratonu poniżej 4:30, regeneracja, pogoda) i wpisuje go do kalendarza. Odpowiedź zobaczysz w Ty → Trener.
- **Trasy:** przy zaplanowanym biegu stuknij „Zaproponuj trasy”. Potrzebny jest klucz `ORS_API_KEY` i adres domowy ustawiony na stronie `/setup` (jak dla trasy na Telegramie).
- **Waga:** Ty → Postęp → wpisz wagę (najlepiej raz w tygodniu, rano). Wykres pokazuje plan od pierwszego ważenia do wagi docelowej 95 kg w dniu maratonu.

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
