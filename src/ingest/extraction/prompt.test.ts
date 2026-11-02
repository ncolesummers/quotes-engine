import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildExtractionPrompt,
  EXAMPLE_OUTPUT,
  outPathForBatch,
  renderExtractionPromptDoc,
} from "./prompt";
import { ExtractionFileSchema } from "./schema";

const BATCH = "/repo/data/extractions/todo/batch-007.json";
const OUT = "/repo/data/extractions/batch-007.json";

describe("buildExtractionPrompt", () => {
  const prompt = buildExtractionPrompt({ batchPath: BATCH, outPath: OUT });

  test("names both the batch path and the output path", () => {
    expect(prompt).toContain(BATCH);
    expect(prompt).toContain(OUT);
  });

  test("names every schema key", () => {
    for (const key of [
      "results",
      "ig_media_id",
      "quotes",
      "text",
      "author",
      "source",
      "found_in",
      "confidence",
      "no_quote",
    ]) {
      expect(prompt).toContain(`"${key}"`);
    }
    for (const value of ['"caption"', '"image"', '"both"']) expect(prompt).toContain(value);
  });

  test("encodes the hashtag, caption-format and process-tag rules", () => {
    expect(prompt).toContain("#joeabercrombie");
    expect(prompt).toContain("Joe Abercrombie");
    expect(prompt).toContain("#thefirstlaw");
    expect(prompt).toContain("The First Law");
    expect(prompt).toContain("📖 Title — Author");
    expect(prompt).toContain("#pythonimaginglibrary");
    expect(prompt).toContain("#p5js");
  });

  test("covers images, carousels, commentary, ordering and the final summary line", () => {
    expect(prompt).toMatch(/Read every image/i);
    expect(prompt).toMatch(/carousel/i);
    expect(prompt).toMatch(/commentary/i);
    expect(prompt).toMatch(/input order/i);
    expect(prompt).toContain("batch-007: 20 posts, 18 quotes, 2 no_quote");
  });

  test("resolves relative paths to absolute ones", () => {
    const p = buildExtractionPrompt({
      batchPath: "data/extractions/todo/batch-001.json",
      outPath: "data/extractions/batch-001.json",
    });
    expect(p).toContain(resolve("data/extractions/todo/batch-001.json"));
    expect(p).toContain(resolve("data/extractions/batch-001.json"));
  });

  test("its JSON example is valid against ExtractionFileSchema", () => {
    expect(ExtractionFileSchema.safeParse(EXAMPLE_OUTPUT).success).toBe(true);
    const match = prompt.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const parsed = ExtractionFileSchema.safeParse(JSON.parse(match?.[1] ?? ""));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.results.some((r) => r.no_quote)).toBe(true);
    expect(parsed.data?.results.some((r) => r.quotes.length > 1)).toBe(true);
  });
});

describe("outPathForBatch", () => {
  test("puts the result next to todo/, where import:extractions reads", () => {
    expect(
      outPathForBatch("/repo/data/extractions/todo/batch-003.json", "/repo/data/extractions"),
    ).toBe("/repo/data/extractions/batch-003.json");
  });
});

describe("docs/extraction-prompt.md", () => {
  test("is up to date with the prompt builder (regenerate with `bun run docs:prompt`)", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../docs/extraction-prompt.md"), "utf8");
    expect(doc).toBe(renderExtractionPromptDoc());
  });
});
