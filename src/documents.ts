/**
 * Documents REST + SOAP (API V1.7 §2.5.1).
 */
import { session, redactSecrets, soapEndpointFor, xmlEscape } from "./client.js";
import { soapCall, type SoapResult } from "./soap.js";
import type { RestFilter } from "./rest.js";

function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

function applyFilters(
  params: Record<string, string | number | undefined>,
  filters: RestFilter[]
): void {
  if (filters.length === 0) return;
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

export interface DocRestResult {
  ok: boolean;
  httpStatus: number;
  contentType: string | null;
  text: string;
  isBinary: boolean;
  base64?: string;
  error?: string;
}

async function restGet(
  path: string,
  extra?: Record<string, string | number | undefined>
): Promise<DocRestResult> {
  const token = session.getToken();
  const q = buildQuery({ authtoken: token, ...(extra ?? {}) });
  const sep = path.includes("?") ? "&" : "?";
  const url = `${session.restBase}${path}${sep}${q}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const ct = res.headers.get("content-type");
    const buf = Buffer.from(await res.arrayBuffer());
    const binaryHint =
      !!ct &&
      (/application\/(pdf|x-dw-zip|octet-stream|zip)/i.test(ct) ||
        (!/xml|json|text|javascript/i.test(ct) && !ct.includes("html")));
    if (!res.ok) {
      const text = redactSecrets(buf.toString("utf8"), token);
      return {
        ok: false,
        httpStatus: res.status,
        contentType: ct,
        text: text.slice(0, 2000),
        isBinary: false,
        error: `HTTP ${res.status}`,
      };
    }
    if (binaryHint) {
      return {
        ok: true,
        httpStatus: res.status,
        contentType: ct,
        text: "",
        isBinary: true,
        base64: buf.toString("base64"),
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      contentType: ct,
      text: redactSecrets(buf.toString("utf8"), token),
      isBinary: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      contentType: null,
      text: "",
      isBinary: false,
      error: redactSecrets(msg, token),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** §2.5.1.1 */
export async function getDocument(opts: {
  documentType: string;
  indexField: string;
  indexValue: string;
  merge?: boolean;
}): Promise<DocRestResult> {
  const path = `documents/${encodeURIComponent(opts.documentType)}/${encodeURIComponent(opts.indexField)}/${encodeURIComponent(opts.indexValue)}`;
  const merge =
    opts.merge === false ? "false" : opts.merge === true ? "true" : undefined;
  return restGet(path, { merge });
}

/** §2.5.1.2 updateIndexValues2 */
export async function updateDocument(opts: {
  documentType: string;
  collectid: string;
  fieldnames: string[];
  fieldvalues: string[];
}): Promise<SoapResult> {
  const token = session.getToken();
  const names = opts.fieldnames.join("|");
  const values = opts.fieldvalues.join("|");
  const inner =
    `    <dw:updateIndexValues2>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:documentType>${xmlEscape(opts.documentType)}</dw:documentType>\n` +
    `      <dw:collectid>${xmlEscape(opts.collectid)}</dw:collectid>\n` +
    `      <dw:fieldname>${xmlEscape(names)}</dw:fieldname>\n` +
    `      <dw:fieldvalue>${xmlEscape(values)}</dw:fieldvalue>\n` +
    `    </dw:updateIndexValues2>`;
  return soapCall("updateIndexValues2", inner, { cfc: "updateDocuments" });
}

/** §2.5.1.3 insertDoc2_1 */
export async function archiveDocumentSoap(opts: {
  documentType: string;
  fieldnames: string[];
  fieldvalues: string[];
  inputfileBase64: string;
  filetype: string;
  convertToPDF?: boolean;
  mailboxEntry?: string;
  ticketid?: string;
}): Promise<SoapResult> {
  const token = session.getToken();
  const names = opts.fieldnames.join("|");
  const values = opts.fieldvalues.join("|");
  const inner =
    `    <dw:insertDoc2_1>\n` +
    `      <dw:authToken>${xmlEscape(token)}</dw:authToken>\n` +
    `      <dw:documentType>${xmlEscape(opts.documentType)}</dw:documentType>\n` +
    `      <dw:fieldname>${xmlEscape(names)}</dw:fieldname>\n` +
    `      <dw:fieldvalue>${xmlEscape(values)}</dw:fieldvalue>\n` +
    `      <dw:inputfile>${xmlEscape(opts.inputfileBase64)}</dw:inputfile>\n` +
    `      <dw:filetype>${xmlEscape(opts.filetype)}</dw:filetype>\n` +
    `      <dw:convertToPDF>${opts.convertToPDF ? "true" : "false"}</dw:convertToPDF>\n` +
    `      <dw:sMailboxEntry>${xmlEscape(opts.mailboxEntry ?? "")}</dw:sMailboxEntry>\n` +
    `      <dw:sTicketid>${xmlEscape(opts.ticketid ?? "")}</dw:sTicketid>\n` +
    `    </dw:insertDoc2_1>`;
  return soapCall("insertDoc2_1", inner, { cfc: "addDocuments", timeoutMs: 180_000 });
}

/** §2.5.1.4 REST archive */
export async function archiveDocumentRest(opts: {
  documentType: string;
  indexfields: Record<string, string>;
  inputfileBase64: string;
  filetype: string;
  convertToPDF?: boolean;
  mailboxentry?: string;
  ticketid?: string;
}): Promise<{ ok: boolean; httpStatus: number; text: string; error?: string }> {
  const token = session.getToken();
  const url = `${session.restBase}adddocument/${encodeURIComponent(opts.documentType)}?${buildQuery({
    authtoken: token,
  })}`;
  const body: Record<string, unknown> = {
    indexfields: opts.indexfields,
    inputfile: opts.inputfileBase64,
    filetype: opts.filetype,
    convertToPDF: opts.convertToPDF ? "true" : "false",
  };
  if (opts.mailboxentry) body.mailboxentry = opts.mailboxentry;
  if (opts.ticketid) body.ticketid = opts.ticketid;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = redactSecrets(await res.text(), token);
    return {
      ok: res.ok,
      httpStatus: res.status,
      text,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus: 0, text: "", error: redactSecrets(msg, token) };
  } finally {
    clearTimeout(timer);
  }
}

/** §2.5.1.5 */
export async function searchByDocumentType(opts: {
  documentType: string;
  start?: number;
  max?: number;
  filters?: RestFilter[];
}): Promise<DocRestResult> {
  const params: Record<string, string | number | undefined> = {
    start: opts.start ?? 1,
    max: opts.max ?? 10,
  };
  applyFilters(params, opts.filters ?? []);
  return restGet(`indexes/${encodeURIComponent(opts.documentType)}/`, params);
}

/** §2.5.1.6 */
export async function searchInProcess(opts: {
  documentType: string;
  start?: number;
  max?: number;
  filters?: RestFilter[];
}): Promise<DocRestResult> {
  const params: Record<string, string | number | undefined> = {
    start: opts.start ?? 1,
    max: opts.max ?? 10,
  };
  applyFilters(params, opts.filters ?? []);
  return restGet(
    `collection-by-indexes/${encodeURIComponent(opts.documentType)}/`,
    params
  );
}

/** §2.5.1.7 */
export async function listDepartments(): Promise<DocRestResult> {
  return restGet("departments/");
}

/** §2.5.1.8 */
export async function listDocumentTypes(): Promise<DocRestResult> {
  return restGet("document-types/");
}

/** §2.5.1.9 */
export async function getDocumentTypeStructure(
  documentType: string
): Promise<DocRestResult> {
  return restGet(`document-types/${encodeURIComponent(documentType)}/`);
}

export function documentSoapEndpoints() {
  return {
    updateDocuments: soapEndpointFor("updateDocuments"),
    addDocuments: soapEndpointFor("addDocuments"),
  };
}
