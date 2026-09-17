/**
 * Optional street → partner cache hook.
 * Empty seed is valid. Future background fill can write entries[];
 * helpers never require this file to be populated.
 */
import { readFileSync } from "node:fs";
import { repoFile } from "./envelope.js";
import { houseKey, streetKey } from "./normalize.js";

export interface StreetPartnerIndexEntry {
  mandantId?: string;
  street?: string;
  houseNo?: string;
  houseNos?: string[];
  partnerId?: string;
  partnerIds?: string[];
  label?: string;
  source?: "seed" | "background" | "live_cache";
  cachedAt?: string;
}

export interface StreetPartnerIndexHook {
  kind: "street_partner_index";
  status: "empty_seed" | "ready";
  lookup: string;
  writer: string;
}

export interface StreetPartnerIndexFile {
  version?: number;
  schema_notes?: string[];
  hook?: StreetPartnerIndexHook;
  entries: StreetPartnerIndexEntry[];
}

export interface StreetPartnerLookup {
  mandant?: string;
  street?: string;
  houseNumbers?: string[];
}

let cached: StreetPartnerIndexFile | null = null;

function indexPath(): string {
  return (
    process.env.DATASEC_STREET_PARTNER_INDEX_PATH?.trim() ||
    repoFile("data/street-partner-index.json")
  );
}

export function loadStreetPartnerIndex(force = false): StreetPartnerIndexFile {
  if (cached && !force) return cached;
  try {
    const raw = JSON.parse(readFileSync(indexPath(), "utf8")) as StreetPartnerIndexFile;
    cached = {
      version: raw.version ?? 1,
      schema_notes: raw.schema_notes,
      hook: raw.hook,
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    };
  } catch {
    cached = {
      version: 1,
      hook: {
        kind: "street_partner_index",
        status: "empty_seed",
        lookup: "mandant + streetKey + houseKey → partnerIds[]",
        writer: "future background fill",
      },
      entries: [],
    };
  }
  return cached;
}

export function resetStreetPartnerIndexForTests(): void {
  cached = null;
}

function entryHouses(e: StreetPartnerIndexEntry): string[] {
  return [...(e.houseNos ?? []), ...(e.houseNo ? [e.houseNo] : [])]
    .map((h) => houseKey(String(h)))
    .filter(Boolean);
}

function entryPartnerIds(e: StreetPartnerIndexEntry): string[] {
  const ids = [...(e.partnerIds ?? []), ...(e.partnerId ? [e.partnerId] : [])];
  return [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
}

/** Lookup cached street→partner rows. Empty index → []. Never invents partners. */
export function lookupStreetPartnerIndex(q: StreetPartnerLookup): StreetPartnerIndexEntry[] {
  if (!q.street?.trim()) return [];
  const file = loadStreetPartnerIndex();
  const wantStreet = streetKey(q.street);
  const houses = (q.houseNumbers ?? []).map(houseKey).filter(Boolean);
  return file.entries.filter((e) => {
    if (!e.street || streetKey(e.street) !== wantStreet) return false;
    if (q.mandant && e.mandantId && String(e.mandantId) !== String(q.mandant)) return false;
    const eHouses = entryHouses(e);
    if (houses.length && eHouses.length && !houses.some((h) => eHouses.includes(h))) {
      return false;
    }
    return entryPartnerIds(e).length > 0;
  });
}

export function streetPartnerIndexStats(): {
  path: string;
  entryCount: number;
  empty: boolean;
  hook: StreetPartnerIndexHook | undefined;
} {
  const file = loadStreetPartnerIndex();
  return {
    path: indexPath(),
    entryCount: file.entries.length,
    empty: file.entries.length === 0,
    hook: file.hook,
  };
}

export function partnerIdsFromIndexEntries(entries: StreetPartnerIndexEntry[]): string[] {
  return [...new Set(entries.flatMap(entryPartnerIds))];
}
