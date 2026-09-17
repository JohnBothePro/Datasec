# Datasec MCP — Gesamtplan Helper-Layer

**Für:** John  
**Von:** Bob (+ TinkaBot Architektur, Claude mcp-builder folgt als Addendum)  
**Datum:** 2026-09-17  
**Status:** Plan only — noch nicht gebaut

---

## 0. Problem in einem Satz

Claude rät Freitext falsch in API-Filter (z.B. Straße → KEYWORD). Die API kann das nicht. Wir brauchen **Composite-Hilfstools**, die Adresse/Mandant/Thema serverseitig korrekt auflösen und erst dann die Raw-Tools aufrufen.

---

## 1. Zielbild

| Schicht | Rolle | Beispiele |
|--------|--------|-----------|
| **L0 Raw** | 1:1 DOKU@WEB / bestehende ~52 `datasec_*` | `search_tickets`, `get_partner_masterdata`, … |
| **L1 Helpers** | 2–N L0-Calls, Input-Normalisierung, **ein** Domain-Objekt zurück | `resolve_address`, `find_tickets_by_address` |
| **L2 Skills** | Wann welches Tool; Hard-Nos; Confirm | Skill-Text, keine Daten erfinden |

**Regel (TinkaBot):** Skills erklären — Tools tun. Raw-Tools bleiben. Kein zweiter MCP-Server.

---

## 2. Ist-Zustand

- **54 Tools** (52 real, 2 Stubs: Mail, SSO) — Abdeckung API 2.5.1–2.5.4 + Deeplinks weitgehend fertig
- Always-On unter `C:\ProgramData\datasec-mcp-runtime` (nssm)
- Ticket-Suche nur: KEYWORD, SUBJECT, PARTNERID, STATE, … — **keine Straße**
- `getPartnerId` ≠ Adresssuche (sParams kundenspezifisch, oft Vertrag+Geburtsdatum)
- Adressfelder in Stammdaten-Rückgaben: `STREET`, `GE_STREET`, …
- Skill „1× search_tickets“ blockiert nötige Multi-Step-Auflösung

---

## 3. Phase A — Inventar & Shapes (½–1 Tag)

1. Matrix: API-Op | bestehendes Tool | Status | Gap
2. Kanonische Types festnageln:
```
AddressHit = { mandantId?, street, houseNo?, unit?, objektId?, partnerId?, label, score }
TicketSummary = { id, ticketnr, subject, status, partnerId?, objektId?, createdAt, keywords[] }
FindTicketsByAddressIn = { query?: string, mandantId?: string|number, street?: string, houseNumbers?: string[], topic?: string, status?: "open"|"all", limit?: number }
FindTicketsByAddressOut = { resolved: AddressHit[], tickets: TicketSummary[], warnings: string[], steps: string[] }
```
3. Fachklärung mit John (Blocker für P0):
   - Wie ist **Mandant 27** modelliert?
   - Welcher Belegtyp/Index trägt Straße/Hausnr für Objektfindung?
   - Exakte Schlagworte für „Mängel“?

---

## 4. Phase B — P0 L1 Helpers (1–2 Tage) ★

| # | Tool | Zweck |
|---|------|--------|
| 1 | `datasec_resolve_address` | Freitext/Felder → AddressHit[] + confidence/candidates (kein stilles Picken) |
| 2 | `datasec_find_tickets_by_address` | resolve → Partner/Objekt → Ticket-Suche (KEYWORD/PARTNERID) |
| 3 | `datasec_find_open_maengel` | Mandant+Ort/Objekt → Mängel-Liste über richtige Entity |
| 4 | `datasec_get_partner_context` | Stammdaten + offene Tickets/Mängel in einem Call |
| 5 | `datasec_search_tickets_safe` | nur erlaubte Felder; Straße ablehnen oder nach #2 routen |
| 6 | `datasec_map_topic` | „Mängel“ → exakte Keywords + subjectHints (Synonym-JSON) |
| 7 | `datasec_list_entities_for_mandant` | schnelle Discovery Objekte/Partner |
| 8 | `datasec_ticket_briefing` | get_ticket + optional notes/links (1 Call) |

**Hard rule:** Niemals Straße in KEYWORD. Mehrdeutigkeit → `candidates[]` + `warnings[]`.

**Internes Flow für Johns Beispiel**
`Mandant 27 + Hauptstraße 118/a/b + Mängel`
→ resolve_address → map_topic → search_tickets(PARTNERID + KEYWORD/SUBJECT) → TicketSummary[]

Implementierung:
```
src/helpers/{place,topic,tickets-by-place,partner-context,register}.ts
config/topic-synonyms.json
config/mandant-rules.json   # nach Klärung
```
Helpers rufen interne L0-Funktionen auf (kein MCP-Self-Call).

---

## 5. Phase C — Mutations + Confirm (nach P0 stabil)

- Create/Update/Status nur mit `confirm: true` + optional Preview/Dry-Run Helper
- Default read-only für neue L1 Write-Wrapper
- Bestehendes `gateWrite` wiederverwenden

---

## 6. Phase D — Rest-L0 aus Doku

- Nur echte Gaps als neue L0 (Inventory sagt: wenig offen)
- Stubs nicht schönlügen
- Spec/Generator wo sinnvoll; Hand-Wrapper für Auth/Paging

---

## 7. L2 Skill-Anpassung (parallel, klein)

- Hard-Speed: Adress/Mandant/Thema → **ein** Helper (`find_tickets_by_address`), nicht raw raten
- Hard-No: „Adresse ≠ KEYWORD“
- Raw `search_tickets` nur wenn ticketnr/partnerId/keyword schon klar

---

## 8. Nicht-Ziele

- Kein LLM im MCP-Server für Parsing
- Kein Ersetzen der Raw-Tools
- Kein zweiter Server / Connector-Bruch

---

## 9. Risiken & Gegenmittel

| Risiko | Gegenmittel |
|--------|-------------|
| Confirm-Gate umgangen | Mutations nur mit confirm; Preview-Tool |
| Langsam | L1 max 2–3 sequentielle L0; parallel wo möglich; limit default klein; kurzes Cache resolve |
| Session/401 | zentraler Token-Provider (nssm); 1× refresh+retry, sonst klarer Fehler |
| NL-Falschrouting | search_tickets_safe + Skill Hard-No |
| Mandant unklar | Phase A Blocker — ohne Mapping kein blindes Guessing |

---

## 10. Test & Rollout

1. Unit: Hausnr-Normalizer, Synonyme
2. Integration test: Hauptstraße 118* + Mandant 27
3. Golden Query: Johns Freitextsatz
4. Regression: alle L0 unverändert
5. Claude-E2E: neuer Chat, 1 Helper-Call
6. Deploy ProgramData runtime + nssm restart; Skill updaten; neuer Claude-Chat

---

## 11. Aufwand

| Phase | Aufwand |
|-------|--------|
| A Inventar/Shapes/Klärung | 0.5–1 Tag |
| B P0 Helpers | 1–2 Tage |
| C Mutations | 0.5–1 Tag |
| D Rest-L0 | nach Bedarf |
| Skill | parallel ~2h |

---

## 12. Empfohlene Reihenfolge für John

1. **Go** auf Phase A+B (P0)
2. Kurz die 3 Fachfragen klären (Mandant / Straßen-Index / Mängel-Keyword)
3. Bob baut + testet auf Server
4. Skill-Zeilen nachziehen
5. Erst danach C/D

---

## 13. Quellen dieses Plans

- Bestehendes Repo `/workspace/datasec-mcp` + TOOLS-INVENTORY.md
- DOKU@WEB API-PDF (Tickets suchen, Stammdaten, STREET/GE_STREET)
- TinkaBot: L0/L1/L2, P0-Tool-Liste, Shapes, Risiken
- Claude mcp-builder: Addendum sobald Desktop-Lauf fertig
