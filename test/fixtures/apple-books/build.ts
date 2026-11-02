/**
 * Builds the synthetic Apple Books fixture DBs in this directory, laid out like the real
 * `~/Library/Containers/com.apple.iBooksX/Data/Documents`. The tables keep the real Core Data
 * names and the columns the importer reads (plus a few that tell annotation kinds apart). All
 * text is made up: never copy real highlights here, the repo is public.
 *
 * Usage: bun test/fixtures/apple-books/build.ts
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const ANNOTATION_DB = "AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite";
export const LIBRARY_DB = "BKLibrary/BKLibrary-1-091020131601.sqlite";

/** ZAEANNOTATION.ZANNOTATIONTYPE values seen in a real library. */
export const ANNOTATION_TYPE = { bookmark: 1, highlight: 2, other: 3 } as const;

/** ZBKLIBRARYASSET.ZSTATE: 1 is downloaded; 3, 5 and 6 are cloud-only variants. */
export const ASSET_STATE = { downloaded: 1, cloud: 3, store: 6 } as const;

export interface FixtureAsset {
  assetId: string;
  title: string | null;
  author: string | null;
  state: number;
}

export interface FixtureAnnotation {
  uuid: string;
  assetId: string;
  text: string | null;
  note?: string | null;
  location?: string | null;
  /** Core Data seconds since 2001-01-01. */
  created?: number | null;
  type?: number;
  style?: number;
  underline?: number;
  deleted?: number;
}

const ANNOTATION_SCHEMA = `
CREATE TABLE ZAEANNOTATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
  ZANNOTATIONDELETED INTEGER, ZANNOTATIONISUNDERLINE INTEGER, ZANNOTATIONSTYLE INTEGER,
  ZANNOTATIONTYPE INTEGER, ZANNOTATIONCREATIONDATE TIMESTAMP,
  ZANNOTATIONMODIFICATIONDATE TIMESTAMP, ZANNOTATIONASSETID VARCHAR,
  ZANNOTATIONLOCATION VARCHAR, ZANNOTATIONNOTE VARCHAR, ZANNOTATIONREPRESENTATIVETEXT VARCHAR,
  ZANNOTATIONSELECTEDTEXT VARCHAR, ZANNOTATIONUUID VARCHAR );
CREATE INDEX Z_AEAnnotation_annotationAssetID ON ZAEANNOTATION (ZANNOTATIONASSETID COLLATE BINARY ASC);
CREATE INDEX Z_AEAnnotation_annotationUuid ON ZAEANNOTATION (ZANNOTATIONUUID COLLATE BINARY ASC);`;

const LIBRARY_SCHEMA = `
CREATE TABLE ZBKLIBRARYASSET ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
  ZCONTENTTYPE INTEGER, ZISSAMPLE INTEGER, ZSTATE INTEGER, ZASSETID VARCHAR, ZAUTHOR VARCHAR,
  ZPATH VARCHAR, ZSORTAUTHOR VARCHAR, ZSORTTITLE VARCHAR, ZTITLE VARCHAR );
CREATE INDEX Z_BKLibraryAsset_byAssetIDIndex ON ZBKLIBRARYASSET (ZASSETID COLLATE BINARY ASC);`;

export const FIXTURE_ASSETS: FixtureAsset[] = [
  {
    assetId: "A1F0000000000000000000000000LANT",
    title: "The Lantern Keeper",
    author: "Mira Okafor",
    state: ASSET_STATE.downloaded,
  },
  {
    assetId: "A2F0000000000000000000000000SALT",
    title: "Salt and Signal",
    author: "Theo Lindqvist & Ana Ruiz",
    state: ASSET_STATE.cloud,
  },
  {
    assetId: "A3F0000000000000000000000000QUIE",
    title: "Quiet Engines",
    author: "Priya Natarajan",
    state: ASSET_STATE.store,
  },
  // In the library but never highlighted: not imported.
  {
    assetId: "A4F0000000000000000000000000UNRD",
    title: "Unread Things",
    author: "Nobody Inparticular",
    state: ASSET_STATE.cloud,
  },
];

const LANTERN = FIXTURE_ASSETS[0]?.assetId ?? "";
const SALT = FIXTURE_ASSETS[1]?.assetId ?? "";
const QUIET = FIXTURE_ASSETS[2]?.assetId ?? "";

/** Live highlights first (5), then rows the reader must skip. */
export const FIXTURE_ANNOTATIONS: FixtureAnnotation[] = [
  {
    uuid: "11111111-0000-4000-8000-000000000001",
    assetId: LANTERN,
    text: "  A lamp left burning is a promise that someone will come home.\n",
    location: "epubcfi(/6/8[ch02]!/4/12,/1:0,/1:62)",
    created: 0,
  },
  {
    uuid: "11111111-0000-4000-8000-000000000002",
    assetId: LANTERN,
    text: "Every keeper learns that the dark is patient, but so is oil.",
    note: "keeper motif",
    location: "epubcfi(/6/10[ch03]!/4/2,/1:0,/1:59)",
    created: 700000000.5,
  },
  {
    uuid: "11111111-0000-4000-8000-000000000003",
    assetId: SALT,
    text: "The sea keeps no records, only rumors of the shore.",
    location: "epubcfi(/6/4[ch01]!/4/6,/1:0,/1:51)",
    created: 710000000,
    style: 0,
    underline: 1,
  },
  {
    uuid: "11111111-0000-4000-8000-000000000004",
    assetId: QUIET,
    text: "A machine that hums quietly is one that has made peace with its work.",
    location: null,
    created: 720000000,
    style: 1,
  },
  {
    uuid: "11111111-0000-4000-8000-000000000005",
    assetId: "ORPHANF000000000000000000000ORPH",
    text: "A highlight whose book has left the library.",
    created: 730000000,
  },
  // Deleted highlight.
  {
    uuid: "22222222-0000-4000-8000-000000000001",
    assetId: LANTERN,
    text: "This sentence was highlighted and then removed.",
    created: 700000100,
    deleted: 1,
  },
  // Highlights with no text.
  { uuid: "22222222-0000-4000-8000-000000000002", assetId: LANTERN, text: "", created: 700000200 },
  { uuid: "22222222-0000-4000-8000-000000000003", assetId: SALT, text: "   ", created: 700000300 },
  // A bookmark, and a type-3 annotation (no selected text in real data).
  {
    uuid: "22222222-0000-4000-8000-000000000004",
    assetId: LANTERN,
    text: null,
    type: ANNOTATION_TYPE.bookmark,
    style: 0,
  },
  {
    uuid: "22222222-0000-4000-8000-000000000005",
    assetId: QUIET,
    text: null,
    type: ANNOTATION_TYPE.other,
    style: 0,
  },
  // Real deleted rows are type 0 with no text.
  { uuid: "22222222-0000-4000-8000-000000000006", assetId: SALT, text: null, type: 0, deleted: 1 },
];

export function createAnnotationDb(path: string, rows: FixtureAnnotation[]): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run(ANNOTATION_SCHEMA);
  insertAnnotations(db, rows);
  return db;
}

export function insertAnnotations(db: Database, rows: FixtureAnnotation[]): void {
  const insert = db.query(
    `INSERT INTO ZAEANNOTATION (Z_ENT, Z_OPT, ZANNOTATIONDELETED, ZANNOTATIONISUNDERLINE,
       ZANNOTATIONSTYLE, ZANNOTATIONTYPE, ZANNOTATIONCREATIONDATE, ZANNOTATIONMODIFICATIONDATE,
       ZANNOTATIONASSETID, ZANNOTATIONLOCATION, ZANNOTATIONNOTE, ZANNOTATIONSELECTEDTEXT,
       ZANNOTATIONUUID)
     VALUES (2, 1, $deleted, $underline, $style, $type, $created, $created, $assetId, $location,
       $note, $text, $uuid)`,
  );
  for (const r of rows) {
    insert.run({
      deleted: r.deleted ?? 0,
      underline: r.underline ?? 0,
      style: r.style ?? 3,
      type: r.type ?? ANNOTATION_TYPE.highlight,
      created: r.created ?? null,
      assetId: r.assetId,
      location: r.location ?? null,
      note: r.note ?? null,
      text: r.text,
      uuid: r.uuid,
    });
  }
}

export function createLibraryDb(path: string, assets: FixtureAsset[]): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run(LIBRARY_SCHEMA);
  const insert = db.query(
    `INSERT INTO ZBKLIBRARYASSET (Z_ENT, Z_OPT, ZCONTENTTYPE, ZISSAMPLE, ZSTATE, ZASSETID,
       ZAUTHOR, ZTITLE, ZSORTTITLE, ZSORTAUTHOR)
     VALUES (3, 1, 1, 0, $state, $assetId, $author, $title, $title, $author)`,
  );
  for (const a of assets) insert.run({ ...a });
  return db;
}

/** Writes both fixture DBs under `dir` (replacing any there) and closes them. */
export function buildFixtures(
  dir: string,
  { assets = FIXTURE_ASSETS, annotations = FIXTURE_ANNOTATIONS } = {},
): void {
  for (const rel of [ANNOTATION_DB, LIBRARY_DB]) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, rel + suffix), { force: true });
  }
  createAnnotationDb(join(dir, ANNOTATION_DB), annotations).close();
  createLibraryDb(join(dir, LIBRARY_DB), assets).close();
}

if (import.meta.main) {
  buildFixtures(import.meta.dir);
  console.log(`Wrote ${ANNOTATION_DB} and ${LIBRARY_DB} under ${import.meta.dir}`);
}
