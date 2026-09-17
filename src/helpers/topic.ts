/**
 * Freitext topic / status → exact keywords + subject hints.
 * Uses config/topic-synonyms.json; no LLM.
 */
import { readFileSync } from "node:fs";
import { foldGerman, collapseWs } from "./normalize.js";
import { repoFile } from "./envelope.js";

export interface TopicEntry {
  id: string;
  label?: string;
  synonyms: string[];
  keywords: string[];
  subjectHints?: string[];
  note?: string;
}

export interface StatusEntry {
  id: string;
  synonyms: string[];
  mapped_to: string[];
  codes?: string[];
  note?: string;
}

export interface DocumentTypeEntry {
  id: string;
  synonyms: string[];
  types: string[];
  note?: string;
}

interface TopicFile {
  notes?: string;
  topics: TopicEntry[];
  statuses: StatusEntry[];
  document_types?: DocumentTypeEntry[];
}

let cached: TopicFile | null = null;
let cachedPath: string | null = null;

function normKey(s: string): string {
  return foldGerman(collapseWs(s)).toLowerCase();
}

export function loadTopicSynonyms(force = false): TopicFile {
  if (cached && !force) return cached;
  const path = repoFile("config/topic-synonyms.json");
  cachedPath = path;
  const raw = JSON.parse(readFileSync(path, "utf8")) as TopicFile;
  cached = {
    notes: raw.notes,
    topics: raw.topics ?? [],
    statuses: raw.statuses ?? [],
    document_types: raw.document_types ?? [],
  };
  return cached;
}

export function topicConfigPath(): string | null {
  loadTopicSynonyms();
  return cachedPath;
}

export interface TopicMapping {
  input: string;
  matched: boolean;
  topicId?: string;
  label?: string;
  keywords: string[];
  subjectHints: string[];
  note?: string;
}

export function mapTopic(input: string | undefined | null): TopicMapping {
  const text = collapseWs(input ?? "");
  if (!text) {
    return { input: "", matched: false, keywords: [], subjectHints: [] };
  }
  const file = loadTopicSynonyms();
  const key = normKey(text);
  for (const t of file.topics) {
    const keys = [t.id, t.label ?? "", ...t.synonyms].map(normKey).filter(Boolean);
    if (keys.includes(key)) {
      return {
        input: text,
        matched: true,
        topicId: t.id,
        label: t.label,
        keywords: [...t.keywords],
        subjectHints: [...(t.subjectHints ?? [])],
        note: t.note,
      };
    }
  }
  // substring / contained synonym (longer first)
  const scored: Array<{ t: TopicEntry; syn: string }> = [];
  for (const t of file.topics) {
    for (const syn of [t.label ?? "", ...t.synonyms]) {
      const sk = normKey(syn);
      if (sk.length >= 4 && (key.includes(sk) || sk.includes(key))) {
        scored.push({ t, syn });
      }
    }
  }
  scored.sort((a, b) => normKey(b.syn).length - normKey(a.syn).length);
  if (scored[0]) {
    const t = scored[0].t;
    return {
      input: text,
      matched: true,
      topicId: t.id,
      label: t.label,
      keywords: [...t.keywords],
      subjectHints: [...(t.subjectHints ?? [])],
      note: t.note,
    };
  }
  return {
    input: text,
    matched: false,
    keywords: [],
    subjectHints: text.includes("*") ? [text] : [`*${text}*`],
    note: "Kein Synonym-Treffer — Freitext nur als SUBJECT-Hint, nicht als Straße/KEYWORD-Rate.",
  };
}

export interface StatusMapping {
  input: string;
  matched: boolean;
  statusId?: string;
  mapped_to: string[];
  codes: string[];
  note?: string;
}

export function mapStatus(input: string | undefined | null): StatusMapping {
  const text = collapseWs(input ?? "");
  if (!text) {
    return { input: "", matched: false, mapped_to: [], codes: [] };
  }
  const file = loadTopicSynonyms();
  const key = normKey(text);
  for (const s of file.statuses) {
    const keys = [s.id, ...s.synonyms, ...s.mapped_to, ...(s.codes ?? [])].map(normKey);
    if (keys.includes(key)) {
      return {
        input: text,
        matched: true,
        statusId: s.id,
        mapped_to: [...s.mapped_to],
        codes: [...(s.codes ?? [])],
        note: s.note,
      };
    }
  }
  return {
    input: text,
    matched: false,
    mapped_to: [text],
    codes: [],
    note: "Kein Status-Synonym — Wert wird unverändert an S.STATE durchgereicht.",
  };
}

/** Find a topic mentioned anywhere in freitext (longest synonym wins). */
export function detectTopicInText(text: string): TopicMapping | undefined {
  const file = loadTopicSynonyms();
  const hay = normKey(text);
  let best: { t: TopicEntry; len: number } | undefined;
  for (const t of file.topics) {
    for (const syn of [t.label ?? "", ...t.synonyms]) {
      const sk = normKey(syn);
      if (sk.length >= 4 && hay.includes(sk) && (!best || sk.length > best.len)) {
        best = { t, len: sk.length };
      }
    }
  }
  if (!best) return undefined;
  return mapTopic(best.t.label ?? best.t.id);
}

export function detectStatusInText(text: string): StatusMapping | undefined {
  const file = loadTopicSynonyms();
  const hay = normKey(text);
  for (const s of file.statuses) {
    for (const syn of s.synonyms) {
      const sk = normKey(syn);
      if (sk.length >= 4 && hay.includes(sk)) return mapStatus(syn);
    }
  }
  return undefined;
}

export function listTopicCatalog(): TopicFile {
  return loadTopicSynonyms();
}

/** Freitext → Belegtyp-Namen (live catalog names win when passed in). */
export function mapDocumentTypes(
  query: string | undefined,
  catalogNames: string[] = []
): { types: string[]; note?: string; matched: boolean } {
  const text = collapseWs(query ?? "");
  if (!text) return { types: [], matched: false };
  const hay = normKey(text);
  const file = loadTopicSynonyms();
  let best: { entry: DocumentTypeEntry; len: number } | undefined;
  for (const entry of file.document_types ?? []) {
    for (const syn of [entry.id, ...entry.synonyms]) {
      const sk = normKey(syn);
      if (sk.length >= 4 && hay.includes(sk) && (!best || sk.length > best.len)) {
        best = { entry, len: sk.length };
      }
    }
  }
  if (best) {
    const fromCatalog = catalogNames
      .filter((n) => {
        const kn = normKey(n);
        return best!.entry.types.some((t) => kn === normKey(t) || kn.includes(normKey(t)));
      })
      .slice(0, 3);
    const types = fromCatalog.length ? fromCatalog : [...best.entry.types];
    return { types, matched: true, note: best.entry.note ?? `Belegtyp ${best.entry.id}` };
  }
  const hits = catalogNames
    .filter((n) => {
      const kn = normKey(n);
      return kn.length >= 4 && (hay.includes(kn) || kn.includes(hay));
    })
    .slice(0, 3);
  return { types: hits, matched: hits.length > 0 };
}
