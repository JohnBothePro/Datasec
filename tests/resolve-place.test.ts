import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DocRestResult } from "../src/documents.ts";
import {
  resetAddressCachesForTests,
  resolvePlace,
  type AddressSearchDeps,
} from "../src/helpers/resolve-place.ts";

function xmlItems(
  rows: Array<Record<string, string>>
): string {
  return rows
    .map((row) => {
      const attrs = Object.entries(row)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<item ${attrs}></item>`;
    })
    .join("");
}

function okDoc(text: string): DocRestResult {
  return {
    ok: true,
    httpStatus: 200,
    contentType: "application/xml",
    text,
    isBinary: false,
  };
}

function failDoc(error: string): DocRestResult {
  return {
    ok: false,
    httpStatus: 0,
    contentType: null,
    text: "",
    isBinary: false,
    error,
  };
}

function liveDeps(
  search: AddressSearchDeps["searchByDocumentType"],
  extra?: Partial<AddressSearchDeps>
): AddressSearchDeps {
  return {
    persistCache: false,
    searchByDocumentType: search,
    ...extra,
  };
}

afterEach(() => {
  resetAddressCachesForTests();
});

describe("live address resolve from Datasec", () => {
  it("pulls partners from document index when seed/cache is empty", async () => {
    let calls = 0;
    const r = await resolvePlace({
      mandant: "27",
      street: "Hauptstraße",
      houseNumbers: "118",
      deps: liveDeps(async () => {
        calls += 1;
        return okDoc(
          xmlItems([
            {
              STREET: "Hauptstraße",
              HAUSNR: "118",
              PARTNERID: "P-118",
              MANDANT: "27",
              OBJEKTID: "O-1",
            },
          ])
        );
      }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data?.partnerIds, ["P-118"]);
    assert.equal(r.resolution.source, "document_index");
    assert.equal(r.resolution.getPartnerId, "not_used");
    assert.equal(r.resolution.streetAsKeyword, false);
    assert.ok(calls >= 1, "must call Datasec document index, not empty-crosswalk-only");
    assert.ok(
      !(r.warnings ?? []).some((w) => /ops muss befüllen|bitte entries\[\]/i.test(w)),
      "must not tell ops to seed a crosswalk as the only path"
    );
  });

  it("returns candidates in ambiguities[] and does not silent-pick", async () => {
    const r = await resolvePlace({
      street: "Hauptstraße",
      houseNumbers: "118",
      deps: liveDeps(async () =>
        okDoc(
          xmlItems([
            { STREET: "Hauptstraße", HAUSNR: "118", PARTNERID: "P-A" },
            { STREET: "Hauptstraße", HAUSNR: "118", PARTNERID: "P-B" },
          ])
        )
      ),
    });
    assert.equal(r.ok, true);
    assert.ok((r.data?.partnerIds?.length ?? 0) >= 2);
    assert.ok(
      (r.ambiguities ?? []).some((a) => /mehrere partner/i.test(a.why)),
      JSON.stringify(r.ambiguities)
    );
  });

  it("on API failure returns warning + empty partial, not hang/throw", async () => {
    const r = await resolvePlace({
      street: "Hauptstraße",
      houseNumbers: "118",
      deps: liveDeps(async () => failDoc("Timeout 5000ms: search_by_document_type")),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data?.partnerIds ?? [], []);
    assert.ok(
      (r.warnings ?? []).some((w) => /fehlgeschlagen|timeout|abgebrochen/i.test(w)),
      JSON.stringify(r.warnings)
    );
    assert.equal(r.resolution.streetAsKeyword, false);
    assert.equal(r.resolution.getPartnerId, "not_used");
  });

  it("memory-caches a live hit so the second call skips Datasec", async () => {
    let calls = 0;
    const deps = liveDeps(async () => {
      calls += 1;
      return okDoc(
        xmlItems([{ STREET: "Hauptstraße", HAUSNR: "5", PARTNERID: "P-5" }])
      );
    });
    const first = await resolvePlace({
      street: "Hauptstraße",
      houseNumbers: "5",
      deps,
    });
    const second = await resolvePlace({
      street: "Hauptstraße",
      houseNumbers: "5",
      deps,
    });
    assert.equal(first.ok, true);
    assert.deepEqual(second.data?.partnerIds, ["P-5"]);
    assert.equal(calls, 1);
    assert.equal(second.resolution.source, "memory_cache");
  });

  it("seed override is used without calling Datasec", async () => {
    let calls = 0;
    const r = await resolvePlace({
      street: "Hauptstraße",
      houseNumbers: "9",
      deps: liveDeps(
        async () => {
          calls += 1;
          return okDoc(xmlItems([]));
        },
        {
          seedEntries: [
            {
              street: "Hauptstraße",
              houseNo: "9",
              partnerId: "SEED-9",
              label: "seed override",
            },
          ],
        }
      ),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data?.partnerIds, ["SEED-9"]);
    assert.equal(r.resolution.source, "seed");
    assert.equal(calls, 0);
  });

  it("liveResolve:false stays local and does not invent partners", async () => {
    let calls = 0;
    const r = await resolvePlace({
      mandant: "27",
      street: "Hauptstraße",
      houseNumbers: "118/118a/118b",
      liveResolve: false,
      deps: liveDeps(async () => {
        calls += 1;
        return okDoc(xmlItems([{ STREET: "Hauptstraße", HAUSNR: "118", PARTNERID: "NOPE" }]));
      }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data?.partnerIds ?? [], []);
    assert.equal(calls, 0);
    assert.equal(r.resolution.streetAsKeyword, false);
  });
});
