/**
 * Stammdaten + Weitere Funktionen (API V1.7 §2.5.3 / §2.5.4).
 * SOAP Masterdata.cfc / Newsticker.cfc
 */
import { soapMethod, type SoapResult } from "./soap.js";

function md(
  method: string,
  params: Record<string, string | undefined | null>,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return soapMethod(method, params, { cfc: "Masterdata", ...opts });
}

/** §2.5.3.1 */
export function getPartnerId(sParamsJson: string): Promise<SoapResult> {
  return md("getPartnerId", { sParams: sParamsJson });
}

/** §2.5.3.2 */
export function getPartnerContracts(
  sPartner: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return md("getPartnerContracts", { sPartner }, opts);
}

/** §2.5.3.3 */
export function getPartnerMasterdata(
  sPartnerid: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return md("getPartnerMasterdata", { sPartnerid }, opts);
}

/** §2.5.3.4 */
export function getAddPartnersMasterdata(
  sPartnerid: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return md("getAddPartnersMasterdata", { sPartnerid }, opts);
}

/** §2.5.3.5 */
export function getPartnerExtMasterdata(
  sPartnerid: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return md("getPartnerExtMasterdata", { sPartnerid }, opts);
}

/** §2.5.3.6 */
export function getPartnerConditionsApp(
  sPartnerid: string,
  opts?: { timeoutMs?: number }
): Promise<SoapResult> {
  return md("getPartnerConditionsApp", { sPartnerid }, opts);
}

/** §2.5.3.7 */
export function getAppUser(sStart = "0"): Promise<SoapResult> {
  return md("getAppUser", { sStart });
}

/** §2.5.3.8 — takes sPartner (PARTNER number) */
export function getGPMasterdata(sPartner: string): Promise<SoapResult> {
  return md("getGPMasterdata", { sPartner });
}

/** §2.5.3.9 */
export function setDocRead(opts: {
  partnerid: string;
  docid: string;
  readOn: string;
  appRendering?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<SoapResult> {
  return md("setDocRead", {
    sPartnerid: opts.partnerid,
    sDocid: opts.docid,
    sReadOn: opts.readOn,
    sAppRendering: opts.appRendering ?? "false",
    sDateFrom: opts.dateFrom ?? "",
    sDateTo: opts.dateTo ?? "",
  });
}

/** §2.5.3.10 */
export function setGRPfromPartner(opts: {
  grp: string;
  partnerid?: string;
  partner?: string;
}): Promise<SoapResult> {
  return md("setGRPfromPartner", {
    sGrp: opts.grp,
    sPartnerid: opts.partnerid ?? "",
    sPartner: opts.partner ?? "",
  });
}

/** §2.5.3.11 */
export function updatePartnerData(opts: {
  type: string;
  newValue: string;
  partnerid?: string;
  partner?: string;
}): Promise<SoapResult> {
  return md("updatePartnerData", {
    sType: opts.type,
    sNewValue: opts.newValue,
    sPartnerid: opts.partnerid ?? "",
    sPartner: opts.partner ?? "",
  });
}

/** §2.5.3.12 */
export function addEEDData(dataJson: string): Promise<SoapResult> {
  return md("addEEDData", { data: dataJson });
}

/** §2.5.3.13 */
export function getSpecialData(opts: {
  type: string;
  partnerid?: string;
}): Promise<SoapResult> {
  return md("getSpecialData", {
    sType: opts.type,
    sPartnerid: opts.partnerid ?? "",
  });
}

/** §2.5.4.1 */
export function getPartnerMaintenanceIssues(opts: {
  partnerid?: string;
  datefrom?: string;
  dateto?: string;
  timeoutMs?: number;
}): Promise<SoapResult> {
  return md(
    "getPartnerMaintenanceIssues",
    {
      sPartnerid: opts.partnerid ?? "",
      sDatefrom: opts.datefrom ?? "",
      sDateto: opts.dateto ?? "",
    },
    { timeoutMs: opts.timeoutMs }
  );
}

/** §2.5.4.2 Newsticker.cfc */
export function getNewsticker(sPartnerid: string): Promise<SoapResult> {
  return soapMethod("getNewsticker", { sPartnerid }, { cfc: "Newsticker" });
}
