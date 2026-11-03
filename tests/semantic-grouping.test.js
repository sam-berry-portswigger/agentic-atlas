import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer, normalize } from "../server/db.js";
import {
  initAnalysisSchema,
  activeAnalysis,
} from "../server/analysis-store.js";
import { analyseArchive as runAnalysis } from "../server/analysis.js";
const analyseArchive = (db, options) =>
  runAnalysis(db, { scopeEmbedder: null, ...options });
import {
  assignStreamRows,
  validateStreamPlan,
} from "../server/stream-analysis.js";
import {
  prepareSemanticRepair,
  repairSemanticMemberships,
} from "../server/semantic-repair.js";

const description =
  "A specific sustained development goal grounded in semantic conversation evidence.";
const row = (id, vector) => ({
  id,
  session: id,
  role: "user",
  timestamp: "2026-10-30T10:00:00Z",
  text: "A substantive request to improve the current development work.",
  title: id,
  vector,
});

test("mixed preliminary clusters refine by conversation semantics despite adversarial naming claims", () => {
  const a = row("old-ui", [1, 0]),
    b = row("new-ui", normalize([1, 0.05])),
    c = row("schedule", [0, 1]);
  const candidates = [
    { center: normalize([1, 1]), rows: [a, b, c] },
    { center: normalize([1, 1]), rows: [row("ambiguous", normalize([1, 1]))] },
  ];
  const plans = [
    {
      name: "Schedule Feature Rollout",
      description,
      background: false,
      exemplars: [a, b, c],
    },
  ];
  const previous = [
    {
      id: 55,
      name: "Task Navigation UI",
      centroid: vectorBuffer([1, 0]),
    },
    {
      id: 43,
      name: "Schedule Feature Rollout",
      centroid: vectorBuffer([0, 1]),
    },
    { id: 58, name: "Background", centroid: vectorBuffer([1, 0]) },
  ];
  const assigned = assignStreamRows(plans, candidates, { previous });
  assert.deepEqual(
    assigned
      .find((p) => p.id === 55)
      .rows.map((r) => r.id)
      .sort(),
    ["new-ui", "old-ui"],
  );
  assert.deepEqual(
    assigned.find((p) => p.id === 43).rows.map((r) => r.id),
    ["schedule"],
  );
  assert.deepEqual(
    assigned.find((p) => p.background).rows.map((r) => r.id),
    ["ambiguous"],
  );
});

test("malformed model flags cannot turn Background into a protected named stream", () => {
  const a = row("a", [1, 0]);
  const byKey = new Map([[1, a]]),
    candidates = [{ center: a.vector, rows: [a] }];
  for (const flag of [undefined, "false", null]) {
    assert.throws(
      () =>
        validateStreamPlan(
          {
            streams: [
              {
                name: "Background",
                description,
                sources: [1],
                background: flag,
              },
            ],
          },
          candidates,
          byKey,
        ),
      /boolean/,
    );
  }
  assert.throws(
    () =>
      validateStreamPlan(
        {
          streams: [
            {
              name: "Background",
              description,
              sources: [1],
              background: false,
            },
          ],
        },
        candidates,
        byKey,
      ),
    /reserved/,
  );
});

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE insights(scope TEXT PRIMARY KEY,fingerprint TEXT,data TEXT); CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER);",
  );
  initAnalysisSchema(db);
  return db;
}
function add(db, id, vector) {
  db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    id,
    "same-project",
    id,
    "user",
    "2026-10-30T10:00:00Z",
    "A substantive request to develop and verify this specific work objective.",
    vectorBuffer(vector),
    "embeddinggemma",
    null,
    null,
    null,
  );
}

test("multiple new streams retain every passage and explicit corrections restore fallback flags", async () => {
  const db = database();
  try {
    for (let i = 0; i < 12; i++) add(db, "existing-" + i, [1, 0, 0]);
    const nameGenerator = async (_db, _system, prompt) => {
      const input = JSON.parse(prompt);
      return {
        streams: [
          ["Existing Release", "existing-"],
          ["Atlas Interface", "ui-"],
          ["Telemetry Analysis", "telemetry-"],
        ]
          .map(([name, prefix]) => ({
            name,
            description,
            background: false,
            sources: input.sessions
              .filter((s) => s.title.startsWith(prefix))
              .map((s) => s.source),
          }))
          .filter((p) => p.sources.length),
      };
    };
    await analyseArchive(db, { projectMap: false, nameGenerator });
    for (let i = 0; i < 12; i++) {
      add(db, "ui-" + i, [0, 1, 0]);
      add(db, "telemetry-" + i, [0, 0, 1]);
    }
    const next = await analyseArchive(db, { projectMap: false, nameGenerator });
    const assigned = db
      .prepare(
        "SELECT c.session,t.name FROM chunks c JOIN analysis_members m ON m.chunk_id=c.id JOIN analysis_topics t ON t.version=m.version AND t.id=m.topic_id WHERE m.version=?",
      )
      .all(next);
    assert.equal(assigned.length, 36);
    assert.ok(
      assigned
        .filter((r) => r.session.startsWith("ui-"))
        .every((r) => r.name === "Atlas Interface"),
    );
    assert.ok(
      assigned
        .filter((r) => r.session.startsWith("telemetry-"))
        .every((r) => r.name === "Telemetry Analysis"),
    );
  } finally {
    db.close();
  }
});

test("versioned fallback repair preserves manual corrections, named assignments and every map coordinate", () => {
  const db = database();
  try {
    const topics = [
      [55, "Task Navigation UI", [1, 0]],
      [43, "Schedule Feature Rollout", [0, 1]],
      [58, "Background", [1, 0]],
      [57, "Other sessions", [1, 1]],
    ];
    db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
      "before",
      "old-fingerprint",
      "embeddinggemma",
      "mock",
      "2026-10-30T10:00:00Z",
      JSON.stringify({ backgroundIds: [57], method: "workstreams-v2" }),
    );
    for (const [id, name, v] of topics)
      db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
        "before",
        id,
        name,
        description,
        "#123456",
        vectorBuffer(normalize(v)),
      );
    for (const [id, v, topic] of [
      ["ui", [1, 0], 55],
      ["new-ui", [1, 0], 58],
      ["manual", [1, 0], 58],
      ["schedule", [0, 1], 43],
      ["residual", [0, 1], 57],
    ]) {
      add(db, id, v);
      db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
        "before",
        id,
        topic,
        0.2,
        0.7,
      );
    }
    db.prepare("INSERT INTO analysis_state VALUES('active','before')").run();
    db.prepare(
      "INSERT INTO analysis_state VALUES('stream_session_assignments',?)",
    ).run(JSON.stringify({ manual: 58 }));
    const plan = prepareSemanticRepair(db);
    assert.deepEqual(
      plan.changes.map((c) => [c.id, c.to]),
      [["new-ui", 55]],
    );
    const result = repairSemanticMemberships(db, {
      acquireLock: () => () => {},
    });
    assert.equal(result.changed, 1);
    assert.notEqual(result.version, "before");
    const after = db
      .prepare(
        "SELECT chunk_id,topic_id,x,y FROM analysis_members WHERE version=? ORDER BY chunk_id",
      )
      .all(result.version);
    assert.equal(after.find((r) => r.chunk_id === "new-ui").topic_id, 55);
    assert.equal(after.find((r) => r.chunk_id === "manual").topic_id, 58);
    assert.equal(after.find((r) => r.chunk_id === "schedule").topic_id, 43);
    assert.equal(after.find((r) => r.chunk_id === "residual").topic_id, 57);
    assert.ok(after.every((r) => r.x === 0.2 && r.y === 0.7));
    assert.ok(JSON.parse(activeAnalysis(db).data).backgroundIds.includes(58));
    assert.equal(repairSemanticMemberships(db), null);
  } finally {
    db.close();
  }
});
