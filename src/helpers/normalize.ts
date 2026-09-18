/**
 * German street / house-number / freitext field parsing.
 * Deterministic — no LLM.
 */

const UMLAUT: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  Ä: "ae",
  Ö: "oe",
  Ü: "ue",
};

const STREET_SUFFIX =
  "(?:strasse|straße|str\\.?|weg|platz|allee|ring|gasse|damm|ufer|steig|chaussee|pfad|zeile)";

/** Compound or split street token: Hauptstraße, Musterstr., An der Allee */
const STREET_TOKEN = `(?:[\\p{L}-]+)?${STREET_SUFFIX}`;
/** Fold German letters for matching (Straße → strasse). */
export function foldGerman(s: string): string {
  return s.replace(/[äöüßÄÖÜ]/g, (ch) => UMLAUT[ch] ?? ch);
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Canonical street key: lowercased, folded, str./straße → strasse. */
export function streetKey(s: string): string {
  let t = foldGerman(collapseWs(s)).toLowerCase();
  t = t.replace(/[–—−]/g, "-");
  t = t.replace(/\bstr(?:asse)?\.?\b/g, "strasse");
  t = t.replace(/str\./g, "strasse");
  t = t.replace(/str$/g, "strasse");
  t = t.replace(/\./g, "");
  t = t.replace(/[^\p{L}\p{N}\s-]/gu, " ");
  return collapseWs(t);
}

export function normalizeStreet(s: string): string {
  const t = collapseWs(s).replace(/[–—−]/g, "-");
  return t
    .replace(/\bStr(?:asse)?\b\.?/gi, (m) =>
      /sse/i.test(m) ? m.replace(/str/i, "Str") : "Straße"
    )
    .replace(/(\p{L})str\.?\b/giu, "$1straße");
}

export function houseKey(s: string): string {
  return collapseWs(s).toLowerCase().replace(/\s+/g, "");
}

const MAX_RANGE = 30;

function expandNumericRange(from: number, to: number): string[] {
  if (to < from) [from, to] = [to, from];
  if (to - from + 1 > MAX_RANGE) {
    return [String(from), String(to)];
  }
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(String(n));
  return out;
}

function expandLetterRange(base: string, from: string, to: string): string[] {
  const a = from.toLowerCase();
  const b = to.toLowerCase();
  if (a.length !== 1 || b.length !== 1) return [`${base}${a}`, `${base}${b}`];
  let start = a.charCodeAt(0);
  let end = b.charCodeAt(0);
  if (end < start) [start, end] = [end, start];
  if (end - start + 1 > 12) return [`${base}${a}`, `${base}${b}`];
  const out: string[] = [];
  for (let c = start; c <= end; c++) {
    out.push(`${base}${String.fromCharCode(c)}`);
  }
  return out;
}

/**
 * Parse German house-number lists:
 *   118/118a/118b  → 118, 118a, 118b
 *   118/a/b        → 118, 118a, 118b
 *   118-120        → 118, 119, 120
 *   118a-c         → 118a, 118b, 118c
 *   118 a-c        → 118a, 118b, 118c
 */
export function parseHouseNumbers(input: string): string[] {
  const raw = collapseWs(input ?? "").replace(/[–—−]/g, "-");
  if (!raw) return [];

  const stripped = raw.replace(/^(?:hsnr|hausnr|hausnummer|nr\.?|no\.?)\s*/i, "");
  const parts = stripped
    .split(/[/,;]|(?:\s+und\s+)/i)
    .map((p) => collapseWs(p))
    .filter(Boolean);

  const out: string[] = [];
  let lastBase = "";

  const push = (v: string) => {
    const k = houseKey(v);
    if (!k) return;
    if (!out.some((x) => houseKey(x) === k)) out.push(k);
  };

  for (const part of parts) {
    const letterOnly = part.match(/^([A-Za-z])$/);
    if (letterOnly && lastBase) {
      push(`${lastBase}${letterOnly[1].toLowerCase()}`);
      continue;
    }

    const spacedLetterRange = part.match(/^(\d+)\s+([A-Za-z])\s*-\s*([A-Za-z])$/);
    if (spacedLetterRange) {
      lastBase = spacedLetterRange[1];
      for (const n of expandLetterRange(
        lastBase,
        spacedLetterRange[2],
        spacedLetterRange[3]
      )) {
        push(n);
      }
      continue;
    }

    const compactLetterRange = part.match(/^(\d+)\s*([A-Za-z])\s*-\s*([A-Za-z])$/);
    if (compactLetterRange) {
      lastBase = compactLetterRange[1];
      for (const n of expandLetterRange(
        lastBase,
        compactLetterRange[2],
        compactLetterRange[3]
      )) {
        push(n);
      }
      continue;
    }

    const fullLetterRange = part.match(
      /^(\d+)\s*([A-Za-z])\s*-\s*\1\s*([A-Za-z])$/
    );
    if (fullLetterRange) {
      lastBase = fullLetterRange[1];
      for (const n of expandLetterRange(
        lastBase,
        fullLetterRange[2],
        fullLetterRange[3]
      )) {
        push(n);
      }
      continue;
    }

    const numRange = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (numRange) {
      lastBase = numRange[1];
      for (const n of expandNumericRange(Number(numRange[1]), Number(numRange[2]))) {
        push(n);
      }
      continue;
    }

    const mixedEnd = part.match(/^(\d+)\s*-\s*(\d+)\s*([A-Za-z])$/);
    if (mixedEnd) {
      const nums = expandNumericRange(Number(mixedEnd[1]), Number(mixedEnd[2]));
      lastBase = mixedEnd[2];
      nums.forEach((n, i) => {
        if (i === nums.length - 1) push(`${n}${mixedEnd[3].toLowerCase()}`);
        else push(n);
      });
      continue;
    }

    const simple = part.match(/^(\d+)\s*([A-Za-z])?$/);
    if (simple) {
      lastBase = simple[1];
      push(simple[2] ? `${simple[1]}${simple[2].toLowerCase()}` : simple[1]);
      continue;
    }

    const leftover = houseKey(part);
    if (leftover) {
      const m = leftover.match(/^(\d+)/);
      if (m) lastBase = m[1];
      push(leftover);
    }
  }

  return out;
}

export interface ParsedAddress {
  street?: string;
  houseNumbers: string[];
  raw?: string;
}

const STREET_RE = new RegExp(
  `\\b((?:[Aa]n\\s+der\\s+|[Aa]m\\s+|[Ii]m\\s+|[Aa]uf\\s+der\\s+|[Ii]n\\s+der\\s+)?${STREET_TOKEN}(?:\\s+${STREET_TOKEN})*)(?=\\s|$|[,;/])`,
  "gu"
);

export function parseAddressFromText(text: string): ParsedAddress {
  const src = collapseWs(text ?? "");
  if (!src) return { houseNumbers: [] };

  STREET_RE.lastIndex = 0;
  const streets: Array<{ raw: string; index: number; length: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = STREET_RE.exec(src)) !== null) {
    streets.push({ raw: collapseWs(m[1]), index: m.index, length: m[0].length });
  }

  const last = streets[streets.length - 1];
  const street = last ? normalizeStreet(last.raw) : undefined;

  let houseNumbers: string[] = [];
  if (last) {
    const after = src.slice(last.index + last.length).replace(/^[.\s]+/, "");
    const chunk = after.match(
      /^\s*(\d+\s*[A-Za-z]?(?:\s*[/,;-]\s*\d*\s*[A-Za-z]?)+|\d+\s*[A-Za-z]?(?:\s*-\s*[A-Za-z\d]+)?)/
    );
    if (chunk) houseNumbers = parseHouseNumbers(chunk[1]);
  }

  if (!houseNumbers.length) {
    const fallback = src.match(
      /\b(\d+\s*[A-Za-z]?(?:\s*\/\s*\d*\s*[A-Za-z]?){1,6})\b/
    );
    if (fallback) houseNumbers = parseHouseNumbers(fallback[1]);
  }

  return { street, houseNumbers, raw: street ? `${street} ${houseNumbers.join("/")}` : undefined };
}

export function extractMandant(text: string): string | undefined {
  const m = text.match(
    /\bmandant(?:en)?\s*(?:nr\.?|nummer|:)?\s*(\d{1,6})\b/i
  );
  return m?.[1];
}

/** Datasec speaking ticket number, e.g. 32-260907-Q0009 */
export function extractTicketnr(text: string): string | undefined {
  const m = text.match(/\b(\d{2}-\d{6}-[A-Za-z]\d{4})\b/);
  return m?.[1]?.toUpperCase();
}

export function extractPartnerId(text: string): string | undefined {
  const m = text.match(/\b(?:partner(?:id)?|mieterid)\s*[:=]?\s*([A-Za-z0-9._-]{2,32})\b/i);
  if (!m) return undefined;
  if (/^id$/i.test(m[1])) return undefined;
  return m[1];
}

export interface PartnerIdSegments {
  bukrs: string;
  swenr: string;
  sgenr: string;
  smenr: string;
  recnnr: string;
}

/**
 * Datasec PartnerID like `1401.587.2.15.35` → SAP index segments.
 * Requires exactly five non-empty dot-separated parts; otherwise null.
 */
export function parsePartnerIdSegments(
  partnerId: string | undefined | null
): PartnerIdSegments | null {
  const raw = String(partnerId ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(".").map((p) => p.trim());
  if (parts.length !== 5 || parts.some((p) => !p)) return null;
  return {
    bukrs: parts[0],
    swenr: parts[1],
    sgenr: parts[2],
    smenr: parts[3],
    recnnr: parts[4],
  };
}

/** SAP RE-FX Wirtschaftseinheit (SWENR), never a street. */
export function extractSwenr(text: string): string | undefined {
  const m = text.match(
    /\b(?:swenr|we-?nr|wirtschaftseinheit)\s*[:=]?\s*([A-Za-z0-9._-]{1,20})\b/i
  );
  return m?.[1];
}

export function looksLikeStreet(value: string): boolean {
  const k = streetKey(value);
  return /strasse|\bstr\b|\bweg\b|\bplatz\b|\ballee\b|\bring\b|\bgasse\b/.test(k);
}
