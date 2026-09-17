/**
 * Partner briefing: stammdaten + optional open tickets / damage reports.
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

export type PartnerInclude =
  | "base"
  | "extended"
  | "contracts"
  | "conditions"
  | "damage_reports"
  | "other_partners"
  | "open_tickets";

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
  const include = new Set(
    input.include ?? ["base", "extended", "open_tickets", "damage_reports"]
  );

  try {
    let partnerId = input.partnerId?.trim();
    let partner = input.partner?.trim();

    if (!partnerId && (input.mandant || input.street || input.query || input.houseNumbers)) {
      const resolved = await resolvePlace(input);
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

    if (include.has("base") && partnerId) {
      const r = await tracker.track("get_partner_base_data", () =>
        stammdaten.getPartnerMasterdata(partnerId!)
      );
      sections.base = { ok: r.ok, errorText: r.errorText, data: r.json };
      if (!r.ok) warnings.push(`Stammdaten: ${r.errorText ?? "Fehler"}`);
    }

    if (include.has("extended") && partnerId) {
      const r = await tracker.track("get_partner_extended_data", () =>
        stammdaten.getPartnerExtMasterdata(partnerId!)
      );
      sections.extended = { ok: r.ok, errorText: r.errorText, data: r.json };
    }

    if (include.has("contracts") && partner) {
      const r = await tracker.track("get_partner_contracts", () =>
        stammdaten.getPartnerContracts(partner!)
      );
      sections.contracts = { ok: r.ok, errorText: r.errorText, data: r.json };
    } else if (include.has("contracts") && !partner) {
      warnings.push(
        "Verträge (getPartnerContracts) brauchen die PARTNER-Nummer, nicht nur PARTNERID."
      );
    }

    if (include.has("conditions") && partnerId) {
      const r = await tracker.track("get_contract_conditions", () =>
        stammdaten.getPartnerConditionsApp(partnerId!)
      );
      sections.conditions = { ok: r.ok, errorText: r.errorText, data: r.json };
    }

    if (include.has("other_partners") && partnerId) {
      const r = await tracker.track("get_other_contract_partners_base", () =>
        stammdaten.getAddPartnersMasterdata(partnerId!)
      );
      sections.other_partners = { ok: r.ok, errorText: r.errorText, data: r.json };
    }

    if (include.has("damage_reports") && partnerId) {
      const r = await tracker.track("get_damage_reports", () =>
        stammdaten.getPartnerMaintenanceIssues({ partnerid: partnerId })
      );
      sections.damage_reports = { ok: r.ok, errorText: r.errorText, data: r.json };
    }

    if (include.has("open_tickets") && partnerId) {
      const tickets = await findTickets({
        partnerIds: [partnerId],
        status: "offen",
        limit: 10,
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
        getPartnerId: "not_used",
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
