/**
 * Freitext router (heuristics / regex). No LLM in the server.
 */
import {
  failEnvelope,
  okEnvelope,
  type HelperEnvelope,
} from "./envelope.js";
import {
  extractMandant,
  extractPartnerId,
  extractSwenr,
  extractTicketnr,
  parseAddressFromText,
  parseHouseNumbers,
} from "./normalize.js";
import { detectStatusInText, detectTopicInText } from "./topic.js";
import { findTickets } from "./find-tickets.js";
import { ticketBriefing, type BriefingInclude } from "./ticket-briefing.js";
import { resolvePlace } from "./resolve-place.js";
import { getCatalog, type CatalogKind } from "./catalog.js";
import { partnerContext } from "./partner-context.js";
import { findDocuments } from "./find-documents.js";
import { getNews } from "./news.js";
import {
  addNoteGuided,
  createTicketGuided,
  setStateGuided,
} from "./write-guided.js";
import { SPEED } from "./speed.js";

export type AskIntent =
  | "find_tickets"
  | "ticket_briefing"
  | "resolve"
  | "catalog"
  | "partner_context"
  | "find_documents"
  | "news"
  | "damage_reports"
  | "create_ticket"
  | "add_note"
  | "set_state";

export interface ParsedAsk {
  intent: AskIntent;
  text: string;
  mandant?: string;
  street?: string;
  houseNumbers: string[];
  topic?: string;
  status?: string;
  ticketnr?: string;
  partnerId?: string;
  weNr?: string;
  note?: string;
  subject?: string;
  catalogKind?: CatalogKind;
  include?: BriefingInclude[];
  confidence: number;
}

const CATALOG_KINDS: CatalogKind[] = [
  "keywords",
  "statuses",
  "groups",
  "doc_types",
  "departments",
];

export function parseAsk(text: string): ParsedAsk {
  const src = text.trim();
  const ticketnr = extractTicketnr(src);
  const mandant = extractMandant(src);
  const partnerId = extractPartnerId(src);
  const weNr = extractSwenr(src);
  const addr = parseAddressFromText(src);
  const topic = detectTopicInText(src);
  const status = detectStatusInText(src);

  const lower = src.toLowerCase();
  const hasAddress = Boolean(addr.street || addr.houseNumbers.length);
  const hasPlace = Boolean(mandant || hasAddress);

  let include: BriefingInclude[] | undefined;
  if (/notiz/i.test(src)) include = [...(include ?? []), "notes"];
  if (/historie|verlauf|statushist/i.test(src)) include = [...(include ?? []), "history"];
  if (/verknüpf|link/i.test(src)) include = [...(include ?? []), "links"];
  if (/anlage|anhang|attachment/i.test(src)) include = [...(include ?? []), "attachments"];

  let intent: AskIntent = "find_tickets";
  let confidence = 0.45;

  if (/\b(anlegen|erstellen|neues ticket|neues vorgang)\b/i.test(src)) {
    intent = "create_ticket";
    confidence = 0.8;
  } else if (ticketnr && /\b(notiz|kommentar)\b/i.test(src) && /\b(setz|schreib|füg|add|hinzu)\b/i.test(src)) {
    intent = "add_note";
    confidence = 0.85;
  } else if (
    ticketnr &&
    /\b(schließ|status|auf geschlossen|setze? status|wiedervorlage)\b/i.test(src)
  ) {
    intent = "set_state";
    confidence = 0.8;
  } else if (ticketnr && (include?.length || /\b(briefing|details|zeig|lade)\b/i.test(src))) {
    intent = "ticket_briefing";
    confidence = 0.85;
  } else if (ticketnr && !hasPlace && !topic) {
    intent = "ticket_briefing";
    confidence = 0.7;
  } else if (
    /\b(katalog|schlagwort(?:e|en)?|belegtypen|dokumenttypen|statuswerte|abteilungen)\b/i.test(
      src
    )
  ) {
    intent = "catalog";
    confidence = 0.8;
  } else if (/\b(newsticker|news[\s-]?ticker|nachrichtenticker)\b/i.test(src)) {
    intent = "news";
    confidence = 0.85;
  } else if (
    /\b(schadensmeldungen|schadensmeldung|instandhaltungsmängel|maintenance issues)\b/i.test(
      src
    )
  ) {
    intent = "damage_reports";
    confidence = 0.8;
  } else if (
    /\b(objektakte|mieterakte|mietakte|liegenschaftsakte|dokument(?:e|en)?|beleg(?:e|en)?|akten?|anlage|anhang|korrespondenz|mietvertrag)\b/i.test(
      src
    ) &&
    !/\btickets?\b/i.test(src)
  ) {
    intent = "find_documents";
    confidence = 0.8;
  } else if (
    /\b(stammdaten|partnerkontext|mieterdaten|360)\b/i.test(src) ||
    (/\b(partner|mieter)\b/i.test(src) && !topic && !/\btickets?\b/i.test(src))
  ) {
    intent = "partner_context";
    confidence = 0.7;
  } else if (
    hasPlace &&
    !topic &&
    !/\btickets?\b/i.test(src) &&
    /\b(adresse|straße|strasse|auflös|partner\s+zu)\b/i.test(lower)
  ) {
    intent = "resolve";
    confidence = 0.75;
  } else if (hasPlace || topic || /\btickets?\b/i.test(src) || /\bmängel\b/i.test(lower)) {
    intent = "find_tickets";
    confidence = hasPlace && topic ? 0.9 : 0.7;
  }

  let catalogKind: CatalogKind | undefined;
  if (intent === "catalog") {
    if (/schlagwort/i.test(src)) catalogKind = "keywords";
    else if (/status/i.test(src)) catalogKind = "statuses";
    else if (/gruppe/i.test(src)) catalogKind = "groups";
    else if (/beleg|dokumenttyp/i.test(src)) catalogKind = "doc_types";
    else if (/abteilung/i.test(src)) catalogKind = "departments";
    else catalogKind = "keywords";
  }

  let note: string | undefined;
  const noteM = src.match(/(?:notiz|kommentar)\s*[:„"']\s*(.+)$/i);
  if (noteM) note = noteM[1].trim();

  return {
    intent,
    text: src,
    mandant,
    street: addr.street,
    houseNumbers: addr.houseNumbers,
    topic: topic?.label ?? topic?.input,
    status: status?.input,
    ticketnr,
    partnerId,
    weNr,
    note,
    subject: intent === "create_ticket" ? src : undefined,
    catalogKind,
    include,
    confidence,
  };
}

export interface AskInput {
  text: string;
  confirm?: boolean;
  include?: BriefingInclude[];
  catalogKind?: CatalogKind;
}

export async function ask(input: AskInput): Promise<HelperEnvelope> {
  const text = (input.text ?? "").trim();
  if (!text) {
    return failEnvelope("Freitext 'text' ist leer.", {
      resolution: { hint: "Beispiel: Mängel Mandant 27 Hauptstraße 118/118a/118b" },
    });
  }

  const parsed = parseAsk(text);
  if (input.include?.length) parsed.include = input.include;
  if (input.catalogKind && CATALOG_KINDS.includes(input.catalogKind)) {
    parsed.catalogKind = input.catalogKind;
  }

  const extraHouse = text.match(
    /(?:hausnr|hausnummer|nr\.?)\s*[:\s]+([0-9A-Za-z/, -]+)/i
  );
  if (extraHouse && !parsed.houseNumbers.length) {
    parsed.houseNumbers = parseHouseNumbers(extraHouse[1]);
  }

  let inner: HelperEnvelope;
  switch (parsed.intent) {
    case "ticket_briefing":
      if (!parsed.ticketnr) {
        inner = failEnvelope("Intent ticket_briefing, aber keine Ticketnr erkannt.");
        break;
      }
      inner = await ticketBriefing({
        ticketnr: parsed.ticketnr,
        include: parsed.include,
      });
      break;
    case "resolve":
      inner = await resolvePlace({
        query: text,
        mandant: parsed.mandant,
        street: parsed.street,
        houseNumbers: parsed.houseNumbers,
        weNr: parsed.weNr,
        partnerIds: parsed.partnerId ? [parsed.partnerId] : undefined,
      });
      break;
    case "news":
      inner = await getNews({ partnerId: parsed.partnerId });
      break;
    case "damage_reports":
      inner = await partnerContext({
        query: text,
        mandant: parsed.mandant,
        street: parsed.street,
        houseNumbers: parsed.houseNumbers,
        partnerId: parsed.partnerId,
        include: ["damage_reports"],
      });
      break;
    case "catalog":
      inner = await getCatalog(parsed.catalogKind ?? "keywords", parsed.topic);
      break;
    case "partner_context":
      inner = await partnerContext({
        query: text,
        mandant: parsed.mandant,
        street: parsed.street,
        houseNumbers: parsed.houseNumbers,
        partnerId: parsed.partnerId,
      });
      break;
    case "find_documents":
      inner = await findDocuments({
        query: text,
        ticketnr: parsed.ticketnr,
        partnerId: parsed.partnerId,
        mandant: parsed.mandant,
        street: parsed.street,
        houseNumbers: parsed.houseNumbers,
      });
      break;
    case "create_ticket":
      inner = await createTicketGuided({
        subject: parsed.subject ?? text,
        topic: parsed.topic,
        keyword: parsed.topic,
        partnerId: parsed.partnerId,
        mandant: parsed.mandant,
        street: parsed.street,
        houseNumbers: parsed.houseNumbers,
        description: text,
        confirm: input.confirm,
      });
      break;
    case "add_note":
      if (!parsed.ticketnr || !parsed.note) {
        inner = okEnvelope(
          { mode: "preview", action: "add_note", parsed },
          {
            warnings: [
              "Notiz-Intent erkannt, aber Ticketnr oder Notiztext unklar. " +
                "Nutze datasec_h_add_note mit ticketnr + note.",
            ],
            resolution: { parsed, confirm: false },
          }
        );
        break;
      }
      inner = await addNoteGuided({
        ticketnr: parsed.ticketnr,
        note: parsed.note,
        confirm: input.confirm,
      });
      break;
    case "set_state":
      if (!parsed.ticketnr) {
        inner = failEnvelope("Status-Intent ohne Ticketnr.");
        break;
      }
      inner = await setStateGuided({
        ticketnr: parsed.ticketnr,
        state: parsed.status ?? "CLOSED",
        confirm: input.confirm,
      });
      break;
    case "find_tickets":
    default:
      inner = await findTickets({
        query: text,
        mandant: parsed.mandant,
        street: parsed.street,
        houseNumbers: parsed.houseNumbers,
        weNr: parsed.weNr,
        topic: parsed.topic,
        status: parsed.status,
        ticketnr: parsed.ticketnr,
        partnerIds: parsed.partnerId ? [parsed.partnerId] : undefined,
        limit: SPEED.MAX_RESULTS,
      });
      break;
  }

  const extras = {
    resolution: {
      parsed,
      inner: inner.resolution,
      streetAsKeyword: false,
      router: "heuristics/regex (no LLM)",
      speed: "one helper call, then answer; seconds-latency",
    },
    ambiguities: inner.ambiguities,
    warnings: [
      ...(inner.ok
        ? []
        : [inner.error ?? "Innerer Helper-Call nicht ok — siehe result/error."]),
      ...(inner.warnings ?? []),
    ],
    raw_calls: inner.raw_calls,
  };
  const payload = { intent: parsed.intent, parsed, result: inner.data };
  if (!inner.ok) {
    return failEnvelope(inner.error ?? "Helper-Call fehlgeschlagen", {
      ...extras,
      data: payload,
    });
  }
  return okEnvelope(payload, extras);
}
