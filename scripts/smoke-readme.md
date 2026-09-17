# Smoke-Test (Kurz)

Voraussetzung: VPN / Johns PC (`machineId 7ac7fb5e-6a99-4b5e-a4cd-c1a6c5c13e08`), Token-Datei vorhanden.

```powershell
cd C:\path\to\datasec-mcp
npm install
npm run build

# Token + Env
$env:DATASEC_ENV = "test"
$env:DATASEC_TOKEN_FILE = "C:\Users\j.bothe\AppData\Local\Temp\datasec_probe\datasec_token.env"
$env:DATASEC_WRITES_ENABLED = "true"
$env:DATASEC_REQUIRE_CONFIRM = "true"

# stdio manuell nicht sinnvoll — lieber HTTP Smoke:
$env:PORT = "8788"
node dist/index-http.js
```

In zweitem Terminal / MCP-Client:

1. `datasec_status` → `tokenLoaded: true`, `env: test`
2. `datasec_h_ask` mit Text `Mängel Mandant 27 Hauptstraße 118/118a/118b` (erwartet Warnung solange Crosswalk leer; nie Straße als KEYWORD)
3. `datasec_search_tickets` mit `max: 5`
3. `datasec_get_ticket` mit bekannter Test-Ticketnr
4. Write ohne `confirm` → Fehler
5. Write mit `confirm: true` nur auf **Test**-Tickets nach Freigabe

Box ohne VPN: Build muss trotzdem grün sein; Live-Calls werden fehlschlagen (Timeout/Netz) — das ist erwartet.
