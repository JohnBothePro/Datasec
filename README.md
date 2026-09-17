# Datasec MCP Server

Vendor-neutrales **Model Context Protocol**-Server für Datasec DOKU@WEB.  
Jeder MCP-fähige Client (Claude Desktop, Cursor, ChatGPT-with-MCP, Grok Bot, eigene Agents) kann damit Tickets **lesen und schreiben**.

> **VPN:** Datasec ist nur aus dem Firmennetz / von Johns PC erreichbar  
> (`machineId 7ac7fb5e-6a99-4b5e-a4cd-c1a6c5c13e08`).

## Features

Vollständige Tool-Inventar-Datei: **`TOOLS-INVENTORY.md`**.

| Bereich | Tools |
|---------|--------|
| Meta | `datasec_status`, `datasec_set_env` |
| Tickets (lesen) | `datasec_search_tickets`, `datasec_get_ticket`, `datasec_get_notes`, `datasec_get_links`, `datasec_get_state_history`, `datasec_get_process_buttons`, `datasec_get_process_fields`, `datasec_list_keywords`, `datasec_get_process_fields_first_step`, `datasec_get_latest_chat_messages` |
| Tickets (schreiben) | `datasec_add_note`, `datasec_set_state`, `datasec_link_tickets`, `datasec_create_master_ticket`, `datasec_create_ticket`, `datasec_link_ticket_to_master`, `datasec_forward_ticket`, `datasec_press_process_button`, `datasec_set_keyword`, `datasec_set_ticket_values`, `datasec_send_ticket_mail` (Stub) |
| Dokumente §2.5.1 | `datasec_get_document`, `datasec_update_document`, `datasec_archive_document_soap`, `datasec_archive_document_rest`, `datasec_search_by_document_type`, `datasec_search_in_process`, `datasec_list_departments`, `datasec_list_document_types`, `datasec_get_document_type_structure` |
| Stammdaten §2.5.3 | `datasec_get_partner_id`, `datasec_get_partner_contracts`, `datasec_get_partner_base_data`, `datasec_get_other_contract_partners_base`, `datasec_get_partner_extended_data`, `datasec_get_contract_conditions`, `datasec_get_app_users`, `datasec_get_business_partner_data`, `datasec_mark_document_read`, `datasec_set_app_user_push_flags`, `datasec_update_contact_data`, `datasec_insert_eed_data`, `datasec_get_special_supplementary_data` |
| Weitere §2.5.4 | `datasec_get_damage_reports`, `datasec_get_news_ticker` |
| Deep Links Kap. 3 | `datasec_build_deeplink_base/akte/search/document_type/sammelbenutzer` (Token-Embedding default aus, admin+confirm) |
| SSO Kap. 4 | `datasec_sso_status` (nicht unterstützt V1.7) |
| Bridge Kap. 1 | `datasec_bridge_info` |
| **L1 Helpers** | Seconds-latency: `datasec_h_ask` (ein Call, dann antworten). Auto-Adresse aus Datasec (OBJEKTAKTE/MIETERAKTE + Cache). Tickets, Akten, Stammdaten, Katalog, News. Siehe **`docs/HELPERS.md`**. |

Schreiben ist **vollständig implementiert** (nicht „Phase 2“), aber abgesichert:

- `DATASEC_WRITES_ENABLED` (Default **`true`** — zum Sperren `false`)
- `DATASEC_REQUIRE_CONFIRM` (Default **`true`** → Write-Tools brauchen `confirm: true`)

Das Roh-Token wird **nie** geloggt oder an Clients zurückgegeben.

## Umgebungen

| | Test | Prod |
|--|------|------|
| REST | `https://dokuwebintegration-saml-0032.datasec.de/api/dokuweb/` | `https://dokuweb-saml-0032.datasec.de/api/dokuweb/` |
| SOAP | `…/api/webservices/Tickets.cfc` | `…/api/webservices/Tickets.cfc` |

Auth: Query/Body `authtoken` — gleicher Token für Test und Prod.

Token-Dateien (Wert nie hardcoden):

- Box: `/workspace/datasec_shared/datasec_token.env`
- PC: `C:\Users\j.bothe\AppData\Local\Temp\datasec_probe\datasec_token.env`

SOAP: nur **raw HTTP POST** (`Content-Type: text/xml; charset=utf-8`, `SOAPAction: ""`) — kein WSDL-Proxy (oft 403).

## Installation

```bash
cd /workspace/datasec-mcp   # bzw. Pfad auf dem PC
npm install
npm run build
```

## Start: stdio (lokal)

Für Claude Desktop / Cursor Local:

```bash
export DATASEC_ENV=test
export DATASEC_TOKEN_FILE=/workspace/datasec_shared/datasec_token.env
# Windows: DATASEC_TOKEN_FILE=C:\Users\j.bothe\AppData\Local\Temp\datasec_probe\datasec_token.env
export DATASEC_WRITES_ENABLED=true
export DATASEC_REQUIRE_CONFIRM=true
npm start
# = node dist/index-stdio.js
```

## Start: HTTP / Streamable HTTP (Remote)

Bindet `0.0.0.0`, Port aus `PORT` (Default **8788**), Pfad **`/mcp`**.  
Zusätzlich Legacy-SSE unter `/sse` + `/messages` (für ältere Clients / mcp-remote).

```bash
export PORT=8788
export DATASEC_ENV=test
export DATASEC_TOKEN_FILE=/workspace/datasec_shared/datasec_token.env
# Multi-Key-Auth (empfohlen):
# export MCP_KEYS_FILE=/pfad/zu/keys.json
# Alternativ/Fallback: export MCP_API_KEY=…  (wird als admin [test,prod] behandelt)
# Ohne keys.json und ohne MCP_API_KEY: HTTP deny (außer MCP_ALLOW_ANON=true)
npm run start:http
# = node dist/index-http.js
```

Health-Check: `GET http://host:8788/health`  
- ohne Key: `ok` + `authRequired`  
- mit gültigem Key: zusätzlich `auth: { name, role, envs }` (nie das Secret)

Auth-Header: `Authorization: Bearer …` **oder** `x-api-key: …`.

### mcp-remote Beispiel

```bash
npx mcp-remote http://127.0.0.1:8788/mcp
# mit API-Key (je nach mcp-remote-Version Header setzen):
# MCP_API_KEY=… npx mcp-remote http://127.0.0.1:8788/mcp
```

## Claude Desktop

Siehe `claude_desktop_config.example.json`. Typisch unter  
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "datasec": {
      "command": "node",
      "args": ["C:/Users/j.bothe/path/to/datasec-mcp/dist/index-stdio.js"],
      "env": {
        "DATASEC_ENV": "test",
        "DATASEC_TOKEN_FILE": "C:\\Users\\j.bothe\\AppData\\Local\\Temp\\datasec_probe\\datasec_token.env",
        "DATASEC_WRITES_ENABLED": "true",
        "DATASEC_REQUIRE_CONFIRM": "true"
      }
    }
  }
}
```

Remote-Variante (wenn HTTP auf dem PC läuft): Client mit URL `http://127.0.0.1:8788/mcp` konfigurieren.

## Cursor

**Project / User MCP** (`.cursor/mcp.json` oder Cursor Settings → MCP):

```json
{
  "mcpServers": {
    "datasec": {
      "command": "node",
      "args": ["C:/Users/j.bothe/path/to/datasec-mcp/dist/index-stdio.js"],
      "env": {
        "DATASEC_ENV": "test",
        "DATASEC_TOKEN_FILE": "C:\\Users\\j.bothe\\AppData\\Local\\Temp\\datasec_probe\\datasec_token.env",
        "DATASEC_WRITES_ENABLED": "true",
        "DATASEC_REQUIRE_CONFIRM": "true"
      }
    }
  }
}
```

Oder HTTP-Transport auf `http://127.0.0.1:8788/mcp`.

## Umgebungsvariablen

| Variable | Default | Bedeutung |
|----------|---------|-----------|
| `DATASEC_ENV` | `test` | `test` oder `prod` |
| `DATASEC_TOKEN_FILE` | (Auto-Kandidaten) | Pfad zur Token-Datei (bevorzugt) |
| `DATASEC_TOKEN` | — | Token direkt (nur lokal, nie committen) |
| `DATASEC_WRITES_ENABLED` | **`true`** | Schreiben erlauben; `false` sperrt Write-Tools |
| `DATASEC_REQUIRE_CONFIRM` | `true` | Write-Tools brauchen `confirm: true` |
| `DATASEC_HELPERS_ENABLED` | **`true`** | `datasec_h_*` Freitext-Helpers; `false` lässt nur Raw-Tools |
| `DATASEC_ADDRESS_CACHE_PATH` | `data/address-crosswalk.json` | Writable Auto-Adresse-Cache (TTL 24h; Seed optional) |
| `PORT` | `8788` | HTTP-Port |
| `HOST` | `0.0.0.0` | HTTP-Bind |
| `MCP_API_KEY` | — | Fallback-Key (admin, envs test+prod), wenn nicht in keys.json |
| `MCP_KEYS_FILE` | (auto: `keys.json` neben App / DATASEC-Desk) | Pfad zur Multi-Key-Datei |
| `MCP_ALLOW_ANON` | `false` | Wenn true: HTTP ohne Key erlauben (Default deny) |
| `DATASEC_DESK` | — | Optionaler Desk-Pfad; dort wird `keys.json` gesucht |
| `BRIDGE_SHARE_PATH` | — | Optionaler lokaler Bridge-Share für `datasec_bridge_info` listPath |


## API-Keys (`keys.json`)

Für Remote/HTTP: mehrere Keys mit **Rolle** und **Env-Einschränkung**.

```json
[
  {
    "name": "claude-john-admin",
    "key": "…langes-geheim…",
    "role": "admin",
    "envs": ["test", "prod"]
  },
  {
    "name": "claude-test-only-read",
    "key": "…",
    "role": "read",
    "envs": ["test"]
  }
]
```

| Rolle | Rechte |
|-------|--------|
| `read` | Suche/Get/Notizen/Links/History/Status; **keine** Write-Tools; `datasec_set_env` nur in `envs`; kann Writes nicht aktivieren |
| `write` | Lesen + Schreiben (weiterhin Confirm-Gate); Env nur in `envs` |
| `admin` | wie write; Status zeigt Key-Name/Rolle |

Pfad: `MCP_KEYS_FILE`, sonst `keys.json` neben der App bzw. unter `DATASEC_DESK`.  
Vorlage: `keys.example.json`. Echte Deploy-Keys nicht committen (`keys.json` / `keys.generated.json` sind in `.gitignore`).

Wenn die aktuelle Session-Umgebung nicht in `envs` liegt, wechselt der Server **automatisch** auf die erste erlaubte Umgebung.  
`DATASEC_WRITES_ENABLED=false` sperrt Writes **unabhängig** von der Rolle.

## Guardrails (Kurz, aus Playbooks)

Nur als Orientierung für Agenten — Details unter `/workspace/datasec_shared/playbooks/`:

- Vor Arbeit **Test vs. Prod** klären; Live-Schreiben nur nach John-Freigabe.
- Verknüpfung: Inhalt/Mieter prüfen; `linkTicketToTicket`, **kein** Master-Hub (`TICKET-VERKNUEPFUNG.md`).
- Status `CLOSED` → UI „Geschlossen“ (verifiziert TEST).
- Anlagen-Check vor Verknüpfung; Unlink nur in der UI.

## API-Lücken

| Gewünscht | Status |
|-----------|--------|
| `linkTicketToTicket` | ✅ SOAP implementiert |
| `getLinkedTickets` | ✅ für `datasec_get_links` |
| `sendTicketMail` / `sendMail` | ❌ **nicht** in API-Doku → Tool ist Stub mit klarer Fehlermeldung |
| Unlink | ❌ nicht gefunden → UI |

## Projektstruktur

```
src/
  auth.ts            # Multi-API-Key, Rollen, AsyncLocalStorage
  client.ts          # Session, Token, Bases, SOAP CFC endpoints
  soap.ts            # Raw SOAP POST (Tickets + helpers)
  rest.ts            # REST tickets + field_count
  documents.ts       # Dokumente REST/SOAP §2.5.1
  stammdaten.ts      # Masterdata/Newsticker §2.5.3–2.5.4
  deeplink.ts        # Direkter Aufruf URL-Builder Kap. 3
  bridge.ts          # Bridge Share-Info Kap. 1
  tools.ts           # Core MCP-Tools + registerExtendedTools + helpers
  tools-extended.ts  # Documents/Tickets+/Stammdaten/Deeplink/SSO/Bridge
  helpers/           # L1 Freitext-Gehirn (datasec_h_*)
  index-stdio.ts     # stdio Entry
  index-http.ts      # HTTP/SSE Entry
config/topic-synonyms.json
data/address-crosswalk.json  # leer — Ops-Befüllung
docs/HELPERS.md      # Helper-Skill, Envelope, Crosswalk-Lücken
TOOLS-INVENTORY.md   # Tool vs. John's Liste (done/stub)
keys.example.json    # Vorlage (keine echten Secrets)
```

## Smoke

Siehe `scripts/smoke-readme.md`.
