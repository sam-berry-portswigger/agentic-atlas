import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer } from "../server/db.js";
import { seedAnalysis } from "./analysis-fixture.js";
import { workIdentity } from "../server/analysis-store.js";
import { readTopic } from "../server/topic.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings(key TEXT,value TEXT);
    CREATE TABLE insights(scope TEXT,fingerprint TEXT,data TEXT);
    CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,cluster INTEGER);`);
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const rows = [
    [
      "review-request",
      "mixed",
      "user",
      20,
      "Please review PR #1234 and report the concrete findings.",
    ],
    [
      "findings",
      "mixed",
      "assistant",
      20,
      "Found a regression in token refresh and missing cancellation coverage.",
    ],
    [
      "workflow-request",
      "mixed",
      "user",
      21,
      "Now design a review workflow that coordinates independent model reviewers.",
    ],
    [
      "workflow-response",
      "mixed",
      "assistant",
      21,
      "The review workflow should reconcile findings and verify each claim independently.",
    ],
    [
      "codex-request",
      "codex:followup",
      "user",
      22,
      "Verify the fixes for PR #1234 and rerun the failing regression tests.",
    ],
    [
      "codex-response",
      "codex:followup",
      "assistant",
      22,
      "Both findings are now fixed and the cancellation regression tests pass.",
    ],
    [
      "other-pr",
      "other",
      "user",
      22,
      "Review PR #9999 and investigate the unrelated settings failure.",
    ],
    [
      "other-result",
      "other",
      "assistant",
      22,
      "The settings failure reproduces on a different branch.",
    ],
    [
      "outside",
      "old",
      "user",
      1,
      "Earlier review of PR #1234 before the selected date range.",
    ],
  ];
  // Deliberately identical vectors and one shared cluster: neither can justify
  // broadening a named work item to these unrelated tasks.
  for (const [id, session, role, day, text] of rows)
    insert.run(
      id,
      session,
      "atlas",
      "General work",
      role,
      `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
      text,
      vectorBuffer([1, 0]),
      "embeddinggemma",
      0.5,
      0,
    );
  insert.run(
    "another-project",
    "project-two",
    "other",
    "Other project",
    "user",
    "2026-10-22T10:00:00Z",
    "Review PR #1234 in a separate project, unrelated to Atlas.",
    vectorBuffer([1, 0]),
    "embeddinggemma",
    0.5,
    0,
  );
  seedAnalysis(db, {
    scope,
    links: [
      review,
      workflow,
      {
        title: "Review findings",
        sourceIds: ["findings", "workflow-response"],
      },
      { ...review, sourceIds: ["outside"] },
    ],
  });
  return db;
}
const scope = {
  project: "",
  start: "2026-10-19T00:00:00Z",
  end: "2026-10-23T00:00:00Z",
};
const review = {
  kind: "work",
  title: "Reviewing PR #1234 Findings",
  sourceIds: ["review-request", "findings"],
};
const workflow = {
  kind: "work",
  title: "Designing the Review Workflow",
  sourceIds: ["workflow-request", "workflow-response"],
};
test("two named tags sharing a cluster produce separate work overviews and evidence", () => {
  const db = fixture();
  try {
    const focused = readTopic(db, scope, review);
    assert.equal(focused.title, review.title);
    assert.equal(focused.kind, "work");
    assert.equal(focused.passages, 4);
    assert.deepEqual(
      new Set(focused.evidence.map((row) => row.id)),
      new Set([
        "review-request",
        "findings",
        "codex-request",
        "codex-response",
      ]),
    );
    assert.equal(focused.conversations.length, 2);
    assert.equal(
      focused.conversations.find((row) => row.session === "mixed").passages,
      2,
    );
    assert.equal(
      focused.conversations.find((row) => row.session === "codex:followup")
        .provider,
      "codex",
    );
    assert.match(
      focused.conversations.find((row) => row.session === "mixed").preview,
      /PR #1234/,
    );
    const designed = readTopic(db, scope, workflow);
    assert.equal(designed.title, workflow.title);
    assert.equal(designed.passages, 2);
    assert.deepEqual(
      new Set(designed.evidence.map((row) => row.id)),
      new Set(["workflow-request", "workflow-response"]),
    );
    const broad = readTopic(db, scope, { kind: "cluster", id: "findings" });
    assert.equal(broad.kind, "cluster");
    assert.ok(broad.passages > focused.passages);
  } finally {
    db.close();
  }
});
test("all tag references survive selection; project and date scope constrain expansion", () => {
  const db = fixture();
  try {
    const refs = {
      kind: "work",
      title: "Review findings",
      sourceIds: ["findings", "workflow-response"],
    };
    const selected = readTopic(db, scope, refs);
    assert.ok(selected.evidence.some((row) => row.id === "findings"));
    assert.ok(selected.evidence.some((row) => row.id === "workflow-response"));
    const pastAnchor = readTopic(db, scope, {
      ...review,
      sourceIds: ["outside"],
    });
    assert.ok(
      pastAnchor.evidence.every(
        (row) => row.timestamp >= scope.start && row.timestamp < scope.end,
      ),
    );
    assert.deepEqual(pastAnchor.projects, ["atlas"]);
    assert.throws(
      () =>
        readTopic(
          db,
          { ...scope, project: "other" },
          {
            ...review,
            workId: workIdentity(scope, review.title, review.sourceIds),
          },
        ),
      {
        status: 404,
      },
    );
    assert.throws(
      () =>
        readTopic(
          db,
          { ...scope, start: "2027-01-01T00:00:00Z", end: "" },
          review,
        ),
      { status: 409 },
    );
    for (const invalid of [
      { ...review, sourceIds: [] },
      { ...review, sourceIds: [{}] },
      { ...review, title: "" },
      { ...review, sourceIds: Array(101).fill("findings") },
    ])
      assert.throws(() => readTopic(db, scope, invalid), { status: 400 });
    assert.throws(
      () => readTopic(db, scope, { ...review, sourceIds: ["missing"] }),
      { status: 409 },
    );
  } finally {
    db.close();
  }
});

test("review findings exclude workflow design citing the same PR and keep an immediate findings follow-up", () => {
  const db = fixture();
  try {
    const add = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    for (const [id, session, role, time, text, vector] of [
      [
        "fix-request",
        "mixed",
        "user",
        "2026-10-20T11:00:00Z",
        "Please fix both findings and rerun the regression tests.",
        [1, 0],
      ],
      [
        "fix-result",
        "mixed",
        "assistant",
        "2026-10-20T12:00:00Z",
        "The two defects are fixed and the regression suite is green.",
        [1, 0],
      ],
      [
        "design-example",
        "design",
        "user",
        "2026-10-22T11:00:00Z",
        "Design a review workflow using PR #1234 as an example for the process.",
        [1, 0],
      ],
      [
        "design-result",
        "design",
        "assistant",
        "2026-10-22T12:00:00Z",
        "The workflow coordinates multiple models using a shared findings schema.",
        [1, 0],
      ],
      [
        "unrelated-change",
        "unrelated",
        "user",
        "2026-10-22T11:00:00Z",
        "Adjust navigation button padding for PR #1234.",
        [0, 1],
      ],
    ])
      add.run(
        id,
        session,
        "atlas",
        "General work",
        role,
        time,
        text,
        vectorBuffer(vector),
        "embeddinggemma",
        0.5,
        0,
      );
    seedAnalysis(db, { scope, links: [review, workflow] });
    const focused = readTopic(db, scope, review);
    const ids = new Set(focused.evidence.map((row) => row.id));
    assert.ok(ids.has("fix-request"));
    assert.ok(ids.has("fix-result"));
    assert.ok(!ids.has("design-example"));
    assert.ok(!ids.has("design-result"));
    assert.ok(!ids.has("unrelated-change"));
    assert.equal(
      focused.conversations.find((c) => c.session === "mixed").passages,
      4,
    );
    assert.equal(
      focused.evidence[0].id,
      "review-request",
      "summary begins with the tag's supporting evidence",
    );
  } finally {
    db.close();
  }
});

test("focused work can be opened without embeddings or a map cluster", () => {
  const db = fixture();
  try {
    db.exec("UPDATE chunks SET vector=NULL,model=NULL,x=NULL,cluster=NULL");
    const focused = readTopic(db, scope, review);
    assert.equal(focused.title, review.title);
    assert.equal(focused.passages, 4);
    assert.ok(focused.evidence.some((row) => row.id === "findings"));
    assert.ok(!focused.evidence.some((row) => row.id === "workflow-response"));
  } finally {
    db.close();
  }
});
