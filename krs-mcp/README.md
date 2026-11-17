# krs-mcp

Lokalny serwer MCP (stdio) do [Otwartego API KRS](https://prs.ms.gov.pl/krs/openApi) (`api-krs.ms.gov.pl`). API jest publiczne, bez klucza.

## Narzędzia
| narzędzie | opis |
|---|---|
| `krs_odpis_aktualny` | odpis aktualny: nazwa, forma, NIP/REGON, siedziba, kapitał, zarząd, reprezentacja, wspólnicy (`tryb: raw` = pełny JSON) |
| `krs_odpis_pelny` | odpis pełny z historią wpisów |
| `krs_biuletyn` | zmiany wpisane do KRS w danym dniu (`YYYY-MM-DD`) |
| `krs_waliduj_numer` | normalizacja numeru do 10 cyfr |

## Instalacja
```bash
cd krs-mcp && npm install
claude mcp add krs -- node /ABSOLUTNA/ŚCIEŻKA/krs-mcp/src/server.js
```
Claude Desktop – `claude_desktop_config.json`:
```json
{ "mcpServers": { "krs": { "command": "node", "args": ["/ABSOLUTNA/ŚCIEŻKA/krs-mcp/src/server.js"] } } }
```
Zmienne opcjonalne: `KRS_API_BASE`, `KRS_MAX_CHARS` (domyślnie 60000).

## Uwagi
- Podsumowanie (`tryb: podsumowanie`) wyciąga pola heurystycznie; różne formy prawne (S.A., P.S.A., fundacje) mają różne struktury – gdy czegoś brakuje, użyj `tryb: raw`.
- Brak wyszukiwania po nazwie/NIP – Otwarte API KRS tego nie oferuje (tylko po numerze KRS).
- Testy: `npm test` (na mocku, bez sieci).
