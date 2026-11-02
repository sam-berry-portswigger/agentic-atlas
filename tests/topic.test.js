import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer } from "../server/db.js";
import { seedAnalysis } from "./analysis-fixture.js";
import { readTopic } from "../server/topic.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings(key TEXT,value TEXT);
    CREATE TABLE insights(scope TEXT,fingerprint TEXT,data TEXT);
    CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,cluster INTEGER);`);
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const rows = [
    [
      "a",
      "one",
      "atlas",
      "SQLite migration",
      "user",
      "2026-10-20",
      "Investigate database persistence and transaction failures.",
      [1, 0],
      0,
      0,
    ],
    [
      "b",
      "one",
      "atlas",
      "SQLite migration",
      "assistant",
      "2026-10-21",
      "Fixed the SQLite transaction failures with a regression test.",
      [1, 0],
      0,
      0,
    ],
    [
      "c",
      "two",
      "atlas",
      "Database followup",
      "user",
      "2026-10-22",
      "Verify that the database migration preserves all existing records.",
      [1, 0],
      null,
      null,
    ],
    [
      "d",
      "three",
      "other",
      "Storage work",
      "user",
      "2026-10-22",
      "Review the database storage configuration for this project.",
      [1, 0],
      0,
      0,
    ],
    [
      "e",
      "four",
      "atlas",
      "Typography",
      "user",
      "2026-10-22",
      "Adjust font sizes and the alignment of the navigation icons.",
      [0, 1],
      0,
      1,
    ],
    [
      "f",
      "old",
      "atlas",
      "Old storage work",
      "user",
      "2026-09-01",
      "An older database investigation outside the selected time window.",
      [1, 0],
      0,
      0,
    ],
  ];
  for (const [
    id,
    session,
    project,
    title,
    role,
    day,
    text,
    vector,
    x,
    cluster,
  ] of rows)
    insert.run(
      id,
      session,
      project,
      title,
      role,
      `${day}T10:00:00Z`,
      text,
      vectorBuffer(vector),
      "embeddinggemma",
      x,
      cluster,
    );
  seedAnalysis(db);
  return db;
}
const scope = {
  project: "atlas",
  start: "2026-10-19T00:00:00Z",
  end: "2026-10-23T00:00:00Z",
};
test("topic covers all related conversations, including unplotted passages, within scope", () => {
  const db = fixture();
  try {
    const topic = readTopic(db, scope, "a");
    assert.equal(topic.cluster, 0);
    assert.equal(topic.passages, 3);
    assert.deepEqual(topic.conversations.map((c) => c.session).sort(), [
      "one",
      "two",
    ]);
    assert.deepEqual(topic.projects, ["atlas"]);
    assert.match(
      topic.conversations.find((c) => c.session === "one").preview,
      /^Investigate/,
    );
    assert.equal(
      topic.conversations.find((c) => c.session === "one").passages,
      2,
    );
    assert.deepEqual(
      new Set(topic.evidence.map((r) => r.id)),
      new Set(["a", "b", "c"]),
    );
    assert.equal(readTopic(db, scope, "c").cluster, 0);
  } finally {
    db.close();
  }
});
test("different topics and cross-project scopes stay distinct", () => {
  const db = fixture();
  try {
    assert.equal(readTopic(db, scope, "e").passages, 1);
    assert.equal(
      readTopic(db, { ...scope, project: "" }, "a").conversations.length,
      3,
    );
    assert.throws(() => readTopic(db, scope, "d"), { status: 404 });
    assert.equal(
      readTopic(db, scope, "f").passages,
      3,
      "historical citations resolve the topic but do not widen the date scope",
    );
    assert.throws(() => readTopic(db, scope, []), { status: 400 });
  } finally {
    db.close();
  }
});
