/**
 * Local PDF text extraction via Poppler `pdftotext` (no OCR).
 * Windows service host: put `pdftotext.exe` on PATH or set DATASEC_PDFTOTEXT_PATH.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_TEXT_CHARS = 50_000;
export const PRINTABLE_EMPTY_THRESHOLD = 40;

export interface PdfTextExtract {
  text: string;
  textChars: number;
  textEmpty: boolean;
  extractNote: string;
}

export interface ExtractPdfTextOpts {
  /** Override binary; `null` forces tool_missing (tests). */
  pdftotextBin?: string | null;
}

let cachedBin: string | null | undefined;

export function resetPdftotextBinCacheForTests(): void {
  cachedBin = undefined;
}

export function countPrintableChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export function isPdfBytes(buf: Buffer, contentType?: string | null): boolean {
  if (contentType && /application\/(?:pdf|x-pdf)\b/i.test(contentType)) return true;
  return buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF";
}

function candidateBins(): string[] {
  const env = process.env.DATASEC_PDFTOTEXT_PATH?.trim();
  const names =
    process.platform === "win32" ? ["pdftotext.exe", "pdftotext"] : ["pdftotext", "pdftotext.exe"];
  const extra =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\poppler\\Library\\bin\\pdftotext.exe",
          "C:\\poppler\\Library\\bin\\pdftotext.exe",
        ]
      : [];
  return [...(env ? [env] : []), ...names, ...extra].filter((bin, i, all) => {
    if (all.indexOf(bin) !== i) return false;
    if (bin.includes("/") || bin.includes("\\") || /^[A-Za-z]:\\/.test(bin)) return existsSync(bin);
    return true;
  });
}

async function probeBin(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["-v"], { timeout: 5_000 });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") return false;
    const blob = `${e.stderr ?? ""} ${e.message ?? ""}`;
    return /pdftotext|poppler/i.test(blob);
  }
}

export function resolvePdftotextBin(): string | null {
  const first = candidateBins()[0];
  return first ?? (process.platform === "win32" ? "pdftotext.exe" : "pdftotext");
}

export async function extractPdfText(
  buf: Buffer,
  maxChars: number,
  opts?: ExtractPdfTextOpts
): Promise<PdfTextExtract> {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_TEXT_CHARS;
  let bin: string | null = null;
  if (opts && "pdftotextBin" in opts) {
    bin = opts.pdftotextBin ?? null;
  } else if (cachedBin !== undefined) {
    bin = cachedBin;
  } else {
    for (const cand of candidateBins()) {
      if (await probeBin(cand)) {
        bin = cand;
        break;
      }
    }
    cachedBin = bin;
  }
  if (!bin) {
    return { text: "", textChars: 0, textEmpty: true, extractNote: "tool_missing" };
  }

  const dir = await mkdtemp(join(tmpdir(), "datasec-pdf-"));
  const pdfPath = join(dir, "doc.pdf");
  try {
    await writeFile(pdfPath, buf);
    const { stdout } = await execFileAsync(bin, ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    let text = stdout;
    let extractNote = "ok";
    if (text.length > cap) {
      text = text.slice(0, cap);
      extractNote = "truncated";
    }
    const textChars = text.length;
    const textEmpty = countPrintableChars(text) < PRINTABLE_EMPTY_THRESHOLD;
    if (textEmpty && extractNote === "ok") extractNote = "empty";
    return { text, textChars, textEmpty, extractNote };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { text: "", textChars: 0, textEmpty: true, extractNote: "tool_missing" };
    }
    return { text: "", textChars: 0, textEmpty: true, extractNote: "extract_failed" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
