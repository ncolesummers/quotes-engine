import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANNOTATION_DB,
  ASSET_STATE,
  createAnnotationDb,
  createLibraryDb,
  FIXTURE_ASSETS,
  insertAnnotations,
  LIBRARY_DB,
} from "../../../test/fixtures/apple-books/build";
import { AppleBooksAccessError } from "./locate";
import { coreDataToIso, readAppleBooks } from "./read";

const FIXTURES = join(import.meta.dir, "../../../test/fixtures/apple-books");
const PATHS = {
  annotationDb: join(FIXTURES, ANNOTATION_DB),
  libraryDb: join(FIXTURES, LIBRARY_DB),
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "apple-books-read-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("coreDataToIso", () => {
  test("0 is the Core Data epoch", () => {
    expect(coreDataToIso(0)).toBe("2001-01-01T00:00:00.000Z");
  });

  test("keeps fractional seconds as milliseconds", () => {
    expect(coreDataToIso(700000000.5)).toBe("2023-03-08T20:26:40.500Z");
  });

  test("null stays null", () => {
    expect(coreDataToIso(null)).toBeNull();
  });
});

describe("readAppleBooks", () => {
  test("returns live highlights with ISO dates and trimmed text", () => {
    const { highlights } = readAppleBooks(PATHS, { tmpRoot: scratch });
    expect(highlights.map((h) => h.annotationUuid)).toEqual([
      "11111111-0000-4000-8000-000000000001",
      "11111111-0000-4000-8000-000000000002",
      "11111111-0000-4000-8000-000000000003",
      "11111111-0000-4000-8000-000000000004",
      "11111111-0000-4000-8000-000000000005",
    ]);
    expect(highlights[0]).toEqual({
      annotationUuid: "11111111-0000-4000-8000-000000000001",
      assetId: FIXTURE_ASSETS[0]?.assetId ?? "",
      text: "A lamp left burning is a promise that someone will come home.",
      note: null,
      location: "epubcfi(/6/8[ch02]!/4/12,/1:0,/1:62)",
      createdAt: "2001-01-01T00:00:00.000Z",
    });
    expect(highlights[1]?.note).toBe("keeper motif");
    expect(highlights[3]?.location).toBeNull();
  });

  test("excludes deleted annotations, empty highlights and bookmarks", () => {
    const { highlights } = readAppleBooks(PATHS, { tmpRoot: scratch });
    expect(highlights.some((h) => h.annotationUuid.startsWith("22222222"))).toBe(false);
  });

  test("returns the library records of highlighted books, in any download state", () => {
    const { books } = readAppleBooks(PATHS, { tmpRoot: scratch });
    expect(books).toEqual(
      FIXTURE_ASSETS.slice(0, 3).map(({ assetId, title, author, state }) => ({
        assetId,
        title,
        author,
        state,
      })),
    );
    expect(books.map((b) => b.state)).toEqual([
      ASSET_STATE.downloaded,
      ASSET_STATE.cloud,
      ASSET_STATE.store,
    ]);
  });

  test("reads rows still in the WAL of a DB another process has open", () => {
    const src = join(scratch, "src");
    const annotationDb = join(src, ANNOTATION_DB);
    const libraryDb = join(src, LIBRARY_DB);
    const writer = createAnnotationDb(annotationDb, []);
    createLibraryDb(libraryDb, FIXTURE_ASSETS).close();
    try {
      writer.run("PRAGMA journal_mode = WAL");
      writer.run("PRAGMA wal_autocheckpoint = 0");
      insertAnnotations(writer, [
        {
          uuid: "33333333-0000-4000-8000-000000000001",
          assetId: FIXTURE_ASSETS[0]?.assetId ?? "",
          text: "Only the WAL knows this line.",
          created: 1,
        },
      ]);
      expect(readdirSync(join(src, "AEAnnotation"))).toContain(
        "AEAnnotation_v10312011_1727_local.sqlite-wal",
      );

      const { highlights } = readAppleBooks({ annotationDb, libraryDb }, { tmpRoot: scratch });
      expect(highlights.map((h) => h.text)).toEqual(["Only the WAL knows this line."]);
    } finally {
      writer.close();
    }
  });

  test("copies the WAL but not its index, which may not match the copied WAL", () => {
    const src = join(scratch, "src");
    const annotationDb = join(src, ANNOTATION_DB);
    const libraryDb = join(src, LIBRARY_DB);
    const writer = createAnnotationDb(annotationDb, []);
    createLibraryDb(libraryDb, FIXTURE_ASSETS).close();
    try {
      writer.run("PRAGMA journal_mode = WAL");
      writer.run("PRAGMA wal_autocheckpoint = 0");
      insertAnnotations(writer, [
        { uuid: "u-wal", assetId: FIXTURE_ASSETS[0]?.assetId ?? "", text: "In the WAL." },
      ]);
      const copied: string[] = [];
      const { highlights } = readAppleBooks(
        { annotationDb, libraryDb },
        {
          tmpRoot: scratch,
          copyFile: (from, to) => {
            copied.push(from);
            copyFileSync(from, to);
          },
        },
      );
      expect(highlights.map((h) => h.text)).toEqual(["In the WAL."]);
      expect(copied).toContain(`${annotationDb}-wal`);
      expect(copied.some((p) => p.endsWith("-shm"))).toBe(false);
    } finally {
      writer.close();
    }
  });

  test("copies again when Books writes to a DB mid-copy", () => {
    const src = join(scratch, "src");
    const annotationDb = join(src, ANNOTATION_DB);
    const libraryDb = join(src, LIBRARY_DB);
    const writer = createAnnotationDb(annotationDb, []);
    createLibraryDb(libraryDb, FIXTURE_ASSETS).close();
    try {
      writer.run("PRAGMA journal_mode = WAL");
      writer.run("PRAGMA wal_autocheckpoint = 0");
      let copies = 0;
      const { highlights } = readAppleBooks(
        { annotationDb, libraryDb },
        {
          tmpRoot: scratch,
          copyFile: (from, to) => {
            copyFileSync(from, to);
            if (from === annotationDb && copies++ === 0) {
              insertAnnotations(writer, [
                { uuid: "u-late", assetId: FIXTURE_ASSETS[0]?.assetId ?? "", text: "Late." },
              ]);
            }
          },
        },
      );
      expect(copies).toBe(2);
      expect(highlights.map((h) => h.text)).toEqual(["Late."]);
    } finally {
      writer.close();
    }
  });

  test("a refused read of a DB file asks for Full Disk Access", () => {
    const refuse = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    expect(() => readAppleBooks(PATHS, { tmpRoot: scratch, copyFile: refuse })).toThrow(
      AppleBooksAccessError,
    );
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("never writes next to the originals and cleans up its copies", () => {
    const before = readdirSync(join(FIXTURES, "AEAnnotation")).sort();
    readAppleBooks(PATHS, { tmpRoot: scratch });
    expect(readdirSync(join(FIXTURES, "AEAnnotation")).sort()).toEqual(before);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
