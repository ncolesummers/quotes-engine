import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSwiftOcrRunner,
  ensureOcrBinary,
  isVisionOcrAvailable,
  OCR_SCRIPT_PATH,
} from "./swift";

const RENDER_SCRIPT = join(import.meta.dir, "../../../test/fixtures/ocr/render-text.swift");

test("Vision OCR is never available off macOS, even with Swift installed", () => {
  expect(isVisionOcrAvailable("linux")).toBe(false);
});

// Opt-in: needs Apple's Vision framework, so it runs only on macOS with `swift` installed.
describe.skipIf(!isVisionOcrAvailable())("Swift Vision OCR CLI (macOS)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "quotes-swift-ocr-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test(
    "OCRs a generated image of known text, lines in reading order",
    async () => {
      const image = join(root, "known.png");
      const render = Bun.spawnSync(
        ["swift", RENDER_SCRIPT, image, "The quick brown fox", "jumps over the lazy dog"],
        { stderr: "pipe" },
      );
      expect(render.stderr.toString()).toBe("");
      expect(render.exitCode).toBe(0);

      const binPath = join(root, "bin", "ocr");
      ensureOcrBinary({ scriptPath: OCR_SCRIPT_PATH, binPath });
      const runner = createSwiftOcrRunner({ binPath });
      const [result] = await runner([image]);

      expect(result?.path).toBe(image);
      expect(result?.error).toBeUndefined();
      expect(result?.lines.map((l) => l.text)).toEqual([
        "The quick brown fox",
        "jumps over the lazy dog",
      ]);
      for (const l of result?.lines ?? []) {
        expect(l.confidence).toBeGreaterThan(0.5);
        expect(l.box.w).toBeGreaterThan(0);
      }
      expect(result?.lines[0]?.box.y).toBeLessThan(result?.lines[1]?.box.y ?? 0);
    },
    { timeout: 180_000 },
  );

  test(
    "reports an unreadable image as an error entry rather than failing the batch",
    async () => {
      const binPath = join(root, "bin", "ocr");
      ensureOcrBinary({ scriptPath: OCR_SCRIPT_PATH, binPath });
      const runner = createSwiftOcrRunner({ binPath });
      const missing = join(root, "missing.png");
      const [result] = await runner([missing]);
      expect(result?.path).toBe(missing);
      expect(result?.error).toBeString();
      expect(result?.lines).toEqual([]);
    },
    { timeout: 180_000 },
  );
});
