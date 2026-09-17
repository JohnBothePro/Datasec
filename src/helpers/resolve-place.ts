/**
 * Mandant + address → partner/object candidates.
 *
 * Live path (default): Datasec document index (OBJEKTAKTE / MIETERAKTE).
 * Optional seed in data/address-crosswalk.json is override/bootstrap only.
 * Same file is a writable cache (not an ops-owned seed).
 * getPartnerId is NOT used (not an address search).
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as documents from "../documents.js";
import type { DocRestResult } from "../documents.js";
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
  extractSwenr,
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
  source: "seed" | "crosswalk" | "document_index" | "memory_cache" | "disk_cache";
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
  source?: "seed" | "live_cache";
  cachedAt?: string;
}

export interface DocumentLiveCfg {
  enabled: boolean;
  document_types: string[];
  /** Candidate names only — live path intersects with getDocumentTypeStructure. */
  street_fields: string[];
  house_fields: string[];
  partner_fields: string[];
  mandant_fields: string[];
  objekt_fields: string[];
  swenr_fields: string[];
  max_types: number;
  max_per_type: number;
}

export interface AddressSearchDeps {
  searchByDocumentType?: typeof documents.searchByDocumentType;
  getDocumentTypeStructure?: typeof documents.getDocumentTypeStructure;
  seedEntries?: CrosswalkEntry[];
  persistCache?: boolean;
  now?: () => number;
}

interface CrosswalkFile {
  version?: number;
  schema_notes?: string[];
  ops_still_needed?: string[];
  cache?: {
    ttl_ms?: number;
    memory_ttl_ms?: number;
    invalidation?: string;
  };
  document_index_live?: DocumentLiveCfg;
  document_index_fallback?: DocumentLiveCfg;
  seed_entries?: CrosswalkEntry[];
  entries: CrosswalkEntry[];
}

const DEFAULT_LIVE: DocumentLiveCfg = {
  enabled: true,
  document_types: ["OBJEKTAKTE", "MIETERAKTE"],
  street_fields: ["STREET", "GE_STREET", "STRASSE", "STR"],
  house_fields: ["HAUSNR", "HOUSENO", "HSNR", "HAUSNUMMER", "HOUSE"],
  partner_fields: ["PARTNERID", "PARTNER", "MIETERID"],
  mandant_fields: ["MANDANT", "MANDANTID", "FIRMA"],
  objekt_fields: ["OBJEKTID", "OBJEKT", "WE", "WENR"],
  swenr_fields: ["SWENR", "WENR", "WE_NR"],
  max_types: SPEED.LIVE_RESOLVE_MAX_TYPES,
  max_per_type: SPEED.LIVE_RESOLVE_MAX_PER_TYPE,
};

const NO_STREET_FIELDS_WARNING =
  "Datasec-Index hat keine Straßenfelder; Adresse kann so nicht aufgelöst werden; bitte PARTNERID / Ticketnr / SWENR.";

const STRUCTURE_SKIP = new Set([
  "ITEM",
  "FIELD",
  "FIELDS",
  "NAME",
  "TRUE",
  "FALSE",
  "INDEX",
  "DOCUMENT",
  "TYPE",
  "DOCUMENTTYPE",
]);

let cachedFile: CrosswalkFile | null = null;
const memoryCache = new Map<string, { hits: AddressHit[]; at: number }>();
const structureCache = new Map<string, { fields: Set<string>; at: number }>();

function nowMs(deps?: AddressSearchDeps): number {
  return deps?.now ? deps.now() : Date.now();
}

function cacheFilePath(): string {
  return process.env.DATASEC_ADDRESS_CACHE_PATH?.trim() || repoFile("data/address-crosswalk.json");
}

export function loadCrosswalk(force = false): CrosswalkFile {
  if (cachedFile && !force) return cachedFile;
  const path = cacheFilePath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as CrosswalkFile;
  const live = {
    ...DEFAULT_LIVE,
    ...(raw.document_index_live ?? raw.document_index_fallback ?? {}),
  };
  cachedFile = {
    version: raw.version,
    schema_notes: raw.schema_notes,
    ops_still_needed: raw.ops_still_needed,
    cache: raw.cache,
    document_index_live: live,
    document_index_fallback: live,
    seed_entries: Array.isArray(raw.seed_entries) ? raw.seed_entries : [],
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
  return cachedFile;
}

export function crosswalkStats(): { path: string; entryCount: number; empty: boolean } {
  const file = loadCrosswalk();
  const seeds = seedEntriesOf(file);
  return {
    path: cacheFilePath(),
    entryCount: seeds.length + file.entries.length,
    empty: seeds.length === 0 && file.entries.length === 0,
  };
}

function seedEntriesOf(file: CrosswalkFile): CrosswalkEntry[] {
  const marked = file.seed_entries ?? [];
  const legacy = file.entries.filter((e) => !e.cachedAt && e.source !== "live_cache");
  return [...marked, ...legacy];
}

function diskCacheEntriesOf(file: CrosswalkFile, now: number): CrosswalkEntry[] {
  const ttl = file.cache?.ttl_ms ?? SPEED.ADDRESS_DISK_TTL_MS;
  return file.entries.filter((e) => {
    if (e.source !== "live_cache" && !e.cachedAt) return false;
    if (!e.cachedAt) return true;
    const age = now - Date.parse(e.cachedAt);
    return Number.isFinite(age) && age >= 0 && age < ttl;
  });
}

export function resetAddressCachesForTests(): void {
  cachedFile = null;
  memoryCache.clear();
  structureCache.clear();
}

/** Index field names from getDocumentTypeStructure XML/JSON. */
export function parseStructureFieldNames(text: string): string[] {
  const names = new Set<string>();
  const add = (v: string | undefined) => {
    const t = String(v ?? "").trim();
    if (!t || t.length > 64) return;
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(t)) return;
    const up = t.toUpperCase();
    if (STRUCTURE_SKIP.has(up)) return;
    names.add(up);
  };

  if (!text?.trim()) return [];

  try {
    const json = JSON.parse(text) as unknown;
    const walk = (node: unknown, hint = ""): void => {
      if (node == null) return;
      if (typeof node === "string") {
        if (/field|index|spalte|name/i.test(hint)) add(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const x of node) walk(x, hint);
        return;
      }
      if (typeof node === "object") {
        const o = node as Record<string, unknown>;
        const direct =
          o.name ?? o.NAME ?? o.field ?? o.FIELD ?? o.id ?? o.ID ?? o.indexField ?? o.INDEXFIELD;
        if (typeof direct === "string") add(direct);
        for (const [k, v] of Object.entries(o)) {
          if (/field|index|name|spalte/i.test(k)) walk(v, k);
        }
      }
    };
    walk(json);
  } catch {
    /* XML / non-JSON */
  }

  const attrRe = /(?:name|field|indexfield|id)="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(text)) !== null) add(m[1]);

  const tagRe = /<(?:field|indexfield|name|column)\b[^>]*>([^<]+)<\//gi;
  while ((m = tagRe.exec(text)) !== null) add(m[1]);

  return [...names];
}

function firstKnown(candidates: string[], available: Set<string>): string | undefined {
  return candidates.find((c) => available.has(c.toUpperCase()));
}

function knownList(candidates: string[], available: Set<string>): string[] {
  return candidates.filter((c) => available.has(c.toUpperCase()));
}

export interface ResolvePlaceInput {
  query?: string;
  mandant?: string;
  street?: string;
  houseNumbers?: string[] | string;
  city?: string;
  weNr?: string;
  partnerIds?: string[];
  /** @deprecated use liveResolve; false skips Datasec (tests / offline). */
  allowDocumentFallback?: boolean;
  /** Default true: resolve via Datasec APIs. Seed is override only. */
  liveResolve?: boolean;
  deps?: AddressSearchDeps;
}

export function shouldLiveResolve(input: {
  liveResolve?: boolean;
  allowDocumentFallback?: boolean;
}): boolean {
  if (input.liveResolve !== undefined) return input.liveResolve;
  if (input.allowDocumentFallback !== undefined) return input.allowDocumentFallback;
  return true;
}

function entryHouseNos(e: CrosswalkEntry): string[] {
  const raw = [...(e.houseNos ?? []), ...(e.houseNo ? [e.houseNo] : [])];
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

function hitFromEntry(
  e: CrosswalkEntry,
  partnerId: string,
  score: number,
  source: AddressHit["source"]
): AddressHit {
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
    source,
  };
}

function hitsFromEntries(
  entries: CrosswalkEntry[],
  norm: { mandant?: string; street?: string; houseNumbers: string[]; weNr?: string },
  source: AddressHit["source"]
): AddressHit[] {
  const hits: AddressHit[] = [];
  for (const e of entries) {
    if (norm.weNr && e.weNr && String(e.weNr) !== String(norm.weNr)) continue;
    const score = matchScore(e, norm.mandant, norm.street, norm.houseNumbers);
    if (score == null) continue;
    const pids = entryPartnerIds(e);
    if (!pids.length) {
      hits.push(hitFromEntry(e, "", score, source));
      continue;
    }
    for (const pid of pids) hits.push(hitFromEntry(e, pid, score, source));
  }
  return hits;
}

function parseIndexRecords(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const blockRe =
    /<(?:item|record|document|row|index)\b([^>]*)>([\s\S]*?)<\/(?:item|record|document|row|index)>/gi;
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

function pickField(row: Record<string, string>, fields: string[]): string | undefined {
  return fields.map((f) => row[f.toUpperCase()]).find(Boolean);
}

function memoryKey(norm: {
  mandant?: string;
  street?: string;
  houseNumbers: string[];
  weNr?: string;
}): string {
  const houses = [...norm.houseNumbers].map(houseKey).sort().join(",");
  return `${norm.mandant ?? ""}|${norm.street ? streetKey(norm.street) : ""}|${houses}|${norm.weNr ?? ""}`;
}

function persistLiveHits(hits: AddressHit[], deps?: AddressSearchDeps): void {
  if (deps?.persistCache === false) return;
  try {
    const file = loadCrosswalk(true);
    const path = cacheFilePath();
    const raw = JSON.parse(readFileSync(path, "utf8")) as CrosswalkFile;
    const stamp = new Date(nowMs(deps)).toISOString();
    const fresh: CrosswalkEntry[] = hits
      .filter((h) => h.partnerId || h.objektId)
      .map((h) => ({
        mandantId: h.mandantId,
        street: h.street,
        houseNo: h.houseNo,
        objektId: h.objektId,
        weNr: h.weNr,
        partnerId: h.partnerId,
        partner: h.partner,
        label: h.label,
        source: "live_cache" as const,
        cachedAt: stamp,
      }));
    const keepSeeds = (raw.seed_entries ?? []).filter((e) => e.source !== "live_cache");
    const oldCache = (raw.entries ?? []).filter((e) => {
      if (e.source !== "live_cache" && !e.cachedAt) return true;
      if (!e.cachedAt) return false;
      const age = nowMs(deps) - Date.parse(e.cachedAt);
      return Number.isFinite(age) && age < (file.cache?.ttl_ms ?? SPEED.ADDRESS_DISK_TTL_MS);
    });
    raw.entries = [...oldCache, ...fresh];
    raw.seed_entries = keepSeeds;
    raw.version = raw.version ?? 2;
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    cachedFile = null;
  } catch {
    /* cache write is best-effort; live result still returned */
  }
}

async function structureFieldsForType(
  documentType: string,
  tracker: CallTracker,
  deps?: AddressSearchDeps
): Promise<{ fields: Set<string>; warning?: string }> {
  const now = nowMs(deps);
  const hit = structureCache.get(documentType);
  if (hit && now - hit.at < SPEED.CATALOG_TTL_MS) {
    return { fields: hit.fields };
  }

  const load =
    deps?.getDocumentTypeStructure ?? documents.getDocumentTypeStructure.bind(documents);
  try {
    const res = await tracker.track(
      "get_document_type_structure",
      () => load(documentType, { timeoutMs: SPEED.FALLBACK_TIMEOUT_MS }),
      documentType
    );
    if (!res.ok) {
      return {
        fields: new Set(),
        warning: `Struktur ${documentType} nicht lesbar (${res.error ?? `HTTP ${res.httpStatus}`}) — keine unbekannten Indexfelder senden.`,
      };
    }
    const fields = new Set(parseStructureFieldNames(res.text ?? ""));
    structureCache.set(documentType, { fields, at: now });
    return { fields };
  } catch (e) {
    return {
      fields: new Set(),
      warning: `Struktur ${documentType} abgebrochen (${e instanceof Error ? e.message : String(e)}) — keine unbekannten Indexfelder senden.`,
    };
  }
}

async function liveDocumentResolve(
  input: { mandant?: string; street?: string; houseNumbers: string[]; weNr?: string },
  cfg: DocumentLiveCfg,
  tracker: CallTracker,
  deps?: AddressSearchDeps
): Promise<{ hits: AddressHit[]; warnings: string[] }> {
  const warnings: string[] = [];
  const hits: AddressHit[] = [];
  const types = cfg.document_types.slice(0, cfg.max_types || SPEED.LIVE_RESOLVE_MAX_TYPES);
  if (!types.length) {
    warnings.push("Live-Adresse: keine Belegtypen konfiguriert (OBJEKTAKTE/MIETERAKTE).");
    return { hits, warnings };
  }

  const search =
    deps?.searchByDocumentType ?? documents.searchByDocumentType.bind(documents);

  let skippedNoStreetFields = false;

  for (const documentType of types) {
    if (hits.length) break;
    const struct = await structureFieldsForType(documentType, tracker, deps);
    if (struct.warning) warnings.push(struct.warning);

    const streetField = input.street
      ? firstKnown(cfg.street_fields, struct.fields)
      : undefined;
    const swenrField = input.weNr
      ? firstKnown(cfg.swenr_fields, struct.fields)
      : undefined;
    const mandantField = input.mandant
      ? firstKnown(cfg.mandant_fields, struct.fields)
      : undefined;

    const filters: RestFilter[] = [];
    if (streetField && input.street) {
      filters.push({ field: streetField, op: "like", val: `*${input.street}*`, con: "AND" });
    }
    if (swenrField && input.weNr) {
      filters.push({ field: swenrField, op: "=", val: input.weNr, con: "AND" });
    }
    if (mandantField && input.mandant) {
      filters.push({ field: mandantField, op: "=", val: input.mandant });
    }

    if (!filters.length) {
      skippedNoStreetFields = true;
      continue;
    }
    if (!streetField && !swenrField) {
      skippedNoStreetFields = true;
      continue;
    }

    let res: DocRestResult;
    try {
      res = await tracker.track(
        "search_by_document_type",
        () =>
          search({
            documentType,
            start: 1,
            max: Math.min(cfg.max_per_type, SPEED.LIVE_RESOLVE_MAX_PER_TYPE),
            filters,
            timeoutMs: SPEED.FALLBACK_TIMEOUT_MS,
          }),
        documentType
      );
    } catch (e) {
      warnings.push(
        `Live-Adresse ${documentType} abgebrochen (${e instanceof Error ? e.message : String(e)}) — Teilresultat, kein Hänger.`
      );
      continue;
    }
    if (!res.ok) {
      warnings.push(
        `Live-Adresse ${documentType} fehlgeschlagen/Timeout (${res.error ?? `HTTP ${res.httpStatus}`}) — Teilresultat, kein Hänger.`
      );
      continue;
    }
    const rows = parseIndexRecords(res.text ?? "");
    const streetPick = knownList(cfg.street_fields, struct.fields);
    const housePick = knownList(cfg.house_fields, struct.fields);
    for (const row of rows) {
      const streetVal = pickField(row, streetPick.length ? streetPick : cfg.street_fields);
      const houseVal = pickField(row, housePick.length ? housePick : cfg.house_fields);
      if (input.houseNumbers.length && houseVal) {
        const rowHouses = parseHouseNumbers(houseVal);
        const ok = input.houseNumbers.some((h) => rowHouses.includes(houseKey(h)));
        if (!ok) continue;
      }
      const partnerId = pickField(row, cfg.partner_fields);
      const objektId = pickField(row, cfg.objekt_fields) ?? pickField(row, cfg.swenr_fields);
      const mandantId = pickField(row, cfg.mandant_fields) ?? input.mandant;
      hits.push({
        mandantId,
        street: streetVal ?? input.street ?? "",
        houseNo: houseVal,
        objektId,
        weNr: pickField(row, cfg.swenr_fields) ?? input.weNr,
        partnerId,
        label: [documentType, streetVal ?? input.street, houseVal, input.weNr, partnerId]
          .filter(Boolean)
          .join(" · "),
        score:
          (houseVal && input.houseNumbers.length) || input.weNr ? 0.85 : 0.65,
        source: "document_index",
      });
    }
  }

  if (skippedNoStreetFields && !hits.length) {
    warnings.push(NO_STREET_FIELDS_WARNING);
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
    weNr: input.weNr?.trim() || extractSwenr(input.query ?? "") || undefined,
    parsedFromQuery: fromQuery,
  };
}

function finishHits(
  hits: AddressHit[],
  extras: {
    norm: ReturnType<typeof normalizeResolveInput>;
    source: string;
    warnings: string[];
    ambiguities: Ambiguity[];
    tracker: CallTracker;
    liveUsed: string;
    stats: { entryCount: number; empty: boolean };
  }
): HelperEnvelope {
  hits.sort((a, b) => b.score - a.score);
  const partnerIds = [
    ...new Set(hits.map((h) => h.partnerId).filter((x): x is string => Boolean(x))),
  ];

  if (partnerIds.length > MAX_PARTNERS) {
    extras.ambiguities.push({
      candidate: partnerIds,
      why: `Mehr als ${MAX_PARTNERS} Partner — bitte eingrenzen (Hausnr/WE).`,
      score: 0.4,
    });
  }

  if (partnerIds.length > 1) {
    extras.ambiguities.push({
      candidate: hits.slice(0, 12),
      why: "Mehrere Partner zur Adresse — kein stilles Picken.",
      score: 0.5,
    });
  }

  return okEnvelope(
    { hits, partnerIds: partnerIds.slice(0, MAX_PARTNERS) },
    {
      resolution: {
        mandant: extras.norm.mandant ?? null,
        street: extras.norm.street ?? null,
        houseNumbers: extras.norm.houseNumbers,
        weNr: extras.norm.weNr ?? null,
        source: extras.source,
        crosswalkEntries: extras.stats.entryCount,
        getPartnerId: "not_used",
        streetAsKeyword: false,
        speed: {
          maxPartners: MAX_PARTNERS,
          documentFallback: extras.liveUsed,
          liveResolve: extras.liveUsed !== "skipped",
          memoryTtlMs: SPEED.ADDRESS_MEMORY_TTL_MS,
          diskTtlMs: SPEED.ADDRESS_DISK_TTL_MS,
        },
      },
      ambiguities: extras.ambiguities,
      warnings: extras.warnings,
      raw_calls: extras.tracker.calls,
    }
  );
}

export async function resolvePlace(input: ResolvePlaceInput): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  const ambiguities: Ambiguity[] = [];
  const deps = input.deps;

  try {
    if (input.partnerIds?.length) {
      const hits: AddressHit[] = input.partnerIds.map((id) => ({
        street: input.street ?? "",
        partnerId: id,
        label: `Partner ${id}`,
        score: 1,
        source: "seed",
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
    const live = shouldLiveResolve(input);
    const memTtl = file.cache?.memory_ttl_ms ?? SPEED.ADDRESS_MEMORY_TTL_MS;
    const key = memoryKey(norm);

    const mem = memoryCache.get(key);
    if (mem && nowMs(deps) - mem.at < memTtl) {
      return finishHits(mem.hits.map((h) => ({ ...h, source: "memory_cache" })), {
        norm,
        source: "memory_cache",
        warnings,
        ambiguities,
        tracker,
        liveUsed: "cached",
        stats,
      });
    }

    const seeds = deps?.seedEntries ?? seedEntriesOf(file);
    const seedHits = hitsFromEntries(seeds, norm, "seed");
    if (seedHits.length) {
      memoryCache.set(key, { hits: seedHits, at: nowMs(deps) });
      return finishHits(seedHits, {
        norm,
        source: "seed",
        warnings,
        ambiguities,
        tracker,
        liveUsed: "skipped",
        stats,
      });
    }

    const diskHits = hitsFromEntries(diskCacheEntriesOf(file, nowMs(deps)), norm, "disk_cache");
    if (diskHits.length) {
      memoryCache.set(key, { hits: diskHits, at: nowMs(deps) });
      return finishHits(diskHits, {
        norm,
        source: "disk_cache",
        warnings,
        ambiguities,
        tracker,
        liveUsed: "cached",
        stats,
      });
    }

    if (live && (norm.street || norm.weNr)) {
      const cfg = file.document_index_live ?? DEFAULT_LIVE;
      const fb = await liveDocumentResolve(
        {
          mandant: norm.mandant,
          street: norm.street,
          houseNumbers: norm.houseNumbers,
          weNr: norm.weNr,
        },
        cfg.enabled === false ? { ...cfg, document_types: [] } : cfg,
        tracker,
        deps
      );
      warnings.push(...fb.warnings);
      if (fb.hits.length) {
        memoryCache.set(key, { hits: fb.hits, at: nowMs(deps) });
        persistLiveHits(fb.hits, deps);
        return finishHits(fb.hits, {
          norm,
          source: "document_index",
          warnings,
          ambiguities,
          tracker,
          liveUsed: "document_index",
          stats,
        });
      }
      if (!fb.warnings.length) {
        warnings.push(
          "Live-Adresse: keine Partner im Document-Index (OBJEKTAKTE/MIETERAKTE). Straße wird nicht als Ticket-KEYWORD verwendet."
        );
      }
    } else if (!live && (norm.street || norm.weNr)) {
      if (stats.empty) {
        warnings.push(
          `Adress-Crosswalk ist leer (${stats.path}). Live-Resolve ist aus (liveResolve:false). ` +
            "Straße kann nicht in die Ticket-KEYWORD-Suche. getPartnerId ist keine Adresssuche."
        );
      } else {
        warnings.push(
          "Keine Partner aus Seed/Cache. Live-Resolve ist aus — keine Datasec-Suche."
        );
      }
    } else if (!norm.street && !norm.weNr) {
      warnings.push("Keine Straße oder SWENR erkannt — Adressauflösung übersprungen.");
    }

    return finishHits([], {
      norm,
      source: live ? "no_match" : stats.empty ? "empty_crosswalk" : "no_match",
      warnings,
      ambiguities,
      tracker,
      liveUsed: live ? "document_index" : "skipped",
      stats,
    });
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
      resolution: { getPartnerId: "not_used", streetAsKeyword: false },
    });
  }
}
