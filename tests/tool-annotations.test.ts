import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatasecServer, TOOL_NAMES } from "../src/tools.ts";
import { ann } from "../src/tool-annotations.ts";

/** Tools that can mutate Datasec or the MCP session — Claude Write / Needs approval. */
const WRITE_TOOLS = new Set<string>([
  "datasec_set_env",
  "datasec_add_note",
  "datasec_set_state",
  "datasec_link_tickets",
  "datasec_send_ticket_mail",
  "datasec_update_document",
  "datasec_archive_document_soap",
  "datasec_archive_document_rest",
  "datasec_create_master_ticket",
  "datasec_create_ticket",
  "datasec_link_ticket_to_master",
  "datasec_forward_ticket",
  "datasec_press_process_button",
  "datasec_set_keyword",
  "datasec_set_ticket_values",
  "datasec_mark_document_read",
  "datasec_set_app_user_push_flags",
  "datasec_update_contact_data",
  "datasec_insert_eed_data",
  "datasec_h_ask",
  "datasec_h_create_ticket",
  "datasec_h_add_note",
  "datasec_h_set_state",
]);

/** Safety net: a new create/update/set/… tool omitted from WRITE_TOOLS must fail CI. */
function looksLikeWriteName(name: string): boolean {
  const short = name.replace(/^datasec_/, "");
  if (short === "h_ask") return true;
  return /(?:^|_)(?:create|update|set|link|forward|archive|press|send|insert|add_note|mark_document_read)(?:_|$)/.test(
    short
  );
}

async function listTools() {
  const server = createDatasecServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annot-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  await client.close();
  await server.close();
  return listed.tools;
}

describe("MCP tool annotations for Claude Connectors", () => {
  it("exposes ann.read / ann.write matching SDK ToolAnnotations", () => {
    assert.deepEqual(ann.read(), { readOnlyHint: true, openWorldHint: true });
    assert.deepEqual(ann.write(), { readOnlyHint: false, destructiveHint: true });
  });

  it("classifies every known tool name as read or write", () => {
    const names = TOOL_NAMES as readonly string[];
    const unknownWrites = [...WRITE_TOOLS].filter((name) => !names.includes(name));
    assert.deepEqual(unknownWrites, [], "WRITE_TOOLS has names not in TOOL_NAMES");

    const heuristicWrites = names.filter(looksLikeWriteName).sort();
    assert.deepEqual(
      heuristicWrites,
      [...WRITE_TOOLS].sort(),
      "name heuristic vs WRITE_TOOLS drifted — add the new mutator to WRITE_TOOLS (or except a false positive)"
    );
  });

  it("registers explicit annotations on every tool (read vs write)", async () => {
    const tools = await listTools();
    const listedNames = tools.map((t) => t.name).sort();
    assert.deepEqual(
      listedNames,
      [...TOOL_NAMES].sort(),
      "registered tools drifted from TOOL_NAMES"
    );

    const missing = tools.filter((t) => t.annotations == null).map((t) => t.name);
    assert.deepEqual(missing, [], "tools without annotations");

    const wrong: string[] = [];
    for (const tool of tools) {
      const a = tool.annotations ?? {};
      if (WRITE_TOOLS.has(tool.name)) {
        if (a.readOnlyHint !== false || a.destructiveHint !== true) {
          wrong.push(`${tool.name} expected write, got ${JSON.stringify(a)}`);
        }
      } else if (a.readOnlyHint !== true || a.openWorldHint !== true) {
        wrong.push(`${tool.name} expected read, got ${JSON.stringify(a)}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
});
