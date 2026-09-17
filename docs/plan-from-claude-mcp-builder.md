# Implementierungsplan: Helper-Tool-Schicht für den Datasec DOKU@WEB MCP

Basis: mcp-builder-Skill (Phasen Research → Implementation → Review/Test → Evaluations), DOKU@WEB-Handbuch V1.7, aktueller Serverstand (54 Tools, TypeScript-Empfehlung des Skills, Confirm-Gate vorhanden). Reine Planung, kein Deployment.

---

## 1. Zielbild & Designprinzipien

**Kernproblem:** NL-Anfragen wie *„Tickets Mängel Mandant 27 Hauptstraße 118/118a/118b"* scheitern, weil `datasec_search_tickets` nur KEYWORD / SUBJECT / PARTNERID / STATUS (+ Datum) kann — keine Straße, keine Synonyme, keine Kategorie-Auflösung. Claude rät dann Filter oder baut lange Raw-Call-Ketten.

**Lösung:** Zwei Schichten im selben Server:

1. **Raw-Layer (unverändert):** alle ~54 `datasec_*`-Tools bleiben 1:1 bestehen (API-Coverage-Prinzip aus dem mcp-builder-Skill: „when uncertain, prioritize comprehensive API coverage" — bleibt erfüllt).
2. **Helper-Layer (neu, Prefix `datasec_h_` oder `dsx_`):** wenige, workflow-orientierte Composite-Tools, die intern mehrere Raw-Calls orchestrieren, sodass Claude für Standard-Workflows **genau einen Call** braucht. Passt zu den bestehenden HARD SPEED RULES („ein Call, dann antworten").

**Prinzipien:**
- Helpers rufen intern nur die Raw-Implementierungen (gleiche Client-Funktionen), nie eigene API-Pfade → keine Doppel-Logik.
- Read-Helpers sind reine Reads (`readOnlyHint: true`). Write-Helpers erzeugen erst einen **Plan (dry_run)** und mutieren nur mit `confirm: true` — das bestehende Gate (`writesEnabled` + `requireConfirm` + Prod-Freigabe) wird durchgereicht, nie umgangen.
- Jeder Helper liefert einen **Resolution-Report** (was wurde wie gemappt) → Nachvollziehbarkeit und Selbstkorrektur für Claude.
- Deterministisches Mapping vor LLM-Raten: Kataloge (491 Schlagworte, 90 Kategorien, 39 Gruppen, Statuswerte, 42 Belegtypen) werden serverseitig gecacht und für Fuzzy-Matching genutzt.

---

## 2. Das zentrale Auflösungsproblem: Adresse/Mandant → Partner → Tickets

**Fakten (V1.7):** Ticket-Suche filtert auf PARTNERID; Straße existiert nur in Dokument-Indexfeldern (OBJEKTAKTE/MIETERAKTE) und ggf. in Stammdaten (`getPartnerBaseData` liefert Adresse, aber nur *pro bekannter Partner-ID* — keine Rückwärtssuche).

**Geplante Auflösungskette (`resolve`-Service):**

1. **Lokaler Crosswalk (primär):** persistente Mapping-Tabelle `address_index` (Mandant, WE/Objekt-Nr, Straße+Hausnr-Range, Partner-IDs, Objekt-Akten-Schlüssel), initial befüllt aus (a) Wodis-Export (CSV/Excel-Import-Kommando) und/oder (b) einmaligem Crawl der OBJEKTAKTE/MIETERAKTE-Indexfelder via `search_by_document_type` (Struktur vorher per `get_document_type_structure` ermitteln). Danach TTL-Refresh (z. B. wöchentlich) statt Live-Suche.
2. **Live-Fallback:** wenn Crosswalk keinen Treffer hat → gezielte `search_by_document_type`-Abfrage auf das Straßen-Indexfeld der OBJEKTAKTE (nur dieser Fall darf 1–2 Dokumentsuchen kosten).
3. **Normalisierung:** Hausnummern-Parser für deutsche Formate: „118/118a/118b", „118-120", „118 a-c" → Set {118, 118a, 118b}; Straßen-Normalisierung (str./straße, Umlaute, Whitespace).
4. **Disambiguierung:** mehrere Kandidaten → Helper antwortet nicht mit leerem Ergebnis, sondern mit `ambiguities: [{candidate, why, score}]` und einer Empfehlung; Claude kann dann rückfragen oder mit `partner_ids` explizit erneut aufrufen.

**Annahmen (zu verifizieren, siehe Abschnitt 7):**
- A1: `getPartnerId` (§2.5.3.1) erwartet die ERP-/Wodis-Partnernummer o. ä., **keine** Adresssuche.
- A2: OBJEKTAKTE/MIETERAKTE haben ein befülltes Straßen-/Objekt-Indexfeld (per `get_document_type_structure` prüfbar).
- A3: Ein Ticket trägt genau eine PARTNERID; adressbezogene Suche = Suche über die Menge der Partner-IDs des Objekts (Fan-out nötig).

---

## 3. Tool-Liste (priorisiert)

### P0 — löst das akute Problem

**1. `datasec_h_find_tickets`** *(read-only)* — der eine Ticket-Such-Einstieg für NL.

Input:
```json
{
  "query_text": "Mängel Hauptstraße 118/118a/118b",   // optional, wird gemappt
  "mandant": "27",                                     // optional
  "address": {"street": "Hauptstraße", "numbers": "118/118a/118b", "city": null}, // optional strukturiert
  "partner_ids": ["..."],        // optional, überspringt Auflösung
  "keyword": "Mängel",           // Freitext, wird auf Kategorie/Schlagwort/Gruppe gemappt
  "status": "offen",             // Freitext, wird auf echte Statuswerte gemappt
  "created_from": "2026-01-01", "created_to": null,
  "limit": 10, "cursor": null
}
```
Output:
```json
{
  "ok": true,
  "tickets": [{"ticketnr": "32-260907-Q0009", "subject": "...", "status": "...", "keyword": "...", "partner_id": "...", "created": "...", "deeplink": null}],
  "total_estimate": 23,
  "next_cursor": "eyJvZmZzZXRz...",
  "resolution": {
    "address": {"matched": ["Hauptstraße 118","118a","118b"], "partner_ids": ["4711","4712"], "source": "crosswalk"},
    "keyword": {"input": "Mängel", "mapped_to": {"type": "category", "value": "Mängel", "expanded_keywords": ["…107 Stück, gekürzt…"]}},
    "status": {"input": "offen", "mapped_to": ["In Bearbeitung","Neu"], "note": "'offen' existiert nicht als API-Wert"}
  },
  "ambiguities": [], "warnings": [], "raw_calls": [{"tool": "search_tickets", "count": 2, "ms": 340}]
}
```
Intern: resolve → 1..N `search_tickets` (ein Call pro Partner-ID × Statuswert, gedeckelt, siehe §5 Fan-out) → Merge/Dedupe nach `ticketnr` → Sortierung nach Datum. Beispielaufruf, der heute scheitert und dann funktioniert: `datasec_h_find_tickets({"mandant":"27","address":{"street":"Hauptstraße","numbers":"118/118a/118b"},"keyword":"Mängel","status":"offen"})`.

**2. `datasec_h_resolve`** *(read-only)* — Adresse/Mandant/Name/WE → Partner-/Objekt-Kandidaten. Input `{mandant?, address?, partner_name?, we_nr?}`; Output `{candidates:[{partner_id, name, address, objekt, score, source}], ambiguous: bool}`. Wird von find_tickets intern genutzt, aber auch einzeln exponiert (Debugging, Vorab-Klärung).

**3. `datasec_h_ticket_briefing`** *(read-only)* — ein Call statt Kette. Input `{ticketnr, include: ["notes","history","links","process_buttons","documents","chat"]}` (Default: nur Kerndaten + letzte 3 Notizen). Output: kompaktes Briefing-Objekt mit klar getrennten Sektionen; `documents` löst intern TICKETANLAGEN korrekt auf (nie via TICKETARCHIV-Suche — bekannter 404-Bug). Ersetzt die heute verbotenen Ketten durch **einen erlaubten** Helper-Call.

**4. `datasec_h_catalog`** *(read-only, gecacht)* — Input `{kind: "keywords"|"statuses"|"groups"|"doc_types"|"departments", filter?: "Mäng"}`; Output gefilterte, kompakte Liste + Cache-Alter. Verhindert, dass Claude 491 Schlagworte in den Kontext zieht; dient auch als Grundlage des Mappers.

### P1 — Workflows rund um Tickets/Dokumente/Partner

**5. `datasec_h_create_ticket_guided`** *(write, confirm)* — Input: NL-Felder (subject, description, keyword_text, group_text, partner/address, priority). Schritt 1 (`confirm:false`, Default): validiert & mappt alles, liefert den **exakten geplanten `create_ticket`-Payload** als Vorschau. Schritt 2 (`confirm:true` + `plan_id`): führt exakt diesen Payload aus, gibt `ticketnr` zurück. Kein stilles Mutieren; Prod nur mit zusätzlicher Freigabe laut bestehender Regel.

**6. `datasec_h_partner_360`** *(read-only)* — `{partner_id | resolve-Input, include:["base","extended","contracts","conditions","damage_reports","open_tickets"]}` → Partner-Briefing in einem Call (intern: partner_base/extended/contracts/getPartnerMaintenanceIssues + find_tickets).

**7. `datasec_h_attach_document_to_ticket`** *(write, confirm)* — Dokument-zu-Ticket-Workflow: Input `{ticketnr, file|base64|doc_ref, doc_type?, index_overrides?}`; Plan-Phase zeigt Belegtyp + Indexfelder (aus `get_document_type_structure` abgeleitet), Ausführung via `archive_document_rest` mit Ticket-Verknüpfungsfeldern. Annahme A4: TICKETANLAGEN-Indexfelder erlauben die Verknüpfung per Ticketnr/-id — im PDF §2.5.1.x verifizieren.

**8. `datasec_h_find_documents`** *(read-only)* — NL-Dokumentsuche: mappt „Mietvertrag Müller" → Belegtyp-Kandidaten (MIETERAKTE, VERM_*) + Indexfeld-Filter; intern 1–3 `search_by_document_type`; gleiche Resolution-/Ambiguity-Semantik wie find_tickets.

**9. `datasec_h_process_advance`** *(write, confirm)* — `{ticketnr}` → Plan: aktuelle Prozessschaltflächen + Pflicht-Prozessfelder; `{confirm:true, button_id, field_values}` → press_process_button. Kapselt get_process_buttons/fields/press in einen 2-Phasen-Flow.

**10. `datasec_h_deeplink`** *(read-only, aber sicherheitskritisch)* — `{target: "ticket"|"akte"|"suche", ref}` → fertiger Deeplink. Token-Variante bleibt Admin-only + confirm (bestehende Regel), Token nie im Klartext im Output — nur maskiert/als „mit Token generiert".

### P2 — Ausbau

**11. `datasec_h_bulk_update_tickets`** *(write, confirm pro Batch)* — Statuswechsel/Schlagwort für eine Ticketliste; Plan zeigt jede Änderung einzeln; Ausführung nur als Ganzes bestätigter Batch, mit Per-Item-Ergebnis.
**12. `datasec_h_digest`** *(read-only)* — „Was ist neu seit X" (neue Tickets, Statuswechsel via state_history-Stichprobe) für die geplante Gehirn-Aufgabe.
**13. `datasec_h_damage_summary`** *(read-only)* — Schadensmeldungen je Partner/Objekt aggregiert.
**14. `datasec_h_crosswalk_admin`** *(write, confirm)* — Crosswalk-Import/Refresh (Wodis-CSV, OBJEKTAKTE-Crawl), Statistiken, Stale-Warnung.

---

## 4. Abdeckung & Lücken (Bestand ~54 Tools vs. API V1.7)

**Abgedeckt bleibt alles Bestehende** (Status/Meta 4, Dokumente 10, Tickets 21, Stammdaten 12, Sonstiges inkl. 5 Deeplinks). Helpers ergänzen, ersetzen nichts.

**Explizite Lücken/Grenzen der API, die kein Helper „wegzaubern" kann (im Plan als bekannte Grenzen dokumentieren):**
- Keine Adress-/Freitextsuche in der Ticket-API → daher Crosswalk (§2) als eigene Datenhaltung, mit Stale-Risiko.
- Keine echte serverseitige Pagination der Ticket-Suche über Cursor (Annahme A5: nur `max`-Begrenzung) → Helper-Pagination ist clientseitig (Offset im Cursor kodiert), Konsistenz nicht garantiert bei parallelen Änderungen.
- Kein Event-/Webhook-Mechanismus (nur Bridge-Polling) → Digest ist Pull-basiert.
- `send_ticket_mail` und SSO: nicht in V1.7 — bleiben Stubs, Helpers nutzen sie nie.
- TICKETARCHIV via Dokumentsuche unzuverlässig (404) — Helper-intern hart verboten.
- Deeplink-Authtoken: 64-stellig, unbegrenzt gültig — Sicherheitsgrenze der API selbst; Mitigation nur organisatorisch (Maskierung, Admin+confirm).

---

## 5. Querschnittsthemen

**Fehler & Teilresultate:** Einheitlicher Envelope `{ok, data, resolution, ambiguities, warnings, error?}`. Fehlertexte aktionsorientiert (mcp-builder-Vorgabe), z. B.: *„Status 'offen' ist kein Datasec-Statuswert. Gemappt auf ['Neu','In Bearbeitung']. Für exakte Werte: datasec_h_catalog(kind='statuses')."* Bei Ausfall einzelner Fan-out-Calls: Teilresultat + Warnung statt Totalfehler.

**Fan-out-Deckel:** max. 6 interne search_tickets pro Helper-Call, max. 8 Partner-IDs pro Auflösung; darüber → Ambiguity-Antwort mit Bitte um Eingrenzung. Timeout pro Raw-Call ~10 s, Gesamt ~30 s.

**Pagination:** `cursor` = base64(JSON) mit Query-Hash + per-Source-Offsets; ungültiger/fremder Cursor → klarer Fehler mit Neustart-Hinweis.

**Observability:** strukturierte Logs pro Helper-Call (Trace-ID, Raw-Call-Liste mit Dauer/Status — auch im Output als `raw_calls`), Zähler für Mapping-Misses (welche Freitexte konnten nicht gemappt werden → Futter für Synonym-Pflege), Cache-Hit-Rate. Angesichts der dokumentierten 502-Flapping-Historie zusätzlich ein `/health`-Endpoint + Startup-Log der Tool-Registrierung.

**Kompatibilität:** Raw-Tool-Namen/-Schemas byte-identisch; Helpers nur additiv; Skill „datasec-mcp"/SPEED RULES werden nach P0 um einen Absatz ergänzt („NL-Anfragen mit Adresse/Kategorie → `datasec_h_find_tickets`, ein Call") — Skill-Update ist Teil des Rollouts, nicht des Servers.

**Annotations (mcp-builder):** alle Helpers mit `readOnlyHint`/`destructiveHint`/`idempotentHint` korrekt gesetzt; Read-Helpers `idempotentHint: true`; Write-Helpers `destructiveHint` je nach Aktion; `outputSchema`/`structuredContent` für alle Helpers definieren (Zod).

---

## 6. Dateistruktur / Modulgrenzen (TypeScript, gemäß Skill-Empfehlung)

```
src/
  server.ts                  // Registrierung: raw + helpers, Feature-Flag HELPERS_ENABLED
  config/env.ts              // env, writesEnabled, requireConfirm, prod-Guard
  clients/                   // bestehende REST/SOAP-Clients (unverändert)
  schemas/
    common.ts                // Envelope, Cursor, Ambiguity, ConfirmPlan (Zod)
    tickets.ts | partners.ts | documents.ts
  tools/
    raw/…                    // bestehende ~54 Tools, UNVERÄNDERT
    helpers/
      find-tickets.ts  resolve.ts  ticket-briefing.ts  catalog.ts        // P0
      create-ticket.ts partner360.ts attach-doc.ts find-docs.ts
      process-advance.ts deeplink.ts                                     // P1
      bulk.ts digest.ts damage.ts crosswalk-admin.ts                     // P2
  services/
    catalog-cache.ts         // keywords/statuses/doctypes, TTL 24h, Lazy-Load
    address-index.ts         // Crosswalk (SQLite/JSON-Datei), Import/Refresh
    mapper.ts                // Freitext→Katalog (normalize + fuzzy + Synonymtabelle)
    hausnummer.ts            // 118/118a/118b-Parser
    fanout.ts pagination.ts confirm-gate.ts
  observability/logger.ts metrics.ts
tests/  unit/ contract/ integration/ nl-regression/ evals/
```

Grenze: Helpers importieren **nur** `services/*` und die Client-Funktionen der Raw-Tools — nie umgekehrt; `confirm-gate.ts` ist die einzige Stelle, die Writes freigibt (ein Audit-Punkt).

---

## 7. Testplan

**Unit:** Hausnummern-Parser (Ranges, Buchstaben, Slash-Listen); Status-Mapping („offen", „erledigt", Tippfehler); Keyword-Mapping gegen fixierten 491er-Katalog (inkl. Kategorie-Expansion „Mängel"→107); Cursor-Encoding; Fan-out-Deckel.

**Contract:** aufgezeichnete Fixtures der V1.7-Antwortformen (`{SUCCESS,ERRORTEXT,DATA}`, `true|id|nr`-Strings) → Parser-Robustheit; Schema-Snapshot-Test, dass Raw-Tool-Schemas unverändert sind (Regressionsschutz für „1:1 verfügbar").

**Integration (nur `test`-Umgebung, Kunde 0032):** find_tickets gegen den 209-Ticket-Bestand (Golden: `32-260907-Q0009` auffindbar über Keyword+Status); ticket_briefing mit allen include-Flags; Crosswalk-Aufbau aus OBJEKTAKTE-Crawl.

**NL-Regression:** Golden-Query-Suite (Start: 15 Queries), Nr. 1 ist wörtlich *„Tickets Mängel Mandant 27 Hauptstraße 118/118a/118b"*; erwartetes Verhalten je Query definiert (gemappte Filter, max. Call-Zahl, Ambiguity ja/nein). Läuft als Skript gegen den Server, prüft `resolution`-Objekt.

**Writes/Confirm (kritisch):** (a) jeder Write-Helper ohne `confirm` → nur Plan, **null** Mutation (per Mock-Client verifiziert); (b) `confirm:true` ohne gültige `plan_id` → Fehler; (c) `writesEnabled:false` → Plan möglich, Ausführung blockiert; (d) `env=prod` ohne Freigabe-Flag → blockiert; (e) Bulk: Abbruch mitten im Batch → korrektes Per-Item-Reporting, keine Doppelausführung bei Retry (Idempotenz-Key im Plan).

**Evals (mcp-builder Phase 4):** 10 read-only, komplexe, verifizierbare Fragen als XML gegen das Testsystem (z. B. „Wie viele Schlagworte hat die Kategorie Mängel?" → 107; „Ticketnr des jüngsten Tickets?" → 32-260907-Q0009), plus MCP-Inspector-Durchlauf und `npm run build` als Gate.

**Vorab-Verifikationen (Annahmen A1–A5):** gezielt im PDF/Testsystem prüfen: getPartnerId-Semantik, Straßen-Indexfelder in OBJEKTAKTE, Ticket↔Partner-Kardinalität, TICKETANLAGEN-Verknüpfungsfelder, search_tickets-Pagination. Ergebnis fließt in §2/§4 zurück.

---

## 8. Rollout & Akzeptanzkriterien

| Phase | Inhalt | Akzeptanzkriterien |
|---|---|---|
| **0 – Fundament** (vor Helpers) | catalog-cache, mapper, hausnummer, Envelope, Observability, Schema-Snapshot der Raw-Tools; Infra-Stabilisierung (502-Flapping analysieren: VPN/Proxy-Bindung an Johns PC) | Build grün; Raw-Schemas unverändert; /health stabil; Katalog-Cache < 1 s warm |
| **1 – P0 (test, Feature-Flag)** | find_tickets, resolve, ticket_briefing, catalog + Crosswalk-Erstbefüllung | Golden-Query 1 liefert korrekte Tickets in **einem** Helper-Call; NL-Suite ≥ 13/15 grün; keine Regressions an Raw-Tools; Briefing ersetzt Ketten (≤ 1 Call aus Claude-Sicht) |
| **2 – P1 Reads** | partner_360, find_documents, deeplink | Evals 10/10; Ambiguity-Fälle liefern nutzbare Kandidatenlisten statt Leerergebnis |
| **3 – Write-Helpers (test)** | create_ticket_guided, attach_doc, process_advance | Alle Confirm-Tests (a)–(e) grün; Audit-Log jeder Mutation mit plan_id |
| **4 – Prod-Freigabe** | Skill-Update (SPEED RULES + Helper-Absatz), Team KPM/TPM-Pilot | 1 Woche Pilot ohne P0/P1-Bugs; Mapping-Miss-Rate < 10 %; keine ungeplante Mutation im Audit-Log |
| **5 – P2** | bulk, digest, crosswalk_admin, damage_summary | je Tool eigene Confirm-/Regressionstests |

**Globale Abnahme:** Die Beispielanfrage aus dem Auftrag wird end-to-end korrekt beantwortet, mit sichtbarem Resolution-Report; Raw-Layer bytegleich; keine Mutation ohne zweistufiges Confirm; alle Annahmen A1–A5 verifiziert oder als dokumentierte Einschränkung ausgewiesen.

---

Wenn du willst, lege ich den Plan als `.md`-Datei ab (z. B. für Claude Code als `PLAN.md` im Server-Repo) oder verfeinere als Nächstes die Zod-Schemas der P0-Tools im Detail.