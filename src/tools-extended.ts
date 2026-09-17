/**
 * Extended Datasec MCP tools: Documents, Tickets (missing), Stammdaten,
 * Other, Deep links, SSO, Bridge.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { session } from "./client.js";
import * as soap from "./soap.js";
import * as documents from "./documents.js";
import * as stammdaten from "./stammdaten.js";
import * as deeplink from "./deeplink.js";
import { bridgeInfo } from "./bridge.js";
import { ann } from "./tool-annotations.js";
import {
  canWrite,
  getAuth,
  isAdmin,
  canUseEnv,
  firstAllowedEnv,
} from "./auth.js";

function textResult(data: unknown, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }], isError };
}

function ensureAuthEnv(): void {
  const auth = getAuth();
  if (!auth) return;
  if (canUseEnv(session.env, auth)) return;
  const first = firstAllowedEnv(auth);
  if (first) session.setEnv(first);
}

function gateWrite(confirm: boolean | undefined): string | null {
  const auth = getAuth();
  if (auth && !canWrite(auth)) {
    return (
      `Schreibzugriff verweigert: Rolle '${auth.role}' (Key: ${auth.name}) ` +
      "darf keine Write-Tools nutzen. Benötigt role write|admin."
    );
  }
  if (!session.writesEnabled) {
    return (
      "Schreibzugriff deaktiviert (DATASEC_WRITES_ENABLED=false). " +
      "Zum Aktivieren: DATASEC_WRITES_ENABLED=true setzen und Server neu starten."
    );
  }
  if (session.requireConfirm && confirm !== true) {
    return (
      "Bestätigung fehlt: DATASEC_REQUIRE_CONFIRM=true verlangt confirm:true. " +
      "Bitte den Aufruf mit confirm:true wiederholen."
    );
  }
  return null;
}

function gateAdminConfirm(confirm: boolean | undefined): string | null {
  const auth = getAuth();
  if (auth && !isAdmin(auth)) {
    return (
      `Admin-Recht erforderlich: Rolle '${auth.role}' (Key: ${auth.name}). ` +
      "Authtoken-Embedding braucht role admin + confirm:true."
    );
  }
  if (session.requireConfirm && confirm !== true) {
    return "Bestätigung fehlt: confirm:true erforderlich für Authtoken-Embedding.";
  }
  return null;
}

function soapOut(
  action: string,
  result: soap.SoapResult,
  extra: Record<string, unknown> = {}
) {
  return textResult(
    {
      env: session.env,
      action,
      ok: result.ok,
      httpStatus: result.httpStatus,
      success: result.success,
      errorText: result.errorText,
      infoText: result.infoText,
      data: result.json,
      returnText: result.returnText,
      ...extra,
    },
    !result.ok
  );
}

function docOut(
  action: string,
  result: documents.DocRestResult,
  extra: Record<string, unknown> = {}
) {
  const payload: Record<string, unknown> = {
    env: session.env,
    action,
    ok: result.ok,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    isBinary: result.isBinary,
    error: result.error,
    ...extra,
  };
  if (result.isBinary && result.base64) {
    payload.base64Length = result.base64.length;
    payload.base64 = result.base64;
    payload.note = "Binary document as base64 (Content-Type siehe contentType)";
  } else {
    payload.body = result.text;
  }
  return textResult(payload, !result.ok);
}

const filterSchema = z.object({
  field: z.string(),
  op: z.string().optional(),
  val: z.string(),
  con: z.enum(["AND", "OR", "and", "or"]).optional(),
});

const confirmSchema = z
  .boolean()
  .optional()
  .describe("Muss true sein wenn Confirm-Gate aktiv (Writes)");

export const EXTENDED_TOOL_NAMES = [
  // Documents 2.5.1
  "datasec_get_document",
  "datasec_update_document",
  "datasec_archive_document_soap",
  "datasec_archive_document_rest",
  "datasec_search_by_document_type",
  "datasec_search_in_process",
  "datasec_list_departments",
  "datasec_list_document_types",
  "datasec_get_document_type_structure",
  // Tickets missing 2.5.2
  "datasec_create_master_ticket",
  "datasec_create_ticket",
  "datasec_link_ticket_to_master",
  "datasec_forward_ticket",
  "datasec_press_process_button",
  "datasec_get_process_buttons",
  "datasec_get_process_fields",
  "datasec_set_keyword",
  "datasec_set_ticket_values",
  "datasec_list_keywords",
  "datasec_get_process_fields_first_step",
  "datasec_get_latest_chat_messages",
  // Stammdaten 2.5.3
  "datasec_get_partner_id",
  "datasec_get_partner_contracts",
  "datasec_get_partner_base_data",
  "datasec_get_other_contract_partners_base",
  "datasec_get_partner_extended_data",
  "datasec_get_contract_conditions",
  "datasec_get_app_users",
  "datasec_get_business_partner_data",
  "datasec_mark_document_read",
  "datasec_set_app_user_push_flags",
  "datasec_update_contact_data",
  "datasec_insert_eed_data",
  "datasec_get_special_supplementary_data",
  // Other 2.5.4
  "datasec_get_damage_reports",
  "datasec_get_news_ticker",
  // Deep links Kap. 3
  "datasec_build_deeplink_base",
  "datasec_build_deeplink_akte",
  "datasec_build_deeplink_search",
  "datasec_build_deeplink_document_type",
  "datasec_build_deeplink_sammelbenutzer",
  // SSO Kap. 4
  "datasec_sso_status",
  // Bridge Kap. 1
  "datasec_bridge_info",
] as const;

export function registerExtendedTools(server: McpServer): void {
  // ── Documents §2.5.1 ───────────────────────────────────────────────
  server.registerTool(
    "datasec_get_document",
    {
      annotations: ann.read(),
      description:
        "Dokument abrufen (REST §2.5.1.1): GET documents/{Belegtyp}/{IndexFeld}/{IndexWert}. Binary → base64. Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        documentType: z.string().describe("Belegtyp, z.B. EINGANGSRECHNUNG"),
        indexField: z.string().describe("Index-Feld, z.B. COLLECTID oder RECHNUNGS_NR"),
        indexValue: z.string().describe("Index-Wert"),
        merge: z.boolean().optional().describe("PDF-Seiten mergen (Default server-seitig)"),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return docOut("get_document", await documents.getDocument(args));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_update_document",
    {
      annotations: ann.write(),
      description:
        "Dokument-Index ändern (SOAP updateIndexValues2 §2.5.1.2). Write+confirm.",
      inputSchema: {
        documentType: z.string(),
        collectid: z.string(),
        fieldnames: z.array(z.string()).min(1).describe("Index-Feldnamen (Reihenfolge = Werte)"),
        fieldvalues: z.array(z.string()).min(1).describe("Index-Werte"),
        confirm: confirmSchema,
      },
    },
    async ({ documentType, collectid, fieldnames, fieldvalues, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      if (fieldnames.length !== fieldvalues.length) {
        return textResult(
          { ok: false, error: "fieldnames und fieldvalues müssen gleich lang sein" },
          true
        );
      }
      try {
        const result = await documents.updateDocument({
          documentType,
          collectid,
          fieldnames,
          fieldvalues,
        });
        return soapOut("update_document", result, { documentType, collectid });
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_archive_document_soap",
    {
      annotations: ann.write(),
      description:
        "Dokument archivieren via SOAP insertDoc2_1 (§2.5.1.3, Base64 + pipe fields). Write+confirm.",
      inputSchema: {
        documentType: z.string(),
        fieldnames: z.array(z.string()).min(1),
        fieldvalues: z.array(z.string()).min(1),
        inputfileBase64: z.string().describe("Datei als Base64"),
        filetype: z.string().describe("PDF/DOC/DOCX/…"),
        convertToPDF: z.boolean().optional(),
        mailboxEntry: z.string().optional().describe("JSON sMailboxEntry"),
        ticketid: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      if (args.fieldnames.length !== args.fieldvalues.length) {
        return textResult(
          { ok: false, error: "fieldnames und fieldvalues müssen gleich lang sein" },
          true
        );
      }
      try {
        const result = await documents.archiveDocumentSoap(args);
        return soapOut("archive_document_soap", result, {
          documentType: args.documentType,
          filetype: args.filetype,
        });
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_archive_document_rest",
    {
      annotations: ann.write(),
      description:
        "Dokument archivieren via REST POST adddocument/{type} (§2.5.1.4). Write+confirm.",
      inputSchema: {
        documentType: z.string(),
        indexfields: z.record(z.string()).describe("Key-Value Indexfelder"),
        inputfileBase64: z.string(),
        filetype: z.string(),
        convertToPDF: z.boolean().optional(),
        mailboxentry: z.string().optional(),
        ticketid: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        const result = await documents.archiveDocumentRest(args);
        return textResult(
          {
            env: session.env,
            action: "archive_document_rest",
            ok: result.ok,
            httpStatus: result.httpStatus,
            body: result.text,
            error: result.error,
            documentType: args.documentType,
          },
          !result.ok
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_search_by_document_type",
    {
      annotations: ann.read(),
      description:
        "In einem Belegtyp suchen (REST §2.5.1.5 indexes/{Belegtyp}/). " +
        "DAS Tool für Ticket-Anlagen: documentType=TICKETANLAGEN, Filter TICKETID=<ticketid aus get_ticket> (nicht TICKETNR), max≤10. " +
        "404 No documents = keine Anlagen; 200 = Anlagen vorhanden. " +
        "Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        documentType: z.string(),
        start: z.number().int().min(1).optional(),
        max: z.number().int().min(1).max(100).optional(),
        filters: z.array(filterSchema).optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return docOut(
          "search_by_document_type",
          await documents.searchByDocumentType(args),
          { documentType: args.documentType }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_search_in_process",
    {
      annotations: ann.read(),
      description:
        "In einem Vorgang suchen (REST §2.5.1.6 collection-by-indexes/{Belegtyp}/). " +
        "NIEMALS für TICKETANLAGEN / TICKETARCHIV / ATTACHMENTS — liefert immer HTTP 403. " +
        "Ticket-Anlagen ausschließlich über datasec_search_by_document_type (TICKETANLAGEN + Filter TICKETID). " +
        "Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        documentType: z.string(),
        start: z.number().int().min(1).optional(),
        max: z.number().int().min(1).max(100).optional(),
        filters: z.array(filterSchema).optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return docOut(
          "search_in_process",
          await documents.searchInProcess(args),
          { documentType: args.documentType }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_list_departments",
    {
      annotations: ann.read(),
      description: "Liste aller Abteilungen (REST §2.5.1.7 departments/).",
      inputSchema: {},
    },
    async () => {
      ensureAuthEnv();
      try {
        return docOut("list_departments", await documents.listDepartments());
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_list_document_types",
    {
      annotations: ann.read(),
      description: "Liste aller Belegtypen (REST §2.5.1.8 document-types/).",
      inputSchema: {},
    },
    async () => {
      ensureAuthEnv();
      try {
        return docOut("list_document_types", await documents.listDocumentTypes());
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_document_type_structure",
    {
      annotations: ann.read(),
      description: "Struktur eines Belegtyps (REST §2.5.1.9 document-types/{Belegtyp}/).",
      inputSchema: { documentType: z.string() },
    },
    async ({ documentType }) => {
      ensureAuthEnv();
      try {
        return docOut(
          "get_document_type_structure",
          await documents.getDocumentTypeStructure(documentType),
          { documentType }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  // ── Tickets missing §2.5.2 ─────────────────────────────────────────
  server.registerTool(
    "datasec_create_master_ticket",
    {
      annotations: ann.write(),
      description: "Masterticket anlegen (SOAP createMasterTicket §2.5.2.1). Write+confirm.",
      inputSchema: {
        subject: z.string(),
        partner: z.string().describe("Partner-ID / MieterID"),
        keyword: z.string(),
        category: z.string().optional(),
        postkorb: z.string().optional(),
        channel: z.string().optional().describe("POST|EMAIL|FAX|PHONE|MANUELL"),
        description: z.string().optional(),
        type: z.string().optional(),
        plz: z.string().optional(),
        ticketgroup: z.string().optional(),
        fieldvalues: z.string().optional().describe("JSON Feld-ID→Wert"),
        priority: z.string().optional(),
        reminderDate: z.string().optional(),
        ticketids: z.string().optional().describe("Ticketnr-Liste ;-getrennt"),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        const { confirm: _c, ...opts } = args;
        return soapOut("create_master_ticket", await soap.createMasterTicket(opts));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_create_ticket",
    {
      annotations: ann.write(),
      description: "Ticket anlegen (SOAP createTicket §2.5.2.2). Write+confirm.",
      inputSchema: {
        subject: z.string(),
        partner: z.string(),
        keyword: z.string(),
        category: z.string().optional(),
        channel: z.string().optional(),
        description: z.string().optional(),
        type: z.string().optional().describe("OZ = ohne Stammdatenpflicht"),
        plz: z.string().optional(),
        ticketgroup: z.string().optional(),
        fieldvalues: z.string().optional(),
        priority: z.string().optional(),
        ticketsystem: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        const { confirm: _c, ...opts } = args;
        return soapOut("create_ticket", await soap.createTicket(opts));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_link_ticket_to_master",
    {
      annotations: ann.write(),
      description:
        "Ticket mit Masterticket verknüpfen (SOAP linkTicketToMaster §2.5.2.3). Write+confirm. " +
        "Hinweis: Playbook bevorzugt oft linkTicketToTicket statt Master-Hub.",
      inputSchema: {
        ticketnr: z.string(),
        masterNr: z.string(),
        subject: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async ({ ticketnr, masterNr, subject, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        return soapOut(
          "link_ticket_to_master",
          await soap.linkTicketToMaster(ticketnr, masterNr, subject),
          { ticketnr, masterNr }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_forward_ticket",
    {
      annotations: ann.write(),
      description: "Ticket weiterleiten (SOAP forwardTicket §2.5.2.4). Write+confirm.",
      inputSchema: {
        ticketnr: z.string(),
        receiver: z.string().describe("Empfänger Login/Postgruppe"),
        disableDepositCheck: z.boolean().optional(),
        confirm: confirmSchema,
      },
    },
    async ({ ticketnr, receiver, disableDepositCheck, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        return soapOut(
          "forward_ticket",
          await soap.forwardTicket(ticketnr, receiver, disableDepositCheck === true),
          { ticketnr, receiver }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_press_process_button",
    {
      annotations: ann.write(),
      description:
        "Prozessschaltfläche betätigen (SOAP doTicketProcessAction §2.5.2.8). Write+confirm.",
      inputSchema: {
        ticketnr: z.string(),
        buttonId: z.string(),
        params: z
          .string()
          .optional()
          .describe('JSON sParams z.B. {"REMINDER":"01.01.2026"} oder CATALOG_VALUE'),
        confirm: confirmSchema,
      },
    },
    async ({ ticketnr, buttonId, params, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        return soapOut(
          "press_process_button",
          await soap.doTicketProcessAction(ticketnr, buttonId, params ?? ""),
          { ticketnr, buttonId }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_process_buttons",
    {
      annotations: ann.read(),
      description: "Prozessschaltflächen abrufen (SOAP getTicketProcessButtons §2.5.2.9). Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: { ticketnr: z.string() },
    },
    async ({ ticketnr }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_process_buttons",
          await soap.getTicketProcessButtons(ticketnr),
          { ticketnr }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_process_fields",
    {
      annotations: ann.read(),
      description: "Prozessfelder abrufen (SOAP getTicketProcessFields §2.5.2.10). Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: { ticketnr: z.string() },
    },
    async ({ ticketnr }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_process_fields",
          await soap.getTicketProcessFields(ticketnr),
          { ticketnr }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_set_keyword",
    {
      annotations: ann.write(),
      description: "Ticketschlagwort ändern (SOAP changeTicketKeyword §2.5.2.12). Write+confirm.",
      inputSchema: {
        ticketnr: z.string(),
        newKeyword: z.string(),
        note: z.string().optional(),
        newSubject: z.string().optional(),
        channel: z.string().optional(),
        keywordAlias: z.string().optional(),
        ticketsystem: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        return soapOut(
          "set_keyword",
          await soap.changeTicketKeyword(args.ticketnr, args.newKeyword, {
            note: args.note,
            newSubject: args.newSubject,
            channel: args.channel,
            keywordAlias: args.keywordAlias,
            ticketsystem: args.ticketsystem,
          }),
          { ticketnr: args.ticketnr, newKeyword: args.newKeyword }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_set_ticket_values",
    {
      annotations: ann.write(),
      description: "Ticketwerte setzen (SOAP setTicketValues §2.5.2.15). Write+confirm.",
      inputSchema: {
        ticketnr: z.string(),
        fieldvalues: z
          .string()
          .describe('JSON z.B. {"Feld":"Wert"} oder {"Feld":{"VALUE":"…","PROCESSID":"…"}}'),
        confirm: confirmSchema,
      },
    },
    async ({ ticketnr, fieldvalues, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        return soapOut(
          "set_ticket_values",
          await soap.setTicketValues(ticketnr, fieldvalues),
          { ticketnr }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_list_keywords",
    {
      annotations: ann.read(),
      description: "Schlagworte abrufen (SOAP getKeywords §2.5.2.16).",
      inputSchema: {
        channel: z.string().optional().describe("Eingangskanal"),
        ticketsystem: z.string().optional(),
      },
    },
    async ({ channel, ticketsystem }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "list_keywords",
          await soap.getKeywords(channel ?? "", ticketsystem ?? "")
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_process_fields_first_step",
    {
      annotations: ann.read(),
      description:
        "Prozessfelder des ersten Schritts (SOAP getTicketProcessFieldsFirstStep §2.5.2.18). " +
        "Mit ticketnr → …FirstStepTicketNr. Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        keyword: z.string(),
        channel: z.string(),
        ticketsystem: z.string().optional(),
        ticketnr: z.string().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_process_fields_first_step",
          await soap.getTicketProcessFieldsFirstStep(args)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_latest_chat_messages",
    {
      annotations: ann.read(),
      description:
        "Neueste Chat-Nachrichten (SOAP getNewTicketChatNotes §2.5.2.20). Datum YYYY-MM-DD[ HH:MM:SS]. Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        dateFrom: z.string(),
        dateTo: z.string(),
        ticketnr: z.string().optional(),
      },
    },
    async ({ dateFrom, dateTo, ticketnr }) => {
      ensureAuthEnv();
      try {
        const from = dateFrom.length <= 10 ? `${dateFrom} 00:00:00` : dateFrom;
        const to = dateTo.length <= 10 ? `${dateTo} 23:59:59` : dateTo;
        return soapOut(
          "get_latest_chat_messages",
          await soap.getNewTicketChatNotes(from, to, ticketnr),
          { dateFrom: from, dateTo: to, ticketnr: ticketnr ?? null }
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  // ── Stammdaten §2.5.3 ──────────────────────────────────────────────
  server.registerTool(
    "datasec_get_partner_id",
    {
      annotations: ann.read(),
      description: "Partner-ID abrufen (SOAP getPartnerId §2.5.3.1). sParams als JSON-String.",
      inputSchema: {
        paramsJson: z
          .string()
          .describe('JSON z.B. {"RECNNR":"4711","BIRTHDT":"2000-01-01"}'),
      },
    },
    async ({ paramsJson }) => {
      ensureAuthEnv();
      try {
        return soapOut("get_partner_id", await stammdaten.getPartnerId(paramsJson));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_partner_contracts",
    {
      annotations: ann.read(),
      description: "Verträge eines Partners (SOAP getPartnerContracts §2.5.3.2). sPartner=PARTNER.",
      inputSchema: { partner: z.string().describe("PARTNER-Nummer aus getPartnerId") },
    },
    async ({ partner }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_partner_contracts",
          await stammdaten.getPartnerContracts(partner)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_partner_base_data",
    {
      annotations: ann.read(),
      description: "Basisdaten Partner (SOAP getPartnerMasterdata §2.5.3.3).",
      inputSchema: { partnerid: z.string().describe("PARTNERID") },
    },
    async ({ partnerid }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_partner_base_data",
          await stammdaten.getPartnerMasterdata(partnerid)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_other_contract_partners_base",
    {
      annotations: ann.read(),
      description:
        "Basisdaten weiterer Vertragspartner (SOAP getAddPartnersMasterdata §2.5.3.4).",
      inputSchema: { partnerid: z.string() },
    },
    async ({ partnerid }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_other_contract_partners_base",
          await stammdaten.getAddPartnersMasterdata(partnerid)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_partner_extended_data",
    {
      annotations: ann.read(),
      description: "Erweiterte Partnerdaten (SOAP getPartnerExtMasterdata §2.5.3.5).",
      inputSchema: { partnerid: z.string() },
    },
    async ({ partnerid }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_partner_extended_data",
          await stammdaten.getPartnerExtMasterdata(partnerid)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_contract_conditions",
    {
      annotations: ann.read(),
      description: "Vertragskonditionen (SOAP getPartnerConditionsApp §2.5.3.6).",
      inputSchema: { partnerid: z.string() },
    },
    async ({ partnerid }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_contract_conditions",
          await stammdaten.getPartnerConditionsApp(partnerid)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_app_users",
    {
      annotations: ann.read(),
      description: "App-Nutzer abrufen (SOAP getAppUser §2.5.3.7). Pagination via start.",
      inputSchema: {
        start: z.string().optional().describe("Pagination Start (Default 0)"),
      },
    },
    async ({ start }) => {
      ensureAuthEnv();
      try {
        return soapOut("get_app_users", await stammdaten.getAppUser(start ?? "0"));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_business_partner_data",
    {
      annotations: ann.read(),
      description: "Geschäftspartnerdaten (SOAP getGPMasterdata §2.5.3.8). sPartner=PARTNER.",
      inputSchema: { partner: z.string() },
    },
    async ({ partner }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_business_partner_data",
          await stammdaten.getGPMasterdata(partner)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_mark_document_read",
    {
      annotations: ann.write(),
      description: "Beleg als gelesen markieren (SOAP setDocRead §2.5.3.9). Write+confirm.",
      inputSchema: {
        partnerid: z.string(),
        docid: z.string(),
        readOn: z.string().describe("YYYY-MM-DD"),
        appRendering: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        const { confirm: _c, ...opts } = args;
        return soapOut("mark_document_read", await stammdaten.setDocRead(opts));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_set_app_user_push_flags",
    {
      annotations: ann.write(),
      description:
        "App-Nutzer-/Push-Kennzeichen setzen (SOAP setGRPfromPartner §2.5.3.10). " +
        "grp: U|UX|P|PX. Write+confirm. partnerid und/oder partner.",
      inputSchema: {
        grp: z.string().describe("U|UX|P|PX"),
        partnerid: z.string().optional(),
        partner: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      if (!args.partnerid && !args.partner) {
        return textResult(
          { ok: false, error: "partnerid oder partner erforderlich" },
          true
        );
      }
      try {
        return soapOut(
          "set_app_user_push_flags",
          await stammdaten.setGRPfromPartner({
            grp: args.grp,
            partnerid: args.partnerid,
            partner: args.partner,
          })
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_update_contact_data",
    {
      annotations: ann.write(),
      description:
        "Kontaktdaten ändern (SOAP updatePartnerData §2.5.3.11). " +
        "type: MAIL|PHONE|MOBILE|MAIL_INDP|PHONE_INDP|MOBILE_INDP. Write+confirm.",
      inputSchema: {
        type: z.string(),
        newValue: z.string(),
        partnerid: z.string().optional(),
        partner: z.string().optional(),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      ensureAuthEnv();
      const blocked = gateWrite(args.confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      if (!args.partnerid && !args.partner) {
        return textResult(
          { ok: false, error: "partnerid oder partner erforderlich" },
          true
        );
      }
      try {
        return soapOut(
          "update_contact_data",
          await stammdaten.updatePartnerData({
            type: args.type,
            newValue: args.newValue,
            partnerid: args.partnerid,
            partner: args.partner,
          })
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_insert_eed_data",
    {
      annotations: ann.write(),
      description: "EED-Daten einfügen (SOAP addEEDData §2.5.3.12). Write+confirm.",
      inputSchema: {
        dataJson: z.string().describe("JSON-Payload (Aufbau kundenspezifisch)"),
        confirm: confirmSchema,
      },
    },
    async ({ dataJson, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
      try {
        return soapOut("insert_eed_data", await stammdaten.addEEDData(dataJson));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_special_supplementary_data",
    {
      annotations: ann.read(),
      description: "Spezielle ergänzende Daten (SOAP getSpecialData §2.5.3.13).",
      inputSchema: {
        type: z.string(),
        partnerid: z.string().optional(),
      },
    },
    async ({ type, partnerid }) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_special_supplementary_data",
          await stammdaten.getSpecialData({ type, partnerid })
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  // ── Other §2.5.4 ───────────────────────────────────────────────────
  server.registerTool(
    "datasec_get_damage_reports",
    {
      annotations: ann.read(),
      description:
        "Schadensmeldungen (SOAP getPartnerMaintenanceIssues §2.5.4.1). " +
        "partnerid ODER datefrom+dateto (DD.MM.YYYY).",
      inputSchema: {
        partnerid: z.string().optional(),
        datefrom: z.string().optional(),
        dateto: z.string().optional(),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        return soapOut(
          "get_damage_reports",
          await stammdaten.getPartnerMaintenanceIssues(args)
        );
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  server.registerTool(
    "datasec_get_news_ticker",
    {
      annotations: ann.read(),
      description: "Newstickermeldungen (SOAP getNewsticker §2.5.4.2, Newsticker.cfc).",
      inputSchema: { partnerid: z.string() },
    },
    async ({ partnerid }) => {
      ensureAuthEnv();
      try {
        return soapOut("get_news_ticker", await stammdaten.getNewsticker(partnerid));
      } catch (e) {
        return textResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );

  // ── Deep links Kap. 3 ──────────────────────────────────────────────
  const deeplinkAuthFields = {
    includeAuthToken: z
      .boolean()
      .optional()
      .describe("Default false. true → admin+confirm; Token nie in Logs roh."),
    disableSearch: z.boolean().optional().describe("disable=search setzen"),
    confirm: z
      .boolean()
      .optional()
      .describe("Erforderlich wenn includeAuthToken=true"),
    extraParams: z.record(z.string()).optional(),
  };

  function finalizeDeeplink(
    built: {
      url: string;
      urlRedacted: string;
      includedAuthToken: boolean;
      [k: string]: unknown;
    },
    includeAuthToken: boolean | undefined,
    confirm: boolean | undefined
  ) {
    if (includeAuthToken) {
      const blocked = gateAdminConfirm(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);
    }
    // Never return raw token unless admin explicitly requested with confirm
    const returnUrl =
      built.includedAuthToken && includeAuthToken === true
        ? built.url
        : built.urlRedacted;
    return textResult({
      ok: true,
      ...built,
      url: returnUrl,
      urlForDisplay: built.urlRedacted,
      includedAuthToken: built.includedAuthToken,
      warning: built.includedAuthToken
        ? "URL enthält Authtoken — nicht öffentlich speichern/teilen."
        : undefined,
    });
  }

  server.registerTool(
    "datasec_build_deeplink_base",
    {
      annotations: ann.read(),
      description: "Deep-Link Basis-URL bauen (Kap. 3.1). Kein Netzwerk.",
      inputSchema: deeplinkAuthFields,
    },
    async ({ includeAuthToken, disableSearch, confirm, extraParams }) => {
      ensureAuthEnv();
      const built = deeplink.buildDeeplinkBase({
        includeAuthToken,
        disableSearch,
        extraParams,
      });
      return finalizeDeeplink(built, includeAuthToken, confirm);
    }
  );

  server.registerTool(
    "datasec_build_deeplink_akte",
    {
      annotations: ann.read(),
      description: "Deep-Link Akte (Kap. 3.2.2). Kein Netzwerk.",
      inputSchema: {
        ...deeplinkAuthFields,
        partnerId: z.string().optional(),
        akte: z.string().optional(),
      },
    },
    async ({ includeAuthToken, disableSearch, confirm, extraParams, partnerId, akte }) => {
      ensureAuthEnv();
      const built = deeplink.buildDeeplinkAkte({
        includeAuthToken,
        disableSearch,
        extraParams,
        partnerId,
        akte,
      });
      return finalizeDeeplink(built, includeAuthToken, confirm);
    }
  );

  server.registerTool(
    "datasec_build_deeplink_search",
    {
      annotations: ann.read(),
      description: "Deep-Link Suche (Kap. 3.2.3). Kein Netzwerk.",
      inputSchema: {
        ...deeplinkAuthFields,
        searchParams: z.record(z.string()).optional(),
      },
    },
    async ({
      includeAuthToken,
      disableSearch,
      confirm,
      extraParams,
      searchParams,
    }) => {
      ensureAuthEnv();
      const built = deeplink.buildDeeplinkSearch({
        includeAuthToken,
        disableSearch,
        extraParams,
        searchParams,
      });
      return finalizeDeeplink(built, includeAuthToken, confirm);
    }
  );

  server.registerTool(
    "datasec_build_deeplink_document_type",
    {
      annotations: ann.read(),
      description: "Deep-Link Belegtyp (Kap. 3.2.4). Kein Netzwerk.",
      inputSchema: {
        ...deeplinkAuthFields,
        documentType: z.string(),
        partnerId: z.string().optional(),
      },
    },
    async ({
      includeAuthToken,
      disableSearch,
      confirm,
      extraParams,
      documentType,
      partnerId,
    }) => {
      ensureAuthEnv();
      const built = deeplink.buildDeeplinkDocumentType({
        includeAuthToken,
        disableSearch,
        extraParams,
        documentType,
        partnerId,
      });
      return finalizeDeeplink(built, includeAuthToken, confirm);
    }
  );

  server.registerTool(
    "datasec_build_deeplink_sammelbenutzer",
    {
      annotations: ann.read(),
      description: "Deep-Link Sammelbenutzer (Kap. 3.2.5). Kein Netzwerk. Admin+confirm für Token.",
      inputSchema: {
        ...deeplinkAuthFields,
        collectiveUser: z.string().optional(),
      },
    },
    async ({
      includeAuthToken,
      disableSearch,
      confirm,
      extraParams,
      collectiveUser,
    }) => {
      ensureAuthEnv();
      const built = deeplink.buildDeeplinkSammelbenutzer({
        includeAuthToken,
        disableSearch,
        extraParams,
        collectiveUser,
      });
      return finalizeDeeplink(built, includeAuthToken, confirm);
    }
  );

  // ── SSO Kap. 4 ─────────────────────────────────────────────────────
  server.registerTool(
    "datasec_sso_status",
    {
      annotations: ann.read(),
      description:
        "SSO-Status laut API-Handbuch Kap. 4: nicht unterstützt in DOKU@WEB V1.7.",
      inputSchema: {},
    },
    async () =>
      textResult({
        ok: false,
        error: "not supported in DOKU@WEB V1.7 docs",
        section: "Kap. 4 DOKU@WEB Single Sign On",
        message:
          "Der DOKU@WEB Single Sign On wird in der im Handbuch angegebenen Version " +
          "von DOKU@WEB noch nicht unterstützt.",
      })
  );

  // ── Bridge Kap. 1 ──────────────────────────────────────────────────
  server.registerTool(
    "datasec_bridge_info",
    {
      annotations: ann.read(),
      description:
        "Bridge-Info (Kap. 1): Share-Folder-Polling. Optional listPath wenn BRIDGE_SHARE_PATH gesetzt. " +
        "Kein Massen-Upload ohne write+confirm (Upload nicht implementiert).",
      inputSchema: {
        listPath: z
          .boolean()
          .optional()
          .describe("Verzeichnis BRIDGE_SHARE_PATH auflisten (max 50)"),
        confirm: confirmSchema,
      },
    },
    async ({ listPath, confirm }) => {
      ensureAuthEnv();
      if (listPath) {
        const blocked = gateWrite(confirm);
        if (blocked) return textResult({ ok: false, error: blocked }, true);
      }
      return textResult(bridgeInfo({ listPath, confirm }));
    }
  );
}
