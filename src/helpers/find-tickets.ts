/**
 * resolve place → search_tickets (PARTNERID + KEYWORD/SUBJECT).
 * HARD-NO: never put street into KEYWORD.
 */
import * as rest from "../rest.js";
import type { TicketSummary } from "../rest.js";
import {
  CallTracker,
  envelopeData,
  failEnvelope,
  mergeWarnings,
  okEnvelope,
  type Ambiguity,
  type HelperEnvelope,
} from "./envelope.js";
import { looksLikeStreet, streetKey } from "./normalize.js";
import { mapStatus, mapTopic } from "./topic.js";
import { MAX_PARTNERS, resolvePlace, type ResolvePlaceInput } from "./resolve-place.js";

export const MAX_SEARCH_CALLS = 6;

export interface TicketSearchJob {
  partnerId?: string;
  keyword?: string;
  subjectLike?: string;
  state?: string;
  ticketnr?: string;
}

export interface FindTicketsInput extends ResolvePlaceInput {
  topic?: string;
  keyword?: string;
  status?: string;
  ticketnr?: string;
  limit?: number;
  start?: number;
}

export function assertNotStreetKeyword(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  if (looksLikeStreet(value) || /\d+\s*[a-z]?\s*\/\s*\d+/i.test(value)) {
    throw new Error(
      `HARD-NO: '${field}' sieht nach einer Straße/Hausnr aus (${value}). ` +
        "Straße gehört nicht in KEYWORD. Erst datasec_h_resolve / Crosswalk."
    );
  }
  return value;
}

/**
 * Build search jobs. Street is never copied into keyword.
 * Partner × keyword, capped; subject used only when no exact keyword.
 */
export function buildTicketSearchJobs(opts: {
  partnerIds: string[];
  keywords: string[];
  subjectHints: string[];
  state?: string;
  ticketnr?: string;
}): { jobs: TicketSearchJob[]; warnings: string[] } {
  const warnings: string[] = [];
  const keywords = opts.keywords
    .map((k) => {
      try {
        return assertNotStreetKeyword(k, "keyword");
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : String(e));
        return undefined;
      }
    })
    .filter((k): k is string => Boolean(k));

  if (opts.ticketnr && !opts.partnerIds.length && !keywords.length) {
    return { jobs: [{ ticketnr: opts.ticketnr }], warnings };
  }

  const jobs: TicketSearchJob[] = [];
  const partners = opts.partnerIds.slice(0, MAX_PARTNERS);
  const push = (job: TicketSearchJob) => {
    if (jobs.length >= MAX_SEARCH_CALLS) return;
    jobs.push(job);
  };

  if (partners.length) {
    if (keywords.length) {
      for (const partnerId of partners) {
        for (const keyword of keywords) {
          push({ partnerId, keyword, state: opts.state });
        }
      }
    } else if (opts.subjectHints.length) {
      for (const partnerId of partners) {
        push({ partnerId, subjectLike: opts.subjectHints[0], state: opts.state });
      }
    } else {
      for (const partnerId of partners) {
        push({ partnerId, state: opts.state });
      }
    }
  } else if (keywords.length) {
    for (const keyword of keywords) {
      push({ keyword, state: opts.state });
    }
  } else if (opts.subjectHints.length) {
    push({ subjectLike: opts.subjectHints[0], state: opts.state });
  } else if (opts.ticketnr) {
    push({ ticketnr: opts.ticketnr });
  }

  if (jobs.length >= MAX_SEARCH_CALLS) {
    warnings.push(
      `Fan-out-Deckel: max. ${MAX_SEARCH_CALLS} search_tickets-Calls. Weitere Partner/Keywords weggelassen.`
    );
  }
  if (opts.partnerIds.length > MAX_PARTNERS) {
    warnings.push(
      `Fan-out-Deckel: max. ${MAX_PARTNERS} Partner-IDs. Bitte Adresse/WE eingrenzen.`
    );
  }
  return { jobs, warnings };
}

function ticketKey(t: TicketSummary): string {
  return t.ticketnr || t.ticketid || JSON.stringify(t);
}

function sortTickets(a: TicketSummary, b: TicketSummary): number {
  const da = a.update_on || a.create_on || "";
  const db = b.update_on || b.create_on || "";
  return db.localeCompare(da);
}

export async function findTickets(
  input: FindTicketsInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  const ambiguities: Ambiguity[] = [];

  try {
    const topicText = input.topic ?? input.keyword ?? "";
    if (input.keyword) {
      try {
        assertNotStreetKeyword(input.keyword, "keyword");
      } catch (e) {
        return failEnvelope(e instanceof Error ? e.message : String(e), {
          resolution: { streetAsKeyword: false, rejected: input.keyword },
        });
      }
    }

    const topic = mapTopic(topicText || undefined);
    const status = mapStatus(input.status);
    if (topicText && !topic.matched) {
      warnings.push(
        topic.note ??
          `Thema '${topicText}' nicht im Synonym-Katalog — nur SUBJECT-Hint, nie als Straße.`
      );
    }
    if (input.status && !status.matched) {
      warnings.push(
        `Status '${input.status}' ist kein bekannter Synonym-Wert. ` +
          "Wird 1:1 an S.STATE durchgereicht. datasec_h_catalog(kind='statuses') für Werte."
      );
    }

    const stateForSearch =
      status.matched && status.mapped_to.length === 1
        ? status.mapped_to[0]
        : status.matched
          ? undefined
          : input.status;
    if (status.matched && status.mapped_to.length > 1) {
      warnings.push(
        `Status '${input.status}' gemappt auf ${JSON.stringify(status.mapped_to)} — ` +
          "nicht alle Werte parallel abgefragt (Fan-out). Clientseitig nachfiltern oder engeren Status nennen."
      );
    }

    const needsResolve = Boolean(
      input.mandant ||
        input.street ||
        input.houseNumbers ||
        input.query ||
        input.weNr
    );

    let partnerIds = [...(input.partnerIds ?? [])];
    let resolveEnv: HelperEnvelope | undefined;

    if (needsResolve || (input.query && !partnerIds.length)) {
      resolveEnv = await resolvePlace({
        query: input.query,
        mandant: input.mandant,
        street: input.street,
        houseNumbers: input.houseNumbers,
        weNr: input.weNr,
        partnerIds: input.partnerIds,
      });
      warnings.push(...(resolveEnv.warnings ?? []));
      ambiguities.push(...(resolveEnv.ambiguities ?? []));
      const resolvedIds = envelopeData<{ partnerIds: string[] }>(resolveEnv)?.partnerIds;
      if (resolvedIds?.length) {
        partnerIds = resolvedIds;
      }
      if (resolveEnv.raw_calls) tracker.calls.push(...resolveEnv.raw_calls);
    }

    const { jobs, warnings: jobWarnings } = buildTicketSearchJobs({
      partnerIds,
      keywords: topic.matched ? topic.keywords : input.keyword ? [input.keyword] : [],
      subjectHints: topic.subjectHints,
      state: stateForSearch,
      ticketnr: input.ticketnr,
    });
    warnings.push(...jobWarnings);

    if (!jobs.length) {
      warnings.push(
        "Keine Ticket-Suche ausgeführt: weder Partner noch Keyword/Thema noch Ticketnr. " +
          "Straße wird nicht als KEYWORD verwendet."
      );
      return okEnvelope(
        { tickets: [], jobs },
        {
          resolution: {
            topic,
            status,
            partnerIds,
            streetAsKeyword: false,
            address: resolveEnv?.resolution ?? null,
          },
          ambiguities,
          warnings,
          raw_calls: tracker.calls,
        }
      );
    }

    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const collected: TicketSummary[] = [];
    const seen = new Set<string>();

    const results = await Promise.all(
      jobs.map((job) =>
        tracker.track(
          "search_tickets",
          () => {
            const filters: rest.RestFilter[] = [];
            if (job.state) filters.push({ field: "S.STATE", op: "=", val: job.state });
            if (job.keyword) filters.push({ field: "KEYWORD", op: "=", val: job.keyword });
            if (job.partnerId)
              filters.push({ field: "PARTNERID", op: "=", val: job.partnerId });
            if (job.subjectLike)
              filters.push({ field: "SUBJECT", op: "like", val: job.subjectLike });
            if (job.ticketnr)
              filters.push({ field: "TICKETNR", op: "=", val: job.ticketnr });
            for (let i = 0; i < filters.length - 1; i++) {
              if (!filters[i].con) filters[i].con = "AND";
            }
            return rest.searchTickets({
              start: input.start ?? 1,
              max: limit,
              filters,
            });
          },
          [job.partnerId, job.keyword, job.subjectLike, job.state]
            .filter(Boolean)
            .join(",")
        )
      )
    );

    for (const r of results) {
      if (!r.ok) {
        warnings.push(`search_tickets Teilfehler: ${r.error ?? `HTTP ${r.httpStatus}`}`);
        continue;
      }
      for (const t of r.tickets) {
        const k = ticketKey(t);
        if (seen.has(k)) continue;
        seen.add(k);
        collected.push(t);
      }
    }

    if (status.matched && status.mapped_to.length > 1) {
      const allowed = new Set(status.mapped_to.map((s) => s.toLowerCase()));
      const filtered = collected.filter((t) =>
        t.state ? allowed.has(t.state.toLowerCase()) : true
      );
      if (filtered.length < collected.length) {
        warnings.push(
          `Status-Nachfilter: ${collected.length - filtered.length} Tickets außerhalb ${JSON.stringify(status.mapped_to)} entfernt.`
        );
      }
      collected.length = 0;
      collected.push(...filtered);
    }

    collected.sort(sortTickets);
    const tickets = collected.slice(0, limit);

    return okEnvelope(
      { tickets, jobs },
      {
        resolution: {
          topic,
          status,
          partnerIds,
          jobs,
          streetAsKeyword: false,
          streetKey: input.street ? streetKey(input.street) : null,
          address: resolveEnv?.resolution ?? null,
        },
        ambiguities,
        warnings: mergeWarnings(warnings),
        raw_calls: tracker.calls,
      }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      ambiguities,
      raw_calls: tracker.calls,
      resolution: { streetAsKeyword: false },
    });
  }
}
