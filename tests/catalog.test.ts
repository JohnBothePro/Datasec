import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseKeywordCatalog,
  rowsFromColumnOriented,
} from "../src/helpers/catalog.ts";

describe("getKeywords catalog parse", () => {
  it("parses ColdFusion column-oriented DATA (SUCCESS=true, not empty items)", () => {
    const json = {
      SUCCESS: true,
      DATA: {
        KEYWORD: ["Abfluss stinkt / riecht", "Steckdosen defekt", "Heizung"],
        CATEGORY: ["Mängel", "Mängel", "Heizung"],
      },
    };
    const items = parseKeywordCatalog(json, null);
    assert.equal(items.length, 3);
    assert.equal(items[0].name, "Abfluss stinkt / riecht");
    assert.equal(items[0].extra?.category, "Mängel");
    assert.ok(items.some((i) => i.name === "Steckdosen defekt" && i.extra?.category === "Mängel"));
  });

  it("parses COLUMNS + row arrays", () => {
    const json = {
      COLUMNS: ["KEYWORD", "CATEGORY"],
      DATA: [
        ["Abfluss stinkt / riecht", "Mängel"],
        ["Reklamation", "Reklamation"],
      ],
    };
    const items = parseKeywordCatalog(json, null);
    assert.equal(items.length, 2);
    assert.equal(items[0].extra?.category, "Mängel");
  });

  it("parses array of structs", () => {
    const items = parseKeywordCatalog(
      {
        SUCCESS: true,
        DATA: [{ KEYWORD: "Abfluss stinkt / riecht", CATEGORY: "Mängel" }],
      },
      null
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "Abfluss stinkt / riecht");
  });

  it("parses XML keyword tags with CATEGORY", () => {
    const xml = `<keywords><keyword CATEGORY="Mängel">Abfluss stinkt / riecht</keyword></keywords>`;
    const items = parseKeywordCatalog(null, xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "Abfluss stinkt / riecht");
    assert.equal(items[0].extra?.category, "Mängel");
  });

  it("rowsFromColumnOriented ignores unrelated arrays", () => {
    assert.deepEqual(rowsFromColumnOriented({ SUCCESS: true, INFOTEXT: "ok" }), []);
  });
});
