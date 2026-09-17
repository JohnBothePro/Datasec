/**
 * Shared L1 helper response envelope + small infra used by every helper.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canUseEnv, firstAllowedEnv, getAuth } from "../auth.js";
import { session } from "../client.js";

export interface Ambiguity {
  candidate: unknown;
  why: string;
  score?: number;
}

export interface RawCall {
  tool: string;
  count?: number;
  ms?: number;
  ok?: boolean;
  error?: string;
  detail?: string;
}

export interface HelperEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  resolution: Record<string, unknown>;
  ambiguities: Ambiguity[];
  warnings: string[];
  error?: string;
  raw_calls?: RawCall[];
}

export class CallTracker {
  readonly calls: RawCall[] = [];

  async track<T>(tool: string, fn: () => Promise<T>, detail?: string): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      const ok =
        result && typeof result === "object" && "ok" in result
          ? Boolean((result as { ok?: boolean }).ok)
          : true;
      const error =
        result && typeof result === "object" && "error" in result
          ? String((result as { error?: unknown }).error ?? "")
          : "";
      this.calls.push({
        tool,
        count: 1,
        ms: Date.now() - t0,
        ok,
        error: error || undefined,
        detail,
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.calls.push({
        tool,
        count: 1,
        ms: Date.now() - t0,
        ok: false,
        error: msg,
        detail,
      });
      throw e;
    }
  }
}

export function okEnvelope<T>(
  data: T,
  extras?: Partial<Omit<HelperEnvelope<T>, "ok" | "data">>
): HelperEnvelope<T> {
  return {
    ok: true,
    data,
    resolution: extras?.resolution ?? {},
    ambiguities: extras?.ambiguities ?? [],
    warnings: extras?.warnings ?? [],
    raw_calls: extras?.raw_calls,
    error: extras?.error,
  };
}

export function failEnvelope<T = unknown>(
  error: string,
  extras?: Partial<Omit<HelperEnvelope<T>, "ok" | "error">>
): HelperEnvelope<T> {
  return {
    ok: false,
    data: extras?.data ?? null,
    resolution: extras?.resolution ?? {},
    ambiguities: extras?.ambiguities ?? [],
    warnings: extras?.warnings ?? [],
    raw_calls: extras?.raw_calls,
    error,
  };
}

export function envelopeData<T>(env: HelperEnvelope): T | null {
  return (env.data ?? null) as T | null;
}

export function mergeWarnings(...groups: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const w of g ?? []) {
      if (!w || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

export function textResult(data: unknown, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

/** Ticket fields kept in compact helper envelopes (Outlook-like). */
export const COMPACT_TICKET_FIELDS = [
  "id",
  "nr",
  "subject",
  "keyword",
  "state",
  "partnerid",
  "category",
  "create_on",
] as const;

export type CompactTicket = {
  id?: string;
  nr?: string;
  subject?: string;
  keyword?: string;
  state?: string;
  partnerid?: string;
  category?: string;
  create_on?: string;
};

const RAW_PAYLOAD_KEYS = new Set([
  "rawXml",
  "raw_xml",
  "rawSnippet",
  "raw_snippet",
  "rawXmlSnippet",
]);

function strField(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function looksLikeTicketRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    "ticketid" in o ||
    "ticketnr" in o ||
    ("nr" in o && ("ticketid" in o || "create_on" in o || "keyword" in o || "state" in o))
  );
}

export function compactTicket(t: Record<string, unknown>): CompactTicket {
  return {
    id: strField(t, "id", "ticketid", "TICKETID"),
    nr: strField(t, "nr", "ticketnr", "TICKETNR"),
    subject: strField(t, "subject", "SUBJECT"),
    keyword: strField(t, "keyword", "KEYWORD"),
    state: strField(t, "state", "STATE"),
    partnerid: strField(t, "partnerid", "partnerId", "PARTNERID"),
    category: strField(t, "category", "CATEGORY"),
    create_on: strField(t, "create_on", "CREATE_ON"),
  };
}

function looksLikeXml(text: string): boolean {
  const s = text.trim();
  return s.startsWith("<") && /<\/|[\/?]>/m.test(s);
}

function compactValue(v: unknown): unknown {
  if (v == null) return v;
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => looksLikeTicketRecord(x))) {
      return v.map((x) => compactTicket(x as Record<string, unknown>));
    }
    return v.map(compactValue);
  }
  if (typeof v !== "object") return v;
  const rec = v as Record<string, unknown>;
  if (looksLikeTicketRecord(rec) && !("hits" in rec) && !("kind" in rec)) {
    return compactTicket(rec);
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (RAW_PAYLOAD_KEYS.has(k)) continue;
    if (k === "body" && typeof val === "string" && looksLikeXml(val)) continue;
    out[k] = compactValue(val);
  }
  return out;
}

export interface PresentEnvelopeOpts {
  /** When true, keep raw_calls and raw XML. Default compact. */
  debug?: boolean;
}

/**
 * Outlook-like helper presentation: tiny hits, no raw XML, no raw_calls
 * unless debug:true.
 */
export function presentEnvelope<T>(
  env: HelperEnvelope<T>,
  opts?: PresentEnvelopeOpts
): HelperEnvelope<T> {
  if (opts?.debug) return env;
  return {
    ...env,
    data: compactValue(env.data) as T | null,
    raw_calls: undefined,
  };
}

export function envelopeResult(
  env: HelperEnvelope,
  forceError?: boolean,
  opts?: PresentEnvelopeOpts
) {
  return textResult(presentEnvelope(env, opts), forceError ?? !env.ok);
}

export function ensureAuthEnv(): void {
  const auth = getAuth();
  if (!auth) return;
  if (canUseEnv(session.env, auth)) return;
  const first = firstAllowedEnv(auth);
  if (first) session.setEnv(first);
}

export function parseEnvBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined || v === "") return defaultValue;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

export function helpersEnabled(): boolean {
  return parseEnvBool(process.env.DATASEC_HELPERS_ENABLED, true);
}

/** Resolve a repo-root file (works from src/ and dist/). */
export function repoFile(relFromRoot: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", relFromRoot),
    resolve(process.cwd(), relFromRoot),
    join(process.cwd(), relFromRoot),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}
