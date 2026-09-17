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

export function envelopeResult(env: HelperEnvelope, forceError?: boolean) {
  return textResult(env, forceError ?? !env.ok);
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
