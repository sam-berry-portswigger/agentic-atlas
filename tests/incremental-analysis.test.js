import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  initAnalysisSchema,
  activeAnalysis,
  readMap,
} from "../server/analysis-store.js";
import {
  updateCatalogue,
  markCatalogueDirty,
} from "../server/incremental-analysis.js";
import { vectorBuffer } from "../server/db.js";
import { SEMANTIC_POLICY } from "../server/semantic-policy.js";
import { upgradeProjection } from "../server/projection-store.js";
import { PROJECTION_POLICY } from "../server/projection.js";
import { conversationVectors } from "../server/conversation-vectors.js";
import { vectorArray, cosine } from "../server/db.js";
import { sessionLabelInputHash } from "../server/session-labels.js";

function add(
  db,
  id,
  session,
  vector,
  text = "A substantive message explaining the sustained objective in this conversation.",
) {
  db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    session,
    "project",
    "Useful native title",
    "user",
    "2026-11-02T10:00:00Z",
    text,
    vectorBuffer(vector),
    "embeddinggemma",
    null,
    null,
    null,
  );
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER); CREATE INDEX chunks_session_time ON chunks(session,timestamp)",
  );
  initAnalysisSchema(db);
  const data = {
    mapUnit: "conversation",
    method: "workstreams-v2",
    conversationPolicy: SEMANTIC_POLICY,
    backgroundIds: [30],
    passages: 2,
    conversations: 2,
  };
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "old",
    "f",
    "embeddinggemma",
    "mock",
    "2026-11-02",
    JSON.stringify(data),
  );
  db.exec("INSERT INTO analysis_state VALUES('active','old')");
  for (const [id, name, vector] of [
    [10, "Atlas interface", [1, 0]],
    [20, "Schedule rollout", [0, 1]],
    [30, "Other sessions", [-1, 0]],
  ])
    db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
      "old",
      id,
      name,
      "A saved work goal.",
      "#" + id,
      vectorBuffer(vector),
    );
  for (const [session, id, vector, topic, x] of [
    ["ui", "ui-original", [1, 0], 10, 0.2],
    ["schedule", "schedule-original", [0, 1], 20, 0.7],
  ]) {
    add(db, id, session, vector);
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "old",
      id,
      topic,
      x,
      0.3,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "old",
      session,
      id,
      vectorBuffer(vector),
      x,
      0.3,
    );
  }
  return db;
}
test("no-op sync reuses the catalogue with no bootstrap, models or new snapshot", async () => {
  const db = fixture();
  try {
    const result = await updateCatalogue(db, {
      bootstrap: () => {
        throw Error("must not infer");
      },
    });
    assert.equal(result.unchanged, true);
    assert.equal(result.version, "old");
    assert.equal(db.prepare("SELECT count(*) n FROM analysis_runs").get().n, 1);
  } finally {
    db.close();
  }
});
test("append and new conversation reuse saved topics and cached unaffected vectors without projection", async () => {
  const db = fixture();
  try {
    const original = db
      .prepare(
        "SELECT vector FROM analysis_conversations WHERE session='schedule'",
      )
      .get().vector;
    add(db, "ui-new", "ui", [1, 0]);
    add(db, "new-chat", "new", [0, 1]);
    const result = await updateCatalogue(db, {
      bootstrap: () => {
        throw Error("must not infer");
      },
    });
    assert.equal(result.changedSessions, 2);
    assert.notEqual(result.version, "old");
    assert.equal(result.mapPending, true);
    const members = db
      .prepare("SELECT chunk_id,topic_id FROM analysis_members WHERE version=?")
      .all(result.version);
    assert.equal(members.find((r) => r.chunk_id === "ui-new").topic_id, 10);
    assert.equal(members.find((r) => r.chunk_id === "new-chat").topic_id, 20);
    const cached = db
      .prepare(
        "SELECT * FROM analysis_conversations WHERE version=? AND session='schedule'",
      )
      .get(result.version);
    assert.deepEqual(cached.vector, original);
    assert.deepEqual([cached.x, cached.y], [0.7, 0.3]);
    const next = db
      .prepare(
        "SELECT * FROM analysis_conversations WHERE version=? AND session='new'",
      )
      .get(result.version);
    assert.equal(next.x, null);
    assert.equal(next.y, null);
    assert.equal(
      readMap(db, {}, "embeddinggemma").points.length,
      2,
      "new chats get no invented coordinates",
    );
    assert.equal((await updateCatalogue(db)).unchanged, true);
    assert.equal(
      (await updateCatalogue(db, { changedSessions: ["ui"] })).unchanged,
      true,
      "identical changed-file content reuses cached representation",
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_dirty_sessions").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
test("manual assignments win and unrelated new evidence stays in the saved residual group", async () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO analysis_state VALUES(?,?)").run(
      "stream_session_assignments",
      JSON.stringify({ ui: 20 }),
    );
    add(db, "ui-new", "ui", [1, 0]);
    add(db, "unclear", "unknown", [-1, 0]);
    const result = await updateCatalogue(db);
    const member = db.prepare(
      "SELECT topic_id FROM analysis_members WHERE version=? AND chunk_id=?",
    );
    assert.equal(member.get(result.version, "ui-new").topic_id, 20);
    assert.equal(member.get(result.version, "unclear").topic_id, 30);
  } finally {
    db.close();
  }
});
test("deletion keeps topic identities and removes deleted content from the new snapshot", async () => {
  const db = fixture();
  try {
    markCatalogueDirty(db, ["ui"]);
    db.exec("DELETE FROM chunks WHERE session='ui'");
    const result = await updateCatalogue(db);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM analysis_conversations WHERE version=?",
        )
        .get(result.version).n,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM analysis_members WHERE version=?")
        .get(result.version).n,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT name FROM analysis_topics WHERE version=? AND id=10")
        .get(result.version).name,
      "Atlas interface",
    );
  } finally {
    db.close();
  }
});
test("cancelled and failed publication preserve the old active snapshot and dirty journal", async () => {
  const db = fixture();
  try {
    add(db, "new-chat", "new", [0, 1]);
    const controller = new AbortController();
    await assert.rejects(
      updateCatalogue(db, {
        changedSessions: ["new"],
        signal: controller.signal,
        send: () => controller.abort(),
      }),
    );
    assert.equal(activeAnalysis(db).id, "old");
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_dirty_sessions").get().n,
      1,
    );
    db.exec(
      "CREATE TRIGGER reject_publish BEFORE INSERT ON analysis_conversations WHEN NEW.version<>'old' AND NEW.session='new' BEGIN SELECT RAISE(ABORT,'test publication failure'); END;",
    );
    await assert.rejects(updateCatalogue(db), /test publication failure/);
    assert.equal(activeAnalysis(db).id, "old");
    assert.equal(db.prepare("SELECT count(*) n FROM analysis_runs").get().n, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_dirty_sessions").get().n,
      1,
    );
  } finally {
    db.close();
  }
});
test("first run uses optional naming and defers map work", async () => {
  const db = fixture();
  try {
    db.exec("DELETE FROM analysis_state WHERE key='active'");
    let called = false;
    const result = await updateCatalogue(db, {
      bootstrap: async (_db, options) => {
        called = true;
        assert.equal(options.namingOptional, true);
        assert.equal(options.projectMap, false);
        assert.equal(options.deferMap, true);
        return "first";
      },
    });
    assert.equal(called, true);
    assert.equal(result.contentReady, true);
    assert.equal(result.mapPending, true);
  } finally {
    db.close();
  }
});
test("explicit map refresh plots pending cached vectors without rebuilding topics", async () => {
  const db = fixture();
  try {
    const data = JSON.parse(activeAnalysis(db).data);
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='old'").run(
      JSON.stringify({
        ...data,
        mapPending: true,
        projection: { policy: PROJECTION_POLICY },
      }),
    );
    db.exec("UPDATE analysis_conversations SET x=NULL,y=NULL");
    await upgradeProjection(db, activeAnalysis(db));
    assert.equal(activeAnalysis(db).id, "old");
    assert.equal(JSON.parse(activeAnalysis(db).data).mapPending, false);
    assert.equal(readMap(db, {}, "embeddinggemma").points.length, 2);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM analysis_topics WHERE version='old'")
        .get().n,
      3,
    );
  } finally {
    db.close();
  }
});
test("successive background updates keep one live incremental version instead of copying the archive forever", async () => {
  const db = fixture();
  try {
    add(db, "append-1", "ui", [1, 0]);
    const first = await updateCatalogue(db);
    add(db, "append-2", "ui", [1, 0]);
    const second = await updateCatalogue(db);
    assert.equal(second.version, first.version);
    assert.equal(db.prepare("SELECT count(*) n FROM analysis_runs").get().n, 2);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM analysis_members WHERE version=?")
        .get(second.version).n,
      4,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM analysis_members WHERE version='old'")
        .get().n,
      2,
      "full snapshot is retained",
    );
  } finally {
    db.close();
  }
});
test("a changed conversation retains corpus-wide duplicate downweighting", async () => {
  const db = fixture();
  try {
    const shared =
      "This repeated request describes an interface feature and is copied into many conversations.";
    db.prepare("UPDATE chunks SET text=? WHERE id='ui-original'").run(shared);
    for (let i = 0; i < 9; i++)
      add(db, "copy-" + i, "copy-" + i, [1, 0], shared);
    add(
      db,
      "ui-unique",
      "ui",
      [0, 1],
      "A different detailed explanation establishes the overall sustained goal for this conversation.",
    );
    const all = db
      .prepare("SELECT * FROM chunks")
      .all()
      .map((r) => ({ ...r, vector: vectorArray(r.vector) }));
    const expected = conversationVectors(all).find(
      (c) => c.session === "ui",
    ).vector;
    const result = await updateCatalogue(db);
    const actual = vectorArray(
      db
        .prepare(
          "SELECT vector FROM analysis_conversations WHERE version=? AND session='ui'",
        )
        .get(result.version).vector,
    );
    assert.ok(cosine(expected, actual) > 0.999999);
  } finally {
    db.close();
  }
});
test("changed intent invalidates inferred titles while preserving manual names", async () => {
  const db = fixture();
  try {
    const rows = db.prepare("SELECT * FROM chunks WHERE session='ui'").all();
    db.prepare("INSERT INTO analysis_session_labels VALUES(?,?,?,?)").run(
      "old",
      "ui",
      "Previous inferred goal",
      sessionLabelInputHash(rows),
    );
    db.prepare("INSERT INTO session_title_overrides VALUES(?,?,?)").run(
      "ui",
      "My manual title",
      "now",
    );
    add(
      db,
      "new-intent",
      "ui",
      [1, 0],
      "A new substantive user request changes the conversation evidence for any inferred title.",
    );
    const result = await updateCatalogue(db);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM analysis_session_labels WHERE version=? AND session='ui'",
        )
        .get(result.version).n,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT title FROM session_title_overrides WHERE session='ui'")
        .get().title,
      "My manual title",
    );
  } finally {
    db.close();
  }
});

test("selecting the explicit :latest alias preserves stream identities and cached vectors", async () => {
  const db = fixture();
  try {
    const before = db
      .prepare("SELECT * FROM analysis_topics ORDER BY id")
      .all();
    const cached = db
      .prepare("SELECT * FROM analysis_conversations ORDER BY session")
      .all();
    db.prepare("INSERT INTO settings VALUES('embeddingModel',?)").run(
      JSON.stringify("embeddinggemma:latest"),
    );
    const result = await updateCatalogue(db, {
      bootstrap: () => {
        throw Error("an alias must not rebuild or rename the catalogue");
      },
    });
    assert.equal(result.unchanged, true);
    assert.equal(result.version, "old");
    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_topics ORDER BY id").all(),
      before,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_conversations ORDER BY session").all(),
      cached,
    );
    add(db, "alias-new-chat", "new-alias", [0, 1]);
    const appended = await updateCatalogue(db, {
      bootstrap: () => {
        throw Error("routine alias sync must keep saved topics");
      },
    });
    assert.equal(
      db
        .prepare(
          "SELECT topic_id FROM analysis_members WHERE version=? AND chunk_id='alias-new-chat'",
        )
        .get(appended.version).topic_id,
      20,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,name,color FROM analysis_topics WHERE version=? ORDER BY id",
        )
        .all(appended.version)
        .map((row) => ({ ...row })),
      before.map(({ id, name, color }) => ({ id, name, color })),
    );
  } finally {
    db.close();
  }
});
