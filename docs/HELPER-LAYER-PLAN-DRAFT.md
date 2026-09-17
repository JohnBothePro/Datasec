# Datasec MCP — Helper-Layer Gesamtplan (Draft)

Stand: 2026-09-17 — Bob (noch ohne finale Claude/TinkaBot-Antworten)

## 1. Ziel

Claude soll Freitext-Aufgaben („Tickets zu Mängeln, Mandant 27, Hauptstraße 118/a/b“) zuverlässig lösen,
ohne falsche API-Filter zu erfinden. Dafür bauen wir eine **zweite Tool-Schicht (Composite Helpers)**
über die bestehenden 52 Raw-API-Tools.

Nicht ersetzen: Raw-Tools bleiben 1:1 zur DOKU@WEB API V1.7.
Ergänzen: Helpers orchestrieren mehrere Raw-Calls serverseitig.

## 2. Ist-Zustand

- **54 registrierte Tools** (52 real, 2 Stubs: send_ticket_mail, sso_status)
- Abdeckung API-Kapitel 2.5.1–2.5.4 + Deeplinks Kap. 3 weitgehend **done** (siehe TOOLS-INVENTORY.md)
- Always-On: nssm `DatasecMCP` + `CloudflaredTunnel` unter `C:\ProgramData\datasec-mcp-runtime`
- Skill/Hard-Speed-Rules: oft **1× search_tickets** — kollidiert mit Adress-Workflows
- Lücke: Ticket-Suche hat **keine** Straße/Hausnr/Mandant-Felder → nur KEYWORD, SUBJECT, PARTNERID, STATE, …

## 3. Architektur (3 Schichten)

```
┌─────────────────────────────────────────────┐
│  Claude (+ Skill Playbooks, kurz)           │
├─────────────────────────────────────────────┤
│  L2 Helper Tools (neu)                      │
│  datasec_find_tickets_by_place              │
│  datasec_resolve_partners_by_address        │
│  datasec_ticket_briefing                    │
│  datasec_map_topic_to_keyword               │
│  …                                          │
├─────────────────────────────────────────────┤
│  L1 Raw Tools (bestehend, unverändert)      │
│  search_tickets, get_partner_*, documents…  │
├─────────────────────────────────────────────┤
│  L0 HTTP/SOAP Client (rest.ts / soap.ts)    │
└─────────────────────────────────────────────┘
```

Prinzipien:
- Helpers rufen **interne Funktionen** auf (nicht MCP-self-call).
- Writes nur über bestehende `gateWrite`/`confirm`.
- Helpers sind read-first; Write-Helpers brauchen `confirm:true`.
- Jeder Helper liefert strukturiertes JSON: `{ ok, steps[], result, warnings[] }`.

## 4. P0 Helper (zuerst bauen — Pain von heute)

### 4.1 `datasec_resolve_place`
Input: `{ mandant?, street, houseNumbers[], city?, zip? }`
Output: `{ partners: [{ partnerId, label, street, houseNo, matchScore }], unresolved[] }`
Intern: Stammdaten/Partner-Suche (Felder wie STREET/GE_STREET/HAUSNR je nach verfügbarer API),
Normalisierung 118/118a/118b, ß/ss.

### 4.2 `datasec_map_topic`
Input: `{ topic: "Mängel" }`
Output: `{ keywords: [exakte Schlagworte], subjectHints: ["*Mangel*", …] }`
Intern: `list_keywords` + Synonym-Map (config JSON, pflegbar).

### 4.3 `datasec_find_tickets_by_place`  ★ Haupt-Tool für Johns Beispiel
Input:
```json
{
  "topic": "Mängel",
  "mandant": "27",
  "street": "Hauptstraße",
  "houseNumbers": ["118", "118a", "118b"],
  "state": null,
  "max": 20
}
```
Flow:
1. resolve_place → partnerIds
2. map_topic → keyword/subjectLike
3. pro Partner (oder batched) `search_tickets` mit PARTNERID + KEYWORD/SUBJECT
4. dedupe by ticketnr, sort by update/create
5. Return tickets + resolution debug

### 4.4 `datasec_ticket_briefing`
Input: `{ ticketnr }`
Output: Ticket + optional notes/links/state (1 Call für Claude statt 4)
Flags: `includeNotes`, `includeLinks`, `includeHistory` (default notes=false für Speed)

## 5. P1 Helper (nächste Welle)

| Helper | Zweck |
|--------|--------|
| `datasec_find_tickets_nl` | Dünner Parser: Freitext → find_tickets_by_place args (regex/heuristik, kein LLM im Server) |
| `datasec_search_documents_for_partner` | Partner → Belegtypen-Suche mit sinnvollen Defaults |
| `datasec_open_ticket_context` | briefing + deeplink_akte |
| `datasec_list_open_work` | Postkorb/State-Presets („meine offenen“) |
| `datasec_prepare_create_ticket` | keyword/category/fields first step bundeln (noch ohne create) |

## 6. P2 Helper / Lücken aus Doku

- Raw-Lücken nur wo API existiert aber Tool fehlt (laut Inventory fast voll)
- Stubs nicht „fertiglügen“: mail/sso bleiben stub bis API da
- Optional: `allowedtickets` Variante wenn Rechte-Filter nötig
- Batch-Helpers für Massenauskunft (mit hartem max)

## 7. Skill-Anpassung (parallel, klein)

Hard-Speed erweitern:
- Adress/Mandant/Thema-Fragen → **ein** Helper `find_tickets_by_place` (nicht raw search raten)
- Raw `search_tickets` nur wenn ticketnr/keyword/partnerId schon klar
- Playbook 10 Zeilen in project-instructions

## 8. Dateistruktur

```
src/
  tools.ts              # raw core (keep)
  tools-extended.ts     # raw extended (keep)
  helpers/
    place.ts            # resolve address/mandant
    topic.ts            # keyword mapping
    tickets-by-place.ts
    ticket-briefing.ts
    register.ts         # registerHelperTools(server)
  config/
    topic-synonyms.json
    mandant-rules.json  # wie Mandant 27 → Filter (klären!)
```

## 9. Offene Fachfragen an John (vor Implementierung P0)

1. Wie ist **Mandant 27** in Datasec modelliert? (PARTNERID-Prefix, eigenes Indexfeld, Firma, …)
2. Welches Feld trägt **Straße/Hausnr** in euren Partner-/Objekt-Stammdaten?
3. Heißt das Schlagwort exakt „Mängel“ / „Mangel“ / „Mängelanzeige“?
4. Soll Suche test oder prod defaulten?



## 9b. Wichtiger API-Fund (Adresse ≠ getPartnerId)

`getPartnerId` (2.5.3.1) erwartet **kundenspezifisches** `sParams` JSON — typisch Mietvertragsnr + Geburtsdatum, **nicht** Straße/Hausnummer.

Adressauflösung für Tickets muss daher über andere Wege:
1. Belegtyp-/Index-Suche mit Feldern wie `STREET` / `GE_STREET` / Hausnr (Dokumenten-API 2.5.1.5)
2. ggf. Schadensmeldungen `getPartnerMaintenanceIssues` wenn Partner schon bekannt
3. Partnerid aus Treffer → `search_tickets` mit PARTNERID

Mandant 27: Mapping klären (Firmen-/Mandantenpräfix in PARTNERID? Objektkatalog?). Ohne diese Klärung Helper nur halb deterministisch.

## 10. Testplan

1. Unit: Normalizer Hausnr, Synonyme
2. Integration test env: resolve Hauptstraße 118* Mandant 27
3. Golden query: Johns Satz → ≥1 plausible tickets oder klare empty+steps
4. Regression: bestehende raw tools unverändert
5. Claude-E2E: neuer Chat, ein Helper-Call, keine Filter-Fehler

## 11. Rollout

1. Helpers nur in test keys
2. Deploy runtime ProgramData + nssm restart
3. Skill/Project Instructions updaten
4. Claude Connector Session reset (neuer Chat)
5. Logoff-Test Always-On unberührt lassen

## 12. Aufwand (grob)

- P0: 1–2 Tage inkl. Mandant-Klärung + Tests
- P1: +1–2 Tage
- P2: nach Bedarf

## 13. Nicht-Ziele

- Kein zweiter MCP-Server
- Kein Ersetzen der Raw-Tools
- Kein LLM im MCP-Server für Parsing (Deterministik + Wartbarkeit)
