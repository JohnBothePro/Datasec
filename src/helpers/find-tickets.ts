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
import { mapStatus, mapTopic, resolveTopicKeywords } from "./topic.js";
import {
  ensureKeywordItems,
  peekCachedKeywordItems,
  type CatalogItem,
} from "./catalog.js";
import {
  MAX_PARTNERS,
  mandantPartnerPrefix,
  resolvePlace,
  type ResolvePlaceInput,
} from "./resolve-place.js";
import { SPEED, budgetExpired, clampResults } from "./speed.js";

export const MAX_SEARCH_CALLS = SPEED.MAX_SEARCH_CALLS;

export interface TicketSearchJob {
  partnerId?: string;
  /** PARTNERID like prefix, e.g. "27." → filter PARTNERID like "27.*" */
  partnerIdPrefix?: string;
  keyword?: string;
  subjectLike?: string;
  state?: string;
  ticketnr?: string;
}

export type SearchStrategy =
  | "partner_ids"
  | "mandant_prefix"
  | "keyword_or_subject"
  | "ticketnr"
  | "none";

/** One strategy only — never partnerIds AND mandant-prefix together. */
export function chooseSearchStrategy(opts: {
  partnerIds: string[];
  partnerPrefix?: string;
  keywords: string[];
  subjectHints: string[];
  ticketnr?: string;
}): SearchStrategy {
  if (opts.partnerIds.length) return "partner_ids";
  if (opts.partnerPrefix) return "mandant_prefix";
  if (opts.keywords.length || opts.subjectHints.length) return "keyword_or_subject";
  if (opts.ticketnr) return "ticketnr";
  return "none";
}

export interface FindTicketsInput extends ResolvePlaceInput {
  topic?: string;
  keyword?: string;
  status?: string;
  ticketnr?: string;
  limit?: number;
  start?: number;
  /** Injected catalog rows (tests). Live path warms getKeywords. */
  catalogItems?: CatalogItem[];
  debug?: boolean;
}

export function assertNotStreetKeyword(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  if (looksLikeStreet(value) || /\d+\s*[a-z]?\s*\/\s*\d+/i.test(value)) {
    throw new Error(
      `HARD-NO: '${field}' sieht nach einer Straße/Hausnr aus (${value}). ` +
        "Straße gehört nicht in KEYWORD. Erst datasec_h_resolve (Live-Adresse / Seed)."
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
  partnerPrefix?: string;
}): { jobs: TicketSearchJob[]; warnings: string[]; strategy: SearchStrategy } {
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

  const strategy = chooseSearchStrategy({
    partnerIds: opts.partnerIds,
    partnerPrefix: opts.partnerPrefix,
    keywords,
    subjectHints: opts.subjectHints,
    ticketnr: opts.ticketnr,
  });

  if (opts.partnerIds.length && opts.partnerPrefix) {
    warnings.push(
      "Eine Suchstrategie: PARTNERID-Liste gewinnt, Mandant-Prefix wird nicht zusätzlich gefächert."
    );
  }

  if (strategy === "ticketnr") {
    return { jobs: [{ ticketnr: opts.ticketnr }], warnings, strategy };
  }

  const jobs: TicketSearchJob[] = [];
  const partners = strategy === "partner_ids" ? opts.partnerIds.slice(0, MAX_PARTNERS) : [];
  const prefix = strategy === "mandant_prefix" ? opts.partnerPrefix : undefined;
  const keywordsCapped = keywords.slice(0, SPEED.MAX_KEYWORDS_PER_SEARCH);
  if (keywords.length > keywordsCapped.length) {
    warnings.push(
      `Speed: nur das erste Keyword (${keywordsCapped[0]}) wird gesucht, nicht ${keywords.length}.`
    );
  }
  const push = (job: TicketSearchJob) => {
    if (jobs.length >= MAX_SEARCH_CALLS) return;
    jobs.push(job);
  };

  const attachTopic = (base: TicketSearchJob) => {
    if (keywordsCapped.length) {
      push({ ...base, keyword: keywordsCapped[0], state: opts.state });
    } else if (opts.subjectHints.length) {
      push({ ...base, subjectLike: opts.subjectHints[0], state: opts.state });
    } else {
      push({ ...base, state: opts.state });
    }
  };

  if (strategy === "partner_ids") {
    for (const partnerId of partners) attachTopic({ partnerId });
  } else if (strategy === "mandant_prefix" && prefix) {
    attachTopic({ partnerIdPrefix: prefix });
  } else if (strategy === "keyword_or_subject") {
    if (keywordsCapped.length) {
      push({ keyword: keywordsCapped[0], state: opts.state });
    } else if (opts.subjectHints.length) {
      push({ subjectLike: opts.subjectHints[0], state: opts.state });
    }
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
  return { jobs, warnings, strategy };
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
  const startedAt = Date.now();
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
        liveResolve: input.liveResolve,
        allowDocumentFallback: input.allowDocumentFallback,
      });
      warnings.push(...(resolveEnv.warnings ?? []));
      ambiguities.push(...(resolveEnv.ambiguities ?? []));
      const resolvedIds = envelopeData<{ partnerIds: string[] }>(resolveEnv)?.partnerIds;
      if (resolvedIds?.length) {
        partnerIds = resolvedIds;
      }
      if (resolveEnv.raw_calls) tracker.calls.push(...resolveEnv.raw_calls);
    }

    const explicitKeyword =
      input.keyword && input.keyword !== topic.label ? [input.keyword] : [];
    let catalogItems = input.catalogItems?.length
      ? input.catalogItems
      : peekCachedKeywordItems();
    if (!catalogItems.length && !input.catalogItems) {
      try {
        catalogItems = await ensureKeywordItems();
      } catch (e) {
        warnings.push(
          `Keyword-Katalog nicht geladen (${e instanceof Error ? e.message : String(e)}) — SUBJECT-Hints.`
        );
      }
    }
    const mappedKw = resolveTopicKeywords(
      topic.matched
        ? { ...topic, keywords: [...topic.keywords, ...explicitKeyword] }
        : { ...topic, keywords: input.keyword ? [input.keyword] : [] },
      catalogItems,
      {
        query: input.query ?? topicText,
        cap: SPEED.MAX_CATEGORY_KEYWORDS,
      }
    );
    warnings.push(...mappedKw.warnings);

    const resolveData = resolveEnv
      ? envelopeData<{
          partnerIds?: string[];
          partnerPrefix?: string | null;
          mode?: string;
        }>(resolveEnv)
      : null;
    const partnerPrefix =
      partnerIds.length
        ? undefined
        : resolveData?.partnerPrefix ??
          (typeof resolveEnv?.resolution?.partnerPrefix === "string"
            ? resolveEnv.resolution.partnerPrefix
            : undefined) ??
          mandantPartnerPrefix(input.mandant);

    const addressAttempted = Boolean(
      input.mandant ||
        input.street ||
        input.houseNumbers ||
        input.weNr ||
        (resolveEnv?.resolution as { street?: string | null } | undefined)?.street
    );
    const streetUnbound = Boolean(
      addressAttempted && !partnerIds.length && (input.street || resolveEnv?.resolution?.street)
    );
    if (addressAttempted && !partnerIds.length && !partnerPrefix) {
      warnings.push(
        "Adresse konnte nicht auf PARTNERID aufgelöst werden. Bitte PARTNERID, Ticketnr oder SWENR angeben."
      );
    } else if (streetUnbound && partnerPrefix) {
      warnings.push(
        `Straße nicht auf ein Objekt gebunden — bounded Suche unter Mandant-Prefix ${partnerPrefix} + Thema.`
      );
    }

    const { jobs, warnings: jobWarnings, strategy } = buildTicketSearchJobs({
      partnerIds,
      partnerPrefix,
      keywords: mappedKw.keywords,
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
            partnerPrefix: partnerPrefix ?? null,
            strategy,
            streetAsKeyword: false,
            address: resolveEnv?.resolution ?? null,
          },
          ambiguities,
          warnings,
          raw_calls: tracker.calls,
        }
      );
    }

    const limit = clampResults(input.limit);
    const collected: TicketSummary[] = [];
    const seen = new Set<string>();

    if (budgetExpired(startedAt)) {
      warnings.push(
        `Zeitbudget ${SPEED.HELPER_BUDGET_MS}ms nach Resolve erschöpft — Ticket-Suche übersprungen (Teilresultat).`
      );
      return okEnvelope(
        { tickets: [], jobs },
        {
          resolution: {
            topic,
            status,
            partnerIds,
            partnerPrefix: partnerPrefix ?? null,
            strategy,
            jobs,
            streetAsKeyword: false,
            speed: { timedOut: true, maxResults: limit },
            address: resolveEnv?.resolution ?? null,
          },
          ambiguities,
          warnings: mergeWarnings(warnings),
          raw_calls: tracker.calls,
        }
      );
    }

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
            if (job.partnerIdPrefix)
              filters.push({
                field: "PARTNERID",
                op: "like",
                val: `${job.partnerIdPrefix}*`,
              });
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
              timeoutMs: SPEED.CALL_TIMEOUT_MS,
            });
          },
          [job.partnerId, job.partnerIdPrefix, job.keyword, job.subjectLike, job.state]
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
          partnerPrefix: partnerPrefix ?? null,
          strategy,
          jobs,
          streetAsKeyword: false,
          streetKey: input.street ? streetKey(input.street) : null,
          address: resolveEnv?.resolution ?? null,
          speed: {
            maxResults: limit,
            maxPartners: MAX_PARTNERS,
            maxSearchCalls: MAX_SEARCH_CALLS,
            elapsedMs: Date.now() - startedAt,
            documentFallback: input.liveResolve !== false,
            liveResolve: input.liveResolve !== false,
          },
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
