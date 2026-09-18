import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatasecServer, searchTicketsMaxSchema } from "../src/tools.ts";

type JsonSchema = {
  type?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
  properties?: Record<string, JsonSchema>;
};

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createDatasecServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "search-max-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("datasec_search_tickets max (no MCP soft-cap)", () => {
  it("publishes max without an MCP maximum; default stays small", async () => {
    const listed = await withClient((c) => c.listTools());
    const tool = listed.tools.find((t) => t.name === "datasec_search_tickets");
    assert.ok(tool, "datasec_search_tickets registered");

    const schema = tool.inputSchema as JsonSchema;
    const max = schema.properties?.max;
    assert.ok(max, "max property exists");
    assert.equal(max.type, "integer");
    assert.equal(max.minimum, 1);
    assert.equal(
      max.maximum,
      undefined,
      "MCP must not set an artificial max ceiling — Datasec API is the only upper bound"
    );

    const text = `${tool.description ?? ""} ${max.description ?? ""}`;
    assert.match(text, /Default\s+10/i);
    assert.match(
      text,
      /kein MCP-(?:Max|Deckel|Obergrenze)|ohne MCP-Obergrenze|Obergrenze nur (?:die )?Datasec-API/i
    );
    assert.match(text, /bulk|Export/i);
  });

  it("Zod accepts a large max and still rejects max below 1", () => {
    assert.equal(searchTicketsMaxSchema.safeParse(5000).success, true);
    assert.equal(searchTicketsMaxSchema.safeParse(1).success, true);
    assert.equal(searchTicketsMaxSchema.safeParse(undefined).success, true);
    assert.equal(searchTicketsMaxSchema.safeParse(0).success, false);
    assert.equal(searchTicketsMaxSchema.safeParse(-1).success, false);
    assert.equal(searchTicketsMaxSchema.safeParse(1.5).success, false);
  });

  it("accepts a large max at MCP call validation without hitting Datasec", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch stub — tests must not call Datasec");
    }) as typeof fetch;
    try {
      const result = await withClient((c) =>
        c.callTool({ name: "datasec_search_tickets", arguments: { max: 5000 } })
      );
      const text = JSON.stringify(result);
      assert.doesNotMatch(
        text,
        /less than or equal to \d+|Input validation error/i,
        "MCP must not reject large max — only Datasec API may cap the page"
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("still rejects max below 1", async () => {
    const result = await withClient((c) =>
      c.callTool({ name: "datasec_search_tickets", arguments: { max: 0 } })
    );
    assert.equal(result.isError, true);
    const text = JSON.stringify(result);
    assert.match(text, /Input validation error/i);
    assert.match(text, /greater than or equal to 1/i);
  });

  it("leaves datasec_h_find_tickets lean (helper clamp stays ≤10)", async () => {
    const listed = await withClient((c) => c.listTools());
    const helper = listed.tools.find((t) => t.name === "datasec_h_find_tickets");
    assert.ok(helper, "datasec_h_find_tickets registered");
    const limit = (helper.inputSchema as JsonSchema).properties?.limit;
    assert.equal(limit?.maximum, 10);
  });
});
