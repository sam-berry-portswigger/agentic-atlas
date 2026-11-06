import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { publishDensityGroups } from "../server/numerical-streams.js";
import { reconcileSessionStreams } from "../server/session-streams.js";
import { vectorBuffer } from "../server/db.js";

test("density publication applies labels to whole conversations while preserving manual corrections and original vector bytes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initAnalysisSchema(db);
    db.exec(
      "CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,title TEXT,project TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,cluster INTEGER)",
    );
    db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
      "v",
      "f",
      "e",
      "g",
      "now",
      JSON.stringify({ mapUnit: "conversation" }),
    );
    db.exec("INSERT INTO analysis_state VALUES('active','v')");
    for (const [id, name] of [
      [10, "Old misleading topic"],
      [20, "User selected goal"],
    ])
      db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
        "v",
        id,
        name,
        "Preserved user scope.",
        "#123456",
        vectorBuffer([1, 0]),
      );
    for (const [session, title, vector] of [
      ["a", "Document import", [1, 0]],
      ["b", "Import validation", [0.9, 0.1]],
      ["c", "Calendar export", [0, 1]],
      ["manual", "Custom workflow", [0.5, 0.5]],
    ]) {
      for (const suffix of ["", "-followup"]) {
        const id = session + suffix;
        db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)").run(
          id,
          session,
          title,
          "project",
          "user",
          "2026-11-03",
          "Original immutable source evidence.",
          vectorBuffer(vector),
          10,
        );
        db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
          "v",
          id,
          10,
          0.2,
          0.7,
        );
      }
      db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
        "v",
        session,
        session,
        vectorBuffer(vector),
        0.2,
        0.7,
      );
    }
    db.prepare(
      "INSERT INTO analysis_state VALUES('stream_session_assignments',?)",
    ).run(JSON.stringify({ manual: 20 }));
    db.exec("INSERT INTO session_relationships VALUES('a','c','spawned')");
    db.prepare("INSERT INTO session_title_overrides VALUES(?,?,?)").run(
      "a",
      "Human import title",
      "now",
    );
    db.prepare("INSERT INTO analysis_summaries VALUES(?,?,?,?)").run(
      "v",
      "old",
      "all",
      "{}",
    );
    const source = () =>
      db.prepare("SELECT id,text,vector FROM chunks ORDER BY id").all();
    const before = source();
    const positions = db
      .prepare(
        "SELECT session,vector,x,y FROM analysis_conversations ORDER BY session",
      )
      .all();
    db.exec("BEGIN");
    const metadata = publishDensityGroups(db, "v", ["a", "b", "c", "manual"], {
      labels: [0, 0, -1, 0],
    });
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='v'").run(
      JSON.stringify(metadata),
    );
    reconcileSessionStreams(db, "v");
    db.exec("COMMIT");
    const members = db
      .prepare(
        "SELECT c.session,m.topic_id,t.name FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id JOIN analysis_topics t ON t.version=m.version AND t.id=m.topic_id ORDER BY c.id",
      )
      .all();
    const topic = (session) => members.find((row) => row.session === session);
    assert.equal(topic("a").topic_id, topic("b").topic_id);
    assert.notEqual(topic("a").topic_id, topic("c").topic_id);
    assert.equal(topic("a").name, "Human import title");
    assert.equal(topic("c").name, "Other sessions");
    assert.equal(topic("manual").topic_id, 20);
    assert.equal(topic("manual").name, "User selected goal");
    for (const session of ["a", "b", "c", "manual"])
      assert.equal(
        new Set(
          members
            .filter((row) => row.session === session)
            .map((row) => row.topic_id),
        ).size,
        1,
      );
    assert.ok(topic("a").topic_id > 20);
    assert.deepEqual(source(), before);
    assert.deepEqual(
      db
        .prepare(
          "SELECT session,vector,x,y FROM analysis_conversations ORDER BY session",
        )
        .all(),
      positions,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_summaries").get().n,
      0,
    );
    assert.equal(
      metadata.namingPending,
      true,
      "new density groups await ordinary topic naming",
    );
    db.prepare(
      "UPDATE analysis_topics SET name=?,description=? WHERE version='v' AND id=?",
    ).run(
      "Document import pipeline",
      "Import documents and validate the resulting records.",
      topic("a").topic_id,
    );
    const second = publishDensityGroups(db, "v", ["a", "b", "c", "manual"], {
      labels: [7, 7, -1, 7],
    });
    assert.equal(
      db
        .prepare("SELECT topic_id FROM analysis_members WHERE chunk_id='a'")
        .get().topic_id,
      topic("a").topic_id,
      "label renumbering preserves a matching group's ID",
    );
    assert.equal(second.namingPending, false);
    const renamed = db
      .prepare(
        "SELECT name,description FROM analysis_topics WHERE version='v' AND id=?",
      )
      .get(topic("a").topic_id);
    assert.equal(renamed.name, "Document import pipeline");
    assert.equal(
      renamed.description,
      "Import documents and validate the resulting records.",
    );
    assert.deepEqual(metadata.backgroundIds, [topic("c").topic_id]);
  } finally {
    db.close();
  }
});
