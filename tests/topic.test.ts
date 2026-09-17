import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAsk } from "../src/helpers/ask.ts";
import {
  assertNotStreetKeyword,
  buildTicketSearchJobs,
  MAX_SEARCH_CALLS,
} from "../src/helpers/find-tickets.ts";
import { DEFAULT_PARTNER_INCLUDE } from "../src/helpers/partner-context.ts";
import { MAX_PARTNERS } from "../src/helpers/resolve-place.ts";
import { SPEED, clampResults } from "../src/helpers/speed.ts";
import { resolvePlace } from "../src/helpers/resolve-place.ts";
import {
  detectTopicInText,
  mapStatus,
  mapTopic,
} from "../src/helpers/topic.ts";

describe("topic map", () => {
  it("maps Mängel / maengel / mangel to keywords + subject hints", () => {
    for (const input of ["Mängel", "mangel", "Maengel", "Mängelanzeige"]) {
      const m = mapTopic(input);
      assert.equal(m.matched, true, input);
      assert.ok(m.keywords.length >= 1, input);
      assert.ok(m.subjectHints.length >= 1, input);
      assert.equal(m.topicId, "maengel", input);
    }
  });

  it("maps offen to UI status candidates, not a silent empty", () => {
    const s = mapStatus("offen");
    assert.equal(s.matched, true);
    assert.ok(s.mapped_to.includes("Offen") || s.mapped_to.includes("Neu"));
  });

  it("detects topic inside a full German sentence", () => {
    const t = detectTopicInText(
      "Such mir alle Tickets zum Thema Mängel im Mandanten 27"
    );
    assert.ok(t?.matched);
    assert.equal(t?.topicId, "maengel");
  });

  it("unmapped topic does not invent a street keyword", () => {
    const m = mapTopic("UnbekanntesThemaXyz");
    assert.equal(m.matched, false);
    assert.ok(m.subjectHints[0]?.includes("*"));
  });
});

describe("HARD-NO street as KEYWORD", () => {
  it("rejects street-like keyword values", () => {
    assert.throws(() => assertNotStreetKeyword("Hauptstraße", "keyword"), /HARD-NO/);
    assert.throws(
      () => assertNotStreetKeyword("Hauptstraße 118/118a", "keyword"),
      /HARD-NO/
    );
  });

  it("buildTicketSearchJobs never copies a street into keyword", () => {
    const { jobs, warnings } = buildTicketSearchJobs({
      partnerIds: ["4711"],
      keywords: ["Hauptstraße"],
      subjectHints: ["*Mangel*"],
      state: undefined,
    });
    assert.ok(warnings.some((w) => /HARD-NO|Straße/i.test(w)));
    assert.ok(jobs.every((j) => !j.keyword || !/strasse|haupt/i.test(j.keyword)));
  });

  it("uses PARTNERID + mapped keyword, not the street", () => {
    const { jobs } = buildTicketSearchJobs({
      partnerIds: ["4711", "4712"],
      keywords: ["Mängel"],
      subjectHints: ["*Mangel*"],
    });
    assert.ok(jobs.length >= 1);
    assert.ok(jobs.every((j) => j.partnerId && j.keyword === "Mängel"));
    assert.ok(jobs.every((j) => j.keyword !== "Hauptstraße"));
  });

  it("caps fan-out (partners × keywords) for seconds-latency", () => {
    assert.ok(SPEED.MAX_RESULTS <= 10);
    assert.ok(MAX_PARTNERS <= 4);
    assert.ok(MAX_SEARCH_CALLS <= 4);
    assert.equal(clampResults(99), 10);
    const { jobs } = buildTicketSearchJobs({
      partnerIds: ["1", "2", "3", "4", "5", "6"],
      keywords: ["Mängel", "Heizung", "Wasser"],
      subjectHints: [],
    });
    assert.ok(jobs.length <= MAX_SEARCH_CALLS);
    assert.ok(jobs.every((j) => j.keyword === "Mängel"));
  });
});

describe("ask router (no LLM)", () => {
  it("routes the golden query to find_tickets with mandant + houses + topic", () => {
    const p = parseAsk("Mängel Mandant 27 Hauptstraße 118/118a/118b");
    assert.equal(p.intent, "find_tickets");
    assert.equal(p.mandant, "27");
    assert.ok(p.street && /haupt/i.test(p.street));
    assert.deepEqual(p.houseNumbers, ["118", "118a", "118b"]);
    assert.ok(p.topic && /mängel/i.test(p.topic));
  });

  it("routes a speaking ticketnr to briefing", () => {
    const p = parseAsk("Zeige Details zu 32-260907-Q0009 inkl. Notizen");
    assert.equal(p.intent, "ticket_briefing");
    assert.equal(p.ticketnr, "32-260907-Q0009");
    assert.ok(p.include?.includes("notes"));
  });

  it("ticketnr alone stays LIGHT (no auto notes/links)", () => {
    const p = parseAsk("32-260907-Q0009");
    assert.equal(p.intent, "ticket_briefing");
    assert.equal(p.include, undefined);
  });

  it("routes create intent without executing", () => {
    const p = parseAsk("Bitte neues Ticket anlegen wegen Heizung");
    assert.equal(p.intent, "create_ticket");
  });
});

describe("empty crosswalk", () => {
  it("warns clearly and does not invent partners", async () => {
    const r = await resolvePlace({
      mandant: "27",
      street: "Hauptstraße",
      houseNumbers: "118/118a/118b",
      allowDocumentFallback: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data?.partnerIds.length, 0);
    assert.ok(
      (r.warnings ?? []).some((w) => /crosswalk ist leer|leer/i.test(w)),
      JSON.stringify(r.warnings)
    );
    assert.equal(r.resolution.streetAsKeyword, false);
    assert.equal(r.resolution.getPartnerId, "not_used");
    assert.equal(
      (r.resolution.speed as { documentFallback?: string } | undefined)?.documentFallback,
      "skipped"
    );
  });
});

describe("lean defaults", () => {
  it("partner_context default is base only", () => {
    assert.deepEqual(DEFAULT_PARTNER_INCLUDE, ["base"]);
  });
});
