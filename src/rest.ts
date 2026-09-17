/**
 * Datasec REST client for tickets list/detail + field_count filters.
 */
import { session, redactSecrets } from "./client.js";

export interface RestFilter {
  field: string;
  op?: string;
  val: string;
  con?: "AND" | "OR" | "and" | "or";
}

export interface TicketSummary {
  ticketid?: string;
  ticketnr?: string;
  keyword?: string;
  subject?: string;
  state?: string;
  category?: string;
  postkorb?: string;
  type?: string;
  partnerid?: string;
  create_by?: string;
  create_on?: string;
  update_by?: string;
  update_on?: string;
  [key: string]: string | undefined;
}

export interface TicketListResult {
  ok: boolean;
  httpStatus: number;
  start: number;
  max: number;
  total: number | null;
  tickets: TicketSummary[];
  error?: string;
  rawSnippet?: string;
}

/** Minimal XML attribute parser (no external deps). */
function parseTicketsXml(xml: string): {
  start: number;
  max: number;
  total: number | null;
  tickets: TicketSummary[];
} {
  const rootMatch = xml.match(/<tickets\b([^>]*)>/i);
  let start = 1;
  let max = 10;
  let total: number | null = null;
  if (rootMatch) {
    const attrs = rootMatch[1];
    const s = attrs.match(/\bstart="([^"]*)"/i);
    const m = attrs.match(/\bmax="([^"]*)"/i);
    const t = attrs.match(/\btotal="([^"]*)"/i);
    if (s) start = Number(s[1]) || 1;
    if (m) max = Number(m[1]) || 10;
    if (t) total = Number(t[1]);
  }

  const tickets: TicketSummary[] = [];
  const ticketRe = /<ticket\b([^>]*)\s*(?:\/>|>([\s\S]*?)<\/ticket>)/gi;
  let match: RegExpExecArray | null;
  while ((match = ticketRe.exec(xml)) !== null) {
    const attrStr = match[1];
    const inner = match[2] ?? "";
    const t: TicketSummary = {};
    const attrRe = /([a-zA-Z0-9_.:-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrStr)) !== null) {
      t[am[1]] = am[2];
    }
    const childRe = /<([a-zA-Z0-9_.:-]+)>([^<]*)<\/\1>/g;
    let cm: RegExpExecArray | null;
    while ((cm = childRe.exec(inner)) !== null) {
      if (!t[cm[1]]) t[cm[1]] = cm[2];
    }
    tickets.push(t);
  }
  return { start, max, total, tickets };
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

export async function searchTickets(opts: {
  start?: number;
  max?: number;
  sort?: string;
  dir?: "asc" | "desc";
  filters?: RestFilter[];
}): Promise<TicketListResult> {
  const token = session.getToken();
  const start = opts.start ?? 1;
  const max = opts.max ?? 10;
  const params: Record<string, string | number | undefined> = {
    authtoken: token,
    start,
    max,
    sort: opts.sort ?? "create_on",
    dir: opts.dir ?? "desc",
  };

  const filters = opts.filters ?? [];
  if (filters.length > 0) {
    params.field_count = filters.length;
    filters.forEach((f, i) => {
      const n = i + 1;
      params[`f${n}`] = f.field;
      params[`f${n}_op`] = f.op ?? "=";
      params[`f${n}_val`] = f.val;
      if (i < filters.length - 1) {
        params[`f${n}_con`] = (f.con ?? "AND").toUpperCase();
      }
    });
  }

  const url = `${session.restBase}tickets/?${buildQuery(params)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await res.text();
    const safe = redactSecrets(text, token);
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        start,
        max,
        total: null,
        tickets: [],
        error: `HTTP ${res.status}`,
        rawSnippet: safe.slice(0, 800),
      };
    }
    const parsed = parseTicketsXml(safe);
    return {
      ok: true,
      httpStatus: res.status,
      start: parsed.start,
      max: parsed.max,
      total: parsed.total,
      tickets: parsed.tickets,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      start,
      max,
      total: null,
      tickets: [],
      error: redactSecrets(msg, token),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getTicketByNr(ticketnr: string): Promise<{
  ok: boolean;
  ticket: TicketSummary | null;
  error?: string;
  listMeta?: TicketListResult;
}> {
  const list = await searchTickets({
    start: 1,
    max: 10,
    filters: [{ field: "TICKETNR", op: "=", val: ticketnr }],
  });
  if (!list.ok) {
    return { ok: false, ticket: null, error: list.error, listMeta: list };
  }
  const hit =
    list.tickets.find((t) => t.ticketnr === ticketnr) ?? list.tickets[0] ?? null;
  if (!hit) {
    return {
      ok: false,
      ticket: null,
      error: `Ticket ${ticketnr} nicht gefunden`,
      listMeta: list,
    };
  }

  if (hit.ticketid) {
    const detail = await getTicketDetail(hit.ticketid);
    if (detail.ok && detail.ticket) {
      return { ok: true, ticket: { ...hit, ...detail.ticket }, listMeta: list };
    }
  }
  return { ok: true, ticket: hit, listMeta: list };
}

export async function getTicketDetail(ticketid: string): Promise<{
  ok: boolean;
  httpStatus: number;
  ticket: TicketSummary | null;
  error?: string;
  rawSnippet?: string;
}> {
  const token = session.getToken();
  const url = `${session.restBase}ticket/${encodeURIComponent(ticketid)}?${buildQuery({
    authtoken: token,
  })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await res.text();
    const safe = redactSecrets(text, token);
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        ticket: null,
        error: `HTTP ${res.status}`,
        rawSnippet: safe.slice(0, 800),
      };
    }
    const parsed = parseTicketsXml(safe);
    let ticket = parsed.tickets[0] ?? null;
    if (!ticket) {
      const single = safe.match(/<ticket\b([^>]*)/i);
      if (single) {
        ticket = {};
        const attrRe = /([a-zA-Z0-9_.:-]+)="([^"]*)"/g;
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(single[1])) !== null) {
          ticket[am[1]] = am[2];
        }
      }
    }
    return { ok: true, httpStatus: res.status, ticket };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      ticket: null,
      error: redactSecrets(msg, token),
    };
  } finally {
    clearTimeout(timer);
  }
}
