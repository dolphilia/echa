CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR REPLACE INTO app_metadata (key, value, updated_at)
VALUES ('schema_stage', 'phase0', unixepoch());
