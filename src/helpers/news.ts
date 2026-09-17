/**
 * Newsticker via existing stammdaten client. Seconds-latency, one SOAP call.
 */
import * as stammdaten from "../stammdaten.js";
import { CallTracker, failEnvelope, okEnvelope, type HelperEnvelope } from "./envelope.js";
import { SPEED } from "./speed.js";

export async function getNews(input: { partnerId?: string } = {}): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  try {
    const partnerId = input.partnerId?.trim() ?? "";
    if (!partnerId) {
      warnings.push("Newsticker ohne Partner-ID — API wird mit leerem sPartnerid aufgerufen.");
    }
    const r = await tracker.track("get_news_ticker", () =>
      stammdaten.getNewsticker(partnerId, { timeoutMs: SPEED.CALL_TIMEOUT_MS })
    );
    if (!r.ok) {
      warnings.push(`Newsticker fehlgeschlagen (${r.errorText ?? `HTTP ${r.httpStatus}`}) — Teilresultat.`);
    }
    return okEnvelope(
      { partnerId: partnerId || null, ok: r.ok, data: r.json, returnText: r.returnText },
      {
        resolution: { module: "newsticker", timeoutMs: SPEED.CALL_TIMEOUT_MS },
        warnings,
        raw_calls: tracker.calls,
      }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
    });
  }
}
