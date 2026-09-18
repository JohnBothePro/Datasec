import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPdfText,
  countPrintableChars,
  isPdfBytes,
} from "../src/helpers/pdf-text.ts";
import { EMPTY_PDF, TEXT_LAYER_PDF } from "./pdf-fixtures.ts";

describe("extractPdfText", () => {
  it("extracts a non-empty text layer from a tiny real PDF", async () => {
    const r = await extractPdfText(TEXT_LAYER_PDF, 50_000);
    assert.equal(r.extractNote === "ok" || r.extractNote === "truncated", true, r.extractNote);
    assert.ok(r.text.includes("Hello Datasec"), JSON.stringify(r));
    assert.ok(r.textChars > 0);
    assert.equal(r.textEmpty, false);
  });

  it("flags image-like / empty PDFs as textEmpty", async () => {
    const r = await extractPdfText(EMPTY_PDF, 50_000);
    assert.equal(r.textEmpty, true);
    assert.ok(countPrintableChars(r.text) < 40);
    assert.ok(r.extractNote === "empty" || r.extractNote === "ok", r.extractNote);
  });

  it("truncates with extractNote=truncated", async () => {
    const r = await extractPdfText(TEXT_LAYER_PDF, 5);
    assert.equal(r.extractNote, "truncated");
    assert.ok(r.text.length <= 5);
    assert.match(r.text, /Hello|Datasec/);
  });

  it("returns tool_missing when pdftotext is unavailable", async () => {
    const r = await extractPdfText(TEXT_LAYER_PDF, 50_000, { pdftotextBin: null });
    assert.equal(r.extractNote, "tool_missing");
    assert.equal(r.text, "");
    assert.equal(r.textEmpty, true);
  });
});

describe("PDF detection helpers", () => {
  it("recognizes %PDF magic and content-type", () => {
    assert.equal(isPdfBytes(TEXT_LAYER_PDF), true);
    assert.equal(isPdfBytes(Buffer.from("not a pdf")), false);
    assert.equal(isPdfBytes(Buffer.from("xx"), "application/pdf"), true);
  });
});
