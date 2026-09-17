/**
 * DOKU@WEB Direkter Aufruf URL builders (API Kap. 3).
 * No network calls — pure URL construction from session UI base.
 * Authtoken embedding is OFF by default; requires admin+confirm to include.
 */
import { session, redactSecrets } from "./client.js";

export interface DeeplinkCommonOpts {
  /** Embed session authtoken (default false). Admin+confirm required at tool layer. */
  includeAuthToken?: boolean;
  /** Add disable=search (lock Stammdatensuche). */
  disableSearch?: boolean;
  /** Extra query params (already encoded values). */
  extraParams?: Record<string, string>;
}

function baseUrl(): string {
  const u = session.uiBase.replace(/\/?$/, "/");
  return u;
}

function buildUrl(
  pathAndQuery: string,
  opts: DeeplinkCommonOpts,
  tokenValue: string | null
): { url: string; urlRedacted: string; includedAuthToken: boolean } {
  const u = new URL(pathAndQuery, baseUrl());
  if (opts.disableSearch) {
    u.searchParams.set("disable", "search");
  }
  if (opts.extraParams) {
    for (const [k, v] of Object.entries(opts.extraParams)) {
      u.searchParams.set(k, v);
    }
  }
  let included = false;
  if (opts.includeAuthToken && tokenValue) {
    u.searchParams.set("authtoken", tokenValue);
    included = true;
  }
  const raw = u.toString();
  const redacted = redactSecrets(raw, tokenValue ?? undefined);
  return {
    url: included ? raw : raw,
    urlRedacted: redacted,
    includedAuthToken: included,
  };
}

function maybeToken(include: boolean | undefined): string | null {
  if (!include) return null;
  try {
    return session.getToken();
  } catch {
    return null;
  }
}

/** Kap. 3.1 — base UI / direkter Aufruf entry */
export function buildDeeplinkBase(opts: DeeplinkCommonOpts = {}) {
  const token = maybeToken(opts.includeAuthToken);
  const built = buildUrl("", opts, token);
  return {
    kind: "base",
    env: session.env,
    uiBase: session.uiBase,
    ...built,
    note:
      "Direkter Aufruf (Kap. 3). Authtoken default aus. Exact tenant paths may vary — " +
      "capture a live 'Direkter Aufruf' URL from the UI to refine.",
  };
}

/** Kap. 3.2.2 — Akte / Aktenauswahl */
export function buildDeeplinkAkte(
  opts: DeeplinkCommonOpts & {
    /** Optional partner / Mieter id for search context */
    partnerId?: string;
    /** Optional Akte name / type hint */
    akte?: string;
  } = {}
) {
  const token = maybeToken(opts.includeAuthToken);
  const extra: Record<string, string> = { ...(opts.extraParams ?? {}) };
  if (opts.partnerId) extra.partnerid = opts.partnerId;
  if (opts.akte) extra.akte = opts.akte;
  const built = buildUrl("?view=akte", { ...opts, extraParams: extra }, token);
  return {
    kind: "akte",
    env: session.env,
    uiBase: session.uiBase,
    partnerId: opts.partnerId ?? null,
    akte: opts.akte ?? null,
    ...built,
    note: "Kap. 3.2.2 Aktenauswahl. Refine path from UI-generated Direkter-Aufruf link.",
  };
}

/** Kap. 3.2.3 — Suche mit Parametern */
export function buildDeeplinkSearch(
  opts: DeeplinkCommonOpts & {
    searchParams?: Record<string, string>;
  } = {}
) {
  const token = maybeToken(opts.includeAuthToken);
  const extra: Record<string, string> = {
    ...(opts.extraParams ?? {}),
    ...(opts.searchParams ?? {}),
  };
  const built = buildUrl("?view=search", { ...opts, extraParams: extra }, token);
  return {
    kind: "search",
    env: session.env,
    uiBase: session.uiBase,
    searchParams: opts.searchParams ?? {},
    ...built,
    note: "Kap. 3.2.3 Suchparameter. Prefer disable=search to lock fields.",
  };
}

/** Kap. 3.2.4 — Belegtyp */
export function buildDeeplinkDocumentType(
  opts: DeeplinkCommonOpts & {
    documentType: string;
    partnerId?: string;
  }
) {
  const token = maybeToken(opts.includeAuthToken);
  const extra: Record<string, string> = {
    ...(opts.extraParams ?? {}),
    documenttype: opts.documentType,
  };
  if (opts.partnerId) extra.partnerid = opts.partnerId;
  const built = buildUrl("?view=documenttype", { ...opts, extraParams: extra }, token);
  return {
    kind: "document_type",
    env: session.env,
    uiBase: session.uiBase,
    documentType: opts.documentType,
    partnerId: opts.partnerId ?? null,
    ...built,
    note: "Kap. 3.2.4 Belegtyp-Aufruf.",
  };
}

/** Kap. 3.2.5 — Sammelbenutzer Ansicht */
export function buildDeeplinkSammelbenutzer(
  opts: DeeplinkCommonOpts & {
    collectiveUser?: string;
  } = {}
) {
  const token = maybeToken(opts.includeAuthToken);
  const extra: Record<string, string> = { ...(opts.extraParams ?? {}) };
  if (opts.collectiveUser) extra.sammelbenutzer = opts.collectiveUser;
  const built = buildUrl(
    "?view=sammelbenutzer",
    { ...opts, extraParams: extra },
    token
  );
  return {
    kind: "sammelbenutzer",
    env: session.env,
    uiBase: session.uiBase,
    collectiveUser: opts.collectiveUser ?? null,
    ...built,
    note:
      "Kap. 3.2.5 Sammelbenutzer — eingeschränkte Oberfläche. " +
      "Authtoken embedding is especially sensitive; keep includeAuthToken=false unless admin+confirm.",
  };
}
