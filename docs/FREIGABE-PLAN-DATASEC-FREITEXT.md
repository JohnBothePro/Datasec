# Freigabe-Plan: Datasec Freitext-Assistent (Claude zuerst)

**Für:** John  
**Von:** Bob  
**Datum:** 2026-09-17  
**Status:** Zur Freigabe — noch nicht gebaut  
**Entscheidung:** Erst in Claude, Fach-Feedback, danach eigenes Fenster

---

## 1. Was wir bauen (in Alltagssprache)

Ein Assistent, bei dem man **normalen Deutsch-Text** eintippt, z. B.:

> „Such mir alle Tickets zum Thema Mängel im Mandanten 27 zur Straße Hauptstraße 118, 118a und 118b.“

…und er findet in Datasec **zuverlässig die richtigen Dinge** — ohne dass man API-Felder kennen muss.

Später (nach Tests mit den Fachabteilungen) kommt dasselbe Gehirn in ein **eigenes Fenster**. Jetzt nur Claude.

---

## 2. Warum das heute scheitert

- Datasec versteht Freitext nicht. Die API will feste Felder (Schlagwort, Partner-ID, Betreff, Status…).
- **Straße steht nicht** in der Ticket-Suche.
- Claude rät oft falsch (z. B. Straße als Schlagwort) → 0 Treffer oder Fehler.
- Ein reines „Skill-Textdokument“ reicht nicht — die Logik muss **im System** stecken.

---

## 3. Zielbild

```
Du tippst in Claude (Freitext)
        ↓
Datasec-Gehirn (neu)
  - versteht die Absicht
  - übersetzt Mandant / Straße / Thema korrekt
  - plant die nötigen Schritte
  - ruft Datasec über MCP/API auf
        ↓
Klare Antwort auf Deutsch (+ was erkannt wurde)
```

Schreiben (Ticket anlegen, Status ändern, …) immer erst **Vorschau**, dann deine Bestätigung.

---

## 4. Architektur (drei Schichten)

| Schicht | Bedeutung | Beispiel |
|--------|-----------|----------|
| **L0 Roh-Werkzeuge** | Bestehende ~52 Datasec-Tools (1:1 API) | Ticket suchen, Partner laden, Dokument finden |
| **L1 Gehirn / Helpers** | Neu: orchestriert mehrere Schritte automatisch | Adresse auflösen → Partner finden → Tickets holen |
| **L2 Anleitung für Claude** | Kurze Regeln: wann Freitext-Gehirn, wann nicht | „Adresse nie als Schlagwort“ |

**Herzstück:** ein Einstiegs-Werkzeug  
`datasec_ask` / `datasec_h_ask`  
→ Freitext rein → Ergebnis raus.  
Innere Bausteine (Adresse, Thema, Briefing, …) nutzt das Gehirn selbst — du tippst die nicht.

Eigenes Fenster später = nur neue Oberfläche auf demselben Gehirn.

---

## 5. Funktionsumfang „komplett“

### Lesen (Priorität für den ersten Pilot)
- Tickets finden (Thema, Status, Partner, Adresse/Mandant)
- Ticket-Übersicht inkl. Notizen/Verknüpfungen auf Wunsch
- Dokumente / Akten finden
- Stammdaten / Partner-Kontext
- Schadens-/Mängel-Übersichten soweit API hergibt
- Deep-Links in Datasec

### Schreiben (nach dem Lesen stabil ist)
- Ticket anlegen / Notiz / Status / Schlagwort / Prozess weiter
- Immer: Vorschau → Bestätigung (`confirm`)
- Keine stillen Änderungen

### Wissensbasis (damit Freitext klappt)
- Schlagwort-/Status-Katalog mit Synonymen („Mängel“, „offen“, …)
- **Adress-/Objekt-Verzeichnis** (Mandant + Straße + Hausnr → Partner/Objekt)
  - Quelle: Export (z. B. Wodis) und/oder einmaliges Einlesen aus Objektakten
  - Ohne dieses Verzeichnis bleibt Straßen-Suche unsicher

---

## 6. Phasen & Liefergegenstände

### Phase 0 — Fundament (ca. 0,5–1 Tag)
- Katalog-Cache (Schlagworte, Status, Belegtypen)
- Synonym-/Normalisierungsregeln (Hausnr 118/118a/118b, Straße/Straße)
- Einheitliches Antwort-Format: Treffer + „so habe ich’s verstanden“ + Warnungen
- Feature-Schalter: Gehirn erst auf Test-Umgebung

**Fertig wenn:** Build grün, bestehende Tools unverändert, Health ok.

### Phase 1 — Freitext Lesen P0 (ca. 1–2 Tage) ★ Pilot für Fachabteilung
- `datasec_h_ask` (Freitext-Einstieg)
- Adress-/Mandant-Auflösung + Ticket-Suche
- Themen-Mapping („Mängel“ → echte Schlagworte)
- Ticket-Kurzbriefing (ein Aufruf)
- Claude-Skill angepasst: Freitext-Adressfragen → Gehirn, nicht raten
- Crosswalk-Erstbefüllung (Export oder Objektakten-Scan — nach Klärung)

**Gold-Test (dein Satz):**  
„Mängel, Mandant 27, Hauptstraße 118/118a/118b“ → sinnvolle Treffer **oder** klare Rückfrage bei Mehrdeutigkeit — in **einem** Assistenten-Schritt aus Claudes Sicht.

**Fertig wenn:** Fachabteilung kann 10–15 echte Alltagsfragen in Claude testen.

### Phase 2 — Lesen ausbauen (ca. 1 Tag)
- Dokument-Freitextsuche
- Partner-360°-Übersicht
- Mängel/Schäden gebündelt
- Deeplink-Helfer (sicher, Token nicht offen)

### Phase 3 — Schreiben mit Sicherheitsnetz (ca. 1 Tag)
- Geführtes Ticket anlegen (Vorschau → Bestätigen)
- Notiz/Status/Prozess weiter ebenso
- Audit: jede Änderung nachvollziehbar

### Phase 4 — Fach-Pilot & Feedback (1–2 Wochen Betrieb)
- KPM/TPM o. ä. testen in Claude
- Feedback-Liste (Falschzuordnungen, fehlende Synonyme, Mandant-Sonderfälle)
- Nachschärfen Katalog/Crosswalk

**Go für eigenes Fenster erst nach Phase 4 „gut genug“.**

### Phase 5 — Eigenes Fenster (später, eigener Freigabe-Schritt)
- Gleiches Gehirn, eigene Chat-Oberfläche
- Keine zweite Logik bauen

---

## 7. Was wir bewusst nicht tun

- Bestehende Raw-MCP-Tools wegwerfen
- Zweites, paralleles Datasec-System
- Eigenes Fenster vor dem Claude-Pilot
- Straße als Ticket-Schlagwort missbrauchen
- Schreib-Aktionen ohne Bestätigung

---

## 8. Risiken & Absicherung

| Risiko | Absicherung |
|--------|-------------|
| Straße nicht in Ticket-API | Eigenes Adressverzeichnis + klare Grenzen |
| Falsches Schlagwort | Katalog + Synonyme + „so gemappt“ in der Antwort |
| Zu viele Treffer / Mehrdeutig | Kandidaten zeigen, nachfragen statt raten |
- Ungewollte Änderungen | Nur Lesen zuerst; Schreiben nur mit Bestätigung |
| Server nach Logoff tot | Already-On unter ProgramData (erledigt) |
| Fach sagt „findet nicht“ | Feedback-Runde Phase 4, Katalog nachpflegen |

---

## 9. Was wir von dir / Fach noch brauchen (kurz)

1. **Mandant 27** — wie heißt das in Datasec genau (Feld/Nummer)?
2. Gibt es einen **Export Objekte/Adressen** (Wodis o. ä.)?
3. Wie heißen die echten **Schlagworte** für „Mängel“?
4. Welche **10 Testfragen** sollen die Fachabteilungen stellen?

(Wenn unbekannt: Phase 0/1 ermittelt vieles am System — blockiert nicht den Start, nur die Präzision der Straßen-Suche.)

---

## 10. Aufwand (grob)

| Phase | Aufwand |
|-------|--------|
| 0 Fundament | 0,5–1 Tag |
| 1 Freitext-Lesen P0 | 1–2 Tage |
| 2 Lesen ausbauen | ~1 Tag |
| 3 Schreiben | ~1 Tag |
| 4 Fach-Pilot | 1–2 Wochen kalender, wenig Bau |
| 5 Eigenes Fenster | später, neu schätzen |

---

## 11. Erfolgsmaß (wann „es funktioniert“)

- Dein Mängel-/Adress-Beispiel funktioniert in Claude zuverlässig
- Fachabteilung: Mehrheit der Testfragen ok ohne Nachhilfe
- Keine ungeplante Schreib-Aktion
- Antwort zeigt nachvollziehbar: Mandant/Adresse/Thema erkannt
- MCP Always-On bleibt stabil

---

## 12. Freigabe-Entscheidungen

Bitte mit Ja/Nein (oder Anpassung):

1. **Gesamtrichtung:** Freitext-Gehirn in Claude zuerst, eigenes Fenster später — freigeben?
2. **Phase 0+1** jetzt umsetzen (Lesen-Pilot), Schreiben erst danach — freigeben?
3. Test-Umgebung zuerst (nicht sofort Produktiv) — freigeben?
4. Darf Bob für das Adressverzeichnis einen **Objekt-/Adress-Export** anfordern bzw. Objektakten indexieren — freigeben?

---

## 13. Quellen

- Bestehender Datasec-MCP (~54 Tools) + Always-On Runtime
- DOKU@WEB API-Dokumentation (PDF)
- TinkaBot: Schichten L0/L1/L2, P0-Tools, Risiken
- Claude mcp-builder: Crosswalk, Katalog, Confirm/Dry-Run, Rollout
- Deine Vorgabe: Claude zuerst → Fach-Feedback → eigenes Fenster
