import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { session } from "../src/client.ts";
import { applyDocumentFormat, type DocRestResult } from "../src/documents.ts";
import { getDocumentFormatSchema } from "../src/tools-extended.ts";
import { createDatasecServer } from "../src/tools.ts";
import { EMPTY_PDF, TEXT_LAYER_PDF } from "./pdf-fixtures.ts";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  properties?: Record<string, JsonSchema>;
};

function binaryDoc(buf: Buffer, contentType = "application/pdf"): DocRestResult {
  return {
    ok: true,
    httpStatus: 200,
    contentType,
    text: "",
    isBinary: true,
    base64: buf.toString("base64"),
  };
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createDatasecServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "get-doc-format-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("datasec_get_document format schema", () => {
  it("defaults format to text and still accepts binary", async () => {
    assert.equal(getDocumentFormatSchema.safeParse(undefined).success, true);
    assert.equal(getDocumentFormatSchema.parse(undefined), "text");
    assert.equal(getDocumentFormatSchema.safeParse("binary").success, true);
    assert.equal(getDocumentFormatSchema.safeParse("both").success, true);
    assert.equal(getDocumentFormatSchema.safeParse("xml").success, false);

    const listed = await withClient((c) => c.listTools());
    const tool = listed.tools.find((t) => t.name === "datasec_get_document");
    assert.ok(tool, "datasec_get_document registered");
    const format = (tool.inputSchema as JsonSchema).properties?.format;
    assert.ok(format, "format property exists");
    assert.deepEqual(format.enum, ["text", "binary", "both"]);
    assert.equal(format.default, "text");
    assert.match(`${tool.description ?? ""} ${format.description ?? ""}`, /text|pdftotext|Base64|binary/i);
    assert.equal(tool.annotations?.readOnlyHint, true);
  });
});

describe("applyDocumentFormat (no live Datasec)", () => {
  it("format=text returns extracted PDF text and omits base64", async () => {
    const r = await applyDocumentFormat(binaryDoc(TEXT_LAYER_PDF), { format: "text" });
    assert.equal(r.isBinary, false);
    assert.equal(r.base64, undefined);
    assert.ok(r.text.includes("Hello Datasec"), r.text);
    assert.equal(r.textEmpty, false);
    assert.ok(r.textChars && r.textChars > 0);
  });

  it("format=binary keeps current base64-only behavior", async () => {
    const src = binaryDoc(TEXT_LAYER_PDF);
    const r = await applyDocumentFormat(src, { format: "binary" });
    assert.equal(r.isBinary, true);
    assert.equal(r.base64, src.base64);
    assert.equal(r.text, "");
  });

  it("format=both includes text and base64", async () => {
    const src = binaryDoc(TEXT_LAYER_PDF);
    const r = await applyDocumentFormat(src, { format: "both" });
    assert.ok(r.text.includes("Hello Datasec"), r.text);
    assert.equal(r.base64, src.base64);
  });

  it("textEmpty PDF warns to use format=binary (no OCR)", async () => {
    const r = await applyDocumentFormat(binaryDoc(EMPTY_PDF), { format: "text" });
    assert.equal(r.textEmpty, true);
    assert.match(r.warning ?? "", /binary|scan|foto|photo|vision/i);
    assert.equal(r.base64, undefined);
  });

  it("non-PDF binary + format=text does not invent text", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const r = await applyDocumentFormat(binaryDoc(jpeg, "image/jpeg"), { format: "text" });
    assert.equal(r.base64, undefined);
    assert.ok(!r.text || !/lorem|invent/i.test(r.text));
    assert.match(r.warning ?? r.error ?? "", /binary|nicht verfügbar|not available|kein Text/i);
  });
});

describe("datasec_get_document callTool (mocked fetch)", () => {
  const origFetch = globalThis.fetch;
  const origToken = process.env.DATASEC_TOKEN;

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.DATASEC_TOKEN;
    else process.env.DATASEC_TOKEN = origToken;
    session.reloadToken();
  });

  it("returns text without base64 for a mocked PDF (default format)", async () => {
    process.env.DATASEC_TOKEN = "test-token-not-real";
    session.reloadToken();
    globalThis.fetch = (async () =>
      new Response(TEXT_LAYER_PDF, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch;

    const result = await withClient((c) =>
      c.callTool({
        name: "datasec_get_document",
        arguments: {
          documentType: "TICKETANLAGEN",
          indexField: "COLLECTID",
          indexValue: "1",
        },
      })
    );
    const payload = JSON.parse(String((result.content[0] as { text: string }).text));
    assert.equal(result.isError, false);
    assert.ok(String(payload.text ?? "").includes("Hello Datasec"), JSON.stringify(payload));
    assert.equal(payload.base64, undefined);
    assert.equal(payload.isBinary, false);
  });

  it("format=binary still returns base64", async () => {
    process.env.DATASEC_TOKEN = "test-token-not-real";
    session.reloadToken();
    globalThis.fetch = (async () =>
      new Response(TEXT_LAYER_PDF, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch;

    const result = await withClient((c) =>
      c.callTool({
        name: "datasec_get_document",
        arguments: {
          documentType: "TICKETANLAGEN",
          indexField: "COLLECTID",
          indexValue: "1",
          format: "binary",
        },
      })
    );
    const payload = JSON.parse(String((result.content[0] as { text: string }).text));
    assert.equal(payload.base64, TEXT_LAYER_PDF.toString("base64"));
    assert.equal(payload.isBinary, true);
  });
});
