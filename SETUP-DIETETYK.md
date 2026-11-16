# Dietetyk: uruchomienie krok po kroku

Dietetyk to dodatek do trenera biegowego: wysyłasz bota na Telegramie zdjęcie posiłku (z notatką albo bez), a on liczy kalorie i makroskładniki, zestawia je z celem na dany dzień treningowy i ze spalaniem z Garmina, przypomina o brakujących posiłkach i raz dziennie podsumowuje. Działa na tym samym bocie, serwerze i pamięci co trener. Całość zajmuje ok. 10 minut.

> **Bezpieczeństwo.** Klucz Gemini wklejasz **tylko** w Cloudflare (sekrety). Nigdy w rozmowę z Claude ani w Telegram.

## Jak to działa

| Zadanie | Kto to robi | Koszt |
| --- | --- | --- |
| Rozpoznanie zdjęcia, szacowanie gramatury i makro | **Gemini** (z serwera, od razu po wysłaniu zdjęcia) | darmowy poziom API |
| Sumy, cele dnia, bilans, trend wagi, przypomnienia | **zwykły kod** na serwerze (bez AI, dlatego liczby są powtarzalne) | 0 zł |
| Podsumowanie dnia i tygodnia, rady, rozmowa o jedzeniu | **Claude** (ten sam trener, widzi dane z Garmina i plan treningowy) | w ramach Twojego planu Claude |

Dzięki temu zużycie jest rozłożone na dwie platformy, a Claude nie traci tokenów na oglądanie każdego zdjęcia.

**Ważne: abonament „Gemini Pro” (Google AI Pro) to nie to samo co API.** Serwer potrzebuje osobnego klucza API z Google AI Studio. Ma on własny, darmowy poziom (limity zmieniają się, aktualne sprawdzisz w AI Studio). Zwykle wystarcza na kilkanaście zdjęć dziennie. Dwie rzeczy do wiedzy: (1) na poziomie darmowym Google może wykorzystywać przesyłane dane do ulepszania produktów; zdjęcia jedzenia nie są wrażliwe, ale jeśli Ci to przeszkadza, włącz rozliczanie w projekcie AI Studio (płatny poziom, koszt to grosze za zdjęcie, a dane nie są wtedy używane do trenowania); (2) po przekroczeniu limitu bot dostaje błąd i odpowiada, że się nie udało. Możesz wtedy wpisać posiłek tekstem po chwili.

## Krok 1. Klucz Gemini (2 minuty)

1. Wejdź na <https://aistudio.google.com/apikey> (zaloguj się kontem Google).
2. Kliknij **Create API key** i skopiuj klucz.

## Krok 2. Wgraj kod i wpisz klucz w Cloudflare (3 minuty)

1. Zmiany dietetyka są w gałęzi `claude/dietitian-agent` repozytorium. Scal je do głównej gałęzi (Pull request → Merge). Cloudflare wdroży zmiany sam, jeśli serwer był utworzony przyciskiem „Deploy to Cloudflare”. Jeśli wdrażasz ręcznie: `npm install && npm run deploy`.
2. Cloudflare → **Workers & Pages** → Twój serwer (`garmin-claude-mcp`) → **Settings** → **Variables and Secrets** → **Add** → typ **Secret**:
   - nazwa: `GEMINI_API_KEY`, wartość: skopiowany klucz → **Deploy**.
3. (Opcjonalnie) zmienne zwykłe `GEMINI_MODEL` i `GEMINI_FALLBACK_MODEL`, jeśli chcesz podmienić modele. Domyślnie: `gemini-3.5-flash` (główny) i `gemini-3.5-flash-lite` (zapasowy, gdy główny wyczerpie limit lub jest niedostępny). Jeśli Google wycofa model, wpisz tu nazwę aktualnego z AI Studio, bez zmiany kodu.

## Krok 3. Odśwież webhook i sprawdź Gemini (1 minuta)

1. Otwórz stronę `https://TWÓJ-SERWER.workers.dev/setup`, wpisz hasło (`MCP_PASSWORD`).
2. W sekcji „Dietetyk” kliknij **Sprawdź Gemini**. Powinien pojawić się komunikat „Gemini działa ✅”.
3. Kliknij u góry **1. Podłącz Telegram (webhook)**. **Zrób to także, jeśli trener już działał**: dietetyk używa przycisków pod wiadomościami, a Telegram wysyła ich kliknięcia dopiero po ponownym ustawieniu webhooka.

## Krok 4. Odśwież konektor w Claude (1 minuta)

W claude.ai: Settings → Connectors → konektor z serwerem → odśwież listę narzędzi (albo odłącz i połącz ponownie). Pojawią się dwa nowe narzędzia: `getNutrition` i `setNutritionConfig`. Prompt zaplanowanego zadania „Trener (agent)” nie wymaga zmian: zasady dietetyka dochodzą przez `getCoachContext` z pliku `coach/TRENER.md`.

## Krok 5. Ustawienia w Telegramie (2 minuty)

Wyślij botowi kolejno:

```
/waga 82,5
/posilki śniadanie 07:30; obiad 13:30; kolacja 19:30
/posilki weekend śniadanie 09:00; obiad 14:00; kolacja 19:30
/cel
```

- `/waga`: bez wagi nie ma celów. Po każdym wpisie bot pokazuje, ile zostało do celu (95 kg) i tempo. Waż się najlepiej **raz w tygodniu**, rano, w podobnych warunkach: dopiero 4 ważenia w ciągu ≥ 2 tygodni pozwalają skalibrować zapotrzebowanie z wagi.
- `/posilki`: godziny, o których zwykle jesz. Dodaj tyle posiłków, ile chcesz (do 10, także przekąski, np. `podwieczorek 16:30`). Przypomnienie przychodzi, jeśli **3 godziny po planowanej godzinie** nie ma wpisu (zmiana: `/cel przypomnienie 120`). Pierwsze przypomnienie ma przyciski: 📸 Dodam / ⏭ Pominąłem / ⏰ Za godzinę (po godzinie przyjdzie jedno ostatnie przypomnienie, potem cisza). Przypomnienia nie przychodzą po 22:00 i przed 6:00.
- `/cel`: pokazuje cele dla każdego typu dnia i skąd pochodzą kalorie. Domyślnie: białko 1,6 g/kg, tłuszcz 0,8 g/kg (od 95 kg, czyli od wagi docelowej) i **deficyt 600 kcal w dni bez biegu i łatwe** (redukcja masy ciała; w dni akcentów i długich biegów bez deficytu). Waga docelowa to 95 kg do 25.04.2027 (`/cel cel 95`, `/cel termin 2027-04-25`). **Korekta Garmina** ×0,9 (`/cel garmin 0,9`; 1 = ufam zegarkowi) zakłada, że zegarek zawyża spalanie, do czasu aż kalibracja z wagi to zweryfikuje. Zmiany: `/cel deficyt 400` (0 = utrzymanie wagi, max 800), `/cel bialko 1,6`, `/cel masa 95` (patrz niżej), `/cel wegle dlugi 8`.
- **Masa referencyjna** (`/cel masa 95`): przy nadwadze gramy na kg liczone od całej wagi dają tyle białka i tłuszczu, że deficyt się nie mieści. Ustaw masę bliżej docelowej (np. waga docelowa), a białko, tłuszcz i minimum węglowodanów liczone będą od niej. `/cel masa auto` wraca do aktualnej wagi.

## Codzienne używanie

| Chcesz | Zrób |
| --- | --- |
| Zapisać posiłek | wyślij **zdjęcie**; podpis pod zdjęciem to notatka („połowa porcji”, „150 g”, „na oliwie”, „zjadłem o 8:15”) |
| Zapisać bez zdjęcia | `/jem 2 jajka, kromka chleba, masło` albo po prostu „zjadłem …” / „na kolację …” |
| Poprawić wpis | **odpowiedz** (Telegram: „Odpowiedz”) na wiadomość bota z tym posiłkiem, np. „to było 200 g”, „bez sosu”, „to skyr naturalny”. Zwykła wiadomość bez „Odpowiedz” trafia do trenera, nie do dietetyka |
| Wskazać, który to był posiłek (np. wpisujesz śniadanie po południu) | dopisz w opisie lub w poprawce „to było moje śniadanie” (nazwa z `/posilki`). Wpis liczy się wtedy do śniadania, a przypomnienie o nim nie przychodzi |
| Usunąć wpis | przycisk 🗑 pod wiadomością albo `/usun 2` (numer z `/dzis`) |
| Szybko dodać to, co jesz często | po zapisaniu stuknij ⭐ **Ulubione**; potem `/ulubione` i jedno stuknięcie |
| Zobaczyć dzień | `/dzis` lub `/dzis wczoraj`: posiłki, cele, ile zostało, spalanie z Garmina |
| Sprawdzić, skąd kalorie w celach | `/spalanie`: spalanie z Garmina dzień po dniu (spoczynkowe + aktywne) i baza do celów |
| Kilka komend naraz | każda w osobnej linii jednej wiadomości, np. `/waga 106` i pod spodem `/dzis`; wykonają się po kolei (jedno `/jem` na wiadomość) |
| Wyłączyć przypomnienia (urlop) | `/przypomnienia off` |
| Zobaczyć pomoc | `/dieta` |

Gdy model nie jest pewny składnika, który wyraźnie zmienia wynik, zadaje jedno pytanie pod posiłkiem. Posiłek jest już wtedy zapisany; odpowiedź na pytanie (jako „Odpowiedz” na tę wiadomość) go poprawia. Pozycje oznaczone (?) są szacunkiem o niskiej pewności, 🏷 oznacza wartości z etykiety lub z bazy Open Food Facts (gdy na zdjęciu jest kod kreskowy pojedynczego produktu).

## Co dostajesz od trenera

- **Wieczorem ok. 21:30**: krótkie podsumowanie dnia (jedzenie vs cel, paliwo względem treningu, jedna uwaga na jutro).
- **W niedzielę ok. 21:30**: osobna wiadomość z podsumowaniem tygodnia (spożycie vs trend wagi, białko na kg, dni długie vs odpoczynek).
- **Po ok. 3–4 tygodniach** (min. 14 zapisanych dni i 4 ważenia): trener potrafi wyliczyć Twoje rzeczywiste dzienne zapotrzebowanie z bilansu i wagi i porównać je z tym, co pokazuje Garmin. To najcenniejsza część systemu, bo kalorie Garmina bywają zawyżone.
- Możesz po prostu pisać do trenera: „co zjeść po dzisiejszym biegu?”, „chcę zrzucić 3 kg do kwietnia”. Odpowiada na podstawie tego, co dziś zjadłeś i co jest w planie.

## Jak to liczy cele

**Kalorie dnia** wynikają z Twojego rzeczywistego zapotrzebowania:
1. Na początku: **od spokojnego dnia** z Garmina w górę. Baza to spoczynkowe spalanie plus lekka aktywność (aktywne kalorie × 0,85, bo bywają zawyżone) liczone z najspokojniejszych dni ostatnich 14 dni. Do tego cel **dolicza bieg z planu** (ok. 0,9 kcal na kg masy na km; bez dystansu przyjmuje 6 km dla łatwego, 8 km dla akcentu, 18 km dla długiego biegu). Gdy w ciągu dnia **Garmin pokaże więcej wysiłku, niż było w planie** (spacer, góry, dłuższy bieg), cel rośnie do faktycznego spalania i bot to zaznacza. Dzień po dniu zobaczysz dane komendą `/spalanie`.
2. Po ok. 3–4 tygodniach (min. 14 zapisanych dni i 4 ważenia): zapotrzebowanie wyliczone z bilansu spożycia i trendu wagi. To dokładniejsze niż Garmin i zastępuje go automatycznie.
3. Bez żadnych z tych danych: cele liczone czysto z gramów na kg masy ciała.

Przy kalibracji z wagi (poniżej) zapotrzebowanie jest mnożone przez współczynnik typu dnia (bez biegu 0,93; łatwy bieg 1,03; akcent 1,08; długi bieg 1,20). **Białko** (domyślnie 1,8 g/kg) i **tłuszcz** (1,0 g/kg) idą z masy ciała, a **węglowodany dopełniają resztę**. Typ dnia serwer ustala z kalendarza intervals.icu i z tego, co faktycznie zrobiłeś (bierze cięższą wersję): dzień bez biegu, łatwy bieg, akcent (tempo/interwały) albo długi bieg (od 16 km lub 100 min, albo „długi” w nazwie).

**Deficyt** (domyślnie 600 kcal, zmiana: `/cel deficyt 400`) obowiązuje tylko w dni bez biegu i łatwe, kosztem węglowodanów, nigdy białka. Węglowodany nie schodzą poniżej 2 g/kg masy referencyjnej, więc przy dużej masie ciała deficyt bywa ograniczony (bot pisze o tym w `/dzis`). Wtedy ustaw masę referencyjną (`/cel masa 95`) albo obniż białko (`/cel bialko 1,5`).

`/cel` pokazuje aktualne cele dla każdego typu dnia i skąd pochodzą.

## Rozwiązywanie problemów

- **Bot milczy po zdjęciu**: sprawdź na `/setup`, czy Gemini działa. Błąd 429 = limit darmowego poziomu (poczekaj lub włącz rozliczanie); 404 = nazwa modelu jest nieaktualna, wpisz nową w `GEMINI_MODEL`.
- **Przyciski nic nie robią**: kliknij ponownie „Podłącz Telegram” na `/setup` (Krok 3.3).
- **Brak celów**: wpisz `/waga`.
- **Brak narzędzi `getNutrition` w Claude**: odśwież konektor (Krok 4).
- **Dane pamięta serwer** (Durable Object na Cloudflare); zdjęć nie przechowuje, tylko wyniki. Zdjęcie trafia na chwilę do Gemini, nic poza tym.
