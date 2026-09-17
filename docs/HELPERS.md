# Datasec MCP — Helper-Layer (`datasec_h_*`)

Freitext-Gehirn für Claude. Raw-Tools (`datasec_*`) bleiben 1:1 unverändert.

**Designed for seconds-latency.** Ein Helper-Call, dann antworten. Keine Multi-Hop-Ketten und keine explorativen Tool-Stürme, außer der User fragt ausdrücklich nach Extras.

## Wann welches Tool

| Situation | Tool |
|-----------|------|
| Deutscher Freitext (Adresse, Mandant, Thema, Akte, Katalog, News) | **`datasec_h_ask`** — **genau ein Call**, dann Antwort |
| Nur Adresse/Mandant → Partner klären | `datasec_h_resolve` |
| Tickets zu Ort/Thema | `datasec_h_find_tickets` |
| Ein Ticket (Kern) | `datasec_h_ticket_briefing` — LIGHT, ohne Includes |
| Schlagworte / Status / Belegtypen | `datasec_h_catalog` (In-Memory-Cache + Live-Listen) |
| Partner-Stammdaten | `datasec_h_partner_context` — LIGHT (nur `base`) |
| Dokumente / Akten / Anlagen | `datasec_h_find_documents` |
| Newsticker | `datasec_h_news` |
| Ticket anlegen / Notiz / Status | `datasec_h_*` Write-Tools, **ohne confirm = Vorschau** |

Raw `datasec_search_tickets` nur, wenn `ticketnr` / `partnerId` / echtes Keyword **schon klar** sind.

## Claude-Skill (L2)

```
SPEED: Antworten in Sekunden, nicht Minuten.
Freitext → genau EIN Helper-Call (datasec_h_ask), dann antworten.
Kein exploratives Nachziehen von catalog / notes / documents / raw tools „nur zur Sicherheit“.
Multi-Hop nur wenn der User Extra-Daten ausdrücklich verlangt (Notizen, Historie, Anlagen).

AUTO-ADRESSE: Live-Pfad ruft getDocumentTypeStructure auf und filtert nur
existierende Indexfelder. STREET/STRASSE/HAUSNR sind Kandidaten, keine Annahme.
Fehlen Straßenfelder: klare Warnung, keine 404-Filter. Optional SWENR.
Seed/Cache bleiben Override.

HARD-NO: Niemals eine Straße oder Hausnummer als KEYWORD in datasec_search_tickets.
Adresse → PARTNERID, dann PARTNERID + KEYWORD/SUBJECT.

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
| Live-Adresse | **1–2** Belegtypen, **5** Zeilen, **5s** Timeout |
| Adress-Cache | Memory **15min**, Disk **24h** |
| Document-Index | default **an** (`liveResolve:false` = Seed/Cache only) |
| Katalog | In-Memory, TTL 24h (Fehler-Cache 60s) + Synonym-Fallback |
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

## Auto-Adresse (aus Datasec)

Leerer Crosswalk als einziger Pfad ist **nicht** akzeptabel. Resolve zieht Daten selbst.

1. **Memory-Cache** (15 min, Key = Mandant + Straße + Hausnr).
2. **Optionaler Seed** (`seed_entries[]` in `data/address-crosswalk.json`) — Override/Bootstrap, kein TTL.
3. **Disk-Cache** (`entries[]` mit `source=live_cache` + `cachedAt`) — 24h TTL.
4. **Live:** zuerst `getDocumentTypeStructure` (Cache), dann `search_by_document_type` auf **OBJEKTAKTE**, bei 0 Treffern **MIETERAKTE**.
   Nur Felder, die in der Struktur vorkommen. Unbekannte Felder (z. B. `STREET` auf SAP-Index) werden **nicht** gesendet — das wäre HTTP 404.
   Gibt es keine Straßenfelder: keine Adresssuche über den Index; Warnung (PARTNERID / Ticketnr / SWENR).
   Ist `SWENR` bekannt und im Index vorhanden: Filter `SWENR`.
   Hausnr-Abgleich nur clientseitig, wenn ein Hausnr-Feld existiert.
5. Treffer werden in Memory + Disk geschrieben (best-effort). `DATASEC_ADDRESS_CACHE_PATH` überschreibt den Dateipfad.
6. Mehrere Partner → `ambiguities[]`, kein stilles Picken.
7. API-Fehler/Timeout → klare Warning + leeres Teilresultat, kein Hänger.
8. `liveResolve:false` (oder `allowDocumentFallback:false`) bleibt lokal — Tests/Offline.

**Invalidation:** TTL. Seed läuft nicht ab. Fehlgeschlagene Live-Suche löscht gültigen Cache nicht.

`getPartnerId` wird nicht verwendet.

## Feature-Flag

`DATASEC_HELPERS_ENABLED` Default **true**. `false` registriert keine `datasec_h_*`; Raw-Tools unverändert.

HTTP + stdio nutzen beide `createDatasecServer()`.

## Inventar: Helper vs Raw (Gap)

Abgedeckt über `datasec_h_ask` / Helfer:

| DOKU-Bereich | Helper-Intent / Tool |
|--------------|----------------------|
| Tickets suchen / briefing | `find_tickets`, `ticket_briefing` |
| Adresse → Partner | `resolve` (live) |
| Dokumente / Akten / Anlagen | `find_documents` |
| Stammdaten / Partner | `partner_context` |
| Katalog (Keywords, Status, Belegtypen, Abteilungen) | `catalog` |
| Newsticker | `news` |
| Schäden / Instandhaltung | `damage_reports` → partner_context include |
| Ticket anlegen / Notiz / Status | guided writes, preview-then-confirm |

Noch **raw-only** (kein Freitext-Intent — bewusst, um Tool-Stürme zu vermeiden):

- Ticket-Prozess: Buttons, Felder, first step, forward, link, master-ticket, set_keyword, set_ticket_values, chat (Briefing-`include` deckt notes/links/history/attachments/buttons/chat ab)
- Dokument schreiben: archive, update index, get binary document, search_in_process
- Stammdaten-Extras: App-User, GP-Masterdata, Sonderdaten, EED, Push-Flags, Kontakt-Update, Doc-read
- Deep-Links Kap. 3, Bridge, SSO-Stub, Mail-Stub

Diese bleiben über `datasec_*` erreichbar, wenn der User sie ausdrücklich braucht.

## Dateien

```
src/helpers/
  speed.ts             # Caps + Timeouts (seconds-latency)
  envelope.ts
  normalize.ts
  catalog.ts           # In-Memory TTL + live list_* + Synonym-Fallback
  topic.ts
  resolve-place.ts     # Live Datasec + Memory/Disk-Cache + optional Seed
  find-tickets.ts
  ticket-briefing.ts   # LIGHT default
  partner-context.ts   # LIGHT default
  ask.ts               # Freitext-Router (Tickets, Akten, Partner, Katalog, News, Writes)
  write-guided.ts
  find-documents.ts
  news.ts
  register-helpers.ts
```
