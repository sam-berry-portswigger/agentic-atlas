import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  initAnalysisSchema,
  catalogue,
  readMap,
} from "../server/analysis-store.js";
import { initTodaySchema, createTodayService } from "../server/today-store.js";
import {
  saveWorkstreamTitle,
  suggestWorkstreamTitle,
} from "../server/workstream-rename.js";
import {
  TOPIC_NAMING_INSTRUCTIONS,
  topicNameRequest,
} from "../server/topic-name-context.js";
import { readTopic } from "../server/topic.js";
import { attachTodayStreams } from "../server/today-streams.js";
import { nameDensityGroups } from "../server/density-naming.js";
import { vectorBuffer } from "../server/db.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  initTodaySchema(db);
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
  );
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "v",
    "f",
    "e",
    "g",
    "2026-11-01",
    JSON.stringify({
      method: "workstreams-v2",
      mapUnit: "conversation",
      densityPolicy: "fixture",
      localClusterPolicy: "fixture",
      densityNamingPolicy: "fixture",
      backgroundIds: [],
      clusterNamingIds: [],
    }),
  );
  db.exec("INSERT INTO analysis_state VALUES('active','v')");
  for (const [id, name] of [
    [1, "Atlas workstream naming"],
    [2, "Independent work"],
  ])
    db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
      "v",
      id,
      name,
      "The concrete subject and scope of this workstream.",
      "purple",
      vectorBuffer([1, 0]),
    );
  for (const [session, topic, at, text] of [
    [
      "a",
      1,
      "2026-10-01",
      "Implement Atlas workstream grouping and shared names.",
    ],
    [
      "b",
      1,
      "2026-11-01",
      "Validate stream identity across refresh and task boards.",
    ],
    ["private", 2, "2026-11-01", "Unrelated secret evidence"],
  ]) {
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      session,
      session,
      "atlas",
      "Concrete session title",
      "user",
      at,
      text,
      vectorBuffer([1, 0]),
      "e",
      0.5,
      0.5,
      topic,
    );
    db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
      "v",
      session,
      topic,
      0.5,
      0.5,
    );
    db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
      "v",
      session,
      session,
      vectorBuffer([1, 0]),
      0.5,
      0.5,
    );
  }
  return db;
}
function model(callback = () => {}) {
  return async (db, system, prompt, schema) => {
    callback({ system, input: JSON.parse(prompt), schema });
    return {
      topics: JSON.parse(prompt).topics.map((t) => ({
        key: t.key,
        name: "Atlas Workstream Management",
        description:
          "Group Atlas conversations and retain consistent workstream identities.",
        background: false,
        renameReason:
          "The shared work now covers stream management and identity across views, beyond naming alone.",
      })),
    };
  };
}

test("workstream suggestions use the original naming prompt, evidence and schema, stay cached, and never save", async () => {
  const db = fixture();
  try {
    const before = db
      .prepare("SELECT * FROM analysis_topics ORDER BY id")
      .all();
    const evidence = topicNameRequest(
      db,
      "v",
      db
        .prepare("SELECT * FROM analysis_topics WHERE version='v' AND id=1")
        .get(),
      ["a", "b"],
      {
        project: "",
        start: "",
        end: "",
      },
    );
    let calls = 0;
    const generator = model(({ system, input, schema }) => {
      calls++;
      assert.equal(system, TOPIC_NAMING_INSTRUCTIONS);
      assert.deepEqual(input.topics, [{ key: 0, ...evidence.input }]);
      assert.equal(input.topics[0].existingName, "Atlas workstream naming");
      assert.ok(!JSON.stringify(input).includes("Unrelated secret"));
      assert.deepEqual(schema.required, ["topics"]);
    });
    const body = { streamId: 1, analysisVersion: "v" };
    const [a, b] = await Promise.all([
      suggestWorkstreamTitle(db, body, { nameGenerator: generator }),
      suggestWorkstreamTitle(db, body, { nameGenerator: generator }),
    ]);
    assert.deepEqual(a, { title: "Atlas Workstream Management" });
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    await suggestWorkstreamTitle(db, body, { nameGenerator: generator });
    assert.equal(calls, 1);
    await suggestWorkstreamTitle(
      db,
      { ...body, force: true },
      { nameGenerator: generator },
    );
    assert.equal(calls, 2);
    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_topics ORDER BY id").all(),
      before,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM workstream_title_overrides").get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test("saved names agree across Today, map, details and task board while preserving source records and memberships", async () => {
  const db = fixture();
  try {
    const service = createTodayService(db, { actor: "user" });
    const task = service.createTask({ title: "Follow up", streamId: 1 }).task;
    const invariant = () =>
      JSON.stringify({
        chunks: db.prepare("SELECT * FROM chunks ORDER BY id").all(),
        members: db
          .prepare("SELECT * FROM analysis_members ORDER BY chunk_id")
          .all(),
        tasks: db.prepare("SELECT * FROM today_tasks").all(),
      });
    const before = invariant();
    saveWorkstreamTitle(db, {
      streamId: 1,
      analysisVersion: "v",
      previousTitle: "Atlas workstream naming",
      title: "  Atlas Workstream Management  ",
    });
    assert.equal(catalogue(db)[0].title, "Atlas Workstream Management");
    assert.equal(
      readMap(db, {}, "e").points[0].topicName,
      "Atlas Workstream Management",
    );
    assert.equal(
      readTopic(db, {}, { kind: "stream", streamId: 1 }).title,
      "Atlas Workstream Management",
    );
    assert.equal(
      attachTodayStreams(db, [{ id: "a" }], []).workstreams.find(
        (t) => t.id === 1,
      ).name,
      "Atlas Workstream Management",
    );
    assert.equal(
      service.listTasks().taskWorkstreams.find((t) => t.id === task.streamId)
        .name,
      "Atlas Workstream Management",
    );
    await nameDensityGroups(db, { refresh: true, nameGenerator: model() });
    assert.equal(catalogue(db)[0].title, "Atlas Workstream Management");
    assert.equal(invariant(), before);
    // A rebuilt generated catalogue can change its own label without replacing a user edit.
    db.exec(
      "UPDATE analysis_topics SET name='Automatic replacement' WHERE id=1",
    );
    assert.equal(catalogue(db)[0].title, "Atlas Workstream Management");
    // Legacy map presentations use the same saved label.
    db.exec("UPDATE analysis_runs SET data='{}' WHERE id='v'");
    assert.equal(
      readMap(db, {}, "e").points[0].topicName,
      "Atlas Workstream Management",
    );
  } finally {
    db.close();
  }
});

test("renames reject stale catalogues, competing edits and invalid titles without partial writes", () => {
  const db = fixture();
  try {
    const body = {
      streamId: 1,
      analysisVersion: "v",
      previousTitle: "Atlas workstream naming",
    };
    assert.throws(
      () =>
        saveWorkstreamTitle(db, {
          ...body,
          analysisVersion: "old",
          title: "A new title",
        }),
      { status: 409 },
    );
    for (const title of ["", " ", "a\nb", "<tag>", "x".repeat(81), null])
      assert.throws(() => saveWorkstreamTitle(db, { ...body, title }), {
        status: 400,
      });
    saveWorkstreamTitle(db, { ...body, title: "Atlas Workstream Management" });
    assert.throws(
      () => saveWorkstreamTitle(db, { ...body, title: "Competing edit" }),
      { status: 409 },
    );
    assert.equal(catalogue(db)[0].title, "Atlas Workstream Management");
  } finally {
    db.close();
  }
});

test("invalid naming output and empty evidence cannot save or poison retries", async () => {
  const db = fixture();
  try {
    const body = { streamId: 1 };
    await assert.rejects(
      suggestWorkstreamTitle(db, body, {
        nameGenerator: async () => ({
          topics: [
            { key: 0, name: "Invalid", description: "Invalid short scope" },
          ],
        }),
      }),
    );
    assert.deepEqual(
      await suggestWorkstreamTitle(db, body, { nameGenerator: model() }),
      { title: "Atlas Workstream Management" },
    );
    db.exec("DELETE FROM analysis_members WHERE topic_id=1");
    await assert.rejects(
      suggestWorkstreamTitle(db, body, {
        nameGenerator: () => assert.fail("must not infer without evidence"),
      }),
      { status: 404 },
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM workstream_title_overrides").get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test("rename uses the displayed project, date range and conversations rather than unrelated historical members of the same cluster", async () => {
  const db = fixture();
  try {
    // The same historical cluster contains an unrelated conversation from another date/project.
    db.exec(
      "UPDATE analysis_members SET topic_id=1 WHERE chunk_id='private'; UPDATE chunks SET project='burp',text='Burp configuration management UI' WHERE id='private'",
    );
    const scope = {
      project: "atlas",
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-02T00:00:00Z",
    };
    const expected = topicNameRequest(
      db,
      "v",
      db
        .prepare("SELECT * FROM analysis_topics WHERE version='v' AND id=1")
        .get(),
      ["b"],
      scope,
    );
    const before = db
      .prepare("SELECT * FROM analysis_members ORDER BY chunk_id")
      .all();
    let calls = 0;
    await suggestWorkstreamTitle(
      db,
      { streamId: 1, scope },
      {
        nameGenerator: model(({ system, input }) => {
          calls++;
          assert.equal(system, TOPIC_NAMING_INSTRUCTIONS);
          assert.deepEqual(input.topics, [{ key: 0, ...expected.input }]);
          const text = JSON.stringify(input);
          assert.ok(!text.includes("Burp configuration"));
          assert.ok(!text.includes("Implement Atlas"));
          assert.ok(text.includes("Validate stream identity"));
        }),
      },
    );
    assert.equal(calls, 1);
    await assert.rejects(
      suggestWorkstreamTitle(
        db,
        { streamId: 1, scope: { ...scope, project: "missing" } },
        {
          nameGenerator: () =>
            assert.fail("empty scopes must not fall back to all history"),
        },
      ),
      { status: 404 },
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM analysis_members ORDER BY chunk_id").all(),
      before,
    );
  } finally {
    db.close();
  }
});

test("explicit suggestions retain a fitting name unless the original naming pipeline accepts a scope-change reason", async () => {
  const db = fixture();
  try {
    const result = await suggestWorkstreamTitle(
      db,
      { streamId: 1 },
      {
        nameGenerator: async () => ({
          topics: [
            {
              key: 0,
              name: "Unrelated Configuration UI",
              description:
                "A valid length description without evidence for a changed scope.",
              background: false,
            },
          ],
        }),
      },
    );
    assert.equal(result.title, "Atlas workstream naming");
  } finally {
    db.close();
  }
});
