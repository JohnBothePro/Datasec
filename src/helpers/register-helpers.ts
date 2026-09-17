/**
 * Register datasec_h_* helper tools. Feature flag: DATASEC_HELPERS_ENABLED (default true).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ask } from "./ask.js";
import { getCatalog } from "./catalog.js";
import {
  ensureAuthEnv,
  envelopeResult,
  helpersEnabled,
  textResult,
} from "./envelope.js";
import { findDocuments } from "./find-documents.js";
import { findTickets } from "./find-tickets.js";
import { getNews } from "./news.js";
import { partnerContext } from "./partner-context.js";
import { resolvePlace } from "./resolve-place.js";
import { ticketBriefing } from "./ticket-briefing.js";
import {
  addNoteGuided,
  createTicketGuided,
  setStateGuided,
} from "./write-guided.js";
import { ann } from "../tool-annotations.js";

export const HELPER_TOOL_NAMES = [
  "datasec_h_ask",
  "datasec_h_resolve",
  "datasec_h_find_tickets",
  "datasec_h_ticket_briefing",
  "datasec_h_catalog",
  "datasec_h_partner_context",
  "datasec_h_find_documents",
  "datasec_h_news",
  "datasec_h_create_ticket",
  "datasec_h_add_note",
  "datasec_h_set_state",
] as const;

const includeBriefing = z
  .array(
    z.enum(["notes", "links", "history", "attachments", "process_buttons", "chat"])
  )
  .optional();

const houseNumbersSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Hausnr-Liste, z.B. 118/118a/118b oder [\"118\",\"118a\"]");

export function registerHelperTools(server: McpServer): boolean {
  if (!helpersEnabled()) {
    console.error(
      "[datasec-mcp] helpers disabled (DATASEC_HELPERS_ENABLED=false) — raw datasec_* unchanged"
    );
    return false;
  }

  server.registerTool(
    "datasec_h_ask",
    {
      annotations: ann.write(),
      description:
        "HAUPT-EINSTIEG für deutschen Freitext über Tickets, Akten, Stammdaten, Katalog, News. " +
        "Designed for seconds-latency: EIN Helper-Call, dann antworten — keine Tool-Stürme. " +
        "Auto-Adresse: Document-Index nach Feld-Discovery (keine STREET-404) + Memory/Disk-Cache; Seed nur Override. " +
        "HARD-NO: Straße wird NIE als Ticket-KEYWORD gesucht. getPartnerId ist keine Adresssuche. " +
        "Writes nur Vorschau bis confirm:true. " +
        "Antwort compact (kleine Treffer, kein raw XML); debug:true für raw_calls.",
      inputSchema: {
        text: z.string().describe("Freitext auf Deutsch"),
        confirm: z
          .boolean()
          .optional()
          .describe("Nur für Write-Intents: true führt aus (plus Write-Gate)"),
        include: includeBriefing.describe("Optional für Ticket-Briefing"),
        catalogKind: z
          .enum(["keywords", "statuses", "groups", "doc_types", "departments"])
          .optional(),
        debug: z
          .boolean()
          .optional()
          .describe("Default false: compact envelope. true = raw_calls + raw XML"),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await ask(args), undefined, { debug: args.debug });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_resolve",
    {
      annotations: ann.read(),
      description:
        "Mandant + Adresse → Partner (seconds-latency). " +
        "Default: Live-Auflösung über Datasec Document-Index (OBJEKTAKTE, dann MIETERAKTE) " +
        "nach getDocumentTypeStructure — nur existierende Felder, nie STREET-404. " +
        "Ohne Straßenfelder: Warnung (PARTNERID / Ticketnr / SWENR). Optional SWENR-Filter. " +
        "Treffer in Memory (15min) und data/address-crosswalk.json (24h Cache, kein Ops-Seed). " +
        "Optionaler Seed nur Override/Bootstrap. Mehrere Treffer → ambiguities[], kein stilles Picken. " +
        "API-Fehler = Warnung + Teilresultat. getPartnerId ist keine Adresssuche. Straße nie KEYWORD. " +
        "Mandant ohne Objekt: PARTNERID-Prefix {mandant}. (explizite Warnung). " +
        "Antwort compact; debug:true für raw_calls.",
      inputSchema: {
        query: z.string().optional().describe("Freitext mit Straße/Hausnr"),
        mandant: z.string().optional(),
        street: z.string().optional(),
        houseNumbers: houseNumbersSchema,
        weNr: z.string().optional().describe("SWENR / Wirtschaftseinheit, wenn bekannt"),
        partnerIds: z.array(z.string()).optional(),
        liveResolve: z
          .boolean()
          .optional()
          .describe("Default true. false = nur Seed/Cache, keine Datasec-Suche"),
        allowDocumentFallback: z
          .boolean()
          .optional()
          .describe("Alias für liveResolve (älterer Name)"),
        debug: z.boolean().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await resolvePlace(args), undefined, { debug: args.debug });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_find_tickets",
    {
      annotations: ann.read(),
      description:
        "Tickets zu Adresse/Mandant/Thema (seconds-latency: max 10 Treffer, max 4 Partner, max 4 parallele Suchen, 8s Timeout). " +
        "Adresse live aus Datasec (nur existierende Indexfelder), dann PARTNERID + KEYWORD/SUBJECT. " +
        "Thema Mängel: live KEYWORDs mit CATEGORY=Mängel (nie KEYWORD=Mängel ohne Katalog-Treffer). " +
        "Eine Strategie: Partner-IDs ODER Mandant-Prefix, nie beides. Straße niemals KEYWORD.",
      inputSchema: {
        query: z.string().optional(),
        mandant: z.string().optional(),
        street: z.string().optional(),
        houseNumbers: houseNumbersSchema,
        weNr: z.string().optional().describe("SWENR / Wirtschaftseinheit, wenn bekannt"),
        partnerIds: z.array(z.string()).optional(),
        topic: z.string().optional().describe("z.B. Mängel — wird über Synonyme gemappt"),
        keyword: z.string().optional().describe("Nur echtes Schlagwort, keine Straße"),
        status: z.string().optional().describe("z.B. offen — wird gemappt"),
        ticketnr: z.string().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Default 10, hart ≤10"),
        start: z.number().int().min(1).optional(),
        liveResolve: z.boolean().optional().describe("Default true — Adresse über Datasec"),
        allowDocumentFallback: z
          .boolean()
          .optional()
          .describe("Alias für liveResolve"),
        debug: z.boolean().optional().describe("Default false: compact envelope"),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await findTickets(args), undefined, { debug: args.debug });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_ticket_briefing",
    {
      annotations: ann.read(),
      description:
        "LIGHT default: nur Ticket-Kern (seconds-latency). " +
        "notes/links/history/attachments NUR bei explizitem include — nie automatisch ketten. " +
        "Anlagen: TICKETANLAGEN + TICKETID (nie TICKETARCHIV).",
      inputSchema: {
        ticketnr: z.string(),
        include: includeBriefing,
        historyFrom: z.string().optional(),
        historyTo: z.string().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await ticketBriefing(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_catalog",
    {
      annotations: ann.read(),
      description:
        "In-Memory-Katalog (TTL 24h): keywords/statuses/groups/doc_types/departments. " +
        "list_* wird nicht bei jedem Call getroffen. Seconds-latency nach Warm-Cache.",
      inputSchema: {
        kind: z.enum(["keywords", "statuses", "groups", "doc_types", "departments"]),
        filter: z.string().optional().describe("Teilstring, z.B. Mäng"),
      },
    },
    async ({ kind, filter }) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await getCatalog(kind, filter));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_partner_context",
    {
      annotations: ann.read(),
      description:
        "LIGHT default: nur Stammdaten (base). " +
        "extended/contracts/open_tickets/Schäden nur bei explizitem include — kein Auto-Chain. " +
        "Adresse live aus Datasec, nicht getPartnerId. Mehrere Partner → ambiguities[]. Seconds-latency.",
      inputSchema: {
        partnerId: z.string().optional(),
        partner: z.string().optional().describe("PARTNER-Nummer für Verträge"),
        query: z.string().optional(),
        mandant: z.string().optional(),
        street: z.string().optional(),
        houseNumbers: houseNumbersSchema,
        include: z
          .array(
            z.enum([
              "base",
              "extended",
              "contracts",
              "conditions",
              "damage_reports",
              "other_partners",
              "open_tickets",
            ])
          )
          .optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await partnerContext(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_find_documents",
    {
      annotations: ann.read(),
      description:
        "Dokument-/Aktensuche (eine Belegtyp-Suche, max 10, 8s Timeout). " +
        "Belegtyp aus Freitext + live Katalog. Adresse → Partner via Live-Resolve. " +
        "Ticket-Anlagen: TICKETANLAGEN + TICKETID. TICKETARCHIV gesperrt.",
      inputSchema: {
        query: z.string().optional(),
        documentType: z.string().optional(),
        ticketnr: z.string().optional(),
        partnerId: z.string().optional(),
        mandant: z.string().optional(),
        street: z.string().optional(),
        houseNumbers: houseNumbersSchema,
        max: z.number().int().min(1).max(30).optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await findDocuments(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_news",
    {
      annotations: ann.read(),
      description:
        "Newsticker (eine SOAP-Suche, 8s Timeout). Optional partnerId. Seconds-latency.",
      inputSchema: {
        partnerId: z.string().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await getNews(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_create_ticket",
    {
      annotations: ann.write(),
      description:
        "Geführtes Ticket anlegen: ohne confirm = Vorschau des createTicket-Payloads; " +
        "confirm:true = bestehendes Write-Gate, dann SOAP createTicket. Straße nie als Keyword.",
      inputSchema: {
        subject: z.string(),
        partner: z.string().optional(),
        partnerId: z.string().optional(),
        keyword: z.string().optional(),
        topic: z.string().optional(),
        category: z.string().optional(),
        channel: z.string().optional(),
        description: z.string().optional(),
        type: z.string().optional(),
        plz: z.string().optional(),
        ticketgroup: z.string().optional(),
        fieldvalues: z.string().optional(),
        priority: z.string().optional(),
        ticketsystem: z.string().optional(),
        mandant: z.string().optional(),
        street: z.string().optional(),
        houseNumbers: houseNumbersSchema,
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await createTicketGuided(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_add_note",
    {
      annotations: ann.write(),
      description:
        "Geführte Notiz: ohne confirm = Vorschau; confirm:true = Write-Gate + addTicketNote.",
      inputSchema: {
        ticketnr: z.string(),
        note: z.string().min(1),
        checkDuplicates: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await addNoteGuided(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_h_set_state",
    {
      annotations: ann.write(),
      description:
        "Geführter Statuswechsel: ohne confirm = Vorschau; confirm:true = Write-Gate + setTicketState.",
      inputSchema: {
        ticketnr: z.string(),
        state: z.string(),
        notice: z.string().optional(),
        param: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return envelopeResult(await setStateGuided(args));
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  console.error(
    `[datasec-mcp] helpers enabled: ${HELPER_TOOL_NAMES.join(", ")}`
  );
  return true;
}

export { helpersEnabled };
