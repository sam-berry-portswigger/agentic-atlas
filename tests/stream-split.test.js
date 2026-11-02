import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  initAnalysisSchema,
  activeAnalysis,
  readMap,
} from "../server/analysis-store.js";
import { vectorBuffer, vectorArray, normalize, cosine } from "../server/db.js";
import { splitWorkStream } from "../server/stream-split.js";
import { updateCatalogue } from "../server/incremental-analysis.js";
import { SEMANTIC_POLICY } from "../server/semantic-policy.js";
import { attachTodayStreams } from "../server/today-streams.js";

const options = {
  sourceId: 43,
  sessions: ["modules", "fork"],
  name: "Codebase modularisation",
  description: "Separate tool modules and enforce architecture boundaries.",
};
const locks = { acquireLock: () => () => {} };
function add(db, id, session, v) {
  db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    session,
    "same-project",
    "Same native title",
    "user",
    "2026-11-02T10:00:00Z",
    "A substantive discussion of a specific development objective with supporting evidence.",
    vectorBuffer(normalize(v)),
    "embeddinggemma",
    0.2,
    0.3,
    43,
  );
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
  );
  initAnalysisSchema(db);
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "v",
    "f",
    "embeddinggemma",
    "mock",
    "now",
    JSON.stringify({
      method: "workstreams-v2",
      mapUnit: "conversation",
      conversationPolicy: SEMANTIC_POLICY,
      topics: 1,
    }),
  );
  db.exec("INSERT INTO analysis_state VALUES('active','v')");
  db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
    "v",
    43,
    "Schedule rollout",
    "Roll out scheduling",
    "#e4a675",
    vectorBuffer(normalize([1, 1])),
  );
  for (const [session, vector] of [
    ["schedule", [1, 0]],
    ["modules", [0.7, 0.714]],
    ["fork", [0.66, 0.75]],
  ]) {
    add(db, session, session, vector);
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      session,
      43,
      0.2,
      0.3,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      session,
      session,
      vectorBuffer(normalize(vector)),
      0.2,
      0.3,
    );
  }
  return db;
}

test("reviewed split separates same-project work in Today and Explore without moving vectors or coordinates", () => {
  const db = fixture();
  try {
    const before = db
      .prepare("SELECT * FROM analysis_conversations ORDER BY session")
      .all();
    const result = splitWorkStream(db, options, locks);
    assert.equal(result.streamId, 44);
    assert.equal(result.passages, 2);
    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_conversations ORDER BY session").all(),
      before,
    );
    assert.deepEqual(
      readMap(db, {}, "embeddinggemma")
        .points.map((p) => [p.session, p.cluster])
        .sort(),
      [
        ["fork", 44],
        ["modules", 44],
        ["schedule", 43],
      ],
    );
    const today = [
      { id: "modules", project: "same-project" },
      { id: "schedule", project: "same-project" },
    ];
    attachTodayStreams(db, today, []);
    assert.equal(today[0].topic.id, "44");
    assert.equal(today[1].topic.id, "43");
    const source = db
      .prepare("SELECT centroid FROM analysis_topics WHERE id=43")
      .get();
    assert.ok(cosine(vectorArray(source.centroid), [1, 0]) > 0.999);
    assert.ok(JSON.parse(activeAnalysis(db).data).assignmentsUpdatedAt);
    assert.throws(() => splitWorkStream(db, options, locks), /already exists/);
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_topics").get().n,
      2,
    );
  } finally {
    db.close();
  }
});

test("split corrections survive incremental updates and new similar chats use the new saved topic with no inference", async () => {
  const db = fixture();
  try {
    splitWorkStream(db, options, locks);
    add(db, "drift", "modules", [1, 0]);
    add(db, "new", "new", [0.68, 0.73]);
    const result = await updateCatalogue(db, {
      bootstrap: () => {
        throw Error("no model or rebuild");
      },
    });
    const members = db
      .prepare("SELECT chunk_id,topic_id FROM analysis_members WHERE version=?")
      .all(result.version);
    for (const id of ["modules", "fork", "drift", "new"])
      assert.equal(members.find((r) => r.chunk_id === id).topic_id, 44, id);
    assert.equal(members.find((r) => r.chunk_id === "schedule").topic_id, 43);
    assert.equal((await updateCatalogue(db)).unchanged, true);
  } finally {
    db.close();
  }
});

test("invalid or stale split requests roll back without altering saved assignments", () => {
  for (const sessions of [["missing"], ["modules", "fork", "schedule"]]) {
    const db = fixture();
    try {
      assert.throws(() => splitWorkStream(db, { ...options, sessions }, locks));
      assert.equal(
        db.prepare("SELECT count(*) n FROM analysis_topics").get().n,
        1,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM analysis_members WHERE topic_id<>43")
          .get().n,
        0,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM analysis_state WHERE key='stream_session_assignments'",
          )
          .get().n,
        0,
      );
    } finally {
      db.close();
    }
  }
});

test("an explicit catalogue rebuild preserves the split ID and manual memberships", async () => {
  const { analyseArchive } = await import("../server/analysis.js");
  const db = fixture();
  try {
    const split = splitWorkStream(db, options, locks);
    const version = await analyseArchive(db, {
      force: true,
      projectMap: false,
      scopeEmbedder: null,
      namingOptional: true,
      nameGenerator: (_db, _system, prompt) => ({
        streams: [
          {
            name: "Other sessions",
            description: "Evidence outside the established saved work streams.",
            background: true,
            sources: JSON.parse(prompt).sessions.map((s) => s.source),
          },
        ],
      }),
    });
    const members = db
      .prepare("SELECT chunk_id,topic_id FROM analysis_members WHERE version=?")
      .all(version);
    for (const id of options.sessions)
      assert.equal(
        members.find((m) => m.chunk_id === id).topic_id,
        split.streamId,
      );
    assert.equal(members.find((m) => m.chunk_id === "schedule").topic_id, 43);
    assert.equal(
      db
        .prepare("SELECT name FROM analysis_topics WHERE version=? AND id=?")
        .get(version, split.streamId).name,
      options.name,
    );
  } finally {
    db.close();
  }
});
