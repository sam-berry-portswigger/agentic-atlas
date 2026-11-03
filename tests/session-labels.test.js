import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer } from "../server/db.js";
import {
  initAnalysisSchema,
  activeAnalysis,
  readMap,
} from "../server/analysis-store.js";
import { analyseArchive as runAnalysis } from "../server/analysis.js";
const analyseArchive = (db, options) =>
  runAnalysis(db, { scopeEmbedder: null, ...options });
import {
  sessionNameResolver,
  publishSessionLabels,
  validateSessionLabels,
} from "../server/session-labels.js";
import { sessionOptions } from "../server/session-options.js";
import { readTopic } from "../server/topic.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
  );
  initAnalysisSchema(db);
  const put = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const [session, title] of [
    ["delegated", "Implement the plan"],
    ["native", "DEMO-123. Turn on the quick-search flag."],
  ])
    for (let i = 0; i < 4; i++)
      put.run(
        session + i,
        session,
        "desktop",
        title,
        i % 2 ? "assistant" : "user",
        `2026-10-28T1${i}:00:00Z`,
        "Fix the scheduling UI tests for the new quick-search flow. Preserve production code. " +
          i,
        vectorBuffer([1, 0]),
        "embeddinggemma",
        null,
        null,
        null,
      );
  return db;
}
function result(prompt) {
  const p = JSON.parse(prompt);
  return {
    streams: [
      {
        name: "Release scheduling",
        description: "Ship the new quick-search flow with verified UI tests.",
        sources: p.sessions.map((s) => s.source),
        background: false,
      },
    ],
    sessionLabels: p.labelSources.map((source) => ({
      source,
      title: "Fix scheduling UI tests",
    })),
  };
}
test("one interpretation call publishes reusable session labels without renaming native titles or evidence", async () => {
  const db = fixture();
  let calls = 0;
  try {
    const gen = async (db, system, prompt, schema) => {
      calls++;
      assert.ok(schema.required.includes("sessionLabels"));
      return result(prompt);
    };
    const version = await analyseArchive(db, {
      projectMap: false,
      nameGenerator: gen,
    });
    const resolve = sessionNameResolver(db);
    assert.equal(
      resolve("delegated", "Implement the plan", "desktop"),
      "Fix scheduling UI tests",
    );
    assert.equal(
      resolve("delegated", "Investigate a new issue", "desktop"),
      "Investigate a new issue",
    );
    assert.equal(
      resolve("native", "DEMO-123. Turn on the quick-search flag.", "desktop"),
      "DEMO-123. Turn on the quick-search flag.",
    );
    assert.equal(
      db.prepare("SELECT title FROM chunks WHERE id='delegated0'").get().title,
      "Implement the plan",
    );
    assert.match(
      db.prepare("SELECT text FROM chunks WHERE id='delegated0'").get().text,
      /Preserve production code/,
    );
    assert.ok(
      readMap(db, {}, "embeddinggemma")
        .points.filter((p) => p.id.startsWith("delegated"))
        .every((p) => p.title === "Fix scheduling UI tests"),
    );
    assert.ok(
      sessionOptions(db, { query: "scheduling UI" }).sessions.some(
        (s) => s.id === "delegated" && s.title === "Fix scheduling UI tests",
      ),
    );
    assert.equal(
      readTopic(db, {}, "delegated0").conversations.find(
        (c) => c.session === "delegated",
      ).title,
      "Fix scheduling UI tests",
    );
    assert.equal(
      await analyseArchive(db, { projectMap: false, nameGenerator: gen }),
      version,
    );
    assert.equal(
      calls,
      1,
      "opening views and unchanged syncs do not trigger another naming call",
    );
  } finally {
    db.close();
  }
});
test("invalid session labels fall back to cached names without blocking valid work streams", async () => {
  const db = fixture();
  try {
    const original = await analyseArchive(db, {
      projectMap: false,
      nameGenerator: async (db, s, p) => result(p),
    });
    const next = await analyseArchive(db, {
      force: true,
      projectMap: false,
      nameGenerator: async (db, s, p) => ({
        ...result(p),
        sessionLabels: [{ source: 999, title: "Invented task" }],
      }),
    });
    assert.notEqual(next, original);
    assert.equal(activeAnalysis(db).id, next);
    assert.equal(
      sessionNameResolver(db)("delegated", "Implement the plan", "desktop"),
      "Fix scheduling UI tests",
    );
  } finally {
    db.close();
  }
});
test("label reuse requires unchanged intent and rejects duplicate or unrequested source claims", async () => {
  const db = fixture();
  try {
    const version = await analyseArchive(db, {
      projectMap: false,
      nameGenerator: async (db, s, p) => result(p),
    });
    const rows = db.prepare("SELECT * FROM chunks").all();
    publishSessionLabels(db, "same", [], rows, version);
    assert.equal(
      sessionNameResolver(db, "same")(
        "delegated",
        "Implement the plan",
        "desktop",
      ),
      "Fix scheduling UI tests",
    );
    publishSessionLabels(
      db,
      "changed",
      [],
      rows.map((r) =>
        r.id === "delegated0"
          ? { ...r, text: "Investigate a different issue." }
          : r,
      ),
      version,
    );
    assert.equal(
      sessionNameResolver(db, "changed")(
        "delegated",
        "Implement the plan",
        "desktop",
      ),
      "Implement the plan",
    );
    const keys = new Map([
      [1, { session: "delegated" }],
      [2, { session: "native" }],
    ]);
    assert.deepEqual(
      validateSessionLabels(
        [{ source: 2, title: "Rename native title" }],
        keys,
        new Set([1]),
      ),
      [],
    );
    assert.deepEqual(
      validateSessionLabels(
        [{ source: 1, title: "Implement the plan" }],
        keys,
        new Set([1]),
      ),
      [],
    );
    assert.deepEqual(
      validateSessionLabels(
        [
          { source: 1, title: "Fix scheduling UI tests" },
          { source: 1, title: "Different label" },
        ],
        keys,
        new Set([1]),
      ),
      [{ session: "delegated", title: "Fix scheduling UI tests" }],
    );
    assert.deepEqual(
      validateSessionLabels([{ source: 1, title: "" }], keys, new Set([1])),
      [],
    );
  } finally {
    db.close();
  }
});
