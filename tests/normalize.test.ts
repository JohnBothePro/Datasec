import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractMandant,
  extractTicketnr,
  houseKey,
  looksLikeStreet,
  normalizeStreet,
  parseAddressFromText,
  parseHouseNumbers,
  streetKey,
} from "../src/helpers/normalize.ts";

describe("parseHouseNumbers", () => {
  it("splits slash lists", () => {
    assert.deepEqual(parseHouseNumbers("118/118a/118b"), ["118", "118a", "118b"]);
  });

  it("expands 118/a/b using the last numeric base", () => {
    assert.deepEqual(parseHouseNumbers("118/a/b"), ["118", "118a", "118b"]);
  });

  it("expands numeric ranges", () => {
    assert.deepEqual(parseHouseNumbers("118-120"), ["118", "119", "120"]);
  });

  it("expands letter ranges", () => {
    assert.deepEqual(parseHouseNumbers("118a-c"), ["118a", "118b", "118c"]);
    assert.deepEqual(parseHouseNumbers("118 a-c"), ["118a", "118b", "118c"]);
  });

  it("accepts commas and und", () => {
    assert.deepEqual(parseHouseNumbers("118, 118a und 118b"), [
      "118",
      "118a",
      "118b",
    ]);
  });

  it("strips Nr. prefix and lowercases letters", () => {
    assert.deepEqual(parseHouseNumbers("Nr. 118 A"), ["118a"]);
  });

  it("returns empty for blank input", () => {
    assert.deepEqual(parseHouseNumbers(""), []);
    assert.deepEqual(parseHouseNumbers("   "), []);
  });

  it("does not explode huge ranges", () => {
    const got = parseHouseNumbers("1-999");
    assert.ok(got.length <= 30);
    assert.ok(got.includes("1"));
    assert.ok(got.includes("999"));
  });
});

describe("street + address parse", () => {
  it("folds Straße to strasse for matching", () => {
    assert.equal(streetKey("Hauptstraße"), streetKey("Hauptstrasse"));
    assert.equal(streetKey("Hauptstr."), streetKey("Hauptstraße"));
  });

  it("parses golden query street + houses", () => {
    const parsed = parseAddressFromText(
      "Mängel Mandant 27 Hauptstraße 118/118a/118b"
    );
    assert.ok(parsed.street);
    assert.equal(streetKey(parsed.street!), streetKey("Hauptstraße"));
    assert.deepEqual(parsed.houseNumbers, ["118", "118a", "118b"]);
  });

  it("parses Hauptstr. 5", () => {
    const parsed = parseAddressFromText("Tickets zu Hauptstr. 5");
    assert.ok(parsed.street);
    assert.equal(houseKey(parsed.houseNumbers[0] ?? ""), "5");
  });

  it("extracts mandant and ticketnr", () => {
    assert.equal(extractMandant("im Mandanten 27 bitte"), "27");
    assert.equal(extractTicketnr("siehe 32-260907-Q0009 danke"), "32-260907-Q0009");
  });

  it("looksLikeStreet is true for streets, false for topics", () => {
    assert.equal(looksLikeStreet("Hauptstraße"), true);
    assert.equal(looksLikeStreet("Mängel"), false);
    assert.equal(looksLikeStreet("Offen"), false);
  });

  it("normalizeStreet keeps readable Straße", () => {
    assert.match(normalizeStreet("Hauptstr."), /Stra/i);
  });
});
