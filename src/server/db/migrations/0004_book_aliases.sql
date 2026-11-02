-- What a merged-away book was known by (#34), so later imports land on the kept book.
--
-- `books.asset_id` holds one Apple Books asset, so when two Apple Books records are merged the
-- dropped asset id is kept here ('asset'). The dropped book's `normalized_key` is kept too
-- ('key'), so a caption reading "IQ84" still resolves to the "1Q84" it was merged into.
-- A real `books` key or asset id always wins over an alias.
CREATE TABLE book_aliases (
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'key')),
  value TEXT NOT NULL,
  book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  PRIMARY KEY (kind, value)
) WITHOUT ROWID;

CREATE INDEX book_aliases_book_id_idx ON book_aliases (book_id);
