/**
 * Datasec session config: env bases, token loading (never log raw token).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type DatasecEnvName = "test" | "prod";

export const BASES = {
  test: {
    rest: "https://dokuwebintegration-saml-0032.datasec.de/api/dokuweb/",
    soap: "https://dokuwebintegration-saml-0032.datasec.de/api/webservices/Tickets.cfc",
    ui: "https://dokuwebintegration-saml-0032.datasec.de/",
  },
  prod: {
    rest: "https://dokuweb-saml-0032.datasec.de/api/dokuweb/",
    soap: "https://dokuweb-saml-0032.datasec.de/api/webservices/Tickets.cfc",
    ui: "https://dokuweb-saml-0032.datasec.de/",
  },
} as const;

const DEFAULT_TOKEN_CANDIDATES = [
  "/workspace/datasec_shared/datasec_token.env",
  process.env.DATASEC_TOKEN_FILE,
  // Windows probe path (when running on John's PC)
  "C:\\Users\\j.bothe\\AppData\\Local\\Temp\\datasec_probe\\datasec_token.env",
].filter(Boolean) as string[];

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined || v === "") return defaultValue;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

function parseEnvName(v: string | undefined): DatasecEnvName {
  const s = (v ?? "test").trim().toLowerCase();
  if (s === "prod" || s === "production" || s === "live") return "prod";
  return "test";
}

function loadTokenFromFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    // Support plain token OR KEY=value
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("#")) continue;
      if (/^(DATASEC_TOKEN|AUTHTOKEN|TOKEN)\s*=/i.test(line)) {
        return line.split("=", 2)[1]?.trim() ?? null;
      }
      // plain token line
      if (!line.includes("=") || !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
        return line.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface DatasecSession {
  env: DatasecEnvName;
  writesEnabled: boolean;
  requireConfirm: boolean;
  /** True if a non-empty token is loaded (value never exposed). */
  tokenLoaded: boolean;
  tokenSource: "env" | "file" | "none";
  tokenFile?: string;
  restBase: string;
  soapEndpoint: string;
  uiBase: string;
  /** Internal — never log or serialize. */
  getToken(): string;
}

class SessionImpl implements DatasecSession {
  env: DatasecEnvName;
  writesEnabled: boolean;
  requireConfirm: boolean;
  private _token: string | null = null;
  tokenSource: "env" | "file" | "none" = "none";
  tokenFile?: string;

  constructor() {
    this.env = parseEnvName(process.env.DATASEC_ENV);
    // John: writes default true
    this.writesEnabled = parseBool(process.env.DATASEC_WRITES_ENABLED, true);
    this.requireConfirm = parseBool(process.env.DATASEC_REQUIRE_CONFIRM, true);
    this.reloadToken();
  }

  get tokenLoaded(): boolean {
    return Boolean(this._token && this._token.length > 0);
  }

  get restBase(): string {
    return BASES[this.env].rest;
  }

  get soapEndpoint(): string {
    return BASES[this.env].soap;
  }

  get uiBase(): string {
    return BASES[this.env].ui;
  }

  getToken(): string {
    if (!this._token) {
      throw new Error(
        "Datasec-Token nicht geladen. Setze DATASEC_TOKEN_FILE oder DATASEC_TOKEN. " +
          "Hinweis: Token-Datei z. B. /workspace/datasec_shared/datasec_token.env"
      );
    }
    return this._token;
  }

  reloadToken(): void {
    this._token = null;
    this.tokenSource = "none";
    this.tokenFile = undefined;

    const fromEnv = process.env.DATASEC_TOKEN?.trim();
    if (fromEnv) {
      this._token = fromEnv;
      this.tokenSource = "env";
      return;
    }

    const preferred = process.env.DATASEC_TOKEN_FILE?.trim();
    const candidates = preferred
      ? [preferred, ...DEFAULT_TOKEN_CANDIDATES.filter((p) => p !== preferred)]
      : DEFAULT_TOKEN_CANDIDATES;

    for (const p of candidates) {
      const abs = resolve(p);
      const t = loadTokenFromFile(abs);
      if (t) {
        this._token = t;
        this.tokenSource = "file";
        this.tokenFile = abs;
        return;
      }
    }
  }

  setEnv(env: DatasecEnvName): void {
    this.env = env;
  }

  status(): Record<string, unknown> {
    return {
      env: this.env,
      writesEnabled: this.writesEnabled,
      requireConfirm: this.requireConfirm,
      tokenLoaded: this.tokenLoaded,
      tokenSource: this.tokenSource,
      tokenFile: this.tokenFile ?? null,
      restBase: this.restBase,
      soapEndpoint: this.soapEndpoint,
      uiBase: this.uiBase,
      note:
        "Datasec ist nur aus dem Firmennetz / VPN (Johns PC) erreichbar. " +
        "Roh-Token wird nie ausgegeben.",
    };
  }
}

/** Singleton session for this process. */
export const session = new SessionImpl();

/** Redact token from any string before returning to clients/logs. */
export function redactSecrets(text: string, token?: string): string {
  let out = text;
  const t = token ?? (session.tokenLoaded ? session.getToken() : "");
  if (t) {
    out = out.split(t).join("<TOKEN>");
  }
  // also scrub query/body patterns
  out = out.replace(/([?&]authtoken=)[^&\s"']+/gi, "$1<TOKEN>");
  out = out.replace(/(<dw:authToken>)[^<]+(<\/dw:authToken>)/gi, "$1<TOKEN>$2");
  return out;
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Known SOAP sNewState codes (see soap/STATES.md). */
export const STATE_CODES: Record<string, string> = {
  CLOSED: "CLOSED",
  GESCHLOSSEN: "CLOSED",
  STATE_REMINDER: "STATE_REMINDER",
  WAIT_EXTERNAL: "WAIT_EXTERNAL",
};

/** SOAP CFC endpoints relative to /api/webservices/ */
export type SoapCfc =
  | "Tickets"
  | "updateDocuments"
  | "addDocuments"
  | "Masterdata"
  | "Newsticker";

export function soapEndpointFor(cfc: SoapCfc = "Tickets"): string {
  const base = session.soapEndpoint.replace(/Tickets\.cfc$/i, "");
  return `${base}${cfc}.cfc`;
}
