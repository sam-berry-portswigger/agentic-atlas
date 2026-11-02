import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  searchContext,
  buildSearchAnswerRequest,
} from "../server/search-answer.js";

test("automatic search context reads bodies and neighboring outcomes within scope and budget", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT)",
  );
  const rows = [
    {
      id: "early",
      session: "s",
      project: "imaging",
      role: "user",
      timestamp: "2026-10-01T10:00:00Z",
      text: "An earlier unrelated request, outside the selected period.",
    },
    {
      id: "request",
      session: "s",
      project: "imaging",
      role: "user",
      timestamp: "2026-10-20T10:00:00Z",
      text: "Migrate the brain imaging frontend to React and keep the custom region controls.",
    },
    {
      id: "answer",
      session: "s",
      project: "imaging",
      role: "assistant",
      timestamp: "2026-10-20T11:00:00Z",
      text: "The brain imaging frontend migration is implemented and the custom region controls are working.",
    },
    {
      id: "wrong-project",
      session: "s",
      project: "private",
      role: "assistant",
      timestamp: "2026-10-20T12:00:00Z",
      text: "Secret neighboring message in another project must not leak into the context.",
    },
    {
      id: "future",
      session: "s",
      project: "imaging",
      role: "assistant",
      timestamp: "2026-10-25T10:00:00Z",
      text: "This future outcome must not appear in the historical search summary.",
    },
  ];
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)");
  const add = (row) =>
    insert.run(
      row.id,
      row.session,
      row.project,
      "Plan my day",
      row.role,
      row.timestamp,
      row.text,
    );
  try {
    rows.forEach(add);
    const scope = {
      project: "imaging",
      start: "2026-10-19T00:00:00Z",
      end: "2026-10-22T00:00:00Z",
    };
    const matches = [{ ...rows[1], score: 0.8 }];
    let selected = searchContext(db, matches, scope, 2000);
    assert.deepEqual(
      selected.sources.map((row) => row.id),
      ["request", "answer"],
    );
    assert.ok(selected.characters <= 2000);
    const later = {
      id: "new",
      session: "s",
      project: "imaging",
      role: "assistant",
      timestamp: "2026-10-20T11:30:00Z",
      text: "A newly indexed verification passed after the migration and should now be included.",
    };
    add(later);
    selected = searchContext(db, matches, scope, 2000);
    assert.ok(
      selected.sources.some((row) => row.id === "new"),
      "each search sees newly indexed replies",
    );
    const tiny = searchContext(db, matches, scope, 10);
    assert.deepEqual(
      tiny.sources,
      [],
      "never truncate a passage to force it into the budget",
    );
  } finally {
    db.close();
  }
});

test("automatic context balances near matches across sessions and ignores progress chatter", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT)",
  );
  try {
    const matches = [
      {
        id: "1",
        session: "a",
        score: 0.8,
        text: "The activation engine applies suppression with an efficient vector projection.",
      },
      {
        id: "2",
        session: "a",
        score: 0.799,
        text: "The activation engine applies ablation using the cached region directions.",
      },
      {
        id: "3",
        session: "b",
        score: 0.798,
        text: "The brain imaging UI now connects to the activation engine in a React application.",
      },
      {
        id: "4",
        session: "a",
        score: 0.9,
        text: "Hooks are in place and I am now writing the next components for this project.",
      },
    ].map((row) => ({
      ...row,
      project: "imaging",
      role: "assistant",
      timestamp: "2026-10-20T10:00:00Z",
      title: "Plan my day",
    }));
    for (const row of matches)
      db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)").run(
        row.id,
        row.session,
        row.project,
        row.title,
        row.role,
        row.timestamp,
        row.text,
      );
    const selected = searchContext(db, matches, {}, 3000);
    assert.deepEqual(
      selected.sources.slice(0, 2).map((row) => row.session),
      ["a", "b"],
    );
    // Chatter can be present as neighboring context, but never drives retrieval anchors.
    assert.notEqual(selected.sources[0].id, "4");
  } finally {
    db.close();
  }
});

test("final synthesis receives numeric references for research findings rather than database IDs", () => {
  const sources = [
    {
      id: "source-id",
      project: "app",
      timestamp: "2026-10-27T10:00:00Z",
      role: "user",
      text: "The old modelling requirement is removed.",
    },
  ];
  const request = buildSearchAnswerRequest(
    "mock",
    "What is unresolved?",
    {},
    sources,
    {
      evidenceThrough: sources[0].timestamp,
      investigation: {
        reads: ["source-id"],
        findings: [
          {
            subject: "Model",
            state: "superseded",
            assessment: "Not required",
            sourceIds: ["source-id"],
          },
        ],
      },
    },
  );
  const input = JSON.parse(request.prompt);
  assert.deepEqual(input.investigation.findings[0].sources, [1]);
  assert.ok(!request.prompt.includes('"source-id"'));
});
