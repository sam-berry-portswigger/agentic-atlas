import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { freshness, rankRecent, recencyReference } from "../server/recency.js";
import { searchEvidence } from "../server/retrieval.js";
import { createEvidenceService } from "../server/mcp-service.js";
const row = (id, score, timestamp) => ({ id, score, timestamp });
test("relative recency promotes close recent matches while preserving strong older relevance", () => {
  const rows = [
    row("old", 0.9, "2020-01-01T00:00:00Z"),
    row("new", 0.89, "2020-02-01T00:00:00Z"),
    row("irrelevant", 0.05, "2020-02-02T00:00:00Z"),
  ];
  const result = rankRecent(rows, (row) => row.score);
  assert.equal(result[0].id, "new");
  assert.equal(result.at(-1).id, "irrelevant");
  assert.equal(result[0].score, 0.89);
  assert.equal(
    rankRecent([rows[0], { ...rows[1], score: 0.4 }], (row) => row.score)[0].id,
    "old",
  );
  assert.equal(
    freshness("2020-01-02T00:00:00Z", Date.parse("2020-02-01T00:00:00Z")),
    0.5,
  );
  assert.equal(freshness("invalid", Date.now()), 0);
  assert.equal(
    recencyReference(rows, "2020-01-15T00:00:00Z"),
    Date.parse(rows[0].timestamp),
  );
});
test("keyword retrieval and MCP share recency ranking with scope applied first", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,model TEXT,vector BLOB);CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED,text)",
  );
  for (const [id, date, project] of [
    ["old", "2020-01-01", "allowed"],
    ["new", "2020-02-01", "allowed"],
    ["future", "2021-01-01", "allowed"],
    ["private", "2020-02-02", "private"],
  ]) {
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)").run(
      id,
      id,
      project,
      "Review",
      "assistant",
      date + "T00:00:00Z",
      `The database migration was verified with SQLite tests. Case ${id}.`,
      "embeddinggemma",
      null,
    );
    db.prepare("INSERT INTO chunks_fts VALUES(?,?)").run(
      id,
      `The database migration was verified with SQLite tests. Case ${id}.`,
    );
  }
  const scope = { end: "2020-02-03T00:00:00Z" };
  const direct = await searchEvidence(db, {
    query: "database",
    mode: "keyword",
    allowedProjects: ["allowed"],
    ...scope,
  });
  assert.deepEqual(
    direct.results.map((row) => row.id),
    ["new", "old"],
  );
  const service = createEvidenceService(db, { allowedProjects: ["allowed"] });
  const mcp = await service.search({
    query: "database",
    mode: "keyword",
    ...scope,
  });
  assert.deepEqual(
    mcp.results.map((row) => row.id),
    ["new", "old"],
  );
  assert.ok(mcp.results[0].rankScore > mcp.results[1].rankScore);
  db.close();
});
