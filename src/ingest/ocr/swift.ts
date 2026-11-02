import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseOcrOutput } from "./parse";
import type { OcrRunner } from "./run";

/** The Vision OCR CLI source. */
export const OCR_SCRIPT_PATH = join(import.meta.dir, "../../../scripts/ocr/ocr.swift");
/** Where `bun run ocr` compiles it (`data/` is gitignored). */
export const DEFAULT_OCR_BIN_PATH = "data/bin/ocr";

/**
 * True when Vision OCR can run: macOS with the Swift toolchain. Linux can have Swift (GitHub's
 * ubuntu runners do) but has no Vision or AppKit.
 */
export function isVisionOcrAvailable(platform: string = process.platform): boolean {
  return platform === "darwin" && Bun.which("swift") !== null && Bun.which("swiftc") !== null;
}

/**
 * Compile `scriptPath` to `binPath` with `swiftc -O`, unless the binary is already newer than the
 * source. Compiling once avoids the interpreter's multi-second start-up on every call.
 */
export function ensureOcrBinary({
  scriptPath = OCR_SCRIPT_PATH,
  binPath = DEFAULT_OCR_BIN_PATH,
}: {
  scriptPath?: string;
  binPath?: string;
} = {}): string {
  if (existsSync(binPath) && statSync(binPath).mtimeMs >= statSync(scriptPath).mtimeMs) {
    return binPath;
  }
  mkdirSync(dirname(binPath), { recursive: true });
  const proc = Bun.spawnSync(["swiftc", "-O", scriptPath, "-o", binPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`swiftc failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`);
  }
  return binPath;
}

/** An `OcrRunner` that runs the compiled Vision CLI once per call. */
export function createSwiftOcrRunner({
  binPath = DEFAULT_OCR_BIN_PATH,
}: {
  binPath?: string;
} = {}): OcrRunner {
  return async (paths) => {
    if (paths.length === 0) return [];
    const proc = Bun.spawn([binPath, ...paths], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`OCR CLI exited ${exitCode}: ${stderr.trim()}`);
    return parseOcrOutput(stdout);
  };
}
