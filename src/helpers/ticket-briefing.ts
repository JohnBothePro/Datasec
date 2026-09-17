/**
 * One-call ticket briefing: ticket + optional notes/links/history/attachments.
 * Attachments: TICKETANLAGEN + TICKETID only (never TICKETARCHIV).
 */
import * as documents from "../documents.js";
import * as rest from "../rest.js";
import * as soap from "../soap.js";
import {
  CallTracker,
  failEnvelope,
  okEnvelope,
  type HelperEnvelope,
} from "./envelope.js";

export type BriefingInclude =
  | "notes"
  | "links"
  | "history"
  | "attachments"
  | "process_buttons"
  | "chat";

export interface BriefingInput {
  ticketnr: string;
  include?: BriefingInclude[];
  historyFrom?: string;
  historyTo?: string;
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  return { from: fmt(from), to: fmt(to) };
}

export async function ticketBriefing(
  input: BriefingInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  const include = new Set(input.include ?? []);

  try {
    const found = await tracker.track("get_ticket", () =>
      rest.getTicketByNr(input.ticketnr)
    );
    if (!found.ok || !found.ticket) {
      return failEnvelope(found.error ?? `Ticket ${input.ticketnr} nicht gefunden`, {
        raw_calls: tracker.calls,
        resolution: { ticketnr: input.ticketnr },
      });
    }

    const ticket = found.ticket;
    const ticketid = ticket.ticketid;
    const sections: Record<string, unknown> = { ticket };

    if (include.has("notes")) {
      const notes = await tracker.track("get_notes", () =>
        soap.getTicketNotes(input.ticketnr)
      );
      sections.notes = {
        ok: notes.ok,
        errorText: notes.errorText,
        data: notes.json,
      };
      if (!notes.ok) warnings.push(`Notizen: ${notes.errorText ?? "Fehler"}`);
    }

    if (include.has("links")) {
      if (!ticketid) {
        warnings.push("Links: keine ticketid — getLinkedTickets übersprungen.");
        sections.links = { ok: false, error: "ticketid fehlt" };
      } else {
        const links = await tracker.track("get_links", () =>
          soap.getLinkedTickets(ticketid)
        );
        sections.links = {
          ok: links.ok,
          errorText: links.errorText,
          data: links.json,
        };
        if (!links.ok) warnings.push(`Links: ${links.errorText ?? "Fehler"}`);
      }
    }

    if (include.has("history")) {
      const range = {
        from: input.historyFrom ?? defaultRange().from,
        to: input.historyTo ?? defaultRange().to,
      };
      const from = range.from.length <= 10 ? `${range.from} 00:00:00` : range.from;
      const to = range.to.length <= 10 ? `${range.to} 23:59:59` : range.to;
      const hist = await tracker.track("get_state_history", () =>
        soap.getTicketsStatesHist(from, to)
      );
      let data = hist.json;
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
      sections.history = {
        ok: hist.ok,
        dateFrom: from,
        dateTo: to,
        errorText: hist.errorText,
        data,
      };
      if (!hist.ok) warnings.push(`Historie: ${hist.errorText ?? "Fehler"}`);
    }

    if (include.has("attachments")) {
      if (!ticketid) {
        warnings.push(
          "Anlagen: TICKETANLAGEN braucht TICKETID (nicht TICKETNR). ticketid fehlt."
        );
        sections.attachments = { ok: false, error: "ticketid fehlt" };
      } else {
        const att = await tracker.track(
          "search_by_document_type",
          () =>
            documents.searchByDocumentType({
              documentType: "TICKETANLAGEN",
              start: 1,
              max: 10,
              filters: [{ field: "TICKETID", op: "=", val: ticketid }],
            }),
          "TICKETANLAGEN"
        );
        sections.attachments = {
          ok: att.ok,
          httpStatus: att.httpStatus,
          error: att.error,
          documentType: "TICKETANLAGEN",
          filterField: "TICKETID",
          body: att.isBinary ? undefined : att.text,
          note:
            att.httpStatus === 404
              ? "404 = keine Anlagen (kein Fehler der Suche)."
              : "TICKETARCHIV wird bewusst nicht genutzt.",
        };
        if (!att.ok && att.httpStatus !== 404) {
          warnings.push(`Anlagen TICKETANLAGEN: ${att.error ?? `HTTP ${att.httpStatus}`}`);
        }
      }
    }

    if (include.has("process_buttons")) {
      const buttons = await tracker.track("get_process_buttons", () =>
        soap.getTicketProcessButtons(input.ticketnr)
      );
      sections.process_buttons = {
        ok: buttons.ok,
        errorText: buttons.errorText,
        data: buttons.json,
      };
    }

    if (include.has("chat")) {
      const range = defaultRange();
      const chat = await tracker.track("get_latest_chat_messages", () =>
        soap.getNewTicketChatNotes(
          `${range.from} 00:00:00`,
          `${range.to} 23:59:59`,
          input.ticketnr
        )
      );
      sections.chat = {
        ok: chat.ok,
        errorText: chat.errorText,
        data: chat.json,
      };
    }

    return okEnvelope(sections, {
      resolution: {
        ticketnr: input.ticketnr,
        ticketid: ticketid ?? null,
        include: [...include],
        attachmentsVia: include.has("attachments") ? "TICKETANLAGEN+TICKETID" : null,
        ticketarchiv: false,
      },
      warnings,
      raw_calls: tracker.calls,
    });
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
      resolution: { ticketnr: input.ticketnr },
    });
  }
}
