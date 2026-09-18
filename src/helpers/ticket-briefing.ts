/**
 * One-call ticket briefing. Default LIGHT (ticket core only).
 * notes/links/history/attachments/attachment_texts ONLY if explicitly requested — never auto-chain.
 * Attachments: TICKETANLAGEN + TICKETID only (never TICKETARCHIV).
 * attachment_texts: optional text extracts (no Base64); attachments stays index-only.
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
import { SPEED } from "./speed.js";

export type BriefingInclude =
  | "notes"
  | "links"
  | "history"
  | "attachments"
  | "attachment_texts"
  | "process_buttons"
  | "chat";

export const ATTACHMENT_TEXT_MAX_ITEMS = 5;
export const ATTACHMENT_TEXT_PREVIEW_CHARS = 4_000;
export const ATTACHMENT_TEXT_TOTAL_CHARS = 20_000;

const INDEX_ID_FIELDS = ["COLLECTID", "DOCUMENTID", "DOCID"];
const INDEX_NAME_FIELDS = ["DATEINAME", "FILENAME", "NAME", "BETREFF", "TITLE"];

export interface BriefingDeps {
  getTicketByNr?: typeof rest.getTicketByNr;
  searchByDocumentType?: typeof documents.searchByDocumentType;
  getDocument?: typeof documents.getDocument;
}

export interface BriefingInput {
  ticketnr: string;
  include?: BriefingInclude[];
  historyFrom?: string;
  historyTo?: string;
  deps?: BriefingDeps;
}

function attrsToRow(attrStr: string): Record<string, string> {
  const row: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9_.:-]+)="([^"]*)"/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(attrStr)) !== null) row[am[1].toUpperCase()] = am[2];
  return row;
}

export function parseAttachmentIndexRows(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const selfRe = /<(?:item|record|document|row|index)\b([^>]*)\/>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = selfRe.exec(text)) !== null) {
    const row = attrsToRow(sm[1]);
    if (Object.keys(row).length) rows.push(row);
  }
  const blockRe =
    /<(?:item|record|document|row|index)\b([^>]*)>([\s\S]*?)<\/(?:item|record|document|row|index)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const row = attrsToRow(m[1]);
    const childRe = /<([a-zA-Z0-9_.:-]+)>([^<]*)<\/\1>/g;
    let cm: RegExpExecArray | null;
    while ((cm = childRe.exec(m[2])) !== null) {
      row[cm[1].toUpperCase()] = cm[2];
    }
    if (Object.keys(row).length) rows.push(row);
  }
  if (!rows.length) {
    try {
      const json = JSON.parse(text) as unknown;
      const arr = Array.isArray(json)
        ? json
        : json && typeof json === "object" && Array.isArray((json as { items?: unknown }).items)
          ? (json as { items: unknown[] }).items
          : [];
      for (const x of arr) {
        if (x && typeof x === "object") {
          const row: Record<string, string> = {};
          for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
            if (v != null) row[k.toUpperCase()] = String(v);
          }
          rows.push(row);
        }
      }
    } catch {
      /* not json */
    }
  }
  return rows;
}

function pickRowField(row: Record<string, string>, fields: string[]): string | undefined {
  return fields.map((f) => row[f]).find((v) => Boolean(v?.trim()));
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
  const getTicket = input.deps?.getTicketByNr ?? rest.getTicketByNr.bind(rest);
  const searchDocs =
    input.deps?.searchByDocumentType ?? documents.searchByDocumentType.bind(documents);
  const getDoc = input.deps?.getDocument ?? documents.getDocument.bind(documents);
  if (include.size === 0) {
    warnings.push(
      "LIGHT: nur Ticket-Kern. notes/links/history/attachments/attachment_texts nur bei explizitem include — kein Auto-Chain."
    );
  }

  try {
    const found = await tracker.track("get_ticket", () =>
      getTicket(input.ticketnr, { timeoutMs: SPEED.CALL_TIMEOUT_MS })
    );
    if (!found.ok || !found.ticket) {
      return failEnvelope(found.error ?? `Ticket ${input.ticketnr} nicht gefunden`, {
        raw_calls: tracker.calls,
        resolution: { ticketnr: input.ticketnr, mode: "light" },
      });
    }

    const ticket = found.ticket;
    const ticketid = ticket.ticketid;
    const sections: Record<string, unknown> = { ticket };

    const extras: Array<Promise<void>> = [];
    const t = SPEED.CALL_TIMEOUT_MS;

    if (include.has("notes")) {
      extras.push(
        (async () => {
          const notes = await tracker.track("get_notes", () =>
            soap.getTicketNotes(input.ticketnr, "", { timeoutMs: t })
          );
          sections.notes = {
            ok: notes.ok,
            errorText: notes.errorText,
            data: notes.json,
          };
          if (!notes.ok) warnings.push(`Notizen: ${notes.errorText ?? "Fehler / Timeout"}`);
        })()
      );
    }

    if (include.has("links")) {
      extras.push(
        (async () => {
          if (!ticketid) {
            warnings.push("Links: keine ticketid — getLinkedTickets übersprungen.");
            sections.links = { ok: false, error: "ticketid fehlt" };
            return;
          }
          const links = await tracker.track("get_links", () =>
            soap.getLinkedTickets(ticketid, { timeoutMs: t })
          );
          sections.links = {
            ok: links.ok,
            errorText: links.errorText,
            data: links.json,
          };
          if (!links.ok) warnings.push(`Links: ${links.errorText ?? "Fehler / Timeout"}`);
        })()
      );
    }

    if (include.has("history")) {
      extras.push(
        (async () => {
          const range = {
            from: input.historyFrom ?? defaultRange().from,
            to: input.historyTo ?? defaultRange().to,
          };
          const from = range.from.length <= 10 ? `${range.from} 00:00:00` : range.from;
          const to = range.to.length <= 10 ? `${range.to} 23:59:59` : range.to;
          const hist = await tracker.track("get_state_history", () =>
            soap.getTicketsStatesHist(from, to, { timeoutMs: t })
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
          if (!hist.ok) warnings.push(`Historie: ${hist.errorText ?? "Fehler / Timeout"}`);
        })()
      );
    }

    let anlagenPromise: Promise<documents.DocRestResult | null> | undefined;
    const loadAnlagen = (): Promise<documents.DocRestResult | null> => {
      if (!anlagenPromise) {
        anlagenPromise = (async () => {
          if (!ticketid) {
            warnings.push(
              "Anlagen: TICKETANLAGEN braucht TICKETID (nicht TICKETNR). ticketid fehlt."
            );
            return null;
          }
          return tracker.track(
            "search_by_document_type",
            () =>
              searchDocs({
                documentType: "TICKETANLAGEN",
                start: 1,
                max: SPEED.MAX_RESULTS,
                filters: [{ field: "TICKETID", op: "=", val: ticketid }],
                timeoutMs: t,
              }),
            "TICKETANLAGEN"
          );
        })();
      }
      return anlagenPromise;
    };

    if (include.has("attachments")) {
      extras.push(
        (async () => {
          const att = await loadAnlagen();
          if (!att) {
            sections.attachments = { ok: false, error: "ticketid fehlt" };
            return;
          }
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
                : "TICKETARCHIV wird bewusst nicht genutzt. Indexliste ohne Bytes.",
          };
          if (!att.ok && att.httpStatus !== 404) {
            warnings.push(`Anlagen TICKETANLAGEN: ${att.error ?? `HTTP ${att.httpStatus}`}`);
          }
        })()
      );
    }

    if (include.has("attachment_texts")) {
      extras.push(
        (async () => {
          const att = await loadAnlagen();
          if (!att) {
            sections.attachment_texts = { ok: false, error: "ticketid fehlt", items: [] };
            return;
          }
          if (!att.ok && att.httpStatus !== 404) {
            sections.attachment_texts = {
              ok: false,
              error: att.error ?? `HTTP ${att.httpStatus}`,
              items: [],
            };
            return;
          }
          const rows = parseAttachmentIndexRows(att.isBinary ? "" : att.text ?? "");
          const wanted = rows.slice(0, ATTACHMENT_TEXT_MAX_ITEMS);
          const omitted = Math.max(0, rows.length - wanted.length);
          const items: Array<Record<string, unknown>> = [];
          let usedChars = 0;
          for (const row of wanted) {
            if (usedChars >= ATTACHMENT_TEXT_TOTAL_CHARS) {
              break;
            }
            const indexField = INDEX_ID_FIELDS.find((f) => row[f]?.trim());
            const indexValue = indexField ? row[indexField] : undefined;
            if (!indexField || !indexValue) {
              warnings.push("Anlage ohne COLLECTID/DOCUMENTID — Text-Extract übersprungen.");
              continue;
            }
            const remaining = ATTACHMENT_TEXT_TOTAL_CHARS - usedChars;
            const cap = Math.min(ATTACHMENT_TEXT_PREVIEW_CHARS, remaining);
            const doc = await tracker.track(
              "get_document",
              () =>
                getDoc({
                  documentType: "TICKETANLAGEN",
                  indexField,
                  indexValue,
                  format: "text",
                  maxTextChars: cap,
                  timeoutMs: t,
                }),
              indexValue
            );
            const rawText = doc.text ?? "";
            const text = rawText.slice(0, cap);
            usedChars += text.length;
            items.push({
              indexField,
              indexValue,
              filename: pickRowField(row, INDEX_NAME_FIELDS) ?? null,
              ok: doc.ok,
              error: doc.error,
              text,
              textChars: doc.textChars ?? text.length,
              textEmpty: doc.textEmpty ?? false,
              extractNote:
                doc.extractNote ?? (doc.ok ? "ok" : "error"),
              truncated: rawText.length > text.length || doc.extractNote === "truncated",
            });
            if (!doc.ok) {
              warnings.push(
                `Anlage ${indexValue}: ${doc.error ?? doc.extractNote ?? "get_document fehlgeschlagen"}`
              );
            } else if (doc.textEmpty) {
              warnings.push(
                `Anlage ${indexValue}: wenig Text (Scan/Foto?) — datasec_get_document format=binary.`
              );
            }
          }
          sections.attachment_texts = {
            ok: true,
            documentType: "TICKETANLAGEN",
            items,
            omitted: omitted + Math.max(0, wanted.length - items.length),
            totalChars: usedChars,
            note:
              "Text-Previews ohne Base64 (kein OCR). Scans/Fotos: datasec_get_document format=binary.",
          };
        })()
      );
    }

    if (include.has("process_buttons")) {
      extras.push(
        (async () => {
          const buttons = await tracker.track("get_process_buttons", () =>
            soap.getTicketProcessButtons(input.ticketnr, { timeoutMs: t })
          );
          sections.process_buttons = {
            ok: buttons.ok,
            errorText: buttons.errorText,
            data: buttons.json,
          };
        })()
      );
    }

    if (include.has("chat")) {
      extras.push(
        (async () => {
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
        })()
      );
    }

    if (extras.length) {
      const settled = await Promise.allSettled(extras);
      for (const s of settled) {
        if (s.status === "rejected") {
          warnings.push(
            `Extra abgebrochen: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`
          );
        }
      }
    }

    return okEnvelope(sections, {
      resolution: {
        ticketnr: input.ticketnr,
        ticketid: ticketid ?? null,
        include: [...include],
        mode: include.size ? "explicit-extras" : "light",
        attachmentsVia:
          include.has("attachments") || include.has("attachment_texts")
            ? "TICKETANLAGEN+TICKETID"
            : null,
        ticketarchiv: false,
        speed: { timeoutMs: t, noAutoChain: true },
      },
      warnings,
      raw_calls: tracker.calls,
    });
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
      resolution: { ticketnr: input.ticketnr, mode: "light" },
    });
  }
}
