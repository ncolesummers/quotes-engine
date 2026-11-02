import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the Books app keeps its Core Data stores. */
export const DEFAULT_BOOKS_DIR = join(
  homedir(),
  "Library/Containers/com.apple.iBooksX/Data/Documents",
);

export interface AppleBooksPaths {
  /** `AEAnnotation/AEAnnotation_*.sqlite`: highlights, notes and bookmarks. */
  annotationDb: string;
  /** `BKLibrary/BKLibrary-*.sqlite`: book titles and authors. */
  libraryDb: string;
}

export interface LocateOptions {
  baseDir?: string;
  readdir?: (path: string) => string[];
}

/** Reading the Books container was refused: the terminal lacks Full Disk Access. */
export class AppleBooksAccessError extends Error {
  override name = "AppleBooksAccessError";
}

function findDb(
  dir: string,
  pattern: RegExp,
  label: string,
  readdir: (path: string) => string[],
): string {
  let names: string[];
  try {
    names = readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new AppleBooksAccessError(
        `Can't read ${dir} (${code}). macOS protects the Books library: grant your terminal ` +
          "Full Disk Access in System Settings > Privacy & Security > Full Disk Access, then " +
          "restart the terminal and try again.",
        { cause: err },
      );
    }
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    names = [];
  }
  const match = names
    .filter((n) => pattern.test(n))
    .sort()
    .at(-1);
  if (!match) {
    throw new Error(
      `Apple Books ${label} database not found in ${dir}. Is Apple Books set up on this Mac?`,
    );
  }
  return join(dir, match);
}

/** Paths of the Apple Books annotation and library DBs under `baseDir`. */
export function locateBooksDbs({
  baseDir = DEFAULT_BOOKS_DIR,
  readdir = (path) => readdirSync(path),
}: LocateOptions = {}): AppleBooksPaths {
  return {
    annotationDb: findDb(
      join(baseDir, "AEAnnotation"),
      /^AEAnnotation.*\.sqlite$/,
      "annotation",
      readdir,
    ),
    libraryDb: findDb(join(baseDir, "BKLibrary"), /^BKLibrary.*\.sqlite$/, "library", readdir),
  };
}
