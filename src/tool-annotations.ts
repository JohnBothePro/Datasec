/**
 * MCP ToolAnnotations for Claude Connectors grouping.
 * Read → Always allow; Write/delete → Needs approval.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const ann = {
  /** Safe reads / URL builders. Claude Connectors: Read group. */
  read(): ToolAnnotations {
    return { readOnlyHint: true, openWorldHint: true };
  },
  /** Mutating tools (incl. datasec_h_ask which can write with confirm). */
  write(): ToolAnnotations {
    return { readOnlyHint: false, destructiveHint: true };
  },
} as const;
