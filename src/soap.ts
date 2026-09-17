/**
 * Datasec SOAP client — raw HTTP POST only (WSDL proxy often 403).
 * Content-Type: text/xml; charset=utf-8, SOAPAction: ""
 */
import { session, redactSecrets, xmlEscape, soapEndpointFor, type SoapCfc } from "./client.js";

export interface SoapResult {
  ok: boolean;
  httpStatus: number;
  rawXml: string;
  /** Parsed return payload when JSON-in-SOAP; otherwise null. */
  json: unknown | null;
  returnText: string | null;
  success?: boolean;
  errorText?: string;
  infoText?: string;
}

function buildEnvelope(methodBody: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:dw="http://soapinterop.org/">\n` +
    `  <soapenv:Header/>\n` +
    `  <soapenv:Body>\n` +
    methodBody +
    `\n  </soapenv:Body>\n` +
    `</soapenv:Envelope>`
  );
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractReturn(xml: string, method: string): string | null {
  // ColdFusion style: <methodReturn>...</methodReturn> or ns-prefixed
  const patterns = [
    new RegExp(`<[^:>]*:?${method}Return[^>]*>([\\s\\S]*?)</[^:>]*:?${method}Return>`, "i"),
    new RegExp(`<return[^>]*>([\\s\\S]*?)</return>`, "i"),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return decodeXmlEntities(m[1].trim());
  }
  return null;
}

function tryParseJson(text: string | null): unknown | null {
  if (!text) return null;
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function pickFlags(json: unknown): { success?: boolean; errorText?: string; infoText?: string } {
  if (!json || typeof json !== "object") return {};
  const o = json as Record<string, unknown>;
  const success =
    typeof o.SUCCESS === "boolean"
      ? o.SUCCESS
      : typeof o.success === "boolean"
        ? o.success
        : undefined;
  const errorText =
    typeof o.ERRORTEXT === "string"
      ? o.ERRORTEXT
      : typeof o.errorText === "string"
        ? o.errorText
        : undefined;
  const infoText =
    typeof o.INFOTEXT === "string"
      ? o.INFOTEXT
      : typeof o.infoText === "string"
        ? o.infoText
        : undefined;
  return { success, errorText, infoText };
}

export async function soapCall(
  method: string,
  innerXml: string,
  opts?: { timeoutMs?: number; cfc?: SoapCfc; endpoint?: string }
): Promise<SoapResult> {
  const token = session.getToken();
  const body = buildEnvelope(innerXml);
  const endpoint = opts?.endpoint ?? soapEndpointFor(opts?.cfc ?? "Tickets");
  const controller = new AbortController();
  const timeout = opts?.timeoutMs ?? 90_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '""',
      },
      body: Buffer.from(body, "utf8"),
      signal: controller.signal,
    });
    const raw = await res.text();
    const safe = redactSecrets(raw, token);
    const returnText = extractReturn(safe, method);
    const json = tryParseJson(returnText);
    const flags = pickFlags(json);
    const okHttp = res.status >= 200 && res.status < 300;
    const ok =
      okHttp &&
      (flags.success === undefined ? true : flags.success === true) &&
      !/soapenv:Fault|faultstring/i.test(safe);

    return {
      ok,
      httpStatus: res.status,
      rawXml: safe,
      json,
      returnText,
      ...flags,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      rawXml: "",
      json: null,
      returnText: null,
      success: false,
      errorText: redactSecrets(msg, token),
    };
  } finally {
    clearTimeout(timer);
  }
}


/** Build <dw:param>value</dw:param> lines (skips undefined). */
export function dwParams(params: Record<string, string | undefined | null>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    lines.push(`      <dw:${k}>${xmlEscape(String(v))}</dw:${k}>`);
  }
  return lines.join("\n");
}

export function soapMethod(
  method: string,
  params: Record<string, string | undefined | null>,
  opts?: { timeoutMs?: number; cfc?: SoapCfc }
): Promise<SoapResult> {
  const token = session.getToken();
  const inner =
    `    <dw:${method}>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    dwParams(params) +
    `\n    </dw:${method}>`;
  return soapCall(method, inner, opts);
}

export async function getTicketNotes(
  ticketnr: string,
  filter = "",
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  const token = session.getToken();
  const inner =
    `    <dw:getTicketNotes>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:sTicketnr>${xmlEscape(ticketnr)}</dw:sTicketnr>\n` +
    `      <dw:sFilter>${xmlEscape(filter)}</dw:sFilter>\n` +
    `    </dw:getTicketNotes>`;
  return soapCall("getTicketNotes", inner, opts);
}

export async function addTicketNote(ticketnr: string, note: string): Promise<SoapResult> {
  const token = session.getToken();
  const inner =
    `    <dw:addTicketNote>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:sTicketnr>${xmlEscape(ticketnr)}</dw:sTicketnr>\n` +
    `      <dw:sNote>${xmlEscape(note)}</dw:sNote>\n` +
    `    </dw:addTicketNote>`;
  return soapCall("addTicketNote", inner);
}

export async function setTicketState(
  ticketnr: string,
  newState: string,
  opts?: { notice?: string; param?: string; disableDepositCheck?: boolean }
): Promise<SoapResult> {
  const token = session.getToken();
  const notice = opts?.notice;
  let inner: string;
  if (notice !== undefined || opts?.param !== undefined || opts?.disableDepositCheck !== undefined) {
    inner =
      `    <dw:setTicketState>\n` +
      `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
      `      <dw:sTicketnr>${xmlEscape(ticketnr)}</dw:sTicketnr>\n` +
      `      <dw:sNewState>${xmlEscape(newState)}</dw:sNewState>\n` +
      `      <dw:sParam>${xmlEscape(opts?.param ?? "")}</dw:sParam>\n` +
      `      <dw:bDisableDepositCheck>${opts?.disableDepositCheck ? "true" : "false"}</dw:bDisableDepositCheck>\n` +
      `      <dw:sNotice>${xmlEscape(notice ?? "")}</dw:sNotice>\n` +
      `    </dw:setTicketState>`;
  } else {
    inner =
      `    <dw:setTicketState>\n` +
      `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
      `      <dw:sTicketnr>${xmlEscape(ticketnr)}</dw:sTicketnr>\n` +
      `      <dw:sNewState>${xmlEscape(newState)}</dw:sNewState>\n` +
      `    </dw:setTicketState>`;
  }
  return soapCall("setTicketState", inner);
}

export async function linkTicketToTicket(
  ticketnr: string,
  linkTicketNr: string
): Promise<SoapResult> {
  const token = session.getToken();
  const inner =
    `    <dw:linkTicketToTicket>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:sTicketnr>${xmlEscape(ticketnr)}</dw:sTicketnr>\n` +
    `      <dw:sLinkTicketNr>${xmlEscape(linkTicketNr)}</dw:sLinkTicketNr>\n` +
    `    </dw:linkTicketToTicket>`;
  return soapCall("linkTicketToTicket", inner);
}

/** Requires internal ticketid (not ticketnr). */
export async function getLinkedTickets(
  ticketid: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  const token = session.getToken();
  const inner =
    `    <dw:getLinkedTickets>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:sTicketid>${xmlEscape(ticketid)}</dw:sTicketid>\n` +
    `    </dw:getLinkedTickets>`;
  return soapCall("getLinkedTickets", inner, opts);
}

/** Date format: YYYY-MM-DD HH24:MI:SS */
export async function getTicketsStatesHist(
  dateFrom: string,
  dateTo: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  const token = session.getToken();
  const inner =
    `    <dw:getTicketsStatesHist>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:sDateFrom>${xmlEscape(dateFrom)}</dw:sDateFrom>\n` +
    `      <dw:sDateTo>${xmlEscape(dateTo)}</dw:sDateTo>\n` +
    `    </dw:getTicketsStatesHist>`;
  return soapCall("getTicketsStatesHist", inner, {
    timeoutMs: opts?.timeoutMs ?? 120_000,
  });
}

// ── Additional ticket SOAP (API V1.7 §2.5.2) ─────────────────────────

export async function createMasterTicket(opts: {
  subject: string;
  partner: string;
  keyword: string;
  category?: string;
  postkorb?: string;
  channel?: string;
  description?: string;
  type?: string;
  plz?: string;
  ticketgroup?: string;
  fieldvalues?: string;
  priority?: string;
  reminderDate?: string;
  ticketids?: string;
}): Promise<SoapResult> {
  return soapMethod("createMasterTicket", {
    sSubject: opts.subject,
    sPartner: opts.partner,
    sKeyword: opts.keyword,
    sCategory: opts.category ?? "",
    sPostkorb: opts.postkorb ?? "",
    sChannel: opts.channel ?? "POST",
    sDescription: opts.description ?? "",
    sType: opts.type ?? "1",
    sPLZ: opts.plz ?? "",
    sTicketgroup: opts.ticketgroup ?? "",
    sFieldvalues: opts.fieldvalues ?? "",
    sPriority: opts.priority ?? "",
    ReminderDate: opts.reminderDate ?? "",
    lTicketids: opts.ticketids ?? "",
  });
}

export async function createTicket(opts: {
  subject: string;
  partner: string;
  keyword: string;
  category?: string;
  channel?: string;
  description?: string;
  type?: string;
  plz?: string;
  ticketgroup?: string;
  fieldvalues?: string;
  priority?: string;
  ticketsystem?: string;
}): Promise<SoapResult> {
  return soapMethod("createTicket", {
    sSubject: opts.subject,
    sPartner: opts.partner,
    sKeyword: opts.keyword,
    sCategory: opts.category ?? "",
    sChannel: opts.channel ?? "POST",
    sDescription: opts.description ?? "",
    sType: opts.type ?? "1",
    sPLZ: opts.plz ?? "",
    sTicketgroup: opts.ticketgroup ?? "",
    sFieldvalues: opts.fieldvalues ?? "",
    sPriority: opts.priority ?? "",
    sTicketsystem: opts.ticketsystem ?? "",
  });
}

export async function linkTicketToMaster(
  ticketnr: string,
  masterNr: string,
  subject?: string
): Promise<SoapResult> {
  return soapMethod("linkTicketToMaster", {
    sTicketnr: ticketnr,
    sMasterNr: masterNr,
    sSubject: subject ?? "",
  });
}

export async function forwardTicket(
  ticketnr: string,
  receiver: string,
  disableDepositCheck = false
): Promise<SoapResult> {
  return soapMethod("forwardTicket", {
    sTicketnr: ticketnr,
    sReceiver: receiver,
    bDisableDepositCheck: disableDepositCheck ? "true" : "false",
  });
}

export async function doTicketProcessAction(
  ticketnr: string,
  buttonId: string,
  params = ""
): Promise<SoapResult> {
  return soapMethod("doTicketProcessAction", {
    sTicketnr: ticketnr,
    sButtonId: buttonId,
    sParams: params,
  });
}

export async function getTicketProcessButtons(
  ticketnr: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return soapMethod("getTicketProcessButtons", { sTicketnr: ticketnr }, opts);
}

export async function getTicketProcessFields(ticketnr: string): Promise<SoapResult> {
  return soapMethod("getTicketProcessFields", { sTicketnr: ticketnr });
}

export async function changeTicketKeyword(
  ticketnr: string,
  newKeyword: string,
  opts?: {
    note?: string;
    newSubject?: string;
    channel?: string;
    keywordAlias?: string;
    ticketsystem?: string;
  }
): Promise<SoapResult> {
  return soapMethod("changeTicketKeyword", {
    sTicketnr: ticketnr,
    sNewKeyword: newKeyword,
    sNote: opts?.note ?? "",
    sNewSubject: opts?.newSubject ?? "",
    sChannel: opts?.channel ?? "",
    sKeywordAlias: opts?.keywordAlias ?? "",
    sTicketsystem: opts?.ticketsystem ?? "",
  });
}

export async function setTicketValues(
  ticketnr: string,
  fieldvalues: string
): Promise<SoapResult> {
  return soapMethod("setTicketValues", {
    sTicketnr: ticketnr,
    sFieldvalues: fieldvalues,
  });
}

export async function getKeywords(
  channel = "",
  ticketsystem = "",
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return soapMethod(
    "getKeywords",
    {
      sChannel: channel,
      sTicketsystem: ticketsystem,
    },
    opts
  );
}

export async function getTicketProcessFieldsFirstStep(opts: {
  keyword: string;
  channel: string;
  ticketsystem?: string;
  ticketnr?: string;
}): Promise<SoapResult> {
  if (opts.ticketnr) {
    return soapMethod("getTicketProcessFieldsFirstStepTicketNr", {
      sKeyword: opts.keyword,
      sChannel: opts.channel,
      sTicketsystem: opts.ticketsystem ?? "",
      sTicketnr: opts.ticketnr,
    });
  }
  return soapMethod("getTicketProcessFieldsFirstStep", {
    sKeyword: opts.keyword,
    sChannel: opts.channel,
    sTicketsystem: opts.ticketsystem ?? "",
  });
}

export async function getNewTicketChatNotes(
  dateFrom: string,
  dateTo: string,
  ticketnr?: string
): Promise<SoapResult> {
  return soapMethod(
    "getNewTicketChatNotes",
    {
      sDateFrom: dateFrom,
      sDateTo: dateTo,
      sTicketnr: ticketnr ?? "",
    },
    { timeoutMs: 120_000 }
  );
}
