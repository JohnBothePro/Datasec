# Datasec MCP — Helper-Layer (`datasec_h_*`)

Freitext-Gehirn für Claude. Raw-Tools (`datasec_*`) bleiben 1:1 unverändert.

**Designed for seconds-latency.** Ein Helper-Call, dann antworten. Keine Multi-Hop-Ketten und keine explorativen Tool-Stürme, außer der User fragt ausdrücklich nach Extras.

## Wann welches Tool

| Situation | Tool |
|-----------|------|
| Deutscher Freitext (Adresse, Mandant, Thema, „Mängel …“) | **`datasec_h_ask`** — **genau ein Call**, dann Antwort |
| Nur Adresse/Mandant → Partner klären | `datasec_h_resolve` |
| Tickets zu Ort/Thema | `datasec_h_find_tickets` |
| Ein Ticket (Kern) | `datasec_h_ticket_briefing` — LIGHT, ohne Includes |
| Schlagworte / Status / Belegtypen | `datasec_h_catalog` (In-Memory-Cache) |
| Partner-Stammdaten | `datasec_h_partner_context` — LIGHT (nur `base`) |
| Dokumente / Akten / Anlagen | `datasec_h_find_documents` |
| Ticket anlegen / Notiz / Status | `datasec_h_*` Write-Tools, **ohne confirm = Vorschau** |

Raw `datasec_search_tickets` nur, wenn `ticketnr` / `partnerId` / echtes Keyword **schon klar** sind.

## Claude-Skill (L2)

```
SPEED: Antworten in Sekunden, nicht Minuten.
Freitext → genau EIN Helper-Call (datasec_h_ask), dann antworten.
Kein exploratives Nachziehen von catalog / notes / documents / raw tools „nur zur Sicherheit“.
Multi-Hop nur wenn der User Extra-Daten ausdrücklich verlangt (Notizen, Historie, Anlagen).

HARD-NO: Niemals eine Straße oder Hausnummer als KEYWORD in datasec_search_tickets.
Adresse über Crosswalk → PARTNERID, dann PARTNERID + KEYWORD/SUBJECT.

getPartnerId ist KEINE Adresssuche (typisch Vertrag + Geburtsdatum).

ticket_briefing und partner_context sind LIGHT: Kern zuerst.
include=[notes|links|history|attachments|…] nur nach expliziter Nachfrage.

Ticket-Anlagen: nur TICKETANLAGEN + TICKETID. Nie TICKETARCHIV.

Schreiben: ohne confirm = Vorschau; Ausführen nur mit confirm:true.
```

## Speed-Budget (Happy Path)

| Hebel | Default |
|-------|---------|
| Treffer `limit` | **10**, hart ≤10 |
| Partner-IDs | max. **4** |
| parallele `search_tickets` | max. **4** |
| Keywords pro Suche | **1** (erstes gemapptes) |
| Timeout pro Raw-Call | **8s** (Fail-fast, Teilresultat + Warnung) |
| Helper-Zeitbudget | **12s** |
| Adresse | **nur Crosswalk** (lokal) |
| Document-Index-Fallback | **aus**; opt-in `allowDocumentFallback=true` → **eine** Suche, **5s** |
| Katalog | In-Memory, TTL 24h (Fehler-Cache 60s) — `list_*` nicht bei jedem Call |
| `ticket_briefing` | LIGHT: nur Ticket-Kern |
| `partner_context` | LIGHT: nur `base` |

Timeouts liefern **Teilresultate + warnings**, keinen Hänger. Straße bleibt trotzdem nie KEYWORD.

## Envelope

```json
{
  "ok": true,
  "data": {},
  "resolution": { "streetAsKeyword": false, "speed": {} },
  "ambiguities": [],
  "warnings": [],
  "raw_calls": [{ "tool": "search_tickets", "ms": 120, "ok": true }]
}
```

Mehrdeutigkeit → `ambiguities[]` + Rückfrage, kein stilles Picken.

## Adressauflösung

1. **Primär (schnell):** `data/address-crosswalk.json`.
2. **Optional, langsam, opt-in:** eine Document-Index-Suche (`OBJEKTAKTE`, 5s).
3. **Leerer Crosswalk:** klare Warnung, **kein** KEYWORD-Missbrauch der Straße, **kein** stiller Crawl.

Seed-Datei ist absichtlich leer. Ops muss befüllen — siehe unten.

## Feature-Flag

`DATASEC_HELPERS_ENABLED` Default **true**. `false` registriert keine `datasec_h_*`; Raw-Tools unverändert.

HTTP + stdio nutzen beide `createDatasecServer()`.

## Was Ops noch liefern muss (Crosswalk)

Ohne gefüllten Crosswalk bleibt Straßen→Partner lokal leer (schnell + ehrlich):

1. **Mandant 27** — Feld/Nummer/Präfix in Datasec.
2. **Adress-/Objekt-Export** (Wodis o. ä.).
3. **Indexfeld-Namen** der Objektakte (nur für den seltenen Fallback).
4. **Echtes Schlagwort** für „Mängel“.
5. Ob Tickets `PARTNERID` oder die PARTNER-Nummer tragen.

`config/topic-synonyms.json` nach Katalog-Abgleich nachziehen.

## Dateien

```
src/helpers/
  speed.ts             # Caps + Timeouts (seconds-latency)
  envelope.ts
  normalize.ts
  catalog.ts           # In-Memory TTL
  topic.ts
  resolve-place.ts     # Crosswalk first
  find-tickets.ts
  ticket-briefing.ts   # LIGHT default
  partner-context.ts   # LIGHT default
  ask.ts
  write-guided.ts
  find-documents.ts
  register-helpers.ts
```
