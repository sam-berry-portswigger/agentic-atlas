import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { initTodaySchema } from "./today-store.js";
import { initAnalysisSchema } from "./analysis-store.js";
export const dataDir = path.resolve(process.env.ATLAS_DATA_DIR || ".atlas");
export function openDb() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "atlas.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS mcp_calls (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_calls_started ON mcp_calls(started);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS insights (scope TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER);
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, file TEXT, session TEXT, project TEXT, title TEXT,
      role TEXT, timestamp TEXT, text TEXT, vector BLOB, model TEXT, x REAL, y REAL, cluster INTEGER
    );
    CREATE INDEX IF NOT EXISTS chunks_timestamp ON chunks(timestamp);
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file);
    CREATE INDEX IF NOT EXISTS chunks_model ON chunks(model);
    CREATE INDEX IF NOT EXISTS chunks_session_time ON chunks(session,timestamp);
    CREATE INDEX IF NOT EXISTS chunks_project ON chunks(project);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(id,text) VALUES(new.id,new.text); END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN DELETE FROM chunks_fts WHERE id=old.id; END;`);
  if (
    !db
      .prepare("PRAGMA table_info(chunks)")
      .all()
      .some((column) => column.name === "provider")
  )
    db.exec(
      "ALTER TABLE chunks ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'",
    );
  initAnalysisSchema(db);
  initTodaySchema(db);
  return db;
}
export function getConfig(db) {
  const defaults = {
    source: path.join(process.env.HOME, ".claude/projects"),
    codexSource:
      process.env.ATLAS_CODEX_SOURCE ??
      path.join(
        process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"),
        "sessions",
      ),
    embeddingModel: "embeddinggemma",
    generationModel: "gemma4:12b-mlx",
  };
  for (const row of db.prepare("SELECT * FROM settings").all())
    if (row.key in defaults) defaults[row.key] = JSON.parse(row.value);
  return defaults;
}
export function vectorBuffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}
export function vectorArray(buffer) {
  return new Float32Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
}
export function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((a, x) => a + x * x, 0)) || 1;
  return Array.from(vector, (x) => x / norm);
}
export function cosine(a, b) {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] * b[i];
  return n;
}
