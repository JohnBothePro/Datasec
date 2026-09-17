/**
 * Multi-API-key auth with roles and env restrictions.
 * Per-request identity via AsyncLocalStorage.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatasecEnvName } from "./client.js";

export type KeyRole = "read" | "write" | "admin";

export type KeyEnv = "test" | "prod";

export interface KeyRecord {
  name: string;
  key: string;
  role: KeyRole;
  envs: KeyEnv[];
}

/** Public view — never includes the secret. */
export interface AuthContext {
  name: string;
  role: KeyRole;
  envs: KeyEnv[];
  /** True when the key came from MCP_API_KEY env fallback. */
  fromEnvFallback?: boolean;
}

const VALID_ROLES = new Set<KeyRole>(["read", "write", "admin"]);
const VALID_ENVS = new Set<KeyEnv>(["test", "prod"]);

const als = new AsyncLocalStorage<AuthContext>();

let cachedKeys: KeyRecord[] | null = null;
let cachedKeysPath: string | null = null;
let keysLoadAttempted = false;

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined || v === "") return defaultValue;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

/** Candidate paths for keys.json (MCP_KEYS_FILE wins). */
export function keysFileCandidates(): string[] {
  const out: string[] = [];
  const envPath = process.env.MCP_KEYS_FILE?.trim();
  if (envPath) out.push(resolve(envPath));

  // Beside the running app (dist/ → parent, or cwd)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    out.push(resolve(here, "..", "keys.json"));
    out.push(resolve(here, "keys.json"));
  } catch {
    /* ignore */
  }

  out.push(resolve(process.cwd(), "keys.json"));

  // DATASEC desk / shared paths (Windows + box)
  const desk = process.env.DATASEC_DESK?.trim();
  if (desk) out.push(resolve(desk, "keys.json"));
  out.push(
    resolve("C:\\Users\\j.bothe\\Desktop\\DATASEC\\keys.json"),
    resolve(
      "C:\\Users\\j.bothe\\OneDrive - GAG Immobilien AG\\Desktop\\DATASEC\\keys.json"
    ),
    resolve("/workspace/datasec_shared/keys.json")
  );

  const localApp = process.env.LOCALAPPDATA?.trim();
  if (localApp) {
    out.push(resolve(localApp, "Temp", "datasec_probe", "keys.json"));
  }

  return [...new Set(out.filter(Boolean))];
}

function normalizeRecord(raw: unknown, index: number): KeyRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const key = typeof o.key === "string" ? o.key.trim() : "";
  const roleRaw = typeof o.role === "string" ? o.role.trim().toLowerCase() : "";
  if (!name || !key) {
    console.error(`[datasec-mcp] keys.json entry #${index}: name/key missing — skipped`);
    return null;
  }
  if (!VALID_ROLES.has(roleRaw as KeyRole)) {
    console.error(
      `[datasec-mcp] keys.json entry "${name}": invalid role "${roleRaw}" — skipped`
    );
    return null;
  }
  const envsRaw = Array.isArray(o.envs) ? o.envs : [];
  const envs = envsRaw
    .map((e) => String(e).trim().toLowerCase())
    .filter((e): e is KeyEnv => VALID_ENVS.has(e as KeyEnv));
  if (envs.length === 0) {
    console.error(
      `[datasec-mcp] keys.json entry "${name}": envs empty/invalid — skipped`
    );
    return null;
  }
  return { name, key, role: roleRaw as KeyRole, envs };
}

/** Load keys from MCP_KEYS_FILE / default candidates. Cached until reloadKeys(). */
export function loadKeys(): KeyRecord[] {
  if (keysLoadAttempted && cachedKeys !== null) return cachedKeys;
  keysLoadAttempted = true;
  cachedKeys = [];
  cachedKeysPath = null;

  for (const p of keysFileCandidates()) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { keys?: unknown }).keys)
          ? (parsed as { keys: unknown[] }).keys
          : null;
      if (!arr) {
        console.error(`[datasec-mcp] keys file is not an array: ${p}`);
        continue;
      }
      const records: KeyRecord[] = [];
      arr.forEach((item, i) => {
        const rec = normalizeRecord(item, i);
        if (rec) records.push(rec);
      });
      cachedKeys = records;
      cachedKeysPath = p;
      console.error(
        `[datasec-mcp] loaded ${records.length} API key(s) from ${p}`
      );
      return cachedKeys;
    } catch (e) {
      console.error(
        `[datasec-mcp] failed to load keys from ${p}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
  return cachedKeys;
}

export function reloadKeys(): KeyRecord[] {
  keysLoadAttempted = false;
  cachedKeys = null;
  cachedKeysPath = null;
  return loadKeys();
}

export function getKeysFilePath(): string | null {
  loadKeys();
  return cachedKeysPath;
}

export function authConfigured(): boolean {
  const keys = loadKeys();
  if (keys.length > 0) return true;
  if (process.env.MCP_API_KEY?.trim()) return true;
  return false;
}

export function allowAnon(): boolean {
  return parseBool(process.env.MCP_ALLOW_ANON, false);
}

function toContext(rec: KeyRecord, fromEnvFallback = false): AuthContext {
  return {
    name: rec.name,
    role: rec.role,
    envs: [...rec.envs],
    ...(fromEnvFallback ? { fromEnvFallback: true } : {}),
  };
}

/**
 * Resolve a bearer / x-api-key token to AuthContext.
 * Backward compat: MCP_API_KEY env not present in keys.json → admin [test,prod].
 */
export function resolveKey(token: string | undefined | null): AuthContext | null {
  const t = token?.trim() ?? "";
  if (!t) return null;

  const keys = loadKeys();
  const hit = keys.find((k) => k.key === t);
  if (hit) return toContext(hit);

  const envKey = process.env.MCP_API_KEY?.trim();
  if (envKey && t === envKey) {
    return toContext(
      {
        name: "MCP_API_KEY",
        key: envKey,
        role: "admin",
        envs: ["test", "prod"],
      },
      true
    );
  }
  return null;
}

/** Extract token from Authorization Bearer or x-api-key header. */
export function extractTokenFromHeaders(headers: {
  authorization?: string;
  "x-api-key"?: string | string[];
}): string | null {
  const auth = headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    const b = auth.slice(7).trim();
    if (b) return b;
  }
  const x = headers["x-api-key"];
  const headerKey = (Array.isArray(x) ? x[0] : x)?.trim() ?? "";
  return headerKey || null;
}

export function runWithAuth<T>(ctx: AuthContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return als.run(ctx, fn);
}

export function getAuth(): AuthContext | undefined {
  return als.getStore();
}

export function isAdmin(ctx?: AuthContext | null): boolean {
  const a = ctx ?? getAuth();
  if (!a) {
    // stdio / no HTTP auth — treat as admin for local use
    return true;
  }
  return a.role === "admin";
}

export function canWrite(ctx?: AuthContext | null): boolean {
  const a = ctx ?? getAuth();
  if (!a) {
    // No HTTP auth context (e.g. stdio) — role gate does not apply
    return true;
  }
  return a.role === "write" || a.role === "admin";
}

export function canUseEnv(
  env: DatasecEnvName | string,
  ctx?: AuthContext | null
): boolean {
  const a = ctx ?? getAuth();
  if (!a) return true;
  return a.envs.includes(env as KeyEnv);
}

export function firstAllowedEnv(ctx?: AuthContext | null): DatasecEnvName | null {
  const a = ctx ?? getAuth();
  if (!a || a.envs.length === 0) return null;
  return a.envs[0] as DatasecEnvName;
}

export function assertWrite(ctx?: AuthContext | null): void {
  if (!canWrite(ctx)) {
    const a = ctx ?? getAuth();
    throw new Error(
      `Schreibzugriff verweigert: Rolle '${a?.role ?? "unknown"}' (Key: ${a?.name ?? "?"}) ` +
        "darf keine Write-Tools nutzen."
    );
  }
}

export function assertCanUseEnv(
  env: DatasecEnvName | string,
  ctx?: AuthContext | null
): void {
  if (!canUseEnv(env, ctx)) {
    const a = ctx ?? getAuth();
    throw new Error(
      `Umgebung '${env}' nicht erlaubt für Key '${a?.name ?? "?"}' ` +
        `(erlaubt: ${(a?.envs ?? []).join(", ") || "—"}).`
    );
  }
}

/** Safe public auth summary (no secret). */
export function authPublic(ctx?: AuthContext | null): {
  name: string;
  role: KeyRole;
  envs: KeyEnv[];
} | null {
  const a = ctx ?? getAuth();
  if (!a) return null;
  return { name: a.name, role: a.role, envs: [...a.envs] };
}
