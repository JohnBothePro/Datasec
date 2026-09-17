/**
 * Register all Datasec MCP tools on an McpServer instance.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { session, STATE_CODES, type DatasecEnvName } from "./client.js";
import * as rest from "./rest.js";
import * as soap from "./soap.js";
import {
  assertCanUseEnv,
  authPublic,
  canUseEnv,
  canWrite,
  firstAllowedEnv,
  getAuth,
} from "./auth.js";
import { registerExtendedTools, EXTENDED_TOOL_NAMES } from "./tools-extended.js";
import {
  HELPER_TOOL_NAMES,
  registerHelperTools,
} from "./helpers/register-helpers.js";
import { ann } from "./tool-annotations.js";

function textResult(data: unknown, isError = false) {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

/**
 * If HTTP auth restricts envs and session.env is not allowed,
 * auto-switch to the first allowed env for this key.
 */
function ensureAuthEnv(): void {
  const auth = getAuth();
  if (!auth) return;
  if (canUseEnv(session.env, auth)) return;
  const first = firstAllowedEnv(auth);
  if (first) {
    session.setEnv(first);
  }
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
      "Zum Aktivieren: DATASEC_WRITES_ENABLED=true setzen und Server neu starten." +
      (auth?.role === "read"
        ? " (Hinweis: read-Keys können Writes nicht aktivieren.)"
        : "")
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


function normalizeState(code: string): string {
  const key = code.trim().toUpperCase().replace(/\s+/g, "_");
  return STATE_CODES[key] ?? code.trim();
}

const filterSchema = z.object({
  field: z
    .string()
    .describe(
      "Index-Feld: TICKETNR, KEYWORD, SUBJECT, PARTNERID, S.STATE, LOGIN, CREATE_ON, …"
    ),
  op: z
    .string()
    .optional()
    .describe("Operator: =, !=, like, notlike, … (Default =)"),
  val: z.string().describe("Suchwert"),
  con: z
    .enum(["AND", "OR", "and", "or"])
    .optional()
    .describe("Verknüpfung zum nächsten Filter (Default AND)"),
});

export function registerTools(server: McpServer): void {
  // ── Meta ──────────────────────────────────────────────────────────
  server.registerTool(
    "datasec_status",
    {
      annotations: ann.read(),
      description:
        "Aktuelle Datasec-Session: Umgebung (test/prod), Writes aktiv?, Token geladen? (ohne Secret), REST/SOAP-Bases.",
      inputSchema: {},
    },
    async () => {
      ensureAuthEnv();
      const status = session.status();
      const auth = authPublic();
      if (auth) {
        return textResult({ ...status, auth });
      }
      return textResult(status);
    }
  );

  server.registerTool(
    "datasec_set_env",
    {
      annotations: ann.write(),
      description:
        "Wechselt die Datasec-Umgebung für diese Session (test|prod). Vor Schreibzugriffen in Prod Freigabe einholen.",
      inputSchema: {
        env: z.enum(["test", "prod"]).describe("Zielumgebung"),
      },
    },
    async ({ env }) => {
      ensureAuthEnv();
      try {
        assertCanUseEnv(env);
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
      session.setEnv(env as DatasecEnvName);
      const status = session.status();
      const auth = authPublic();
      return textResult({
        ok: true,
        message: `Umgebung auf ${env} gesetzt`,
        status: auth ? { ...status, auth } : status,
      });
    }
  );

  // ── Read ──────────────────────────────────────────────────────────
  server.registerTool(
    "datasec_search_tickets",
    {
      annotations: ann.read(),
      description:
        "Tickets suchen (REST) — NUR für Listen/Filter wenn ticketnr UNBEKANNT. " +
        "Bei bekannter Ticketnummer (z.B. 32-260907-Q0009) NIEMALS nutzen → datasec_get_ticket. " +
        "Einmal aufrufen dann stoppen; Notizen/Links/Historie danach NICHT ketten außer explizit verlangt. " +
        "Default max 10. Optional: state (S.STATE), keyword, postkorb (LOGIN), partnerId, Freitext-Filter via field_count.",
      inputSchema: {
        start: z.number().int().min(1).optional().describe("Startindex (Default 1)"),
        max: z.number().int().min(1).max(50).optional().describe("Max Treffer (Default 10; für Speed klein halten)"),
        state: z.string().optional().describe("Filter S.STATE (UI-Text, z.B. Offen, Geschlossen)"),
        keyword: z.string().optional().describe("Filter KEYWORD"),
        postkorb: z.string().optional().describe("Filter LOGIN (Postkorb-Name)"),
        partnerId: z.string().optional().describe("Filter PARTNERID"),
        subjectLike: z.string().optional().describe("SUBJECT like (Platzhalter * erlaubt)"),
        ticketnr: z.string().optional().describe("Filter TICKETNR exakt"),
        filters: z
          .array(filterSchema)
          .optional()
          .describe("Zusätzliche field_count-Filter"),
        sort: z.string().optional().describe("Sortierfeld (Default create_on)"),
        dir: z.enum(["asc", "desc"]).optional().describe("Sortierrichtung"),
      },
    },
    async (args) => {
      ensureAuthEnv();
      try {
        const filters: rest.RestFilter[] = [...(args.filters ?? [])];
        if (args.state) filters.push({ field: "S.STATE", op: "=", val: args.state });
        if (args.keyword) filters.push({ field: "KEYWORD", op: "=", val: args.keyword });
        if (args.postkorb) filters.push({ field: "LOGIN", op: "=", val: args.postkorb });
        if (args.partnerId) filters.push({ field: "PARTNERID", op: "=", val: args.partnerId });
        if (args.subjectLike)
          filters.push({ field: "SUBJECT", op: "like", val: args.subjectLike });
        if (args.ticketnr) filters.push({ field: "TICKETNR", op: "=", val: args.ticketnr });

        // chain connectors for convenience filters
        for (let i = 0; i < filters.length - 1; i++) {
          if (!filters[i].con) filters[i].con = "AND";
        }

        const result = await rest.searchTickets({
          start: args.start,
          max: args.max,
          sort: args.sort,
          dir: args.dir,
          filters,
        });
        return textResult({
          env: session.env,
          action: "search_tickets",
          ...result,
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_get_ticket",
    {
      annotations: ann.read(),
      description:
        "ERSTE WAHL wenn der User eine Ticketnummer / ticketnr nennt (Format z.B. 32-260907-Q0009). " +
        "Parameter: ticketnr (NICHT ticketid). NICHT zuerst datasec_search_tickets aufrufen — direkt dieses Tool. " +
        "Lädt ein Ticket per ticketnr (REST-Liste + optional Detail).",
      inputSchema: {
        ticketnr: z.string().describe("Sprechende Ticketnummer, z.B. 32-260727-Q0001"),
      },
    },
    async ({ ticketnr }) => {
      ensureAuthEnv();
      try {
        const result = await rest.getTicketByNr(ticketnr);
        return textResult({
          env: session.env,
          action: "get_ticket",
          ticketnr,
          ...result,
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_get_notes",
    {
      annotations: ann.read(),
      description: "Ticket-Notizen per SOAP getTicketNotes. Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        ticketnr: z.string().describe("Ticketnummer"),
        filter: z.string().optional().describe("Optionaler sFilter"),
      },
    },
    async ({ ticketnr, filter }) => {
      ensureAuthEnv();
      try {
        const result = await soap.getTicketNotes(ticketnr, filter ?? "");
        return textResult({
          env: session.env,
          action: "get_notes",
          ticketnr,
          ok: result.ok,
          httpStatus: result.httpStatus,
          success: result.success,
          errorText: result.errorText,
          infoText: result.infoText,
          data: result.json,
          returnText: result.returnText,
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_get_links",
    {
      annotations: ann.read(),
      description:
        "Verknüpfte Tickets: SOAP getLinkedTickets (braucht ticketid). " +
        "Falls nur ticketnr gegeben: zuerst REST-Lookup. Fallback: Hinweis wenn API fehlschlägt. Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        ticketnr: z.string().optional().describe("Ticketnummer (wird zu ticketid aufgelöst)"),
        ticketid: z.string().optional().describe("Interne Ticket-ID (bevorzugt)"),
      },
    },
    async ({ ticketnr, ticketid }) => {
      ensureAuthEnv();
      try {
        let id = ticketid;
        let resolvedNr = ticketnr;
        if (!id && ticketnr) {
          const t = await rest.getTicketByNr(ticketnr);
          if (!t.ok || !t.ticket?.ticketid) {
            return textResult(
              {
                ok: false,
                env: session.env,
                action: "get_links",
                error:
                  t.error ??
                  "ticketid konnte nicht aufgelöst werden — bitte ticketid direkt angeben",
              },
              true
            );
          }
          id = t.ticket.ticketid;
          resolvedNr = t.ticket.ticketnr ?? ticketnr;
        }
        if (!id) {
          return textResult(
            {
              ok: false,
              error: "ticketid oder ticketnr erforderlich",
            },
            true
          );
        }
        const result = await soap.getLinkedTickets(id);
        return textResult({
          env: session.env,
          action: "get_links",
          ticketnr: resolvedNr,
          ticketid: id,
          ok: result.ok,
          httpStatus: result.httpStatus,
          success: result.success,
          errorText: result.errorText,
          data: result.json,
          returnText: result.returnText,
          note:
            "API: getLinkedTickets (sTicketid). Unlink nur in der UI (kein API-Unlink gefunden).",
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_get_state_history",
    {
      annotations: ann.read(),
      description:
        "Statushistorie per SOAP getTicketsStatesHist (Datumsbereich YYYY-MM-DD HH:MM:SS). " +
        "Optional nach ticketid filtern (clientseitig). Nur nach expliziter User-Nachfrage / nicht vorsorglich nach Ticket-Lookup.",
      inputSchema: {
        dateFrom: z
          .string()
          .describe("Startdatum YYYY-MM-DD oder YYYY-MM-DD HH:MM:SS"),
        dateTo: z
          .string()
          .describe("Enddatum YYYY-MM-DD oder YYYY-MM-DD HH:MM:SS"),
        ticketid: z
          .string()
          .optional()
          .describe("Optional: nur Einträge dieser TICKETID zurückgeben"),
      },
    },
    async ({ dateFrom, dateTo, ticketid }) => {
      ensureAuthEnv();
      try {
        const from = dateFrom.length <= 10 ? `${dateFrom} 00:00:00` : dateFrom;
        const to = dateTo.length <= 10 ? `${dateTo} 23:59:59` : dateTo;
        const result = await soap.getTicketsStatesHist(from, to);
        let data = result.json;
        if (ticketid && data && typeof data === "object") {
          const o = data as Record<string, unknown>;
          const arr = (o.DATA ?? o.data) as unknown;
          if (Array.isArray(arr)) {
            const filtered = arr.filter((row) => {
              if (!row || typeof row !== "object") return false;
              const r = row as Record<string, unknown>;
              return String(r.TICKETID ?? r.ticketid ?? "") === ticketid;
            });
            data = { ...o, DATA: filtered, _filteredByTicketid: ticketid };
          }
        }
        return textResult({
          env: session.env,
          action: "get_state_history",
          dateFrom: from,
          dateTo: to,
          ticketid: ticketid ?? null,
          ok: result.ok,
          httpStatus: result.httpStatus,
          success: result.success,
          errorText: result.errorText,
          data,
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  // ── Write ─────────────────────────────────────────────────────────
  server.registerTool(
    "datasec_add_note",
    {
      annotations: ann.write(),
      description:
        "Notiz hinzufügen (SOAP addTicketNote). Optional vorher getTicketNotes für Duplikat-Warnung. " +
        "Benötigt confirm:true wenn DATASEC_REQUIRE_CONFIRM=true.",
      inputSchema: {
        ticketnr: z.string().describe("Ticketnummer"),
        note: z.string().min(1).describe("Notiztext"),
        checkDuplicates: z
          .boolean()
          .optional()
          .describe("Vorab Notizen laden und ähnliche warnen (Default true)"),
        confirm: z
          .boolean()
          .optional()
          .describe("Muss true sein wenn Confirm-Gate aktiv"),
      },
    },
    async ({ ticketnr, note, checkDuplicates, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);

      try {
        let duplicateWarning: string | null = null;
        if (checkDuplicates !== false) {
          const existing = await soap.getTicketNotes(ticketnr);
          const blob =
            (existing.returnText ?? "") +
            JSON.stringify(existing.json ?? "");
          const snippet = note.trim().slice(0, 80);
          if (snippet.length >= 8 && blob.includes(snippet)) {
            duplicateWarning =
              "Mögliche Duplikat-Notiz: ähnlicher Text bereits vorhanden (checkDuplicates).";
          }
        }

        const result = await soap.addTicketNote(ticketnr, note);
        return textResult({
          env: session.env,
          action: "add_note",
          ticketnr,
          noteLength: note.length,
          duplicateWarning,
          ok: result.ok,
          httpStatus: result.httpStatus,
          success: result.success,
          errorText: result.errorText,
          infoText: result.infoText,
          data: result.json,
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_set_state",
    {
      annotations: ann.write(),
      description:
        "Ticket-Status setzen (SOAP setTicketState). Codes z.B. CLOSED (= Geschlossen). " +
        "Benötigt confirm:true wenn Confirm-Gate aktiv.",
      inputSchema: {
        ticketnr: z.string().describe("Ticketnummer"),
        state: z
          .string()
          .describe("sNewState Code, z.B. CLOSED, STATE_REMINDER, WAIT_EXTERNAL"),
        notice: z.string().optional().describe("Optional sNotice"),
        param: z
          .string()
          .optional()
          .describe("Optional sParam (JSON-String für Reminder etc.)"),
        confirm: z.boolean().optional().describe("Muss true sein wenn Confirm-Gate aktiv"),
      },
    },
    async ({ ticketnr, state, notice, param, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);

      try {
        const newState = normalizeState(state);
        const result = await soap.setTicketState(ticketnr, newState, {
          notice,
          param,
        });
        return textResult({
          env: session.env,
          action: "set_state",
          ticketnr,
          requestedState: state,
          appliedState: newState,
          ok: result.ok,
          httpStatus: result.httpStatus,
          success: result.success,
          errorText: result.errorText,
          infoText: result.infoText,
          data: result.json,
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_link_tickets",
    {
      annotations: ann.write(),
      description:
        "Zwei Tickets verknüpfen (SOAP linkTicketToTicket). Kein Master-Link. " +
        "Playbook: Inhalt/Mieter/Schlagworte prüfen vor dem Link. confirm:true nötig bei Confirm-Gate.",
      inputSchema: {
        ticketnr: z.string().describe("Ausgangsticket"),
        linkTicketNr: z.string().describe("Ziel-Ticket zum Verknüpfen"),
        confirm: z.boolean().optional().describe("Muss true sein wenn Confirm-Gate aktiv"),
      },
    },
    async ({ ticketnr, linkTicketNr, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);

      try {
        const result = await soap.linkTicketToTicket(ticketnr, linkTicketNr);
        return textResult({
          env: session.env,
          action: "link_tickets",
          ticketnr,
          linkTicketNr,
          ok: result.ok,
          httpStatus: result.httpStatus,
          success: result.success,
          errorText: result.errorText,
          infoText: result.infoText,
          data: result.json,
          note: "linkTicketToMaster wird bewusst nicht genutzt. Unlink nur in UI.",
        });
      } catch (e) {
        return textResult(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          true
        );
      }
    }
  );

  server.registerTool(
    "datasec_send_ticket_mail",
    {
      annotations: ann.write(),
      description:
        "Ticket-Mail senden — in der DOKU@WEB-API (Stand 2026-09) wurde keine Methode " +
        "sendTicketMail/sendMail gefunden. Tool gibt klaren Stub-Hinweis zurück.",
      inputSchema: {
        ticketnr: z.string().describe("Ticketnummer"),
        to: z.string().optional().describe("Empfänger (falls Endpoint später verfügbar)"),
        subject: z.string().optional().describe("Betreff"),
        body: z.string().optional().describe("Mailtext"),
        confirm: z.boolean().optional().describe("Muss true sein wenn Confirm-Gate aktiv"),
      },
    },
    async ({ ticketnr, to, subject, body, confirm }) => {
      ensureAuthEnv();
      const blocked = gateWrite(confirm);
      if (blocked) return textResult({ ok: false, error: blocked }, true);

      return textResult(
        {
          ok: false,
          env: session.env,
          action: "send_ticket_mail",
          ticketnr,
          requested: { to: to ?? null, subject: subject ?? null, bodyLength: body?.length ?? 0 },
          error:
            "Nicht verfügbar: In datasec_api.txt / datasec-api.txt gibt es keine Methode " +
            "sendTicketMail oder sendMail am Tickets.cfc. Bitte Mail über die Datasec-UI senden " +
            "oder Endpoint nachliefern.",
          availableAlternatives: [
            "forwardTicket (SOAP) — Weiterleitung, kein freier Mailversand",
            "UI: Ticket öffnen → Mail-Funktion",
          ],
        },
        true
      );
    }
  );

  registerExtendedTools(server);
  registerHelperTools(server);
}

export function createDatasecServer(): McpServer {
  const server = new McpServer({
    name: "datasec-mcp",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

export const CORE_TOOL_NAMES = [
  "datasec_status",
  "datasec_set_env",
  "datasec_search_tickets",
  "datasec_get_ticket",
  "datasec_get_notes",
  "datasec_get_links",
  "datasec_get_state_history",
  "datasec_add_note",
  "datasec_set_state",
  "datasec_link_tickets",
  "datasec_send_ticket_mail",
] as const;

/** All tool names for docs / smoke checks. */
export const TOOL_NAMES = [
  ...CORE_TOOL_NAMES,
  ...EXTENDED_TOOL_NAMES,
  ...HELPER_TOOL_NAMES,
];
