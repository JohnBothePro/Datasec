/**
 * Mandant + address → partner/object candidates.
 * Primary: data/address-crosswalk.json
 * Optional: document-index fallback (OBJEKTAKTE/MIETERAKTE).
 * getPartnerId is NOT used (not an address search).
 */
import { readFileSync } from "node:fs";
import * as documents from "../documents.js";
import type { RestFilter } from "../rest.js";
import {
  CallTracker,
  failEnvelope,
  okEnvelope,
  repoFile,
  type Ambiguity,
  type HelperEnvelope,
} from "./envelope.js";
import {
  houseKey,
  parseAddressFromText,
  parseHouseNumbers,
  streetKey,
  type ParsedAddress,
} from "./normalize.js";
import { SPEED } from "./speed.js";

export const MAX_PARTNERS = SPEED.MAX_PARTNERS;

export interface AddressHit {
  mandantId?: string;
  street: string;
  houseNo?: string;
  unit?: string;
  objektId?: string;
  weNr?: string;
  partnerId?: string;
  partner?: string;
  label: string;
  score: number;
  source: "crosswalk" | "document_index";
}

export interface CrosswalkEntry {
  mandantId?: string;
  street?: string;
  houseNo?: string;
  houseNos?: string[];
  unit?: string;
  city?: string;
  zip?: string;
  objektId?: string;
  weNr?: string;
  partnerId?: string;
  partnerIds?: string[];
  partner?: string;
  label?: string;
}

export interface DocumentFallbackCfg {
  enabled: boolean;
  document_types: string[];
  street_fields: string[];
  house_fields: string[];
  partner_fields: string[];
  mandant_fields: string[];
  objekt_fields: string[];
  max_types: number;
  max_per_type: number;
}

interface CrosswalkFile {
  version?: number;
  schema_notes?: string[];
  ops_still_needed?: string[];
  document_index_fallback?: DocumentFallbackCfg;
  entries: CrosswalkEntry[];
}

let cachedFile: CrosswalkFile | null = null;

const DEFAULT_FALLBACK: DocumentFallbackCfg = {
  enabled: false,
  document_types: ["OBJEKTAKTE"],
  street_fields: ["STREET", "GE_STREET", "STRASSE"],
  house_fields: ["HAUSNR", "HOUSENO", "HSNR", "HAUSNUMMER"],
  partner_fields: ["PARTNERID", "PARTNER", "MIETERID"],
  mandant_fields: ["MANDANT", "MANDANTID", "FIRMA"],
  objekt_fields: ["OBJEKTID", "OBJEKT", "WE", "WENR"],
  max_types: 1,
  max_per_type: 5,
};

export function loadCrosswalk(force = false): CrosswalkFile {
  if (cachedFile && !force) return cachedFile;
  const path = repoFile("data/address-crosswalk.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as CrosswalkFile;
  cachedFile = {
    version: raw.version,
    schema_notes: raw.schema_notes,
    ops_still_needed: raw.ops_still_needed,
    document_index_fallback: {
      ...DEFAULT_FALLBACK,
      ...(raw.document_index_fallback ?? {}),
    },
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
  return cachedFile;
}

export function crosswalkStats(): { path: string; entryCount: number; empty: boolean } {
  const file = loadCrosswalk();
  return {
    path: repoFile("data/address-crosswalk.json"),
    entryCount: file.entries.length,
    empty: file.entries.length === 0,
  };
}

export interface ResolvePlaceInput {
  query?: string;
  mandant?: string;
  street?: string;
  houseNumbers?: string[] | string;
  city?: string;
  weNr?: string;
  partnerIds?: string[];
  allowDocumentFallback?: boolean;
}

function entryHouseNos(e: CrosswalkEntry): string[] {
  const raw = [
    ...(e.houseNos ?? []),
    ...(e.houseNo ? [e.houseNo] : []),
  ];
  return raw.flatMap((h) => parseHouseNumbers(String(h)));
}

function entryPartnerIds(e: CrosswalkEntry): string[] {
  const ids = [...(e.partnerIds ?? [])];
  if (e.partnerId) ids.push(e.partnerId);
  return [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
}

function matchScore(
  e: CrosswalkEntry,
  mandant: string | undefined,
  street: string | undefined,
  houses: string[]
): number | null {
  if (mandant && e.mandantId && String(e.mandantId) !== String(mandant)) {
    return null;
  }
  if (street && e.street && streetKey(e.street) !== streetKey(street)) {
    return null;
  }
  if (street && !e.street) return null;

  const eHouses = entryHouseNos(e);
  if (houses.length && eHouses.length) {
    const hit = houses.some((h) => eHouses.includes(houseKey(h)));
    if (!hit) return null;
    return mandant && e.mandantId ? 1 : 0.9;
  }
  if (houses.length && !eHouses.length) return 0.55;
  if (!houses.length && street) return 0.6;
  if (mandant && !street) return 0.35;
  return street || mandant ? 0.4 : null;
}

function hitFromEntry(e: CrosswalkEntry, partnerId: string, score: number): AddressHit {
  const house = e.houseNo ?? e.houseNos?.[0];
  return {
    mandantId: e.mandantId,
    street: e.street ?? "",
    houseNo: house,
    unit: e.unit,
    objektId: e.objektId,
    weNr: e.weNr,
    partnerId,
    partner: e.partner,
    label:
      e.label ??
      [e.street, house, e.mandantId ? `Mandant ${e.mandantId}` : "", partnerId]
        .filter(Boolean)
        .join(" · "),
    score,
    source: "crosswalk",
  };
}

function parseIndexRecords(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const blockRe = /<(?:item|record|document|row|index)\b([^>]*)>([\s\S]*?)<\/(?:item|record|document|row|index)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const row: Record<string, string> = {};
    const attrRe = /([a-zA-Z0-9_.:-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[1])) !== null) row[am[1].toUpperCase()] = am[2];
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
      if (Array.isArray(json)) {
        for (const x of json) {
          if (x && typeof x === "object") {
            const row: Record<string, string> = {};
            for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
              if (v != null) row[k.toUpperCase()] = String(v);
            }
            rows.push(row);
          }
        }
      }
    } catch {
      /* not json */
    }
  }
  return rows;
}

async function documentFallback(
  input: {
    mandant?: string;
    street: string;
    houseNumbers: string[];
  },
  cfg: DocumentFallbackCfg,
  tracker: CallTracker
): Promise<{ hits: AddressHit[]; warnings: string[] }> {
  const warnings: string[] = [];
  const hits: AddressHit[] = [];
  const types = cfg.document_types.slice(0, 1);
  if (!types.length) {
    warnings.push("Document-Index-Fallback: keine Belegtypen konfiguriert.");
    return { hits, warnings };
  }

  const documentType = types[0];
  warnings.push(
    `Document-Index-Fallback: genau eine gezielte Suche (${documentType}, ${SPEED.FALLBACK_TIMEOUT_MS}ms). Crosswalk bevorzugen.`
  );
  {
    const streetField = cfg.street_fields[0];
    const filters: RestFilter[] = [
      { field: streetField, op: "like", val: `*${input.street}*`, con: "AND" },
    ];
    if (input.mandant && cfg.mandant_fields[0]) {
      filters.push({
        field: cfg.mandant_fields[0],
        op: "=",
        val: input.mandant,
      });
    }
    const res = await tracker.track(
      "search_by_document_type",
      () =>
        documents.searchByDocumentType({
          documentType,
          start: 1,
          max: Math.min(cfg.max_per_type, 5),
          filters,
          timeoutMs: SPEED.FALLBACK_TIMEOUT_MS,
        }),
      documentType
    );
    if (!res.ok) {
      warnings.push(
        `Document-Index-Fallback ${documentType} abgebrochen/fehlgeschlagen (${res.error ?? `HTTP ${res.httpStatus}`}) — Teilresultat, kein Hänger.`
      );
      return { hits, warnings };
    }
    const rows = parseIndexRecords(res.text ?? "");
    for (const row of rows) {
      const streetVal = cfg.street_fields
        .map((f) => row[f.toUpperCase()])
        .find(Boolean);
      const houseVal = cfg.house_fields
        .map((f) => row[f.toUpperCase()])
        .find(Boolean);
      if (input.houseNumbers.length && houseVal) {
        const rowHouses = parseHouseNumbers(houseVal);
        const ok = input.houseNumbers.some((h) => rowHouses.includes(houseKey(h)));
        if (!ok) continue;
      }
      const partnerId = cfg.partner_fields
        .map((f) => row[f.toUpperCase()])
        .find(Boolean);
      const objektId = cfg.objekt_fields
        .map((f) => row[f.toUpperCase()])
        .find(Boolean);
      hits.push({
        mandantId: input.mandant,
        street: streetVal ?? input.street,
        houseNo: houseVal,
        objektId,
        partnerId,
        label: [documentType, streetVal ?? input.street, houseVal, partnerId]
          .filter(Boolean)
          .join(" · "),
        score: 0.7,
        source: "document_index",
      });
    }
  }
  return { hits, warnings };
}

export function normalizeResolveInput(input: ResolvePlaceInput): {
  mandant?: string;
  street?: string;
  houseNumbers: string[];
  weNr?: string;
  parsedFromQuery?: ParsedAddress;
} {
  const fromQuery = input.query ? parseAddressFromText(input.query) : undefined;
  let houseNumbers: string[] = [];
  if (typeof input.houseNumbers === "string") {
    houseNumbers = parseHouseNumbers(input.houseNumbers);
  } else if (Array.isArray(input.houseNumbers)) {
    houseNumbers = input.houseNumbers.flatMap((h) => parseHouseNumbers(String(h)));
  }
  if (!houseNumbers.length && fromQuery?.houseNumbers.length) {
    houseNumbers = fromQuery.houseNumbers;
  }
  return {
    mandant: input.mandant?.trim() || undefined,
    street: input.street?.trim() || fromQuery?.street,
    houseNumbers,
    weNr: input.weNr?.trim() || undefined,
    parsedFromQuery: fromQuery,
  };
}

export async function resolvePlace(
  input: ResolvePlaceInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  const ambiguities: Ambiguity[] = [];

  try {
    if (input.partnerIds?.length) {
      const hits: AddressHit[] = input.partnerIds.map((id) => ({
        street: input.street ?? "",
        partnerId: id,
        label: `Partner ${id}`,
        score: 1,
        source: "crosswalk",
      }));
      return okEnvelope(
        { hits, partnerIds: input.partnerIds.slice(0, MAX_PARTNERS) },
        {
          resolution: { source: "explicit_partner_ids", skippedCrosswalk: true },
          warnings: [
            "partner_ids übergeben — Crosswalk/Adresssuche übersprungen. getPartnerId wurde nicht aufgerufen.",
          ],
          raw_calls: tracker.calls,
        }
      );
    }

    const file = loadCrosswalk();
    const norm = normalizeResolveInput(input);
    const stats = crosswalkStats();

    if (stats.empty) {
      warnings.push(
        `Adress-Crosswalk ist leer (${stats.path}). Straße kann nicht in die Ticket-KEYWORD-Suche. ` +
          "Bitte entries[] aus Wodis-Export oder Objektakten befüllen. " +
          "getPartnerId ist keine Adresssuche und wird nicht verwendet."
      );
    }

    const hits: AddressHit[] = [];
    for (const e of file.entries) {
      if (norm.weNr && e.weNr && String(e.weNr) !== String(norm.weNr)) continue;
      const score = matchScore(e, norm.mandant, norm.street, norm.houseNumbers);
      if (score == null) continue;
      const pids = entryPartnerIds(e);
      if (!pids.length) {
        hits.push(hitFromEntry(e, "", score));
        continue;
      }
      for (const pid of pids) hits.push(hitFromEntry(e, pid, score));
    }

    const wantFallback =
      input.allowDocumentFallback === true &&
      Boolean(file.document_index_fallback?.enabled) &&
      Boolean(norm.street) &&
      hits.length === 0;

    if (wantFallback && norm.street) {
      warnings.push(
        "Kein Crosswalk-Treffer — eine gezielte Document-Index-Suche (kurz, Timeout). Nicht getPartnerId."
      );
      const fb = await documentFallback(
        {
          mandant: norm.mandant,
          street: norm.street,
          houseNumbers: norm.houseNumbers,
        },
        file.document_index_fallback ?? DEFAULT_FALLBACK,
        tracker
      );
      hits.push(...fb.hits);
      warnings.push(...fb.warnings);
    } else if (hits.length === 0 && norm.street) {
      warnings.push(
        "Keine Partner aus dem Crosswalk. Live-Document-Crawl ist opt-in " +
          "(allowDocumentFallback:true) und auf eine kurze Suche begrenzt — Happy Path bleibt lokal/schnell."
      );
    }

    hits.sort((a, b) => b.score - a.score);
    const partnerIds = [
      ...new Set(hits.map((h) => h.partnerId).filter((x): x is string => Boolean(x))),
    ];

    if (partnerIds.length > MAX_PARTNERS) {
      ambiguities.push({
        candidate: partnerIds,
        why: `Mehr als ${MAX_PARTNERS} Partner — bitte eingrenzen (Hausnr/WE).`,
        score: 0.4,
      });
    }

    if (partnerIds.length > 1) {
      ambiguities.push({
        candidate: hits.slice(0, 12),
        why: "Mehrere Partner zur Adresse — kein stilles Picken.",
        score: 0.5,
      });
    }

    const capped = partnerIds.slice(0, MAX_PARTNERS);
    return okEnvelope(
      { hits, partnerIds: capped },
      {
        resolution: {
          mandant: norm.mandant ?? null,
          street: norm.street ?? null,
          houseNumbers: norm.houseNumbers,
          weNr: norm.weNr ?? null,
          source: hits.some((h) => h.source === "crosswalk")
            ? "crosswalk"
            : hits.length
              ? "document_index"
              : stats.empty
                ? "empty_crosswalk"
                : "no_match",
          crosswalkEntries: stats.entryCount,
          getPartnerId: "not_used",
          streetAsKeyword: false,
          speed: {
            maxPartners: MAX_PARTNERS,
            documentFallback: wantFallback ? "one_shot" : "skipped",
            preferCrosswalk: true,
          },
        },
        ambiguities,
        warnings,
        raw_calls: tracker.calls,
      }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
      resolution: { getPartnerId: "not_used" },
    });
  }
}
