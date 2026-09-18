import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DocRestResult } from "../src/documents.ts";
import type { RestFilter } from "../src/rest.ts";
import { findDocuments } from "../src/helpers/find-documents.ts";
import { parsePartnerIdSegments } from "../src/helpers/normalize.ts";
import { resetAddressCachesForTests } from "../src/helpers/resolve-place.ts";

function okDoc(text: string): DocRestResult {
  return {
    ok: true,
    httpStatus: 200,
    contentType: "application/xml",
    text,
    isBinary: false,
  };
}

function structureDoc(fieldNames: string[]) {
  return okDoc(JSON.stringify({ fields: fieldNames.map((name) => ({ name })) }));
}

const MIETERAKTE_FIELDS = [
  "BUKRS",
  "SWENR",
  "SGENR",
  "SMENR",
  "RECNNR",
  "BETREFF",
  "TICKETID",
];

afterEach(() => {
  resetAddressCachesForTests();
});

describe("parsePartnerIdSegments", () => {
  it("maps five Datasec PartnerID segments to SAP index fields", () => {
    assert.deepEqual(parsePartnerIdSegments("1401.587.2.15.35"), {
      bukrs: "1401",
      swenr: "587",
      sgenr: "2",
      smenr: "15",
      recnnr: "35",
    });
  });

  it("returns null when a segment is missing or empty", () => {
    assert.equal(parsePartnerIdSegments("1401.587.2.15"), null);
    assert.equal(parsePartnerIdSegments("1401.587.2.15.35.99"), null);
    assert.equal(parsePartnerIdSegments("1401.587.2.15."), null);
    assert.equal(parsePartnerIdSegments("1401.587..15.35"), null);
    assert.equal(parsePartnerIdSegments(""), null);
    assert.equal(parsePartnerIdSegments("   "), null);
    assert.equal(parsePartnerIdSegments(undefined), null);
  });
});

describe("findDocuments partner filters", () => {
  it("uses BUKRS/SWENR/SGENR/SMENR/RECNNR on MIETERAKTE, never PARTNERID", async () => {
    const searches: Array<{ documentType: string; filters: RestFilter[] }> = [];
    const r = await findDocuments({
      documentType: "MIETERAKTE",
      partnerId: "1401.587.2.15.35",
      deps: {
        getDocumentTypeStructure: async () => structureDoc(MIETERAKTE_FIELDS),
        searchByDocumentType: async (opts) => {
          searches.push({ documentType: opts.documentType, filters: opts.filters ?? [] });
          return okDoc("<items/>");
        },
      },
    });

    assert.equal(r.ok, true);
    assert.equal(searches.length, 1);
    assert.equal(searches[0].documentType, "MIETERAKTE");
    const fields = searches[0].filters.map((f) => f.field);
    assert.ok(!fields.includes("PARTNERID"), `must not send PARTNERID: ${JSON.stringify(searches[0].filters)}`);
    assert.deepEqual(
      searches[0].filters.map((f) => ({ field: f.field, val: f.val })),
      [
        { field: "BUKRS", val: "1401" },
        { field: "SWENR", val: "587" },
        { field: "SGENR", val: "2" },
        { field: "SMENR", val: "15" },
        { field: "RECNNR", val: "35" },
      ]
    );
  });

  it("warns and skips search when partnerId cannot be mapped and PARTNERID is absent", async () => {
    let searched = false;
    const r = await findDocuments({
      documentType: "MIETERAKTE",
      partnerId: "not-a-partner-id",
      deps: {
        getDocumentTypeStructure: async () => structureDoc(MIETERAKTE_FIELDS),
        searchByDocumentType: async () => {
          searched = true;
          return okDoc("<items/>");
        },
      },
    });

    assert.equal(r.ok, true);
    assert.equal(searched, false, "must not call search with an unknown PARTNERID field");
    assert.deepEqual((r.data as { documents?: unknown[] } | null)?.documents, []);
    assert.ok(
      (r.warnings ?? []).some((w) => /PARTNERID|PartnerID|nicht parse|kein PARTNERID|BUKRS/i.test(w)),
      `expected mapping warning, got ${JSON.stringify(r.warnings)}`
    );
    assert.ok(
      !(r.warnings ?? []).some((w) => /HTTP 404|404/.test(w)),
      "must not surface a 404 from a PARTNERID filter"
    );
  });

  it("still uses PARTNERID when the document type actually has that field", async () => {
    const searches: Array<{ filters: RestFilter[] }> = [];
    const r = await findDocuments({
      documentType: "SONSTIGE",
      partnerId: "1401.587.2.15.35",
      deps: {
        getDocumentTypeStructure: async () => structureDoc(["PARTNERID", "BETREFF"]),
        searchByDocumentType: async (opts) => {
          searches.push({ filters: opts.filters ?? [] });
          return okDoc("<items/>");
        },
      },
    });

    assert.equal(r.ok, true);
    assert.deepEqual(
      searches[0].filters.map((f) => ({ field: f.field, val: f.val })),
      [{ field: "PARTNERID", val: "1401.587.2.15.35" }]
    );
  });

  it("keeps STREET warning and never sends STREET when the index lacks it", async () => {
    const searches: Array<{ filters: RestFilter[] }> = [];
    const r = await findDocuments({
      documentType: "OBJEKTAKTE",
      street: "Hauptstraße",
      deps: {
        resolvePlace: async () => ({
          ok: true,
          data: { hits: [], partnerIds: [] },
          resolution: {},
          ambiguities: [],
          warnings: [],
        }),
        getDocumentTypeStructure: async () => structureDoc(MIETERAKTE_FIELDS),
        searchByDocumentType: async (opts) => {
          searches.push({ filters: opts.filters ?? [] });
          return okDoc("<items/>");
        },
      },
    });

    assert.equal(r.ok, true);
    assert.ok(
      (r.warnings ?? []).some((w) => /Straßenfelder|STREET/i.test(w)),
      `expected STREET honesty warning, got ${JSON.stringify(r.warnings)}`
    );
    for (const s of searches) {
      assert.ok(
        !s.filters.some((f) => f.field.toUpperCase() === "STREET"),
        `must not send STREET: ${JSON.stringify(s.filters)}`
      );
    }
  });
});
