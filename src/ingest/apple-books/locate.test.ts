import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANNOTATION_DB, LIBRARY_DB } from "../../../test/fixtures/apple-books/build";
import { AppleBooksAccessError, DEFAULT_BOOKS_DIR, locateBooksDbs } from "./locate";

const FIXTURES = join(import.meta.dir, "../../../test/fixtures/apple-books");

describe("locateBooksDbs", () => {
  test("finds the annotation and library DBs under the base dir", () => {
    expect(locateBooksDbs({ baseDir: FIXTURES })).toEqual({
      annotationDb: join(FIXTURES, ANNOTATION_DB),
      libraryDb: join(FIXTURES, LIBRARY_DB),
    });
  });

  test("defaults to the Books container in the home directory", () => {
    expect(DEFAULT_BOOKS_DIR).toEndWith("Library/Containers/com.apple.iBooksX/Data/Documents");
  });

  test("ignores -wal/-shm siblings and other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "apple-books-locate-"));
    try {
      mkdirSync(join(dir, "AEAnnotation"));
      mkdirSync(join(dir, "BKLibrary"));
      for (const f of [
        "AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite",
        "AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite-wal",
        "AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite-shm",
        "AEAnnotation/notes.txt",
        "BKLibrary/BKLibrary-1-091020131601.sqlite",
        "BKLibrary/BKLibrary-1-091020131601.sqlite-wal",
      ]) {
        writeFileSync(join(dir, f), "");
      }
      expect(locateBooksDbs({ baseDir: dir })).toEqual({
        annotationDb: join(dir, "AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite"),
        libraryDb: join(dir, "BKLibrary/BKLibrary-1-091020131601.sqlite"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory names the path it looked in", () => {
    const missing = join(tmpdir(), "apple-books-does-not-exist");
    expect(() => locateBooksDbs({ baseDir: missing })).toThrow(
      `Apple Books annotation database not found in ${join(missing, "AEAnnotation")}`,
    );
  });

  test("a directory without a DB file is reported as not found", () => {
    const dir = mkdtempSync(join(tmpdir(), "apple-books-locate-"));
    try {
      mkdirSync(join(dir, "AEAnnotation"));
      writeFileSync(join(dir, "AEAnnotation/AEAnnotation_x.sqlite"), "");
      mkdirSync(join(dir, "BKLibrary"));
      expect(() => locateBooksDbs({ baseDir: dir })).toThrow(
        "Apple Books library database not found",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("EPERM explains that Full Disk Access is needed", () => {
    const readdir = (path: string): string[] => {
      throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${path}'`), {
        code: "EPERM",
      });
    };
    let error: unknown;
    try {
      locateBooksDbs({ baseDir: "/Users/someone/Library/Containers/x", readdir });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AppleBooksAccessError);
    const message = (error as Error).message;
    expect(message).toContain("Full Disk Access");
    expect(message).toContain("System Settings");
    expect(message).toContain("/Users/someone/Library/Containers/x/AEAnnotation");
  });

  test("other read errors are rethrown unchanged", () => {
    const boom = Object.assign(new Error("EIO"), { code: "EIO" });
    const readdir = (): string[] => {
      throw boom;
    };
    expect(() => locateBooksDbs({ baseDir: FIXTURES, readdir })).toThrow(boom);
  });
});
