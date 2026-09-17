/**
 * Freitext topic / status → exact keywords + subject hints.
 * Uses config/topic-synonyms.json; no LLM.
 */
import { readFileSync } from "node:fs";
import { foldGerman, collapseWs } from "./normalize.js";
import { repoFile } from "./envelope.js";
import { SPEED } from "./speed.js";

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

/**
 * Exact KEYWORD values only. Synonym labels (e.g. "Mängel") are not sent
 * unless the live catalog confirms that exact keyword exists.
 */
export function resolveSearchKeywords(
  topic: TopicMapping,
  liveKeywords: string[] = []
): { keywords: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const liveSet = new Set(liveKeywords.map((k) => foldGerman(k).toLowerCase()));
  const hasLive = liveSet.size > 0;
  const labelKey = topic.label ? foldGerman(topic.label).toLowerCase() : "";

  const keywords: string[] = [];
  for (const k of topic.keywords) {
    const nk = foldGerman(k).toLowerCase();
    if (!nk) continue;
    const isLabel = Boolean(labelKey) && nk === labelKey;
    if (isLabel) {
      if (hasLive && liveSet.has(nk)) keywords.push(k);
      continue;
    }
    if (hasLive && !liveSet.has(nk)) continue;
    keywords.push(k);
  }

  if (topic.matched && topic.keywords.length && !keywords.length && topic.subjectHints.length) {
    warnings.push(
      topic.label
        ? `Thema '${topic.label}' ist nur ein Synonym-Label, kein nachweisbares KEYWORD — Suche über SUBJECT, nicht KEYWORD='${topic.label}'.`
        : "Keine Katalog-Keywords — Suche über SUBJECT-Hints."
    );
  }
  return { keywords, warnings };
}

export interface CatalogKeywordLike {
  name: string;
  extra?: Record<string, string>;
}

function categoryKey(item: CatalogKeywordLike): string {
  return foldGerman(item.extra?.category ?? item.extra?.CATEGORY ?? "").toLowerCase();
}

function overlapScore(name: string, needles: string[]): number {
  const hay = foldGerman(name).toLowerCase();
  if (!hay) return 0;
  let score = 0;
  for (const n of needles) {
    const k = foldGerman(n.replace(/\*/g, "")).toLowerCase();
    if (k.length < 3) continue;
    if (hay.includes(k) || k.includes(hay)) score += k.length;
  }
  return score;
}

/**
 * Live catalog pick: topic `maengel` → KEYWORDs whose CATEGORY is Mängel.
 * Never emits KEYWORD=Mängel unless a catalog row has that exact KEYWORD name.
 */
export function pickCatalogKeywords(
  topic: TopicMapping,
  items: CatalogKeywordLike[],
  opts?: { query?: string; cap?: number }
): { keywords: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const cap = Math.max(1, opts?.cap ?? SPEED.MAX_CATEGORY_KEYWORDS);
  const labelKey = topic.label ? foldGerman(topic.label).toLowerCase() : "";
  const categoryNeedles = [topic.label, topic.topicId]
    .filter(Boolean)
    .map((s) => foldGerman(String(s)).toLowerCase());

  const byCategory = items.filter((it) => {
    const ck = categoryKey(it);
    if (!ck) return false;
    return categoryNeedles.some((n) => n && (ck === n || ck.includes(n) || n.includes(ck)));
  });

  const needles = [
    opts?.query ?? "",
    ...topic.subjectHints,
    topic.input,
  ].filter(Boolean);

  const ranked = [...byCategory].sort((a, b) => {
    const diff = overlapScore(b.name, needles) - overlapScore(a.name, needles);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, "de");
  });

  const keywords: string[] = [];
  for (const it of ranked) {
    const nk = foldGerman(it.name).toLowerCase();
    if (!nk) continue;
    const isLabel = Boolean(labelKey) && nk === labelKey;
    if (isLabel) continue;
    if (keywords.some((k) => foldGerman(k).toLowerCase() === nk)) continue;
    keywords.push(it.name);
    if (keywords.length >= cap) break;
  }

  const labelConfirmed = items.some(
    (it) => foldGerman(it.name).toLowerCase() === labelKey && labelKey
  );
  if (labelConfirmed && keywords.length === 0) {
    keywords.push(
      topic.label ??
        items.find((it) => foldGerman(it.name).toLowerCase() === labelKey)!.name
    );
  }

  if (topic.topicId === "maengel" && !keywords.includes("Mängel") && !labelConfirmed) {
    /* keep hard-no: never KEYWORD=Mängel without catalog confirmation */
  }

  if (!keywords.length && byCategory.length && labelKey) {
    warnings.push(
      `Katalog hat CATEGORY='${topic.label}', aber kein KEYWORD außer dem Label — Suche über SUBJECT, nicht KEYWORD='${topic.label}'.`
    );
  }
  return { keywords, warnings };
}

/** Prefer CATEGORY pick for maengel; otherwise exact names / subject fallback. */
export function resolveTopicKeywords(
  topic: TopicMapping,
  items: CatalogKeywordLike[] = [],
  opts?: { query?: string; cap?: number }
): { keywords: string[]; warnings: string[] } {
  const preferCategory =
    topic.topicId === "maengel" ||
    (!topic.keywords.length && Boolean(topic.label) && items.length > 0);

  if (preferCategory && items.length) {
    const picked = pickCatalogKeywords(topic, items, opts);
    if (picked.keywords.length) return picked;
    const names = items.map((i) => i.name);
    const fallback = resolveSearchKeywords(topic, names);
    return {
      keywords: fallback.keywords,
      warnings: [...picked.warnings, ...fallback.warnings],
    };
  }
  return resolveSearchKeywords(
    topic,
    items.map((i) => i.name)
  );
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
