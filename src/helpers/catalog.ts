/**
 * Cached keywords / statuses / document types via existing SOAP/REST clients.
 */
import * as documents from "../documents.js";
import * as soap from "../soap.js";
import { STATE_CODES } from "../client.js";
import {
  CallTracker,
  failEnvelope,
  okEnvelope,
  type HelperEnvelope,
} from "./envelope.js";
import { listTopicCatalog } from "./topic.js";
import { collapseWs, foldGerman } from "./normalize.js";
import { SPEED } from "./speed.js";

export type CatalogKind =
  | "keywords"
  | "statuses"
  | "groups"
  | "doc_types"
  | "departments";

interface CacheEntry {
  fetchedAt: number;
  ttlMs: number;
  items: CatalogItem[];
  source: string;
  warning?: string;
}

export interface CatalogItem {
  name: string;
  kind: CatalogKind;
  extra?: Record<string, string>;
}

const cache = new Map<CatalogKind, CacheEntry>();

function ageMs(entry: CacheEntry | undefined): number | null {
  if (!entry) return null;
  return Date.now() - entry.fetchedAt;
}

function filterItems(items: CatalogItem[], filter?: string): CatalogItem[] {
  if (!filter?.trim()) return items;
  const q = foldGerman(filter).toLowerCase();
  return items.filter((it) => {
    const blob = foldGerman(
      `${it.name} ${Object.values(it.extra ?? {}).join(" ")}`
    ).toLowerCase();
    return blob.includes(q);
  });
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickStr(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function walkRows(json: unknown): Record<string, unknown>[] {
  if (!json) return [];
  if (typeof json === "string") {
    const t = json.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return walkRows(JSON.parse(t));
      } catch {
        return [];
      }
    }
    return [];
  }
  if (Array.isArray(json)) {
    if (!json.length) return [];
    if (json.every((x) => Array.isArray(x))) return [];
    return json.flatMap((x) =>
      x && typeof x === "object" && !Array.isArray(x) ? [x as Record<string, unknown>] : []
    );
  }
  const o = asRecord(json);
  if (!o) return [];
  const fromSelf = rowsFromColumnOriented(o);
  if (fromSelf.length) return fromSelf;
  for (const k of ["DATA", "data", "KEYWORDS", "keywords", "ITEMS", "items", "ROWS"]) {
    if (Array.isArray(o[k])) return walkRows(o[k]);
    if (typeof o[k] === "string") {
      const nested = walkRows(o[k]);
      if (nested.length) return nested;
    }
    const inner = asRecord(o[k]);
    if (inner) {
      const fromCols = rowsFromColumnOriented(inner);
      if (fromCols.length) return fromCols;
      const nested = walkRows(inner);
      if (nested.length) return nested;
    }
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      return walkRows(v);
    }
  }
  return [o];
}

/** ColdFusion serializeJSON query: { KEYWORD: [...], CATEGORY: [...] } or COLUMNS + DATA. */
export function rowsFromColumnOriented(o: Record<string, unknown>): Record<string, unknown>[] {
  const columnsRaw = o.COLUMNS ?? o.columns ?? o.ColumnList ?? o.columnList;
  const data = o.DATA ?? o.data;
  if (Array.isArray(columnsRaw) && Array.isArray(data) && data.length && Array.isArray(data[0])) {
    const cols = columnsRaw.map((c) => String(c));
    return (data as unknown[][]).map((row) => {
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        rec[c] = row[i];
      });
      return rec;
    });
  }
  const arrayCols = Object.entries(o).filter(
    ([k, v]) =>
      Array.isArray(v) &&
      v.length > 0 &&
      (typeof v[0] === "string" || typeof v[0] === "number") &&
      /keyword|category|gruppe|group|name|bezeichnung/i.test(k)
  );
  if (!arrayCols.length) return [];
  const len = Math.max(...arrayCols.map(([, v]) => (v as unknown[]).length));
  if (!len || len > 20_000) return [];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < len; i++) {
    const rec: Record<string, unknown> = {};
    for (const [k, v] of arrayCols) rec[k] = (v as unknown[])[i];
    rows.push(rec);
  }
  return rows;
}

function parseKeywordXml(text: string): CatalogItem[] {
  const items: CatalogItem[] = [];
  const selfRe = /<(keyword|item|row)\b([^>]*)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = selfRe.exec(text)) !== null) {
    const name =
      /(?:keyword|name|value)="([^"]+)"/i.exec(m[2])?.[1] ?? "";
    const cat = /(?:category|kategorie)="([^"]+)"/i.exec(m[2])?.[1];
    if (name.trim()) {
      items.push({
        name: collapseWs(name),
        kind: "keywords",
        extra: cat ? { category: cat } : undefined,
      });
    }
  }
  const tagRe = /<(keyword|item|row)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  while ((m = tagRe.exec(text)) !== null) {
    const attrName = /(?:keyword|name|value)="([^"]+)"/i.exec(m[2])?.[1];
    const cat =
      /(?:category|kategorie)="([^"]+)"/i.exec(m[2])?.[1] ??
      /<(?:category|kategorie)>([^<]+)<\//i.exec(m[3])?.[1];
    const innerKw = /<(?:keyword|name)>([^<]+)<\//i.exec(m[3])?.[1];
    const name = collapseWs(attrName ?? innerKw ?? m[3]);
    if (!name || /[<>]/.test(name)) continue;
    items.push({
      name,
      kind: "keywords",
      extra: cat ? { category: collapseWs(cat) } : undefined,
    });
  }
  return uniqueItems(items);
}

function uniqueItems(items: CatalogItem[]): CatalogItem[] {
  const seen = new Set<string>();
  const out: CatalogItem[] = [];
  for (const it of items) {
    const key = `${it.kind}:${foldGerman(it.name).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function parseXmlNamed(text: string, kind: CatalogKind): CatalogItem[] {
  const items: CatalogItem[] = [];
  const tagRe =
    /<(document-type|documenttype|department|type|keyword|item|name)([^>]*)>([^<]*)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const name =
      /(?:name|value|type|id)="([^"]+)"/i.exec(m[2])?.[1] ?? collapseWs(m[3]);
    if (name) items.push({ name, kind });
  }
  const selfRe =
    /<(document-type|documenttype|department|type)\b([^>]*)\/>/gi;
  while ((m = selfRe.exec(text)) !== null) {
    const name = /(?:name|value|type|id)="([^"]+)"/i.exec(m[2])?.[1];
    if (name) items.push({ name, kind });
  }
  return uniqueItems(items);
}

function stamped(
  items: CatalogItem[],
  source: string,
  ok: boolean,
  warning?: string
): CacheEntry {
  return {
    fetchedAt: Date.now(),
    ttlMs: ok && items.length ? SPEED.CATALOG_TTL_MS : SPEED.CATALOG_NEGATIVE_TTL_MS,
    items,
    source,
    warning,
  };
}

function itemsFromKeywordRows(rows: Record<string, unknown>[]): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const row of rows) {
    const name = pickStr(row, ["KEYWORD", "keyword", "NAME", "name", "BEZEICHNUNG"]);
    if (!name) continue;
    const extra: Record<string, string> = {};
    const cat = pickStr(row, ["CATEGORY", "category", "KATEGORIE"]);
    const grp = pickStr(row, ["TICKETGROUP", "GROUP", "group", "GRUPPE"]);
    if (cat) extra.category = cat;
    if (grp) extra.group = grp;
    items.push({ name, kind: "keywords", extra: Object.keys(extra).length ? extra : undefined });
  }
  return items;
}

/**
 * Parse getKeywords SOAP JSON/XML into usable catalog items.
 * Handles ColdFusion column-oriented queries (common SUCCESS=true + empty items bug).
 */
export function parseKeywordCatalog(
  json: unknown,
  returnText?: string | null
): CatalogItem[] {
  const items = itemsFromKeywordRows(walkRows(json));
  if (items.length) return uniqueItems(items);
  const text = typeof returnText === "string" ? returnText : "";
  if (!text.trim()) return [];
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      const fromText = itemsFromKeywordRows(walkRows(JSON.parse(text)));
      if (fromText.length) return uniqueItems(fromText);
    } catch {
      /* fall through to XML */
    }
  }
  const xmlItems = parseKeywordXml(text);
  if (xmlItems.length) return xmlItems;
  return uniqueItems(parseXmlNamed(text, "keywords"));
}

async function loadKeywords(tracker: CallTracker): Promise<CacheEntry> {
  const res = await tracker.track("getKeywords", () =>
    soap.getKeywords("", "", { timeoutMs: SPEED.CATALOG_TIMEOUT_MS })
  );
  const uniq = parseKeywordCatalog(res.json, res.returnText);
  const warning = res.ok
    ? uniq.length
      ? undefined
      : "getKeywords SOAP OK, aber keine KEYWORD-Zeilen geparst — Synonym-Datei bleibt Fallback."
    : res.errorText ??
      "getKeywords Timeout/Fehler — Synonym-Datei bleibt Fallback. Cache kurz, kein Retry-Sturm.";
  return stamped(uniq, "soap.getKeywords", res.ok && uniq.length > 0, warning);
}

async function loadDocTypes(tracker: CallTracker): Promise<CacheEntry> {
  const res = await tracker.track("listDocumentTypes", () =>
    documents.listDocumentTypes({ timeoutMs: SPEED.CATALOG_TIMEOUT_MS })
  );
  let items: CatalogItem[] = [];
  const text = res.text ?? "";
  try {
    const json = JSON.parse(text) as unknown;
    for (const row of walkRows(json)) {
      const name = pickStr(row, [
        "NAME",
        "name",
        "TYPE",
        "type",
        "DOCUMENTTYPE",
        "documentType",
      ]);
      if (name) items.push({ name, kind: "doc_types" });
    }
  } catch {
    items = parseXmlNamed(text, "doc_types");
  }
  const fromSyn = listTopicCatalog().document_types ?? [];
  for (const d of fromSyn) {
    for (const name of d.types) {
      items.push({ name, kind: "doc_types", extra: { id: d.id, source: "topic-synonyms" } });
    }
  }
  const uniq = uniqueItems(items);
  return stamped(
    uniq,
    res.ok && uniq.some((i) => i.extra?.source !== "topic-synonyms")
      ? "documents.listDocumentTypes + topic-synonyms"
      : "topic-synonyms (live listDocumentTypes leer/Fehler)",
    res.ok || uniq.length > 0,
    res.ok ? undefined : res.error ?? "listDocumentTypes Timeout/Fehler — Synonym-Belegtypen als Fallback."
  );
}

async function loadDepartments(tracker: CallTracker): Promise<CacheEntry> {
  const res = await tracker.track("listDepartments", () =>
    documents.listDepartments({ timeoutMs: SPEED.CATALOG_TIMEOUT_MS })
  );
  let items: CatalogItem[] = [];
  const text = res.text ?? "";
  try {
    const json = JSON.parse(text) as unknown;
    for (const row of walkRows(json)) {
      const name = pickStr(row, ["NAME", "name", "DEPARTMENT", "ABTEILUNG"]);
      if (name) items.push({ name, kind: "departments" });
    }
  } catch {
    items = parseXmlNamed(text, "departments");
  }
  return stamped(
    uniqueItems(items),
    "documents.listDepartments",
    res.ok,
    res.ok ? undefined : res.error ?? "listDepartments Timeout/Fehler — kein Retry-Sturm."
  );
}

function loadStatuses(): CacheEntry {
  const syn = listTopicCatalog();
  const items: CatalogItem[] = [];
  for (const s of syn.statuses) {
    for (const name of s.mapped_to) {
      items.push({
        name,
        kind: "statuses",
        extra: { id: s.id, source: "topic-synonyms" },
      });
    }
    for (const code of s.codes ?? []) {
      items.push({
        name: code,
        kind: "statuses",
        extra: { id: s.id, source: "topic-synonyms-code" },
      });
    }
  }
  for (const [alias, code] of Object.entries(STATE_CODES)) {
    items.push({
      name: code,
      kind: "statuses",
      extra: { alias, source: "STATE_CODES" },
    });
  }
  return stamped(
    uniqueItems(items),
    "topic-synonyms + STATE_CODES (keine Status-Listen-API)",
    true
  );
}

function loadGroupsFromKeywords(keywords: CatalogItem[]): CacheEntry {
  const items: CatalogItem[] = [];
  for (const k of keywords) {
    const g = k.extra?.group ?? k.extra?.category;
    if (g) items.push({ name: g, kind: "groups" });
  }
  return stamped(uniqueItems(items), "derived from getKeywords", true);
}

async function ensure(
  kind: CatalogKind,
  tracker: CallTracker
): Promise<CacheEntry> {
  const hit = cache.get(kind);
  if (hit && ageMs(hit)! < hit.ttlMs) return hit;

  if (kind === "statuses") {
    const entry = loadStatuses();
    cache.set(kind, entry);
    return entry;
  }

  if (kind === "keywords" || kind === "groups") {
    const kw = await loadKeywords(tracker);
    cache.set("keywords", kw);
    const groups = loadGroupsFromKeywords(kw.items);
    cache.set("groups", groups);
    return kind === "keywords" ? kw : groups;
  }

  if (kind === "doc_types") {
    const entry = await loadDocTypes(tracker);
    cache.set(kind, entry);
    return entry;
  }

  const entry = await loadDepartments(tracker);
  cache.set(kind, entry);
  return entry;
}

export async function getCatalog(
  kind: CatalogKind,
  filter?: string
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  try {
    const entry = await ensure(kind, tracker);
    const items = filterItems(entry.items, filter);
    const warnings: string[] = [];
    if (entry.warning) warnings.push(entry.warning);
    if (kind !== "statuses" && entry.items.length === 0) {
      warnings.push(
        `Katalog '${kind}' leer oder API nicht erreichbar. Synonym-Datei / manuelle Werte nutzen.`
      );
    }
    return okEnvelope(
      {
        kind,
        filter: filter ?? null,
        items,
        count: items.length,
        totalUnfiltered: entry.items.length,
        cacheAgeMs: ageMs(entry),
        source: entry.source,
      },
      {
        resolution: {
          kind,
          cached: (ageMs(entry) ?? 0) > 5,
          source: entry.source,
          cacheAgeMs: ageMs(entry),
          ttlMs: entry.ttlMs,
          speed: "in-memory TTL; list_* nicht bei jedem Call",
        },
        warnings,
        raw_calls: tracker.calls,
      }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      raw_calls: tracker.calls,
      warnings: ["Katalog-API fehlgeschlagen."],
      resolution: { kind },
    });
  }
}

export function peekCachedKeywords(): string[] {
  return (cache.get("keywords")?.items ?? []).map((i) => i.name);
}

export function peekCachedKeywordItems(): CatalogItem[] {
  return [...(cache.get("keywords")?.items ?? [])];
}

export function peekCachedNames(kind: CatalogKind): string[] {
  return (cache.get(kind)?.items ?? []).map((i) => i.name);
}

export function resetCatalogCacheForTests(): void {
  cache.clear();
}

export function setCachedKeywordsForTests(items: CatalogItem[]): void {
  cache.set(
    "keywords",
    stamped(uniqueItems(items), "test", true)
  );
}

/** Warm or return cached keyword items (one SOAP call on miss). */
export async function ensureKeywordItems(): Promise<CatalogItem[]> {
  const hit = cache.get("keywords");
  if (hit && ageMs(hit)! < hit.ttlMs) return hit.items;
  const tracker = new CallTracker();
  const entry = await ensure("keywords", tracker);
  return entry.items;
}
