/**
 * Seconds-latency budget for L1 helpers.
 * Raw datasec_* tools keep their own (longer) client timeouts.
 */
export const SPEED = {
  /** Default and hard cap for helper ticket/document lists. */
  MAX_RESULTS: 10,
  /** Partner IDs per resolve / find_tickets fan-out. */
  MAX_PARTNERS: 4,
  /** Parallel search_tickets calls per helper invocation. */
  MAX_SEARCH_CALLS: 4,
  /** Only the first mapped keyword is searched (happy path). */
  MAX_KEYWORDS_PER_SEARCH: 1,
  /** Per raw-call abort for helpers. */
  CALL_TIMEOUT_MS: 8_000,
  /** Single document-index live resolve / fallback call. */
  FALLBACK_TIMEOUT_MS: 5_000,
  /** In-process address hits (repeat queries in the same helper session). */
  ADDRESS_MEMORY_TTL_MS: 15 * 60 * 1000,
  /** Writable cache in data/address-crosswalk.json (not an ops seed). */
  ADDRESS_DISK_TTL_MS: 24 * 60 * 60 * 1000,
  /** Max document types tried for live address (OBJEKTAKTE then MIETERAKTE). */
  LIVE_RESOLVE_MAX_TYPES: 2,
  /** Max index rows per document type. */
  LIVE_RESOLVE_MAX_PER_TYPE: 5,
  /** Catalog list_* first fetch. */
  CATALOG_TIMEOUT_MS: 8_000,
  /** Wall-clock budget for one helper (partial + warning after this). */
  HELPER_BUDGET_MS: 12_000,
  /** Successful catalog cache. */
  CATALOG_TTL_MS: 24 * 60 * 60 * 1000,
  /** Failed catalog fetch — avoid retry storms. */
  CATALOG_NEGATIVE_TTL_MS: 60_000,
} as const;

export class TimeoutError extends Error {
  readonly timedOut = true;
  constructor(label: string, ms: number) {
    super(`Timeout ${ms}ms: ${label} — Teilresultat / Abbruch statt Hänger.`);
    this.name = "TimeoutError";
  }
}

export function isTimeoutMessage(msg: string | undefined): boolean {
  return Boolean(msg && /timeout/i.test(msg));
}

/** Race a promise; does not abort the underlying work unless the callee honors timeoutMs. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function remainingBudget(startedAt: number, budgetMs = SPEED.HELPER_BUDGET_MS): number {
  return Math.max(0, budgetMs - (Date.now() - startedAt));
}

export function budgetExpired(startedAt: number, budgetMs = SPEED.HELPER_BUDGET_MS): boolean {
  return remainingBudget(startedAt, budgetMs) <= 0;
}

export function clampResults(n: number | undefined): number {
  return Math.min(Math.max(n ?? SPEED.MAX_RESULTS, 1), SPEED.MAX_RESULTS);
}
