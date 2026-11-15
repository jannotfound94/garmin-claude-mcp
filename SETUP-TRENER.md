# Trener biegowy: jak to działa i jak go uruchomić

## Jak to działa

```
 Jan pisze na Telegramie ──┐
 nowy bieg w Garminie ─────┤      Serwer na Cloudflare (darmowy)        Claude Code (subskrypcja)
 6:45 / 20:15 każdego dnia ┼──►  pamięć, Telegram, dane intervals.icu ──► zadanie „Trener (agent)”
 sprawdzenie, które trener ┘     „budzi” trenera tylko, gdy jest powód      czyta kontekst, decyduje,
 sam sobie zaplanował                                                     pisze, zmienia plan, zapamiętuje
```

- **Ciało agenta** to serwer na Cloudflare (ten sam, który już łączy Claude z intervals.icu). Odbiera Twoje wiadomości z Telegrama, pamięta rozmowę i ustalenia, co 15 minut sprawdza, czy pojawił się nowy bieg, i pilnuje godzin porannego i wieczornego przeglądu.
- **Mózg agenta** to jedno zadanie Claude Code, budzone przez serwer. Sam decyduje, czy napisać, co zmienić w planie i kiedy sprawdzić coś ponownie (np. „o 17:00 zobaczę, czy bieg się odbył”).
- **Zasady trenera** są w jednym pliku: `coach/TRENER.md`. Zmiana zasad = zmiana tego pliku.
- **Koszt dodatkowy: 0 zł.** Cloudflare w darmowym planie, Claude w ramach Twojej subskrypcji (zadanie zużywa limit tak jak zwykła rozmowa; uruchomień jest mniej niż dotychczas). Telegram bez Composio.
- Odpowiedź na Twoją wiadomość przychodzi zwykle po 1–2 minutach (tyle trwa start sesji Claude).

## Uruchomienie (jednorazowo, ok. 15 minut)

### 1. Token bota Telegrama
W Telegramie otwórz **@BotFather** → `/mybots` → wybierz bota, przez którego trener pisze dziś do Ciebie → **API Token**. Skopiuj token.

### 2. Nowa wersja serwera na Cloudflare
Kod jest na gałęzi `claude/running-coach-agent-1su5ib`. Po scaleniu z `main` Cloudflare zbuduje i wdroży go sam (jeśli serwer powstał przyciskiem „Deploy to Cloudflare”). Ręcznie: `npm install && npm run deploy`.

### 3. Konektor i API trigger zadania „Trener (agent)”
Wejdź na **claude.ai/code/routines** → zadanie **Trener (agent)** → menu → **Edit**:
- w sekcji **Connectors** dodaj **Dane z Garmina (interval)** (tylko ten; inne usuń) i kliknij **Save changes**;
- w wierszu **Trigger** kliknij **+** → **API**. Skopiuj **Fire URL**, kliknij **Generate token** i od razu skopiuj token (pokazuje się tylko raz).

### 4. Sekrety na Cloudflare
Cloudflare → **Workers & Pages** → `garmin-claude-mcp` → **Settings** → **Variables and Secrets** → **Add** (typ **Secret**):

| Nazwa | Wartość |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | token z kroku 1 |
| `TELEGRAM_CHAT_ID` | `8950929323` |
| `ROUTINE_FIRE_URL` | Fire URL z kroku 3 |
| `ROUTINE_FIRE_TOKEN` | token z kroku 3 |

### 5. Podłączenie
Otwórz `https://<adres-twojego-serwera>/setup`, wpisz `MCP_PASSWORD` i kliknij:
1. **Podłącz Telegram**: dostaniesz wiadomość „Trener podłączony ✅”.
2. **Obudź trenera teraz**: po 1–2 minutach na tej stronie (Odśwież) pojawi się ✅ przy pobudce.

### 6. Wyłączenie starych zadań
Dotychczasowe 9 zadań „Trener: …” trzeba wyłączyć: po podłączeniu webhooka nie odczytają już wiadomości przez Composio. Wystarczy poprosić o to Claude.

## Gdy coś nie działa
- Strona `/setup` pokazuje, które sekrety są ustawione, stan webhooka i ostatnie pobudki z ewentualnym błędem.
- Powrót do starego sposobu: na `/setup` kliknij **Odłącz webhook** i włącz stare zadania.
