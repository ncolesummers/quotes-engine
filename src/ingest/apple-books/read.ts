import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AppleBooksPaths } from "./locate";

/** A book from the Books library (`ZBKLIBRARYASSET`). */
export interface AppleBook {
  assetId: string;
  title: string | null;
  author: string | null;
  /** `ZSTATE`: 1 is downloaded; other values are cloud-only states. Informational. */
  state: number | null;
}

/** A live highlight (`ZAEANNOTATION`). */
export interface AppleHighlight {
  annotationUuid: string;
  assetId: string;
  /** Trimmed, never empty. */
  text: string;
  note: string | null;
  /** EPUB CFI of the selection, when Books recorded one. */
  location: string | null;
  createdAt: string | null;
}

export interface AppleBooksData {
  /** Library records of the books that have highlights. */
  books: AppleBook[];
  /** Oldest first. */
  highlights: AppleHighlight[];
}

export interface ReadOptions {
  /** Where the temporary copies go. Default: the OS temp dir. */
  tmpRoot?: string;
}

/** Core Data timestamps count seconds from 2001-01-01T00:00:00Z. */
const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);

export function coreDataToIso(seconds: number | null): string | null {
  if (seconds === null) return null;
  return new Date(CORE_DATA_EPOCH_MS + Math.round(seconds * 1000)).toISOString();
}

/** `ZANNOTATIONTYPE` of highlights; bookmarks (1) and type 3 rows carry no selected text. */
const HIGHLIGHT_TYPE = 2;

interface AnnotationRow {
  uuid: string | null;
  assetId: string | null;
  text: string | null;
  note: string | null;
  location: string | null;
  created: number | null;
}

/**
 * Copies `path` and its `-wal`/`-shm` (Books keeps recent writes in the WAL) into `dir`, and
 * opens the copy read-only. The originals are never opened.
 */
function openCopy(path: string, dir: string): Database {
  const copy = join(dir, basename(path));
  for (const suffix of ["", "-wal", "-shm"]) {
    if (suffix === "" || existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
  }
  return new Database(copy, { readonly: true, strict: true });
}

function cleanText(s: string | null): string | null {
  const trimmed = s?.trim();
  return trimmed ? trimmed : null;
}

function readHighlights(db: Database): AppleHighlight[] {
  const rows = db
    .query<AnnotationRow, { type: number }>(
      `SELECT ZANNOTATIONUUID AS uuid, ZANNOTATIONASSETID AS assetId,
         ZANNOTATIONSELECTEDTEXT AS text, ZANNOTATIONNOTE AS note,
         ZANNOTATIONLOCATION AS location, ZANNOTATIONCREATIONDATE AS created
       FROM ZAEANNOTATION
       WHERE ZANNOTATIONDELETED = 0 AND ZANNOTATIONTYPE = $type
         AND ZANNOTATIONSELECTEDTEXT IS NOT NULL
       ORDER BY ZANNOTATIONCREATIONDATE, Z_PK`,
    )
    .all({ type: HIGHLIGHT_TYPE });
  const highlights: AppleHighlight[] = [];
  for (const r of rows) {
    const text = cleanText(r.text);
    if (!text || !r.uuid || !r.assetId) continue;
    highlights.push({
      annotationUuid: r.uuid,
      assetId: r.assetId,
      text,
      note: cleanText(r.note),
      location: r.location || null,
      createdAt: coreDataToIso(r.created),
    });
  }
  return highlights;
}

function readBooks(db: Database, assetIds: Set<string>): AppleBook[] {
  return db
    .query<AppleBook, []>(
      `SELECT ZASSETID AS assetId, ZTITLE AS title, ZAUTHOR AS author, ZSTATE AS state
       FROM ZBKLIBRARYASSET WHERE ZASSETID IS NOT NULL ORDER BY Z_PK`,
    )
    .all()
    .filter((b) => assetIds.has(b.assetId));
}

/**
 * Reads live highlights (not deleted, with text) and their books from copies of the Apple
 * Books DBs. The copies are removed afterwards.
 */
export function readAppleBooks(paths: AppleBooksPaths, opts: ReadOptions = {}): AppleBooksData {
  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "apple-books-"));
  try {
    const annotations = openCopy(paths.annotationDb, dir);
    let highlights: AppleHighlight[];
    try {
      highlights = readHighlights(annotations);
    } finally {
      annotations.close();
    }

    const library = openCopy(paths.libraryDb, dir);
    try {
      const books = readBooks(library, new Set(highlights.map((h) => h.assetId)));
      return { books, highlights };
    } finally {
      library.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
