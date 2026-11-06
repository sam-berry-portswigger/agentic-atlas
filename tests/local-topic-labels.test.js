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
test("scoped labels are synthesized from dialogue, cached, and shared by Today, map and detail", async () => {
  const db = fixture();
  try {
    db.prepare("UPDATE chunks SET text=? WHERE session='s11'").run(
      "Configure Belfry organisation policies and synchronise the central configuration server with Burp.",
    );
    const invariant = () =>
      JSON.stringify({
        topics: db.prepare("SELECT * FROM analysis_topics").all(),
        members: db.prepare("SELECT * FROM analysis_members").all(),
        chunks: db.prepare("SELECT * FROM chunks").all(),
      });
    const before = invariant(),
      scope = { start: "2026-11-05T00:00:00Z", end: "2026-11-06T00:00:00Z" };
    const first = readMap(db, scope, "e");
    assert.notEqual(
      first.points[0].topicName,
      "Local belfry setup",
      "missing semantic names must never be replaced by a copied title",
    );
    let calls = 0;
    const model = async (_db, system, prompt) => {
      calls++;
      assert.match(system, /conversation content/);
      const topics = JSON.parse(prompt).topics;
      assert.ok(
        topics.every((t) =>
          t.sessions.every((s) =>
            s.dialogue.some((m) => /organisation policies/.test(m.text)),
          ),
        ),
      );
      assert.ok(
        topics.every((t) =>
          t.sessions.every((s) => s.sessionName === "Local belfry setup"),
        ),
      );
      return {
        topics: topics.map((t) => ({
          key: t.key,
          name: "Belfry configuration management",
          description:
            "Central organisation policies and configuration synchronisation between Belfry and Burp.",
          background: false,
        })),
      };
    };
    await refreshRequestedTopicNames(db, { nameGenerator: model });
    const day = readMap(db, scope, "e");
    assert.equal(day.points[0].topicName, "Belfry configuration management");
    const sessions = [{ id: "s11", title: "Local belfry setup" }],
      today = attachTodayStreams(db, sessions, [], scope);
    assert.equal(
      today.workstreams.find((t) => t.id === 1).name,
      "Belfry configuration management",
    );
    assert.equal(today.workstreams.find((t) => t.id === 1).background, false);
    assert.equal(
      readTopic(db, scope, { kind: "stream", streamId: 1 }).title,
      "Belfry configuration management",
    );
    await refreshRequestedTopicNames(db, { nameGenerator: model });
    assert.equal(calls, 1);
    assert.equal(invariant(), before);
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "future",
      "s11",
      "p",
      "Local belfry setup",
      "user",
      "2026-11-07T08:00:00Z",
      "Unrelated future project about billing",
      vectorBuffer([1, 0]),
      "e",
      null,
      null,
      1,
    );
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      "future",
      1,
      null,
      null,
    );
    const request = topicNameRequest(db, "v", { id: 1 }, ["s11"], scope);
    assert.ok(!JSON.stringify(request.input).includes("Unrelated future"));
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
      db
        .prepare("SELECT name FROM analysis_topics WHERE version='v' AND id=1")
        .get().name,
      "New Belfry planning",
    );
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

test("concurrent reads coalesce naming and a changed context is resolved before returning", async () => {
  const db = fixture();
  try {
    const scope = {
      start: "2026-11-05T00:00:00Z",
      end: "2026-11-06T00:00:00Z",
    };
    let calls = 0;
    const model = async (_db, _system, prompt) => {
      calls++;
      if (calls === 1)
        db.prepare("UPDATE chunks SET text=? WHERE session='s11'").run(
          "Belfry organisation policy synchronisation now also covers signed configuration distribution.",
        );
      return {
        topics: JSON.parse(prompt).topics.map((t) => ({
          key: t.key,
          name: calls === 1 ? "Belfry setup" : "Belfry policy distribution",
          description:
            "Belfry organisation policies and signed configuration distribution.",
          background: false,
        })),
      };
    };
    const options = { nameGenerator: model };
    const [a, b] = await Promise.all([
      withTopicNames(db, () => readMap(db, scope, "e"), options),
      withTopicNames(db, () => readMap(db, scope, "e"), options),
    ]);
    assert.equal(
      calls,
      2,
      "one call for each genuinely different context, shared by both readers",
    );
    assert.equal(a.points[0].topicName, "Belfry policy distribution");
    assert.equal(b.points[0].topicName, "Belfry policy distribution");
  } finally {
    db.close();
  }
});
