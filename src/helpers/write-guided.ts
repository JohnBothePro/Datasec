/**
 * Guided writes: preview unless confirm=true, then existing write gate.
 */
import { canWrite, getAuth } from "../auth.js";
import { session, STATE_CODES } from "../client.js";
import * as soap from "../soap.js";
import {
  CallTracker,
  envelopeData,
  failEnvelope,
  okEnvelope,
  type HelperEnvelope,
} from "./envelope.js";
import { mapTopic } from "./topic.js";
import { resolvePlace } from "./resolve-place.js";
import { assertNotStreetKeyword } from "./find-tickets.js";

/** Same rules as raw tools (`gateWrite` in tools.ts / tools-extended.ts). */
export function checkWriteGate(confirm: boolean | undefined): string | null {
  const auth = getAuth();
  if (auth && !canWrite(auth)) {
    return (
      `Schreibzugriff verweigert: Rolle '${auth.role}' (Key: ${auth.name}) ` +
      "darf keine Write-Tools nutzen. Benötigt role write|admin."
    );
  }
  if (!session.writesEnabled) {
    return (
      "Schreibzugriff deaktiviert (DATASEC_WRITES_ENABLED=false). " +
      "Zum Aktivieren: DATASEC_WRITES_ENABLED=true setzen und Server neu starten." +
      (auth?.role === "read"
        ? " (Hinweis: read-Keys können Writes nicht aktivieren.)"
        : "")
    );
  }
  if (session.requireConfirm && confirm !== true) {
    return (
      "Bestätigung fehlt: DATASEC_REQUIRE_CONFIRM=true verlangt confirm:true. " +
      "Bitte den Aufruf mit confirm:true wiederholen."
    );
  }
  return null;
}

function normalizeState(code: string): string {
  const key = code.trim().toUpperCase().replace(/\s+/g, "_");
  return STATE_CODES[key] ?? code.trim();
}

export interface CreateTicketGuidedInput {
  subject: string;
  partner?: string;
  partnerId?: string;
  keyword?: string;
  topic?: string;
  category?: string;
  channel?: string;
  description?: string;
  type?: string;
  plz?: string;
  ticketgroup?: string;
  fieldvalues?: string;
  priority?: string;
  ticketsystem?: string;
  mandant?: string;
  street?: string;
  houseNumbers?: string[] | string;
  confirm?: boolean;
}

export async function createTicketGuided(
  input: CreateTicketGuidedInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];

  try {
    const topic = mapTopic(input.topic ?? input.keyword);
    let keyword = input.keyword;
    if (!keyword && topic.matched && topic.keywords[0]) {
      keyword = topic.keywords[0];
    }
    if (keyword) {
      try {
        assertNotStreetKeyword(keyword, "keyword");
      } catch (e) {
        return failEnvelope(e instanceof Error ? e.message : String(e), {
          resolution: { streetAsKeyword: false },
        });
      }
    }

    let partner = input.partner ?? input.partnerId;
    if (!partner && (input.mandant || input.street || input.houseNumbers)) {
      const resolved = await resolvePlace({
        mandant: input.mandant,
        street: input.street,
        houseNumbers: input.houseNumbers,
      });
      if (resolved.raw_calls) tracker.calls.push(...resolved.raw_calls);
      warnings.push(...(resolved.warnings ?? []));
      const pids = envelopeData<{ partnerIds: string[] }>(resolved)?.partnerIds ?? [];
      if (pids.length === 1) {
        partner = pids[0];
      } else if (pids.length > 1) {
        warnings.push(
          "Mehrere Partner — Vorschau ohne Partner. Vor confirm einen wählen (kein stilles Picken)."
        );
      }
    }

    const planned = {
      subject: input.subject,
      partner: partner ?? "",
      keyword: keyword ?? "",
      category: input.category,
      channel: input.channel,
      description: input.description,
      type: input.type,
      plz: input.plz,
      ticketgroup: input.ticketgroup,
      fieldvalues: input.fieldvalues,
      priority: input.priority,
      ticketsystem: input.ticketsystem,
    };

    const missing: string[] = [];
    if (!planned.subject) missing.push("subject");
    if (!planned.partner) missing.push("partner");
    if (!planned.keyword) missing.push("keyword");
    if (missing.length) {
      warnings.push(`Pflichtfelder fehlen: ${missing.join(", ")}.`);
    }

    if (input.confirm !== true) {
      return okEnvelope(
        {
          mode: "preview",
          action: "create_ticket",
          planned,
          message:
            "Kein Schreibzugriff. Prüfe den geplanten Payload und rufe mit confirm:true erneut auf.",
        },
        {
          resolution: { topic, streetAsKeyword: false, confirm: false },
          warnings,
          raw_calls: tracker.calls,
        }
      );
    }

    const blocked = checkWriteGate(true);
    if (blocked) {
      return failEnvelope(blocked, {
        data: { mode: "blocked", action: "create_ticket", planned },
        resolution: { topic, confirm: true },
        warnings,
        raw_calls: tracker.calls,
      });
    }
    if (missing.length) {
      return failEnvelope(`Kann nicht anlegen, Pflichtfelder fehlen: ${missing.join(", ")}`, {
        data: { mode: "blocked", planned },
        warnings,
        raw_calls: tracker.calls,
      });
    }

    const result = await tracker.track("create_ticket", () => soap.createTicket(planned));
    return okEnvelope(
      {
        mode: "executed",
        action: "create_ticket",
        planned,
        ok: result.ok,
        httpStatus: result.httpStatus,
        success: result.success,
        errorText: result.errorText,
        infoText: result.infoText,
        data: result.json,
        returnText: result.returnText,
      },
      {
        resolution: { topic, streetAsKeyword: false, confirm: true },
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

export interface AddNoteGuidedInput {
  ticketnr: string;
  note: string;
  checkDuplicates?: boolean;
  confirm?: boolean;
}

export async function addNoteGuided(
  input: AddNoteGuidedInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const warnings: string[] = [];
  const planned = {
    ticketnr: input.ticketnr,
    note: input.note,
    noteLength: input.note?.length ?? 0,
  };

  if (input.confirm !== true) {
    return okEnvelope(
      {
        mode: "preview",
        action: "add_note",
        planned,
        message: "Notiz wird nicht geschrieben. confirm:true zum Ausführen.",
      },
      { resolution: { confirm: false }, warnings }
    );
  }

  const blocked = checkWriteGate(true);
  if (blocked) {
    return failEnvelope(blocked, {
      data: { mode: "blocked", action: "add_note", planned },
    });
  }

  try {
    let duplicateWarning: string | null = null;
    if (input.checkDuplicates !== false) {
      const existing = await tracker.track("get_notes", () =>
        soap.getTicketNotes(input.ticketnr)
      );
      const blob = (existing.returnText ?? "") + JSON.stringify(existing.json ?? "");
      const snippet = input.note.trim().slice(0, 80);
      if (snippet.length >= 8 && blob.includes(snippet)) {
        duplicateWarning =
          "Mögliche Duplikat-Notiz: ähnlicher Text bereits vorhanden (checkDuplicates).";
        warnings.push(duplicateWarning);
      }
    }
    const result = await tracker.track("add_note", () =>
      soap.addTicketNote(input.ticketnr, input.note)
    );
    return okEnvelope(
      {
        mode: "executed",
        action: "add_note",
        planned,
        duplicateWarning,
        ok: result.ok,
        httpStatus: result.httpStatus,
        success: result.success,
        errorText: result.errorText,
        infoText: result.infoText,
        data: result.json,
      },
      { resolution: { confirm: true }, warnings, raw_calls: tracker.calls }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      warnings,
      raw_calls: tracker.calls,
    });
  }
}

export interface SetStateGuidedInput {
  ticketnr: string;
  state: string;
  notice?: string;
  param?: string;
  confirm?: boolean;
}

export async function setStateGuided(
  input: SetStateGuidedInput
): Promise<HelperEnvelope> {
  const tracker = new CallTracker();
  const appliedState = normalizeState(input.state);
  const planned = {
    ticketnr: input.ticketnr,
    requestedState: input.state,
    appliedState,
    notice: input.notice,
    param: input.param,
  };

  if (input.confirm !== true) {
    return okEnvelope(
      {
        mode: "preview",
        action: "set_state",
        planned,
        message: "Status wird nicht gesetzt. confirm:true zum Ausführen.",
      },
      { resolution: { confirm: false, appliedState } }
    );
  }

  const blocked = checkWriteGate(true);
  if (blocked) {
    return failEnvelope(blocked, {
      data: { mode: "blocked", action: "set_state", planned },
    });
  }

  try {
    const result = await tracker.track("set_state", () =>
      soap.setTicketState(input.ticketnr, appliedState, {
        notice: input.notice,
        param: input.param,
      })
    );
    return okEnvelope(
      {
        mode: "executed",
        action: "set_state",
        planned,
        ok: result.ok,
        httpStatus: result.httpStatus,
        success: result.success,
        errorText: result.errorText,
        infoText: result.infoText,
        data: result.json,
      },
      { resolution: { confirm: true, appliedState }, raw_calls: tracker.calls }
    );
  } catch (e) {
    return failEnvelope(e instanceof Error ? e.message : String(e), {
      raw_calls: tracker.calls,
    });
  }
}
