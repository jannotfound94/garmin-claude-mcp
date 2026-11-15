# Trener biegowy: uruchomienie krok po kroku

Instrukcja dla osoby, która nie programuje. Każdy krok mówi: **gdzie wejść, co kliknąć, co skopiować i gdzie wkleić.**
Najlepiej robić to na komputerze, z Telegramem na telefonie pod ręką. Całość zajmuje ok. 20–30 minut.

> **Ważne o bezpieczeństwie.** Tokeny i hasła z tej instrukcji wklejasz **tylko** w miejsca tu wskazane: Cloudflare albo stronę `/setup` Twojego serwera. **Nigdy w rozmowę z Claude** ani w Telegram.

Przygotuj sobie pusty plik w Notatniku. Będziesz w nim chwilowo trzymać 4 rzeczy:

```
1. Token bota Telegram:
2. Fire URL:      https://api.anthropic.com/v1/claude_code/routines/trig_01CSGwQBs52v5rCrhKoZrkQv/fire
3. Token zadania:
4. Adres serwera:
```

Pozycja 2 jest już wpisana: to adres Twojego nowego zadania „Trener (agent)”. Po zakończeniu całej instrukcji usuń ten plik.

---

## Krok 0. Dostęp Claude do GitHuba (żeby nowy kod trafił do repozytorium)

Claude może dziś **czytać** repozytorium `jannotfound94/garmin-claude-mcp`, ale nie może do niego **zapisywać**. Potrzebna jest aplikacja „Claude” zainstalowana na GitHubie z dostępem do tego repozytorium.

1. Otwórz https://github.com/apps/claude/installations/select_target (zaloguj się na GitHub, jeśli trzeba).
2. Kliknij swoje konto **jannotfound94**.
   - Jeśli zobaczysz przycisk **Install**: kliknij go.
   - Jeśli zobaczysz **Configure** (aplikacja już jest): kliknij go.
3. W sekcji **Repository access** wybierz **All repositories** albo **Only select repositories** i zaznacz `garmin-claude-mcp`.
4. Sprawdź, czy na liście uprawnień jest **Read and write** dla „Contents” i „Pull requests”. Jeśli GitHub pokazuje prośbę o zaakceptowanie nowych uprawnień, zaakceptuj.
5. Kliknij **Save** (albo **Install**).
6. Napisz Claude w tej rozmowie: „gotowe, wyślij kod”. Claude wyśle kod i przygotuje tzw. pull request, czyli propozycję zmiany.

## Krok 1. Wgranie nowego kodu na serwer (Cloudflare)

### 1a. Zatwierdzenie zmiany na GitHubie
1. Claude poda Ci link do pull requesta. Otwórz go.
2. Na dole strony kliknij zielony przycisk **Merge pull request**, potem **Confirm merge**.

### 1b. Sprawdzenie, czy Cloudflare wgrywa kod sam
1. Wejdź na https://dash.cloudflare.com i zaloguj się.
2. Z menu po lewej wybierz **Compute (Workers)**. W starszym wyglądzie menu to **Workers & Pages**.
3. Kliknij swój serwer **garmin-claude-mcp**.
4. Przejdź do zakładki **Deployments** (Wdrożenia).
   - Jeśli widzisz nowe wdrożenie z ostatnich minut (status „Success”/„Active”), wszystko gra. Przejdź do kroku 2.
   - Jeśli nie, otwórz zakładkę **Settings** → sekcja **Build** → **Git repository**:
     - jeśli jest „Connect”: kliknij, wybierz GitHub → konto `jannotfound94` → repozytorium `garmin-claude-mcp` → gałąź `main` → **Connect**. Cloudflare zbuduje i wgra serwer sam (ok. 1–2 min);
     - jeśli repozytorium jest podłączone, ale nic się nie wgrało: w zakładce **Deployments** kliknij **Retry build** przy ostatniej pozycji, albo poproś Claude o pomoc.

### 1c. Adres Twojego serwera
Na stronie serwera w Cloudflare (zakładka **Overview** albo **Settings → Domains & Routes**) jest adres w rodzaju:
`https://garmin-claude-mcp.TWOJA-NAZWA.workers.dev`.
Skopiuj go do Notatnika jako pozycję **4** (bez `/mcp` na końcu).

Ten sam adres znajdziesz też w Claude: **Ustawienia → Konektory → „Dane z Garmina (interval)”**. Tam jest z `/mcp` na końcu; ten końcowy fragment pomiń.

## Krok 2. Token bota Telegram

Trener pisze do Ciebie przez bota, którego już masz. Potrzebny jest jego „klucz” (token).

1. Na telefonie otwórz Telegram i w wyszukiwarce wpisz **BotFather** (oficjalny, z niebieskim znaczkiem weryfikacji).
2. Wyślij mu wiadomość: `/mybots`
3. Pojawi się lista Twoich botów. Wybierz tego, przez którego trener pisze do Ciebie dziś.
4. Kliknij **API Token**.
5. BotFather pokaże token: długi napis w rodzaju `7712345678:AAHk3...xyz`. Przytrzymaj go, skopiuj i prześlij sobie na komputer (np. przez Telegram na komputerze albo e-mailem do siebie).
6. Wklej go do Notatnika jako pozycję **1**.

Nie klikaj „Revoke current token”: to unieważniłoby obecny token.

## Krok 3. Zadanie „Trener (agent)” w Claude

Zadanie już istnieje. Trzeba mu dać dostęp do danych i „dzwonek”, którym serwer będzie je budził.

1. Wejdź na https://claude.ai/code/routines.
2. Kliknij zadanie **Trener (agent)**.
3. Kliknij trzy kropki (menu) obok nazwy → **Edit**.

**3a. Konektor**
4. W sekcji **Connectors** kliknij dodawanie konektora i wybierz **Dane z Garmina (interval)**.
5. Jeśli na liście są inne konektory (Gmail, Booking, Drive itd.), usuń je ikoną kosza. Trenerowi potrzebny jest tylko ten jeden.
6. Kliknij **Save changes**.

**3b. API trigger (dzwonek)**
7. Ponownie otwórz **Edit**. W wierszu **Trigger** kliknij **+** → wybierz **API**.
8. Pojawi się panel z **Fire URL**. Sprawdź, czy kończy się na `trig_01CSGwQBs52v5rCrhKoZrkQv/fire`, tak jak pozycja 2 w Notatniku.
9. Kliknij **Generate token**. Pojawi się okienko z tokenem zaczynającym się od `sk-ant-oat01-`.
   **Skopiuj go od razu** do Notatnika jako pozycję **3**. Pokazuje się tylko raz. Jeśli go zgubisz, kliknij **Regenerate** i skopiuj nowy.
10. Zamknij okienko. Zapisywać nie trzeba, dzwonek działa od razu.

## Krok 4. Wpisanie 4 sekretów do Cloudflare

1. Wróć do https://dash.cloudflare.com → **Compute (Workers)** → **garmin-claude-mcp** → zakładka **Settings**.
2. Znajdź sekcję **Variables and Secrets** i kliknij **+ Add**.
3. Dodaj kolejno 4 pozycje. Za każdym razem:
   - **Type:** wybierz **Secret**;
   - **Variable name:** wpisz nazwę **dokładnie** jak w tabeli (wielkie litery, podkreślniki);
   - **Value:** wklej wartość.

| Variable name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | pozycja 1 z Notatnika (token od BotFather) |
| `TELEGRAM_CHAT_ID` | `8950929323` |
| `ROUTINE_FIRE_URL` | pozycja 2 z Notatnika |
| `ROUTINE_FIRE_TOKEN` | pozycja 3 z Notatnika (`sk-ant-oat01-...`) |

4. Po dodaniu wszystkich kliknij **Deploy** (albo **Save and deploy**).
5. Na liście powinny być teraz te 4 nazwy oraz 3 dawne: `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `MCP_PASSWORD`. Dawnych nie ruszaj.

## Krok 5. Podłączenie Telegrama i pierwsza pobudka

1. W przeglądarce otwórz pozycję 4 z Notatnika z dopiskiem `/setup`, np.
   `https://garmin-claude-mcp.TWOJA-NAZWA.workers.dev/setup`
2. Wpisz hasło **MCP_PASSWORD**: to samo, którego używasz przy łączeniu konektora w Claude. Kliknij **Wejdź**.
3. Zobaczysz listę z ✅/❌. Wszystkie 4 nowe pozycje powinny mieć ✅. Jeśli któraś ma ❌, wróć do kroku 4 i sprawdź pisownię nazwy.
4. Kliknij **„1. Podłącz Telegram (webhook) i wyślij wiadomość testową”**. Na telefonie powinna przyjść wiadomość „Trener podłączony ✅”.
5. Kliknij **„2. Obudź trenera teraz (test)”**. Odczekaj 1–2 minuty i kliknij **Odśwież**. W „Ostatnie pobudki trenera” powinien być wpis z ✅.
6. Napisz do trenera na Telegramie, np. „Cześć, jak wygląda mój plan na ten tydzień?”. Odpowiedź powinna przyjść w ciągu 1–3 minut.

## Krok 6. Garmin Connect (dodatkowe dane z zegarka)

Na tej samej stronie `/setup`, w sekcji **Garmin Connect**:
1. Wpisz e-mail i hasło, którymi logujesz się do Garmin Connect, i kliknij **Połącz z Garmin Connect**.
2. Jeśli Garmin wyśle Ci kod weryfikacyjny (e-mailem lub SMS-em), na stronie pojawi się pole na kod. Wpisz go i kliknij **Potwierdź kod**. Masz na to kilka minut.
3. Po połączeniu kliknij **Sprawdź dane z Garmin Connect**. Powinieneś zobaczyć m.in. gotowość do treningu, Body Battery i sen.

Hasło jest użyte jednorazowo i nigdzie nie jest zapisywane. Serwer zachowuje tylko klucz dostępu, ważny ok. roku. Po roku (albo po zmianie hasła w Garminie) powtórz ten krok.

Jeśli pojawi się błąd w rodzaju „Garmin mógł zablokować logowanie z serwera”, napisz do Claude. To nieoficjalne połączenie i Garmin czasem je blokuje. Trener działa wtedy dalej na danych z intervals.icu.

## Krok 7. Wyłączenie starych zadań

Gdy w kroku 5 wszystko zadziałało, napisz do Claude: „wyłącz stare zadania trenera”. Dotychczasowe 9 zadań („Trener: poranna motywacja…” itd.) zostanie wyłączonych, ale nie usuniętych. Po podłączeniu Telegrama do serwera stare zadania i tak nie odczytają już Twoich wiadomości.

---

## Jak to działa na co dzień
- **Piszesz do trenera na Telegramie** o dowolnej porze. Odpowiedź przychodzi zwykle po 1–3 minutach.
- **Po biegu:** gdy zegarek zsynchronizuje się z Garminem, w ciągu ok. 15–30 minut dostajesz podsumowanie.
- **Rano (6:45, w niedzielę 7:30) i wieczorem (20:15)** trener przegląda sytuację. Pisze tylko wtedy, gdy ma coś do powiedzenia.
- **Sam ustala sobie sprawdzenia**, np. „o 17:00 zobaczę, czy bieg się odbył”.
- **Pamięta ustalenia**, np. ból kolana, wyjazd, Twoje odpowiedzi.
- **Koszt dodatkowy: 0 zł.** Cloudflare w darmowym planie, Claude w ramach Twojej subskrypcji.

## Gdy coś nie działa
- **Strona `/setup`** pokazuje, które ustawienia są wpisane, czy Telegram jest podłączony i co się działo przy ostatnich pobudkach (z opisem błędu).
- **Trener nie odpowiada:** sprawdź na `/setup`, czy ostatnia pobudka ma ✅. Jeśli ❌ z liczbą 401, token zadania (pozycja 3) jest zły: wygeneruj nowy (krok 3b) i podmień `ROUTINE_FIRE_TOKEN` (krok 4).
- **Powrót do starego sposobu:** na `/setup` kliknij **Odłącz webhook Telegrama** i poproś Claude o ponowne włączenie starych zadań.
