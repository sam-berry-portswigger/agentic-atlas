import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  conversationWindow,
  selectContext,
  retrieveFollowups,
  cleanVerdict,
  uniqueEvidence,
  usefulText,
} from "../server/evidence.js";

function fixture(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB)",
  );
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)");
  const evidence = rows.map((r, i) => ({
    id: String(i),
    session: "one",
    project: "atlas",
    title: "Work",
    role: "user",
    timestamp: `2026-10-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
    ...r,
  }));
  for (const r of evidence)
    insert.run(
      r.id,
      r.session,
      r.project,
      r.title,
      r.role,
      r.timestamp,
      r.text,
      r.vector || null,
    );
  return { db, evidence };
}

test("context retains full passages, adjacent replies and earlier context but respects the historical cutoff", () => {
  const { db, evidence } = fixture([
    {
      text: "Please verify whether the login refresh token persists correctly.",
    },
    {
      role: "assistant",
      text:
        "Detailed investigation. ".repeat(80) +
        "The refresh token test passed and the defect is fixed.",
    },
    { text: "great" },
    { text: "Future update: the unrelated deployment needs attention." },
  ]);
  try {
    const scope = {
      start: "2026-10-11T00:00:00Z",
      end: "2026-10-13T00:00:00Z",
    };
    const window = conversationWindow(db, evidence[1], scope);
    assert.deepEqual(
      window.map((r) => r.id),
      ["0", "1", "2"],
    );
    assert.match(window[1].text, /defect is fixed\.$/);
    assert.ok(window[1].text.length > 1000);
    const selected = selectContext(db, [evidence[1]], scope);
    assert.ok(
      selected.some((r) => r.id === "0"),
      "read the request preceding the selected period",
    );
    assert.ok(
      selected.some((r) => r.text === "great"),
      "short acceptance is context, not an anchor",
    );
    assert.ok(!usefulText("[Request interrupted by user]"));
    assert.ok(
      !usefulText(
        "<local-command-stdout>some internal output content</local-command-stdout>",
      ),
    );
    assert.equal(
      uniqueEvidence([
        evidence[1],
        { ...evidence[1], id: "fork-copy", session: "fork" },
      ]).length,
      1,
    );
  } finally {
    db.close();
  }
});

test("follow-ups favor related recent outcomes across sessions and exclude future and other projects", () => {
  const { db, evidence } = fixture([
    { text: "Please fix login token persistence before release." },
    {
      session: "older",
      text: "Login token persistence still fails when signing out.",
    },
    {
      session: "newer",
      role: "assistant",
      text: "Login token persistence is fixed; regression checks passed.",
    },
    {
      session: "other",
      project: "unrelated",
      text: "Login token persistence is still broken in another project.",
    },
    {
      session: "future",
      text: "Login token persistence fails again after the cutoff.",
    },
  ]);
  try {
    const fact = { text: "Fix login token persistence", sourceIds: ["0"] };
    const found = retrieveFollowups(
      db,
      fact,
      evidence,
      { end: "2026-10-13T00:00:00Z" },
      null,
    );
    assert.ok(found.some((r) => r.id === "2"));
    assert.ok(found.some((r) => r.id === "0"));
    assert.ok(!found.some((r) => ["3", "4"].includes(r.id)));
  } finally {
    db.close();
  }
});

test("open status requires a real quotation and concrete commitment or observed blocker", () => {
  const evidence = [
    {
      id: "aside",
      role: "assistant",
      text: "I did not check how ThreadUtilities is wired elsewhere in the codebase.",
    },
    {
      id: "permission",
      role: "assistant",
      text: "Should I commit these changes together or separately?",
    },
    {
      id: "request",
      role: "user",
      text: "Please fix the refresh token persistence bug before release.",
      timestamp: "2026-10-21T10:00:00Z",
    },
    {
      id: "blocker",
      role: "assistant",
      text: "The regression test still fails when switching accounts.",
    },
    {
      id: "suggestion",
      role: "assistant",
      text: "We could consider reviewing the EULA consent clause.",
    },
  ];
  const verdict = (id, kind = "user_commitment") =>
    cleanVerdict(
      {
        sourceId: id,
        status: "open",
        kind,
        quote: evidence.find((r) => r.id === id).text,
        reason: "Still relevant.",
      },
      evidence,
    );
  assert.equal(verdict("aside").status, "not_actionable");
  assert.equal(verdict("permission").status, "not_actionable");
  assert.equal(verdict("request").status, "open");
  assert.equal(verdict("request").lastEvidenceAt, evidence[2].timestamp);
  assert.equal(verdict("blocker", "observed_blocker").status, "open");
  assert.equal(verdict("suggestion").status, "unclear");
  assert.equal(verdict("suggestion", "observed_blocker").status, "unclear");
  assert.equal(
    cleanVerdict(
      {
        sourceId: "missing",
        status: "resolved",
        quote: "Everything is now resolved.",
      },
      evidence,
    ).status,
    "unclear",
  );
  assert.equal(
    cleanVerdict(
      {
        sourceId: "request",
        status: "resolved",
        quote: "Everything is now resolved.",
      },
      evidence,
    ).status,
    "unclear",
  );
  assert.equal(
    cleanVerdict(
      {
        sourceId: "request",
        status: "unclear",
        kind: "unknown",
        quote: evidence[2].text,
        reason: "No subsequent outcome is recorded.",
      },
      evidence,
    ).status,
    "unclear",
  );
});

test("a long original discussion cannot crowd a later resolution out of the follow-up budget", () => {
  const { db, evidence } = fixture([
    {
      text:
        "Please fix login token persistence. " +
        "Original details. ".repeat(80),
    },
    {
      role: "assistant",
      text:
        "Login token persistence investigation. " +
        "More original details. ".repeat(100),
    },
    {
      session: "later",
      role: "assistant",
      text: "Login token persistence is fixed; the regression checks passed.",
    },
  ]);
  try {
    const found = retrieveFollowups(
      db,
      { text: "Fix login token persistence", sourceIds: ["0", "1"] },
      evidence,
      { end: "2026-10-14T00:00:00Z" },
      null,
      6500,
    );
    assert.ok(
      found.some((r) => r.id === "0"),
      "keep the original request",
    );
    assert.ok(
      found.some((r) => r.id === "2"),
      "reserve room for the newer outcome",
    );
  } finally {
    db.close();
  }
});

test("recency breaks close semantic matches without admitting unrelated new messages", () => {
  const vector = (values) => Buffer.from(new Float32Array(values).buffer);
  const { db, evidence } = fixture([
    {
      text: "Please fix login token persistence before release.",
      vector: vector([1, 0]),
    },
    {
      session: "old",
      text: "Login token persistence is blocked by the old implementation.",
      vector: vector([1, 0]),
    },
    {
      session: "new",
      text: "Login token persistence is fixed and the checks passed.",
      vector: vector([0.96, 0.28]),
    },
    {
      session: "unrelated",
      text: "The visualization now uses purple and green point clusters.",
      vector: vector([0, 1]),
    },
  ]);
  try {
    const found = retrieveFollowups(
      db,
      { text: "login token persistence", sourceIds: ["0"] },
      evidence,
      { end: "2026-10-15T00:00:00Z" },
      [1, 0],
      500,
    );
    assert.deepEqual(
      found.map((r) => r.id),
      ["0", "2"],
    );
  } finally {
    db.close();
  }
});

test("compact overview context preserves distinct conversation purposes alongside technical outcomes", () => {
  const { db, evidence } = fixture([
    {
      session: "tools",
      title: "Review workflow",
      text: "Build a review skill that compares multiple model reviews and reconciles their findings.",
    },
    {
      session: "tools",
      title: "Review workflow",
      role: "assistant",
      text:
        "The workflow found authentication race conditions. " +
        "Detailed findings. ".repeat(95),
    },
    {
      session: "auth",
      title: "Authentication",
      text: "Please fix token persistence and verify the account switching regression.",
    },
    {
      session: "auth",
      title: "Authentication",
      role: "assistant",
      text:
        "Token persistence is fixed and the tests pass. " +
        "Implementation details. ".repeat(75),
    },
  ]);
  try {
    const context = selectContext(
      db,
      [evidence[1], evidence[3]],
      { start: "2026-10-10T00:00:00Z", end: "2026-10-15T00:00:00Z" },
      6000,
      { diverse: true },
    );
    assert.ok(
      context.some((row) => row.id === "0"),
      "include why the tool was built, not only the auth defects it found",
    );
    assert.ok(
      context.some((row) => row.id === "2"),
      "retain the distinct authentication work too",
    );
  } finally {
    db.close();
  }
});

test("generic session titles do not hide different sessions or different tasks within a session", () => {
  const { db, evidence } = fixture([
    {
      session: "planning",
      title: "Plan my day",
      text: "Fix the scheduling refresh race and verify sign-out behavior.",
    },
    {
      session: "planning",
      title: "Plan my day",
      role: "assistant",
      text: "The scheduling refresh race is fixed and regression tests pass.",
    },
    {
      session: "planning",
      title: "Plan my day",
      text: "Build a reusable multi-model review skill that reconciles conflicting reviewer findings.",
    },
    {
      session: "planning",
      title: "Plan my day",
      role: "assistant",
      text: "The reusable review skill now reconciles findings and checks reviewer evidence.",
    },
    {
      session: "other",
      title: "Plan my day",
      text: "Migrate the brain imaging visualization to React with custom activation regions.",
    },
    {
      session: "other",
      title: "Plan my day",
      role: "assistant",
      text: "The React visualization now supports custom activation regions and side-by-side comparison.",
    },
  ]);
  const scope = { start: "2026-10-10T00:00:00Z", end: "2026-10-20T00:00:00Z" };
  try {
    const selected = selectContext(db, evidence, scope, 4000, {
      diverse: true,
    });
    for (const id of ["0", "2", "4"])
      assert.ok(
        selected.some((row) => row.id === id),
        "keep each actual work objective",
      );
    db.prepare(
      "UPDATE chunks SET title='A deliberately misleading installation title'",
    ).run();
    const renamed = selectContext(
      db,
      evidence.map((row) => ({
        ...row,
        title: "A deliberately misleading installation title",
      })),
      scope,
      4000,
      { diverse: true },
    );
    assert.deepEqual(
      renamed.map((row) => row.id),
      selected.map((row) => row.id),
      "renaming sessions cannot change context selection",
    );
  } finally {
    db.close();
  }
});

test("future intent cannot be reported as a confirmed resolution", () => {
  const source = {
    id: "plan",
    role: "assistant",
    text: "I’ll stop the test run and undo my staging configuration change.",
  };
  assert.equal(
    cleanVerdict(
      {
        status: "resolved",
        kind: "unknown",
        sourceId: "plan",
        quote: source.text,
      },
      [source],
    ).status,
    "unclear",
  );
});
