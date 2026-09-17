import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAsk } from "../src/helpers/ask.ts";

describe("ask router covers main DOKU modules", () => {
  it("keeps the Mängel pain-case on find_tickets", () => {
    const p = parseAsk("Mängel Mandant 27 Hauptstraße 118/118a/118b");
    assert.equal(p.intent, "find_tickets");
    assert.equal(p.mandant, "27");
    assert.ok(p.topic && /mängel/i.test(p.topic));
  });

  it("routes Objektakte / Akten to find_documents, not tickets", () => {
    const p = parseAsk("Objektakte zur Hauptstraße 12 bitte");
    assert.equal(p.intent, "find_documents");
    assert.ok(p.street && /haupt/i.test(p.street));
  });

  it("routes Mieterakte to find_documents", () => {
    const p = parseAsk("Zeige die Mieterakte zu Partner 4711");
    assert.equal(p.intent, "find_documents");
    assert.equal(p.partnerId, "4711");
  });

  it("routes catalog questions to catalog", () => {
    for (const q of [
      "Welche Schlagworte gibt es?",
      "Belegtypen auflisten",
      "Dokumenttypen im Katalog",
      "Abteilungen zeigen",
    ]) {
      const p = parseAsk(q);
      assert.equal(p.intent, "catalog", q);
    }
  });

  it("routes Stammdaten / Partnerkontext away from tickets", () => {
    const p = parseAsk("Stammdaten zu Partner 8800");
    assert.equal(p.intent, "partner_context");
    assert.equal(p.partnerId, "8800");
  });

  it("routes Newsticker to news", () => {
    const p = parseAsk("Was steht im Newsticker?");
    assert.equal(p.intent, "news");
  });

  it("routes Schadensmeldungen to damage_reports", () => {
    const p = parseAsk("Schadensmeldungen zu Partner 12");
    assert.equal(p.intent, "damage_reports");
    assert.equal(p.partnerId, "12");
  });

  it("routes address-only resolve questions to resolve", () => {
    const p = parseAsk("Adresse Hauptstraße 118 auflösen");
    assert.equal(p.intent, "resolve");
    assert.ok(p.street && /haupt/i.test(p.street));
  });

  it("routes guided writes without executing", () => {
    assert.equal(parseAsk("Bitte neues Ticket anlegen wegen Heizung").intent, "create_ticket");
    assert.equal(
      parseAsk("Setze Status von 32-260907-Q0009 auf geschlossen").intent,
      "set_state"
    );
  });
});
