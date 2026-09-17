/**
 * Guided document search. Ticket attachments: TICKETANLAGEN + TICKETID only.
 */
import * as documents from "../documents.js";
import * as rest from "../rest.js";
import type { RestFilter } from "../rest.js";
import {
  CallTracker,
  envelopeData,
  failEnvelope,
  okEnvelope,
  type HelperEnvelope,
} from "./envelope.js";
import { getCatalog, peekCachedNames } from "./catalog.js";
import { mapDocumentTypes, mapTopic } from "./topic.js";
import { foldGerman } from "./normalize.js";
import { resolvePlace, type ResolvePlaceInput } from "./resolve-place.js";
import { SPEED, clampResults } from "./speed.js";

export interface FindDocumentsInput {
  query?: string;
  documentType?: string;
  ticketnr?: string;
  partnerId?: string;
  mandant?: string;
  street?: string;
  houseNumbers?: ResolvePlaceInput["houseNumbers"];
  filters?: RestFilter[];
  max?: number;
}

const TICKETARCHIV = "TICKETARCHIV";

function pickDocType(query: string | undefined, catalogNames: string[]): {
  types: string[];
  note?: string;
} {
  if (!query) return { types: [] };
  const q = foldGerman(query).toLowerCase();
  if (/anlage|anhang|attachment/.test(q)) {
    return { types: ["TICKETANLAGEN"], note: "Anlagen → TICKETANLAGEN (nie TICKETARCHIV)." };
  }
  const mapped = mapDocumentTypes(query, catalogNames);
  if (mapped.types.length) return { types: mapped.types, note: mapped.note };
  if (/objektakte/.test(q)) return { types: ["OBJEKTAKTE"] };
  if (/mieterakte|mietakte/.test(q)) return { types: ["MIETERAKTE"] };
  if (/mietvertrag/.test(q)) {
    const hits = catalogNames.filter((n) => /miet|vertrag|verm/i.test(n)).slice(0, 3);
    return { types: hits.length ? hits : ["MIETERAKTE"] };
  }
  return { types: catalogNames.slice(0, 0), note: mapped.note };
}

export async function findDocuments(
  input: FindDocumentsInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];

  try {
    if (input.documentType && foldGerman(input.documentType).toUpperCase() === TICKETARCHIV) {
      return failEnvelope(
        "TICKETARCHIV-Suche ist gesperrt (bekannter 404-Bug). Ticket-Anlagen: TICKETANLAGEN + TICKETID.",
        { resolution: { documentType: input.documentType, ticketarchiv: false } }
      );
    }

    let partnerId = input.partnerId?.trim();
    if (
      !partnerId &&
      (input.street || input.mandant || input.houseNumbers)
    ) {
      const resolved = await resolvePlace({
        query: input.query,
        mandant: input.mandant,
        street: input.street,
        houseNumbers: input.houseNumbers,
      });
      warnings.push(...(resolved.warnings ?? []));
      if (resolved.raw_calls) tracker.calls.push(...resolved.raw_calls);
      const pids = envelopeData<{ partnerIds: string[] }>(resolved)?.partnerIds ?? [];
      if (pids.length > 1) {
        return okEnvelope(
          { documents: [], types: [], partnerIds: pids },
          {
            resolution: {
              query: input.query ?? null,
              address: resolved.resolution,
              ticketarchiv: false,
            },
            ambiguities: resolved.ambiguities,
            warnings: [
              ...warnings,
              "Mehrere Partner zur Adresse — kein stilles Picken. Partner wählen oder datasec_h_resolve.",
            ],
            raw_calls: tracker.calls,
          }
        );
      }
      partnerId = pids[0];
    }

    let ticketid: string | undefined;
    if (input.ticketnr) {
      const t = await tracker.track("get_ticket", () =>
        rest.getTicketByNr(input.ticketnr!, { timeoutMs: SPEED.CALL_TIMEOUT_MS })
      );
      ticketid = t.ticket?.ticketid;
      if (!ticketid) {
        warnings.push(
          `ticketid zu ${input.ticketnr} nicht auflösbar — TICKETANLAGEN-Filter nicht möglich.`
        );
      }
    }

    const knownType = Boolean(input.documentType) ||
      /anlage|anhang/i.test(input.query ?? "") ||
      Boolean(input.ticketnr);

    let catalogNames: string[] = [];
    if (!knownType) {
      const catalog = await getCatalog("doc_types", input.query);
      if (catalog.raw_calls) tracker.calls.push(...catalog.raw_calls);
      catalogNames =
        (
          catalog.data as { items?: Array<{ name: string }> } | null
        )?.items?.map((i) => i.name) ?? peekCachedNames("doc_types");
    }

    const mapped = input.documentType
      ? { types: [input.documentType], note: "explizit" }
      : pickDocType(input.query, catalogNames);

    let types = mapped.types.filter(
      (t) => foldGerman(t).toUpperCase() !== TICKETARCHIV
    );

    if (input.ticketnr || /anlage|anhang/i.test(input.query ?? "")) {
      types = ["TICKETANLAGEN"];
    }

    if (!types.length) {
      warnings.push(
        "Kein Belegtyp gemappt. datasec_h_catalog(kind='doc_types') nutzen oder documentType setzen."
      );
      return okEnvelope(
        { documents: [], types: [] },
        {
          resolution: {
            query: input.query ?? null,
            topic: mapTopic(input.query),
            ticketarchiv: false,
          },
          warnings,
          raw_calls: tracker.calls,
        }
      );
    }

    const max = clampResults(input.max);
    const results: Array<Record<string, unknown>> = [];

    for (const documentType of types.slice(0, 1)) {
      const filters: RestFilter[] = [...(input.filters ?? [])];
      if (documentType.toUpperCase() === "TICKETANLAGEN") {
        if (ticketid) {
          filters.push({ field: "TICKETID", op: "=", val: ticketid });
        } else {
          warnings.push(
            "TICKETANLAGEN ohne TICKETID übersprungen (nicht TICKETNR, nicht TICKETARCHIV)."
          );
          continue;
        }
      } else if (partnerId) {
        filters.push({ field: "PARTNERID", op: "=", val: partnerId });
      } else if (input.street && /OBJEKT|MIETER/i.test(documentType)) {
        filters.push({ field: "STREET", op: "like", val: `*${input.street}*` });
      }
      for (let i = 0; i < filters.length - 1; i++) {
        if (!filters[i].con) filters[i].con = "AND";
      }

      const res = await tracker.track(
        "search_by_document_type",
        () =>
          documents.searchByDocumentType({
            documentType,
            start: 1,
            max,
            filters,
            timeoutMs: SPEED.CALL_TIMEOUT_MS,
          }),
        documentType
      );
      results.push({
        documentType,
        ok: res.ok,
        httpStatus: res.httpStatus,
        error: res.error,
        body: res.isBinary ? undefined : res.text?.slice(0, 4000),
      });
      if (!res.ok && res.httpStatus !== 404) {
        warnings.push(`${documentType}: ${res.error ?? `HTTP ${res.httpStatus}`}`);
      }
    }

    return okEnvelope(
      { documents: results, types },
      {
        resolution: {
          query: input.query ?? null,
          types,
          ticketid: ticketid ?? null,
          attachmentsVia: types.includes("TICKETANLAGEN")
            ? "TICKETANLAGEN+TICKETID"
            : null,
          ticketarchiv: false,
          note: mapped.note,
        },
        warnings,
        raw_calls: tracker.calls,
      }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
      resolution: { ticketarchiv: false },
    });
  }
}
