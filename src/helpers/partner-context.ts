/**
 * Partner briefing. Default LIGHT: base stammdaten only.
 * Extra sections only if explicitly requested — never auto-chain tickets/schäden.
 */
import * as stammdaten from "../stammdaten.js";
import {
  CallTracker,
  envelopeData,
  failEnvelope,
  okEnvelope,
  type HelperEnvelope,
} from "./envelope.js";
import { findTickets } from "./find-tickets.js";
import { resolvePlace, type ResolvePlaceInput } from "./resolve-place.js";
import { SPEED } from "./speed.js";

export type PartnerInclude =
  | "base"
  | "extended"
  | "contracts"
  | "conditions"
  | "damage_reports"
  | "other_partners"
  | "open_tickets";

export const DEFAULT_PARTNER_INCLUDE: PartnerInclude[] = ["base"];

export interface PartnerContextInput extends ResolvePlaceInput {
  partnerId?: string;
  partner?: string;
  include?: PartnerInclude[];
}

export async function partnerContext(
  input: PartnerContextInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  const explicit = Boolean(input.include?.length);
  const include = new Set(input.include?.length ? input.include : DEFAULT_PARTNER_INCLUDE);
  if (!explicit) {
    warnings.push(
      "LIGHT: nur Stammdaten (base). extended/contracts/open_tickets/damage_reports nur bei explizitem include."
    );
  }

  const t = SPEED.CALL_TIMEOUT_MS;

  try {
    let partnerId = input.partnerId?.trim();
    let partner = input.partner?.trim();

    if (!partnerId && (input.mandant || input.street || input.query || input.houseNumbers)) {
      const resolved = await resolvePlace({
        ...input,
        allowDocumentFallback: input.allowDocumentFallback === true,
      });
      warnings.push(...(resolved.warnings ?? []));
      if (resolved.raw_calls) tracker.calls.push(...resolved.raw_calls);
      const pids = envelopeData<{ partnerIds: string[] }>(resolved)?.partnerIds ?? [];
      partnerId = pids[0];
      if (pids.length > 1) {
        warnings.push(
          `Mehrere Partner (${pids.join(", ")}). Kontext für den ersten.`
        );
      }
      if (!partnerId) {
        return failEnvelope(
          "Keine Partner-ID: Crosswalk leer oder Adresse nicht auflösbar. getPartnerId ist keine Adresssuche.",
          {
            warnings,
            ambiguities: resolved.ambiguities,
            resolution: resolved.resolution,
            raw_calls: tracker.calls,
          }
        );
      }
    }

    if (!partnerId && !partner) {
      return failEnvelope(
        "partnerId oder Adresse/Mandant erforderlich. getPartnerId nicht als Adresssuche verwenden.",
        { warnings, raw_calls: tracker.calls }
      );
    }

    const sections: Record<string, unknown> = {
      partnerId: partnerId ?? null,
      partner: partner ?? null,
    };

    const extras: Array<Promise<void>> = [];

    if (include.has("base") && partnerId) {
      extras.push(
        (async () => {
          const r = await tracker.track("get_partner_base_data", () =>
            stammdaten.getPartnerMasterdata(partnerId!, { timeoutMs: t })
          );
          sections.base = { ok: r.ok, errorText: r.errorText, data: r.json };
          if (!r.ok) warnings.push(`Stammdaten: ${r.errorText ?? "Fehler / Timeout"}`);
        })()
      );
    }

    if (include.has("extended") && partnerId) {
      extras.push(
        (async () => {
          const r = await tracker.track("get_partner_extended_data", () =>
            stammdaten.getPartnerExtMasterdata(partnerId!, { timeoutMs: t })
          );
          sections.extended = { ok: r.ok, errorText: r.errorText, data: r.json };
        })()
      );
    }

    if (include.has("contracts") && partner) {
      extras.push(
        (async () => {
          const r = await tracker.track("get_partner_contracts", () =>
            stammdaten.getPartnerContracts(partner!, { timeoutMs: t })
          );
          sections.contracts = { ok: r.ok, errorText: r.errorText, data: r.json };
        })()
      );
    } else if (include.has("contracts") && !partner) {
      warnings.push(
        "Verträge (getPartnerContracts) brauchen die PARTNER-Nummer, nicht nur PARTNERID."
      );
    }

    if (include.has("conditions") && partnerId) {
      extras.push(
        (async () => {
          const r = await tracker.track("get_contract_conditions", () =>
            stammdaten.getPartnerConditionsApp(partnerId!, { timeoutMs: t })
          );
          sections.conditions = { ok: r.ok, errorText: r.errorText, data: r.json };
        })()
      );
    }

    if (include.has("other_partners") && partnerId) {
      extras.push(
        (async () => {
          const r = await tracker.track("get_other_contract_partners_base", () =>
            stammdaten.getAddPartnersMasterdata(partnerId!, { timeoutMs: t })
          );
          sections.other_partners = { ok: r.ok, errorText: r.errorText, data: r.json };
        })()
      );
    }

    if (include.has("damage_reports") && partnerId) {
      extras.push(
        (async () => {
          const r = await tracker.track("get_damage_reports", () =>
            stammdaten.getPartnerMaintenanceIssues({
              partnerid: partnerId,
              timeoutMs: t,
            })
          );
          sections.damage_reports = { ok: r.ok, errorText: r.errorText, data: r.json };
        })()
      );
    }

    await Promise.allSettled(extras);

    if (include.has("open_tickets") && partnerId) {
      const tickets = await findTickets({
        partnerIds: [partnerId],
        status: "offen",
        limit: SPEED.MAX_RESULTS,
        allowDocumentFallback: false,
      });
      if (tickets.raw_calls) tracker.calls.push(...tickets.raw_calls);
      warnings.push(...(tickets.warnings ?? []));
      sections.open_tickets =
        envelopeData<{ tickets: unknown[] }>(tickets)?.tickets ?? [];
    }

    return okEnvelope(sections, {
      resolution: {
        partnerId: partnerId ?? null,
        partner: partner ?? null,
        include: [...include],
        mode: explicit ? "explicit-extras" : "light",
        getPartnerId: "not_used",
        speed: { timeoutMs: t, noAutoChain: true },
      },
      warnings,
      raw_calls: tracker.calls,
    });
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
    });
  }
}
