import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OcrLine, parseOcrOutput, sortReadingOrder } from "./parse";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../../test/fixtures/ocr/cli-output.json"),
  "utf8",
);

function line(text: string, x: number, y: number, h = 0.05): OcrLine {
  return { text, confidence: 1, box: { x, y, w: 0.3, h } };
}

describe("parseOcrOutput", () => {
  test("parses the Swift CLI's JSON into one entry per image", () => {
    const images = parseOcrOutput(FIXTURE);
    expect(images.map((i) => i.path)).toEqual([
      "/media/17890000000000001.jpg",
      "/media/17890000000000002_1.jpg",
    ]);
    expect(images[0]?.error).toBeUndefined();
    expect(images[1]?.error).toBe("Could not load image");
    expect(images[1]?.lines).toEqual([]);
  });

  test("puts lines in reading order: top to bottom, then left to right", () => {
    const [first] = parseOcrOutput(FIXTURE);
    expect(first?.lines.map((l) => l.text)).toEqual([
      "Once you've got a",
      "task to do, you",
      "remember to be",
      "— Joe Abercrombie",
    ]);
    expect(first?.lines[0]).toEqual({
      text: "Once you've got a",
      confidence: 0.95,
      box: { x: 0.1, y: 0.2, w: 0.8, h: 0.05 },
    });
  });

  test("rejects invalid JSON and wrong shapes with a readable error", () => {
    expect(() => parseOcrOutput("not json")).toThrow(/Invalid OCR output/);
    expect(() => parseOcrOutput('[{"path": "/a.jpg", "lines": [{"text": "x"}]}]')).toThrow(
      /Invalid OCR output/,
    );
  });
});

describe("sortReadingOrder", () => {
  test("treats lines whose vertical centres nearly match as one row", () => {
    const sorted = sortReadingOrder([
      line("right", 0.6, 0.101),
      line("below", 0.1, 0.2),
      line("left", 0.1, 0.1),
    ]);
    expect(sorted.map((l) => l.text)).toEqual(["left", "right", "below"]);
  });

  test("keeps distinct rows apart even when close together", () => {
    const sorted = sortReadingOrder([line("second", 0.05, 0.16), line("first", 0.5, 0.1)]);
    expect(sorted.map((l) => l.text)).toEqual(["first", "second"]);
  });

  test("does not mutate its input", () => {
    const input = [line("b", 0.1, 0.5), line("a", 0.1, 0.1)];
    sortReadingOrder(input);
    expect(input.map((l) => l.text)).toEqual(["b", "a"]);
  });
});
