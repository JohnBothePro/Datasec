import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DocRestResult } from "../src/documents.ts";
import { ticketBriefing } from "../src/helpers/ticket-briefing.ts";
import { createDatasecServer } from "../src/tools.ts";

function okIndex(body: string): DocRestResult {
  return {
    ok: true,
    httpStatus: 200,
    contentType: "application/xml",
    text: body,
    isBinary: false,
  };
}

describe("datasec_h_ticket_briefing include=attachment_texts", () => {
  it("publishes attachment_texts in the include enum", async () => {
    const server = createDatasecServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "briefing-schema", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    await client.close();
    await server.close();
    const tool = listed.tools.find((t) => t.name === "datasec_h_ticket_briefing");
    assert.ok(tool);
    const include = (tool.inputSchema as { properties?: { include?: { items?: { enum?: string[] } } } })
      .properties?.include;
    assert.ok(include?.items?.enum?.includes("attachments"));
    assert.ok(include?.items?.enum?.includes("attachment_texts"));
  });

  it("keeps attachments as index-only and extracts text without base64", async () => {
    const getDocumentCalls: Array<Record<string, unknown>> = [];
    const r = await ticketBriefing({
      ticketnr: "32-260907-Q0009",
      include: ["attachments", "attachment_texts"],
      deps: {
        getTicketByNr: async () => ({
          ok: true,
          ticket: { ticketnr: "32-260907-Q0009", ticketid: "TID-1", subject: "Test" },
        }),
        searchByDocumentType: async () =>
          okIndex(
            `<items><item COLLECTID="C1" DATEINAME="brief.pdf"/><item COLLECTID="C2" DATEINAME="scan.pdf"/></items>`
          ),
        getDocument: async (opts) => {
          getDocumentCalls.push(opts as unknown as Record<string, unknown>);
          return {
            ok: true,
            httpStatus: 200,
            contentType: "application/pdf",
            text: `Extracted ${opts.indexValue} lorem ipsum`,
            isBinary: false,
            textChars: 28,
            textEmpty: false,
            extractNote: "ok",
          };
        },
      },
    });

    assert.equal(r.ok, true);
    const data = r.data as {
      attachments?: { body?: string; base64?: string };
      attachment_texts?: { items?: Array<Record<string, unknown>>; note?: string };
    };
    assert.ok(data.attachments?.body?.includes("COLLECTID"));
    assert.equal(data.attachments?.base64, undefined);
    assert.equal(getDocumentCalls.length, 2);
    assert.ok(getDocumentCalls.every((c) => c.format === "text"));
    const items = data.attachment_texts?.items ?? [];
    assert.equal(items.length, 2);
    assert.ok(String(items[0].text).includes("C1"));
    assert.equal(items[0].textEmpty, false);
    assert.ok(!JSON.stringify(data.attachment_texts).includes("base64"));
  });

  it("caps attachment_texts at 5 items and total chars, still no base64", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `<item COLLECTID="C${i + 1}"/>`).join("");
    let fetches = 0;
    const r = await ticketBriefing({
      ticketnr: "NR-1",
      include: ["attachment_texts"],
      deps: {
        getTicketByNr: async () => ({
          ok: true,
          ticket: { ticketnr: "NR-1", ticketid: "TID-9" },
        }),
        searchByDocumentType: async () => okIndex(`<items>${rows}</items>`),
        getDocument: async () => {
          fetches += 1;
          return {
            ok: true,
            httpStatus: 200,
            contentType: "application/pdf",
            text: "X".repeat(8000),
            isBinary: false,
            textChars: 8000,
            textEmpty: false,
            extractNote: "ok",
            base64: "SHOULD_NOT_LEAK",
          };
        },
      },
    });

    const data = r.data as {
      attachment_texts?: { items?: Array<{ text: string }>; omitted?: number };
      attachments?: unknown;
    };
    assert.equal(data.attachments, undefined, "attachment_texts does not imply attachments index section");
    assert.ok((data.attachment_texts?.items?.length ?? 0) <= 5);
    assert.equal(fetches, data.attachment_texts?.items?.length);
    const total = (data.attachment_texts?.items ?? []).reduce((n, it) => n + it.text.length, 0);
    assert.ok(total <= 20_000, `total chars ${total}`);
    assert.ok(!JSON.stringify(r).includes("SHOULD_NOT_LEAK"));
  });
});
