-- Quote pairs a reviewer marked "not a duplicate" (#17), so the duplicate scan stops
-- suggesting them. Stored once per pair with the lower id first; a merged-away quote takes
-- its dismissals with it.
CREATE TABLE quote_not_duplicates (
  a_id INTEGER NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  b_id INTEGER NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
) WITHOUT ROWID;

CREATE INDEX quote_not_duplicates_b_id_idx ON quote_not_duplicates (b_id);
