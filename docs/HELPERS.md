# Datasec MCP — Helper-Layer (`datasec_h_*`)

Freitext-Gehirn für Claude. Raw-Tools (`datasec_*`) bleiben 1:1 unverändert.

## Wann welches Tool

| Situation | Tool |
|-----------|------|
| Deutscher Freitext (Adresse, Mandant, Thema, „Mängel …“) | **`datasec_h_ask`** — ein Call |
| Nur Adresse/Mandant → Partner klären | `datasec_h_resolve` |
| Tickets zu Ort/Thema | `datasec_h_find_tickets` |
| Ein Ticket inkl. Notizen/Links/Anlagen | `datasec_h_ticket_briefing` |
| Schlagworte / Status / Belegtypen nachschlagen | `datasec_h_catalog` |
| Partner-360° | `datasec_h_partner_context` |
| Dokumente / Akten / Anlagen | `datasec_h_find_documents` |
| Ticket anlegen / Notiz / Status | `datasec_h_*` Write-Tools, **ohne confirm = Vorschau** |

Raw `datasec_search_tickets` nur, wenn `ticketnr` / `partnerId` / echtes Keyword **schon klar** sind.

## Claude-Skill (L2)

```
Freitext mit Adresse, Mandant oder Thema → datasec_h_ask (genau ein Call), nicht raw raten.

HARD-NO: Niemals eine Straße oder Hausnummer als KEYWORD in datasec_search_tickets.
Adresse wird über Crosswalk (datasec_h_resolve) zu PARTNERID, dann PARTNERID + KEYWORD/SUBJECT.

getPartnerId ist KEINE Adresssuche (typisch Vertrag + Geburtsdatum). Nicht dafür verwenden.

Ticket-Anlagen: nur TICKETANLAGEN + TICKETID. Nie TICKETARCHIV.

Schreiben: datasec_h_create_ticket / add_note / set_state ohne confirm = Vorschau.
Ausführen nur mit confirm:true (zusätzlich bestehendes Write-Gate).
```

## Envelope

Jeder Helper liefert:

```json
{
  "ok": true,
  "data": {},
  "resolution": { "streetAsKeyword": false },
  "ambiguities": [],
  "warnings": [],
  "error": null,
  "raw_calls": [{ "tool": "search_tickets", "ms": 120, "ok": true }]
}
```

Mehrdeutigkeit → `ambiguities[]` + Rückfrage, kein stilles Picken.

## Adressauflösung

1. **Primär:** `data/address-crosswalk.json` (`entries[]`: Mandant, Straße, Hausnr → `partnerId`).
2. **Optional:** Document-Index-Fallback (`OBJEKTAKTE` / `MIETERAKTE`, Felder `STREET` / `GE_STREET` / `HAUSNR`).
3. **Leerer Crosswalk:** klare Warnung, **kein** KEYWORD-Missbrauch der Straße.

Seed-Datei ist absichtlich leer. Ops muss befüllen — siehe unten.

## Fan-out

- max. 8 Partner-IDs
- max. 6 interne `search_tickets`-Calls
- Dedupe nach `ticketnr`

## Feature-Flag

`DATASEC_HELPERS_ENABLED` Default **true**. `false` registriert keine `datasec_h_*`; Raw-Tools unverändert.

HTTP + stdio nutzen beide `createDatasecServer()` → Helpers sind dort verdrahtet.

## Was Ops noch liefern muss (Crosswalk)

Die Helper-Schicht ist gebaut; Straßen-Treffer in Tickets bleiben unscharf, bis das Verzeichnis steht:

1. **Mandant 27** — Feld/Nummer/Präfix in Datasec (nicht geraten).
2. **Adress-/Objekt-Export** (Wodis o. ä.) mit Mandant, Straße, Hausnr, Partner-ID, Objekt/WE.
3. **Indexfeld-Namen** der Objekt-/Mieterakte (`get_document_type_structure`) — `STREET` vs. `GE_STREET` etc.
4. **Echtes Schlagwort** für „Mängel“ (aktuell Synonym → `Mängel`; per `datasec_h_catalog` gegen 491er-Liste prüfen).
5. Ob Tickets `PARTNERID` oder die PARTNER-Nummer tragen.

`config/topic-synonyms.json` nach Katalog-Abgleich nachziehen.

## Dateien

```
src/helpers/
  envelope.ts          # { ok, data, resolution, ambiguities, warnings, raw_calls }
  normalize.ts         # Straße / Hausnr
  catalog.ts           # Cache keywords/statuses/doc types
  topic.ts             # Synonyme
  resolve-place.ts     # Crosswalk + optionaler Dok-Fallback
  find-tickets.ts      # resolve → search_tickets
  ticket-briefing.ts   # Ticket + Includes (TICKETANLAGEN)
  partner-context.ts
  ask.ts               # Freitext-Router, kein LLM
  write-guided.ts      # Preview / confirm + gateWrite
  find-documents.ts
  register-helpers.ts
config/topic-synonyms.json
data/address-crosswalk.json
```
