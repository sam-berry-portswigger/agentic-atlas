import { createTodayService, initTodaySchema } from "../server/today-store.js";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema, readMap } from "../server/analysis-store.js";
import { vectorBuffer } from "../server/db.js";
import { visibleTopicLabel } from "../server/local-topic-labels.js";
import { attachTodayStreams } from "../server/today-streams.js";
import { readTopic } from "../server/topic.js";
import { runMap } from "../server/map-runner.js";
import {
  publishDensityGroups,
  refreshSavedDensityGroups,
  LOCAL_CLUSTER_POLICY,
} from "../server/numerical-streams.js";
import {
  refreshRequestedTopicNames,
  topicNameRequest,
  resolveTopicNames,
  cachedTopicName,
  withTopicNames,
} from "../server/topic-name-context.js";
import { fileURLToPath } from "node:url";
function fixture() {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
  );
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "v",
    "f",
    "e",
    "g",
    "now",
    JSON.stringify({
      mapUnit: "conversation",
      method: "workstreams-v2",
      localClusterPolicy: LOCAL_CLUSTER_POLICY,
    }),
  );
  db.exec("INSERT INTO analysis_state VALUES('active','v')");
  db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
    "v",
    1,
    "Historical Burp Tooling",
    "Old reproduction and tooling work across several months.",
    "#123456",
    vectorBuffer([1, 0]),
  );
  for (let i = 0; i < 12; i++) {
    const id = "s" + i,
      title =
        i === 11 ? "Local belfry setup" : "Old tooling investigation " + i,
      at = i === 11 ? "2026-11-05T08:00:00Z" : "2026-10-01T08:00:00Z",
      x = i < 6 ? i * 0.001 : 100 + (i - 6) * 0.001,
      y = (i % 3) * 0.001,
      v = vectorBuffer(i === 11 ? [0, 1] : [1, 0]);
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id,
      id,
      "p",
      title,
      "user",
      at,
      "Investigate and document the current setup with original evidence preserved.",
      v,
      "e",
      x,
      y,
      1,
    );
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      id,
      1,
      x,
      y,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      id,
      id,
      v,
      x,
      y,
    );
  }
  return db;
}
test("Today, map, detail and tasks use one stable name across dates and changing dialogue", async () => {
  const db = fixture();
  try {
    initTodaySchema(db);
    const service = createTodayService(db);
    const task = service.createTask({ title: "Follow up", streamId: 1 }).task;
    const before = JSON.stringify(
      db.prepare("SELECT * FROM analysis_members").all(),
    );
    const scope = {
      start: "2026-11-05T00:00:00Z",
      end: "2026-11-06T00:00:00Z",
    };
    const model = () => {
      throw Error("Reading a filtered view must not rename workstreams");
    };
    for (const filter of [scope, {}]) {
      const map = await withTopicNames(db, () => readMap(db, filter, "e"), {
        nameGenerator: model,
      });
      const today = attachTodayStreams(db, [{ id: "s11" }], [], filter);
      const label = service.listTasks().taskWorkstreams[0].name;
      assert.equal(label, "Historical Burp Tooling");
      assert.equal(
        map.points.find((p) => p.session === "s11").topicName,
        label,
      );
      assert.equal(
        today.workstreams.find((s) => s.id === task.streamId).name,
        label,
      );
      assert.equal(
        readTopic(db, filter, { kind: "stream", streamId: 1 }).title,
        label,
      );
    }
    db.prepare(
      "UPDATE chunks SET text='New implementation and verification phase' WHERE session='s11'",
    ).run();
    assert.equal(
      readMap(db, scope, "e").points[0].topicName,
      "Historical Burp Tooling",
    );
    assert.equal(
      JSON.stringify(db.prepare("SELECT * FROM analysis_members").all()),
      before,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
      0,
    );
    const request = topicNameRequest(db, "v", { id: 1 }, ["s11"], scope);
    assert.ok(request.input.sessions.length);
  } finally {
    db.close();
  }
});
test("coordination can be quiet without hiding meaningful work with the same session name", async () => {
  const db = fixture();
  try {
    db.prepare("UPDATE chunks SET title=?,text=? WHERE session='s10'").run(
      "Standup brief",
      "Give me my daily standup brief from existing project updates.",
    );
    db.prepare("UPDATE chunks SET title=?,text=? WHERE session='s11'").run(
      "Standup brief",
      "Implement the standup dashboard's PostgreSQL migration and add rollback verification.",
    );
    const incidental = topicNameRequest(db, "v", { id: 1 }, ["s10"]),
      work = topicNameRequest(db, "v", { id: 1 }, ["s11"]);
    let calls = 0;
    await resolveTopicNames(db, [incidental, work], {
      nameGenerator: async (_db, _system, prompt) => {
        calls++;
        return {
          topics: JSON.parse(prompt).topics.map((t) => ({
            key: t.key,
            name: t.sessions[0].dialogue.some((m) => /PostgreSQL/.test(m.text))
              ? "Standup dashboard storage"
              : "Daily work coordination",
            description:
              "The context distinguishes a routine brief from implementation of dashboard storage.",
            background: !t.sessions[0].dialogue.some((m) =>
              /PostgreSQL/.test(m.text),
            ),
          })),
        };
      },
    });
    assert.equal(calls, 1, "changed visible topics use one bounded batch");
    assert.equal(cachedTopicName(db, incidental).background, true);
    assert.equal(cachedTopicName(db, work).background, false);
    const saved = db
      .prepare("SELECT count(*) n FROM analysis_name_cache")
      .get().n;
    await resolveTopicNames(db, [incidental, work], {
      nameGenerator: () => {
        throw Error("cache missed");
      },
    });
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
      saved,
    );
  } finally {
    db.close();
  }
});
test("the existing density algorithm separates two islands formerly labelled as one without moving any points", async () => {
  const db = fixture();
  try {
    const rows = db
      .prepare("SELECT * FROM analysis_conversations ORDER BY session")
      .all();
    const extra = vectorBuffer([0, 1]);
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "later",
      "later",
      "p",
      "New Belfry planning",
      "user",
      "2026-11-05T09:00:00Z",
      "Plan the next Belfry setup steps while preserving the source records.",
      extra,
      "e",
      null,
      null,
      1,
    );
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      "later",
      1,
      null,
      null,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      "later",
      "later",
      extra,
      null,
      null,
    );
    const snapshot = () =>
      JSON.stringify({
        sources: db
          .prepare("SELECT id,text,vector,x,y FROM chunks ORDER BY id")
          .all(),
        conversations: db
          .prepare("SELECT * FROM analysis_conversations ORDER BY session")
          .all(),
      });
    const before = snapshot();
    const result = await runMap(
      rows.map((r) => [r.x, r.y]),
      {
        script: fileURLToPath(
          new URL("../server/density-saved.py", import.meta.url),
        ),
      },
    );
    assert.deepEqual(
      result.points,
      rows.map((r) => [r.x, r.y]),
    );
    const label = new Map(rows.map((r, i) => [r.session, result.labels[i]]));
    assert.notEqual(label.get("s0"), label.get("s6"));
    assert.ok([...label.values()].every((l) => l >= 0));
    db.exec("BEGIN");
    const metadata = publishDensityGroups(
      db,
      "v",
      rows.map((r) => r.representative_id),
      result,
    );
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='v'").run(
      JSON.stringify({ mapUnit: "conversation", ...metadata }),
    );
    db.exec("COMMIT");
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM analysis_topics WHERE version='v'")
        .get().n,
      3,
    );
    assert.equal(
      db.prepare("SELECT name FROM retired_workstreams WHERE id=1").get().name,
      "Historical Burp Tooling",
    );
    const remaining = db
      .prepare(
        "SELECT t.id,t.name FROM analysis_topics t JOIN analysis_members m ON m.version=t.version AND m.topic_id=t.id WHERE m.chunk_id='later'",
      )
      .get();
    assert.notEqual(remaining.id, 1);
    assert.equal(remaining.name, "New Belfry planning");
    assert.equal(snapshot(), before);
    await refreshSavedDensityGroups(
      db,
      db.prepare("SELECT * FROM analysis_runs WHERE id='v'").get(),
      { python: "/nonexistent-runtime" },
    );
    assert.equal(
      snapshot(),
      before,
      "routine updates do not recluster an unchanged saved layout",
    );
  } finally {
    db.close();
  }
});

test("an unplotted residual bucket is never promoted or renamed after its remaining sessions", () => {
  const db = fixture();
  try {
    db.prepare(
      "UPDATE analysis_topics SET name=?,description=? WHERE id=1",
    ).run(
      "Other sessions",
      "Activity not yet assigned confidently to a sustained work stream.",
    );
    const v = vectorBuffer([1, 0]);
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "brief",
      "brief",
      "p",
      "Standup brief",
      "user",
      "2026-11-05T09:00:00Z",
      "Give me today's standup brief",
      v,
      "e",
      null,
      null,
      1,
    );
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      "brief",
      1,
      null,
      null,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      "brief",
      "brief",
      v,
      null,
      null,
    );
    const rows = db
      .prepare(
        "SELECT representative_id id FROM analysis_conversations WHERE x IS NOT NULL ORDER BY session",
      )
      .all();
    const labels = rows.map((r, i) => (i < 6 ? 0 : 1));
    const metadata = publishDensityGroups(
      db,
      "v",
      rows.map((r) => r.id),
      { labels },
    );
    assert.equal(
      db.prepare("SELECT name FROM analysis_topics WHERE id=1").get().name,
      "Other sessions",
    );
    assert.ok(metadata.residualTopicIds.includes(1));
    assert.ok(metadata.backgroundIds.includes(1));
    assert.ok(!metadata.clusterNamingIds.includes(1));
  } finally {
    db.close();
  }
});

test("invalid contextual output cannot partially cache siblings or change membership", async () => {
  const db = fixture();
  try {
    const request = topicNameRequest(db, "v", { id: 1 }, ["s11"]);
    const before = JSON.stringify(
      db.prepare("SELECT * FROM analysis_members").all(),
    );
    await assert.rejects(
      resolveTopicNames(db, [request], {
        nameGenerator: async () => ({
          topics: [
            {
              key: 0,
              name: "Belfry",
              description:
                "The configuration server's organisation policy settings.",
            },
          ],
        }),
      }),
      /background boolean/,
    );
    assert.equal(cachedTopicName(db, request), null);
    assert.equal(
      JSON.stringify(db.prepare("SELECT * FROM analysis_members").all()),
      before,
    );
  } finally {
    db.close();
  }
});

test("concurrent filtered reads retain the published name without generation", async () => {
  const db = fixture();
  try {
    const scope = {
      start: "2026-11-05T00:00:00Z",
      end: "2026-11-06T00:00:00Z",
    };
    const options = {
      nameGenerator: () => {
        throw Error("Unexpected generation");
      },
    };
    const [a, b] = await Promise.all([
      withTopicNames(db, () => readMap(db, scope, "e"), options),
      withTopicNames(db, () => readMap(db, scope, "e"), options),
    ]);
    assert.equal(a.points[0].topicName, "Historical Burp Tooling");
    assert.equal(b.points[0].topicName, a.points[0].topicName);
  } finally {
    db.close();
  }
});
