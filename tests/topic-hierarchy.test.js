import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema, readMap } from "../server/analysis-store.js";
import {
  groupTopics,
  topicHierarchy,
  refreshTopicHierarchy,
} from "../server/topic-hierarchy.js";
import { vectorBuffer, normalize } from "../server/db.js";
import { nestTopics } from "../shared/topic-hierarchy.js";
import { publishWorkstreamCatalogue } from "../server/workstream-catalogue.js";
import { nameDensityGroups } from "../server/density-naming.js";
import { attachTodayStreams } from "../server/today-streams.js";
import { createHash } from "node:crypto";
const topic = (id, name, vector) => ({
  id,
  name,
  description: name + " with a concrete outcome.",
  color: "#123456",
  vector: normalize(vector),
  scope: normalize(vector),
});
const examples = () => [
  topic(1, "Document Import Planning", [1, 0.03, 0]),
  topic(2, "Document Import Verification", [1, -0.03, 0]),
  topic(3, "Personal Coaching Goals", [0, 1, 0.02]),
  topic(4, "Billing Dashboard", [0, 0.02, 1]),
];
test("broader groups join supporting topics while preserving unrelated work and every original record", () => {
  const topics = examples(),
    before = structuredClone(topics),
    groups = groupTopics(topics);
  assert.deepEqual(groups.find((g) => g.topicIds.includes(1)).topicIds, [1, 2]);
  assert.notEqual(
    groups.find((g) => g.topicIds.includes(1)).id,
    groups.find((g) => g.topicIds.includes(3)).id,
  );
  assert.deepEqual(topics, before);
  assert.deepEqual(
    groups.flatMap((g) => g.topicIds).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
  assert.deepEqual(groupTopics([...topics].reverse()), groups);
});
test("a shared generic modifier cannot join unrelated subjects", () => {
  const groups = groupTopics([
    topic(1, "Multi Review Tool", [1, 0, 0]),
    topic(2, "Multi License Selection", [0, 1, 0]),
    topic(3, "Research Roadmap", [0, 0, 1]),
  ]);
  assert.ok(
    groups.every((g) => !(g.topicIds.includes(1) && g.topicIds.includes(2))),
  );
});
test("overlap preserves a parent identity without changing topic IDs", () => {
  const initial = groupTopics(examples());
  const prior = initial.map((g) => ({ ...g, id: g.id + 100 }));
  const next = groupTopics(examples(), prior);
  assert.equal(next.find((g) => g.topicIds.includes(1)).id, 101);
  assert.deepEqual(
    next.flatMap((g) => g.topicIds).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,model TEXT,vector BLOB,x REAL,y REAL,cluster INTEGER)",
  );
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "v",
    "fingerprint",
    "embeddinggemma",
    "unused",
    "now",
    JSON.stringify({ mapUnit: "conversation" }),
  );
  db.exec("INSERT INTO analysis_state VALUES('active','v')");
  for (const t of examples()) {
    db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
      "v",
      t.id,
      t.name,
      t.description,
      t.color,
      vectorBuffer(t.vector),
    );
    const id = "source" + t.id;
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id,
      id,
      "p",
      t.name,
      "user",
      "2026-11-04T10:00:00Z",
      "Original request about " + t.name,
      "embeddinggemma",
      vectorBuffer(t.vector),
      t.id / 10,
      0.25,
      t.id,
    );
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      id,
      t.id,
      t.id / 10,
      0.25,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      id,
      id,
      vectorBuffer(t.vector),
      t.id / 10,
      0.25,
    );
    const key =
      "stream-scope-v1:" +
      createHash("sha256")
        .update(JSON.stringify(["embeddinggemma", t.name, t.description]))
        .digest("hex");
    db.prepare("INSERT INTO analysis_name_cache VALUES(?,?)").run(
      key,
      JSON.stringify(t.vector),
    );
  }
  return db;
}
test("cached hierarchy needs no inference, invalidates on scope changes, and leaves original data byte-for-byte intact", async () => {
  const db = fixture();
  try {
    const snapshot = () =>
      JSON.stringify({
        topics: db.prepare("SELECT * FROM analysis_topics").all(),
        members: db.prepare("SELECT * FROM analysis_members").all(),
        conversations: db.prepare("SELECT * FROM analysis_conversations").all(),
        chunks: db.prepare("SELECT * FROM chunks").all(),
      });
    const before = snapshot();
    const first = await refreshTopicHierarchy(db, "v");
    const state = db
      .prepare("SELECT value FROM analysis_state WHERE key='topic_hierarchy'")
      .get().value;
    const second = await refreshTopicHierarchy(db, "v");
    assert.deepEqual(second, first);
    assert.equal(
      db
        .prepare("SELECT value FROM analysis_state WHERE key='topic_hierarchy'")
        .get().value,
      state,
    );
    assert.equal(snapshot(), before);
    const map = readMap(db, {}, "embeddinggemma");
    assert.equal(map.points.length, 4);
    assert.equal(map.points[0].x, 0.1);
    assert.equal(map.points[0].cluster, 1);
    assert.equal(map.points[0].workstreamId, map.points[1].workstreamId);
    assert.equal(snapshot(), before);
    db.exec("UPDATE analysis_topics SET name='New Import Scope' WHERE id=1");
    assert.equal(topicHierarchy(db, "v").flatMap((g) => g.topicIds).length, 4);
  } finally {
    db.close();
  }
});
test("read-only views do not populate hierarchy state or change source membership", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT count(*) n FROM analysis_state").get().n;
    topicHierarchy(db, "v");
    topicHierarchy(db, "v");
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_state").get().n,
      before,
    );
  } finally {
    db.close();
  }
});
test("Today nesting keeps visible topic order, filters absent topics and retains unparented topics", () => {
  const topics = examples(),
    groups = nestTopics(topics, [
      { id: 9, name: "Document import", color: "#abc", topicIds: [1, 2, 99] },
    ]);
  assert.deepEqual(groups[0].topics, topics.slice(0, 2));
  assert.equal(groups.flatMap((g) => g.topics).length, 4);
  assert.deepEqual(
    nestTopics(topics.slice(1, 2), [
      { id: 9, name: "Import", color: "#abc", topicIds: [1, 2] },
    ])[0].topics,
    [topics[1]],
  );
});

test("accepted map clusters become one shared catalogue and are named from their combined evidence", async () => {
  const db = fixture();
  try {
    db.exec(
      "CREATE TABLE today_tasks(id TEXT PRIMARY KEY,title TEXT,stream_id INTEGER)",
    );
    db.prepare("INSERT INTO today_tasks VALUES(?,?,?)").run(
      "task",
      "Keep this task",
      2,
    );
    const oldTopics = db
      .prepare("SELECT * FROM analysis_topics WHERE version='v'")
      .all();
    const oldMap = readMap(db, {}, "embeddinggemma").points;
    const source = db
      .prepare("SELECT id,text,vector,x,y FROM chunks ORDER BY id")
      .all();
    const conversations = db
      .prepare(
        "SELECT session,representative_id,vector,x,y FROM analysis_conversations WHERE version='v' ORDER BY session",
      )
      .all();
    const accepted = topicHierarchy(db, "v");
    const next = publishWorkstreamCatalogue(db, "v");
    assert.notEqual(next, "v");
    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_topics WHERE version='v'").all(),
      oldTopics,
    );
    assert.deepEqual(
      db.prepare("SELECT id,text,vector,x,y FROM chunks ORDER BY id").all(),
      source,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT session,representative_id,vector,x,y FROM analysis_conversations WHERE version=? ORDER BY session",
        )
        .all(next),
      conversations,
    );
    const map = readMap(db, {}, "embeddinggemma").points;
    assert.deepEqual(
      map.map((p) => [p.id, p.x, p.y]),
      oldMap.map((p) => [p.id, p.x, p.y]),
    );
    assert.deepEqual(
      map.map((p) => p.cluster),
      oldMap.map(
        (p) => accepted.find((g) => g.topicIds.includes(p.cluster)).id,
      ),
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM analysis_topics WHERE version=?")
        .get(next).n,
      accepted.length,
    );
    assert.equal(
      db.prepare("SELECT stream_id FROM today_tasks WHERE id='task'").get()
        .stream_id,
      2,
    );
    let calls = 0;
    await nameDensityGroups(db, {
      nameGenerator: async (_db, system, prompt) => {
        calls++;
        assert.match(system, /Name the concrete subject/);
        const evidence = JSON.parse(prompt).topics.flatMap((t) => t.sessions);
        assert.ok(evidence.length > 0);
        assert.ok(
          evidence.every((s) =>
            [
              "Document Import Planning",
              "Document Import Verification",
            ].includes(s.sessionName),
          ),
        );
        return {
          topics: JSON.parse(prompt).topics.map((t) => ({
            key: t.key,
            name: "Document import workflow",
            description:
              "Plan and verify document import while preserving original records.",
            background: false,
          })),
        };
      },
    });
    assert.equal(calls, 1, "only a newly combined cluster needs naming");
    const sessions = [{ id: "source1" }, { id: "source2" }];
    const today = attachTodayStreams(db, sessions, []);
    assert.equal(sessions[0].boardStreamId, sessions[1].boardStreamId);
    assert.equal(
      today.workstreams.find((s) => s.id === sessions[0].boardStreamId).name,
      "Document import workflow",
    );
    assert.equal(
      readMap(db, {}, "embeddinggemma").points[0].topicName,
      "Document import workflow",
    );
    assert.equal(
      publishWorkstreamCatalogue(db, next),
      next,
      "routine sync cannot group the clusters again",
    );
    await nameDensityGroups(db, {
      nameGenerator: () => {
        throw Error("unchanged cluster was renamed");
      },
    });
    assert.deepEqual(
      readMap(db, {}, "embeddinggemma").points.map((p) => [p.id, p.x, p.y]),
      oldMap.map((p) => [p.id, p.x, p.y]),
    );
  } finally {
    db.close();
  }
});
