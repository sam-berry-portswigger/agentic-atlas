import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema, readMap } from "../server/analysis-store.js";
import {
  rememberRelationships,
  reconcileSessionStreams,
} from "../server/session-streams.js";
import { attachTodayStreams } from "../server/today-streams.js";
import { familyRoots } from "../shared/today-layout.js";
import { disambiguateSessionTitles } from "../server/session-display.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunks(id TEXT,session TEXT,title TEXT,project TEXT,role TEXT,timestamp TEXT,cluster INTEGER);",
  );
  initAnalysisSchema(db);
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "v",
    "f",
    "e",
    "g",
    "now",
    JSON.stringify({ method: "workstreams-v2" }),
  );
  db.exec("INSERT INTO analysis_state VALUES('active','v')");
  for (const id of [1, 2])
    db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
      "v",
      id,
      "Stream " + id,
      "Known scope sentence.",
      "#aaa",
      Buffer.from([0]),
    );
  return db;
}
function add(db, sid, id) {
  db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)").run(
    sid,
    sid,
    "Session",
    "project",
    "user",
    "2026-10-29T10:00:00Z",
    id,
  );
  db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
    "v",
    sid,
    id,
    0.2,
    0.7,
  );
}
test("recorded delegation reconciles canonical membership used by Today and evidence, without moving points", () => {
  const db = fixture();
  try {
    for (const [s, id] of [
      ["root", 1],
      ["child", 2],
      ["nested", 2],
      ["shared", 2],
      ["fork", 2],
      ["explicit", 2],
    ])
      add(db, s, id);
    const edges = [
      { parent: "root", child: "child", kind: "delegated" },
      { parent: "child", child: "nested", kind: "spawned" },
      { parent: "root", child: "shared", kind: "shared_history" },
      { parent: "root", child: "fork", kind: "forked" },
      { parent: "root", child: "explicit", kind: "spawned" },
    ];
    db.prepare("INSERT INTO analysis_state VALUES(?,?)").run(
      "stream_session_assignments",
      JSON.stringify({ explicit: 2 }),
    );
    rememberRelationships(db, edges);
    assert.equal(reconcileSessionStreams(db), 2);
    assert.equal(reconcileSessionStreams(db), 0);
    const membership = Object.fromEntries(
      db
        .prepare("SELECT chunk_id,topic_id FROM analysis_members")
        .all()
        .map((r) => [r.chunk_id, r.topic_id]),
    );
    assert.deepEqual(membership, {
      root: 1,
      child: 1,
      nested: 1,
      shared: 2,
      fork: 2,
      explicit: 2,
    });
    assert.ok(
      db
        .prepare("SELECT * FROM analysis_members")
        .all()
        .every((r) => r.x === 0.2 && r.y === 0.7),
    );
    const sessions = Object.keys(membership).map((id) => ({ id }));
    attachTodayStreams(db, sessions, edges);
    for (const s of sessions)
      assert.equal(Number(s.topic.id), membership[s.id]);
    assert.equal(sessions.find((s) => s.id === "explicit").boardStreamId, 2);
    assert.equal(familyRoots(sessions, edges).root("explicit"), "explicit");
  } finally {
    db.close();
  }
});
test("cycles, multiple parents and missing parents cannot invent an inherited stream", () => {
  const db = fixture();
  try {
    for (const [s, id] of [
      ["a", 1],
      ["b", 2],
      ["ambiguous", 2],
      ["orphan", 2],
    ])
      add(db, s, id);
    rememberRelationships(db, [
      { parent: "a", child: "b", kind: "spawned" },
      { parent: "b", child: "a", kind: "spawned" },
      { parent: "a", child: "ambiguous", kind: "delegated" },
      { parent: "b", child: "ambiguous", kind: "delegated" },
      { parent: "missing", child: "orphan", kind: "spawned" },
    ]);
    assert.equal(reconcileSessionStreams(db), 0);
    assert.equal(
      db
        .prepare("SELECT topic_id FROM analysis_members WHERE chunk_id='b'")
        .get().topic_id,
      2,
    );
  } finally {
    db.close();
  }
});
test("Today reuses the saved seven-day map assignment even when today's passages favour another topic", () => {
  const db = fixture();
  try {
    // The saved representative precedes today's window. More recent passages
    // must not trigger either a new day-scoped vote or an archive-wide vote.
    for (const [sid, id] of [
      ["saved", 1],
      ["today-a", 2],
      ["today-b", 2],
    ]) {
      add(db, sid, id);
      db.prepare("UPDATE chunks SET session='chat',timestamp=? WHERE id=?").run(
        sid === "saved" ? "2026-10-27T10:00:00Z" : "2026-10-29T10:00:00Z",
        sid,
      );
    }
    db.exec("ALTER TABLE chunks ADD COLUMN text TEXT DEFAULT ''");
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      "chat",
      "saved",
      Buffer.from([0]),
      0.2,
      0.7,
    );
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='v'").run(
      JSON.stringify({ method: "workstreams-v2", mapUnit: "conversation" }),
    );
    const week = readMap(db, { start: "2026-10-23", end: "2026-10-30" }, "e");
    assert.equal(week.points[0].cluster, 1);
    const sessions = [{ id: "chat" }];
    attachTodayStreams(db, sessions, [], {
      start: "2026-10-29",
      end: "2026-10-30",
    });
    assert.equal(sessions[0].boardStreamId, week.points[0].cluster);
    assert.deepEqual(sessions[0].streamIds, [1]);
    const day = readMap(db, { start: "2026-10-29", end: "2026-10-30" }, "e");
    assert.equal(day.points[0].cluster, week.points[0].cluster);
    assert.equal(day.points[0].id, "today-a");
    assert.equal(db.prepare("SELECT count(*) n FROM analysis_runs").get().n, 1);
  } finally {
    db.close();
  }
});
test("repeated native titles stay separate and receive a deterministic disambiguation marker", () => {
  const sessions = [
    { id: "one", provider: "claude", title: "Same title" },
    { id: "two", provider: "claude", title: "Same title" },
    { id: "three", provider: "codex", title: "Other title" },
  ];
  disambiguateSessionTitles(sessions);
  assert.equal(sessions[0].sameTitle, true);
  assert.equal(sessions[1].sameTitle, true);
  assert.equal(sessions[2].sameTitle, undefined);
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["one", "two", "three"],
  );
  sessions.pop();
  sessions[1].title = "Different";
  disambiguateSessionTitles(sessions);
  assert.equal(sessions[0].sameTitle, undefined);
});
