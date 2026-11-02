import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildClassificationPrompt,
  CLASSIFICATION_EXAMPLE,
  classifiedPathForBatch,
  renderClassificationPromptDoc,
} from "./classification-prompt";
import { ClassificationFileSchema } from "./classification-schema";

const BATCH = "/repo/data/extractions/todo/batch-007.json";
const OUT = "/repo/data/extractions/classified/batch-007.json";

describe("buildClassificationPrompt", () => {
  const prompt = buildClassificationPrompt({ batchPath: BATCH, outPath: OUT });

  test("names both the batch path and the output path", () => {
    expect(prompt).toContain(BATCH);
    expect(prompt).toContain(OUT);
  });

  test("says explicitly never to write out quote text", () => {
    expect(prompt).toMatch(/never write (out )?(the )?quote text/i);
    expect(prompt).toMatch(/line (numbers|references)/i);
    expect(prompt).not.toMatch(/transcribe/i);
  });

  test("does not ask the agent to read images", () => {
    expect(prompt).not.toMatch(/Read every image/i);
    expect(prompt).toMatch(/do not (open|read) the images/i);
  });

  test("explains the img<N>:L<M> line references and the from_caption flag", () => {
    expect(prompt).toContain('img1:L0 "');
    expect(prompt).toMatch(/inclusive/i);
    expect(prompt).toContain('"from_caption"');
    expect(prompt).toContain('cap:L0 "');
    expect(prompt).toContain('"caption_lines"');
    for (const key of [
      "results",
      "ig_media_id",
      "no_quote",
      "quotes",
      "image",
      "lines",
      "author",
      "source",
      "confidence",
    ]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test("keeps the hashtag, caption-format, process-tag, commentary and carousel rules", () => {
    expect(prompt).toContain("#joeabercrombie");
    expect(prompt).toContain("Joe Abercrombie");
    expect(prompt).toContain("📖 Title — Author");
    expect(prompt).toContain("📖 Title · Author");
    expect(prompt).toContain("#pythonimaginglibrary");
    expect(prompt).toMatch(/commentary is not a quote/i);
    expect(prompt).toMatch(/carousel/i);
    expect(prompt).toMatch(/input order/i);
  });

  test("tells the agent to leave attribution lines out of the line range", () => {
    expect(prompt).toMatch(/attribution line/i);
  });

  test("ends with a one-line summary that carries no quote text", () => {
    expect(prompt).toContain("batch-007: 20 posts, 18 quotes, 2 no_quote");
  });

  test("resolves relative paths to absolute ones", () => {
    const p = buildClassificationPrompt({
      batchPath: "data/extractions/todo/batch-001.json",
      outPath: "data/extractions/classified/batch-001.json",
    });
    expect(p).toContain(resolve("data/extractions/todo/batch-001.json"));
    expect(p).toContain(resolve("data/extractions/classified/batch-001.json"));
  });

  test("its JSON example parses with the classification schema and has no quote text", () => {
    expect(ClassificationFileSchema.safeParse(CLASSIFICATION_EXAMPLE).success).toBe(true);
    const match = prompt.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const json = JSON.parse(match?.[1] ?? "");
    const parsed = ClassificationFileSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    const results = parsed.data?.results ?? [];
    expect(results.some((r) => r.no_quote)).toBe(true);
    expect(results.some((r) => r.quotes.length > 1)).toBe(true);
    expect(results.some((r) => r.quotes.some((q) => q.caption_lines !== null))).toBe(true);
    expect(match?.[1]).not.toContain('"text"');
  });
});

describe("classifiedPathForBatch", () => {
  test("puts the result in classified/ next to todo/", () => {
    expect(
      classifiedPathForBatch(
        "/repo/data/extractions/todo/batch-003.json",
        "/repo/data/extractions",
      ),
    ).toBe("/repo/data/extractions/classified/batch-003.json");
  });

  test("refuses a batch path that is itself the result path", () => {
    expect(() =>
      classifiedPathForBatch(
        "/repo/data/extractions/classified/batch-003.json",
        "/repo/data/extractions",
      ),
    ).toThrow(/overwrite/);
  });
});

describe("CLASSIFICATION_EXAMPLE", () => {
  test("its first quote matches the walkthrough: lines [0, 3], leaving out the attribution line", () => {
    expect(CLASSIFICATION_EXAMPLE.results[0]?.quotes?.[0]?.lines).toEqual([0, 3]);
  });
});

describe("docs/classification-prompt.md", () => {
  test("is up to date with the prompt builder (regenerate with `bun run docs:prompt`)", () => {
    const doc = readFileSync(
      join(import.meta.dir, "../../../docs/classification-prompt.md"),
      "utf8",
    );
    expect(doc).toBe(renderClassificationPromptDoc());
  });
});
