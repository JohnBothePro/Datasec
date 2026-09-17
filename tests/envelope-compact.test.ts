import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactTicket,
  okEnvelope,
  presentEnvelope,
} from "../src/helpers/envelope.ts";

describe("compact helper envelope", () => {
  it("keeps only id/nr/subject/keyword/state/partnerid/category/create_on", () => {
    const compact = compactTicket({
      ticketid: "T1",
      ticketnr: "32-260907-Q0009",
      subject: "Abfluss stinkt",
      keyword: "Abfluss stinkt / riecht",
      state: "Offen",
      partnerid: "27.27006.15.2.477",
      category: "Mängel",
      create_on: "2026-09-01",
      update_on: "2026-09-02",
      create_by: "jbothe",
      postkorb: "hidden",
    });
    assert.deepEqual(Object.keys(compact).sort(), [
      "category",
      "create_on",
      "id",
      "keyword",
      "nr",
      "partnerid",
      "state",
      "subject",
    ]);
    assert.equal(compact.id, "T1");
    assert.equal(compact.nr, "32-260907-Q0009");
    assert.equal((compact as { update_on?: string }).update_on, undefined);
  });

  it("strips raw XML and omits raw_calls unless debug:true", () => {
    const env = okEnvelope(
      {
        tickets: [
          {
            ticketid: "1",
            ticketnr: "NR-1",
            subject: "Leck",
            keyword: "Wasser",
            state: "Offen",
            partnerid: "27.1",
            category: "Mängel",
            create_on: "2026-01-01",
            extra: "drop-me",
          },
        ],
        documents: [{ documentType: "OBJEKTAKTE", body: "<xml>huge</xml>" }],
        rawXml: "<soap>nope</soap>",
      },
      {
        warnings: ["Mandant-Prefix-Scope"],
        raw_calls: [{ tool: "search_tickets", ms: 12, ok: true }],
      }
    );

    const compact = presentEnvelope(env);
    assert.equal(compact.raw_calls, undefined);
    const tickets = (compact.data as { tickets: Array<Record<string, unknown>> }).tickets;
    assert.equal(tickets[0].id, "1");
    assert.equal(tickets[0].nr, "NR-1");
    assert.equal(tickets[0].extra, undefined);
    const docs = (compact.data as { documents: Array<Record<string, unknown>> }).documents;
    assert.equal(docs[0].body, undefined);
    assert.equal((compact.data as { rawXml?: string }).rawXml, undefined);

    const debug = presentEnvelope(env, { debug: true });
    assert.ok(debug.raw_calls?.length);
    assert.equal((debug.data as { rawXml?: string }).rawXml, "<soap>nope</soap>");
  });
});
