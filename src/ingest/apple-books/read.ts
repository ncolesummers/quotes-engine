import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type AppleBooksPaths, asAccessError } from "./locate";

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
  /** Copies one file. Default: `copyFileSync`. For tests. */
  copyFile?: (from: string, to: string) => void;
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

/** Attempts at a copy that no write by Books interleaved with. */
const COPY_ATTEMPTS = 5;

/** Size and mtime of `path`, or null when it doesn't exist. */
function fingerprint(path: string): string | null {
  const st = statSync(path, { throwIfNoEntry: false });
  return st ? `${st.size}:${st.mtimeMs}` : null;
}

/**
 * Copies `path` and its `-wal` (Books keeps recent writes in the WAL) into `dir`, and opens
 * the copy read-only. The originals are never opened. The `-shm` index isn't copied: copied
 * at another moment than the WAL it could disagree with it, and SQLite rebuilds it from the
 * WAL. If Books wrote to either file during the copy, the pair may not match, so it copies
 * again.
 */
function openCopy(path: string, dir: string, copyFile: (from: string, to: string) => void) {
  const copy = join(dir, basename(path));
  const files = [path, `${path}-wal`];
  const state = () => files.map(fingerprint).join("|");
  try {
    for (let attempt = 1; ; attempt++) {
      const before = state();
      rmSync(`${copy}-wal`, { force: true });
      for (const file of files) {
        if (file === path || fingerprint(file) !== null) copyFile(file, join(dir, basename(file)));
      }
      if (state() === before) break;
      if (attempt === COPY_ATTEMPTS) {
        throw new Error(`${path} kept changing while it was copied. Quit Books and try again.`);
      }
    }
  } catch (err) {
    throw asAccessError(path, err);
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
  const copyFile = opts.copyFile ?? copyFileSync;
  try {
    const annotations = openCopy(paths.annotationDb, dir, copyFile);
    let highlights: AppleHighlight[];
    try {
      highlights = readHighlights(annotations);
    } finally {
      annotations.close();
    }

    const library = openCopy(paths.libraryDb, dir, copyFile);
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
