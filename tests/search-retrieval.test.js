import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  latestSearchEvidence,
  latestSubjectEvidence,
  subjectTerms,
  statusEvidence,
  isStatusQuestion,
} from "../server/search-retrieval.js";
import { searchContext } from "../server/search-answer.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT)",
  );
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)");
  const add = (
    id,
    session,
    time,
    text,
    role = "assistant",
    project = "app",
  ) => {
    const row = {
      id,
      session,
      project,
      title: "Plan my day",
      role,
      timestamp: `2026-10-22T${time}:00Z`,
      text,
    };
    insert.run(id, session, project, row.title, role, row.timestamp, text);
    return row;
  };
  return { db, add };
}
test("later cross-thread evidence follows concrete IDs through to short outcomes, within project and historical scope", () => {
  const { db, add } = fixture();
  try {
    const plan = add(
      "plan",
      "old",
      "08:00",
      "For schedule switching PR 1234, tests are still running. Review their XML before committing.",
    );
    add(
      "pointer",
      "new",
      "09:00",
      "PR 1234 schedule switching is now under review after the test run.",
    );
    add(
      "report",
      "new",
      "09:10",
      "The tests finished. All fifteen passed.",
      "user",
    );
    add(
      "outcome",
      "new",
      "09:11",
      "Master is merged locally. Tests passed, but the review found two possible bugs that need investigation.",
    );
    add(
      "future",
      "new",
      "12:00",
      "PR 1234 is merged and deployed. This is beyond the historical cutoff.",
    );
    add(
      "private",
      "private",
      "09:15",
      "PR 1234 schedule switching has confidential unrelated outcomes.",
      "assistant",
      "private",
    );
    const scope = {
      project: "app",
      start: "2026-10-22T07:00:00Z",
      end: "2026-10-22T10:00:00Z",
    };
    const recent = latestSearchEvidence(
      db,
      [{ ...plan, score: 0.9 }],
      "Am I ready to merge schedule switching?",
      scope,
    );
    assert.ok(
      recent.some((row) => row.id === "report"),
      "short outcome found despite no semantic query words",
    );
    assert.ok(
      recent.some((row) => row.id === "outcome"),
      "read past matching mention into later replies",
    );
    assert.ok(
      !recent.some((row) => row.id === "future" || row.id === "private"),
    );
    const selected = searchContext(db, [{ ...plan, score: 0.9 }], scope, 4000, {
      recent,
    });
    assert.ok(selected.sources.some((row) => row.id === "outcome"));
    assert.equal(selected.sources.at(-1).id, "outcome");
  } finally {
    db.close();
  }
});
test("newer outcomes retain a budget even when older high-scoring plans are long and duplicated across forks", () => {
  const { db, add } = fixture();
  try {
    const plans = Array.from({ length: 12 }, (_, i) => ({
      ...add(
        `old-${i}`,
        `s${i}`,
        "08:00",
        `Schedule switching plan ${i}: ` +
          "Run the tests and check the result. ".repeat(25),
      ),
      score: 1 - i * 0.001,
    }));
    const outcome = add(
      "passed",
      "current",
      "09:30",
      "Schedule switching tests passed, and master was merged locally. Two review findings still need investigation.",
    );
    const duplicate = { ...outcome, id: "fork-copy", session: "fork" };
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)").run(
      duplicate.id,
      duplicate.session,
      duplicate.project,
      duplicate.title,
      duplicate.role,
      duplicate.timestamp,
      duplicate.text,
    );
    const selected = searchContext(db, plans, {}, 3500, {
      recent: [outcome, duplicate],
    });
    assert.equal(
      selected.sources.filter((row) => row.text === outcome.text).length,
      1,
    );
    assert.ok(selected.characters <= 3500);
    assert.equal(selected.sources.at(-1).id, "passed");
  } finally {
    db.close();
  }
});
test("a generic session title or unrelated recent tail cannot establish a current outcome", () => {
  const { db, add } = fixture();
  try {
    const plan = add(
      "plan",
      "s",
      "08:00",
      "Implement the schedule switching flow and test revocation on account changes.",
    );
    for (let i = 0; i < 20; i++)
      add(
        `holiday-${i}`,
        "s",
        `09:${String(i).padStart(2, "0")}`,
        "Discuss the holiday itinerary and compare train fares for tomorrow's trip.",
      );
    assert.deepEqual(
      latestSearchEvidence(
        db,
        [plan],
        "Am I ready to merge schedule switching?",
        {},
      ),
      [],
    );
    assert.deepEqual(subjectTerms("Am I ready to merge schedule switching?"), [
      "schedule",
      "switch",
    ]);
  } finally {
    db.close();
  }
});

test("captured task notifications do not displace human reports and final assistant outcomes", () => {
  const { db, add } = fixture();
  try {
    const plan = add(
      "plan",
      "s",
      "08:00",
      "Schedule switching PR 1234 tests are running and the review has not finished.",
    );
    const notify = add(
      "notify",
      "s",
      "09:00",
      "<task-notification>Schedule switching PR 1234 tool output: " +
        "lots of captured machine output ".repeat(100) +
        "</task-notification>",
      "user",
    );
    const done = add(
      "done",
      "s",
      "09:01",
      "The schedule switching tests passed and the review found two possible bugs.",
    );
    const recent = latestSearchEvidence(
      db,
      [plan],
      "Am I ready to merge schedule switching?",
      {},
    );
    assert.ok(!recent.some((row) => row.id === notify.id));
    const context = searchContext(db, [{ ...plan, score: 0.9 }], {}, 2500, {
      recent,
    });
    assert.ok(context.sources.some((row) => row.id === done.id));
    assert.ok(!context.sources.some((row) => row.id === notify.id));
  } finally {
    db.close();
  }
});

test("one long review message cannot crowd earlier test outcomes and a local merge out of the thread tail", () => {
  const { db, add } = fixture();
  try {
    const plan = add(
      "plan",
      "s",
      "08:00",
      "Schedule switching PR 1234 is waiting for tests and a local master merge.",
    );
    add(
      "merge",
      "s",
      "09:00",
      "Master is now merged locally and all tests passed for schedule switching PR 1234.",
    );
    for (let i = 0; i < 24; i++)
      add(
        `review-${i}`,
        "s",
        "09:10",
        `Review detail ${i}: schedule switching PR 1234 has potential review findings to investigate.`,
      );
    add(
      "summary",
      "s",
      "09:11",
      "Schedule switching review found two possible bugs; tests passed on the merged code.",
    );
    const recent = latestSearchEvidence(
      db,
      [plan],
      "Am I ready to merge schedule switching?",
      {},
    );
    assert.ok(recent.some((row) => row.id === "merge"));
    assert.ok(recent.filter((row) => row.id.startsWith("review-")).length <= 2);
  } finally {
    db.close();
  }
});

test("status synthesis drops superseded thread states but retains later user corrections", () => {
  const { db, add } = fixture();
  try {
    const old = add(
      "old",
      "s",
      "08:00",
      "Schedule switching tests are still running; review has not completed.",
    );
    const latest = add(
      "latest",
      "s",
      "09:00",
      "Schedule switching tests passed. The review completed and found two possible bugs.",
    );
    const correction = add(
      "correction",
      "s",
      "09:01",
      "One test was skipped, so that result is not complete.",
      "user",
    );
    const other = add(
      "other",
      "other",
      "08:30",
      "Schedule switching has an independent open check in another conversation.",
    );
    const selected = statusEvidence(
      [old, other, latest, correction],
      "Am I ready to merge schedule switching?",
    );
    assert.deepEqual(
      selected.map((row) => row.id),
      ["other", "latest", "correction"],
    );
    assert.equal(isStatusQuestion("How do the merge algorithms work?"), false);
    assert.equal(
      isStatusQuestion("Am I ready to merge schedule switching?"),
      true,
    );
  } finally {
    db.close();
  }
});

test("status evidence preserves substantive review findings when the latest update is only a test result", () => {
  const { db, add } = fixture();
  try {
    const report = add(
      "review",
      "s",
      "09:00",
      "The schedule switching review found two possible must-fix bugs that need investigation.",
    );
    const progress = add(
      "progress",
      "s",
      "09:10",
      "The schedule switching tests are still running.",
    );
    const result = add(
      "result",
      "s",
      "09:20",
      "The schedule switching tests passed. That alone does not verify review findings.",
    );
    assert.deepEqual(
      statusEvidence(
        [report, progress, result],
        "Am I ready to merge schedule switching?",
      ).map((row) => row.id),
      ["review", "result"],
    );
  } finally {
    db.close();
  }
});

test("latest obligation checks find later scope reductions without generic-model noise or scope leaks", () => {
  const { db, add } = fixture();
  db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED,text)");
  const addIndexed = (...args) => {
    const row = add(...args);
    db.prepare("INSERT INTO chunks_fts VALUES(?,?)").run(row.id, row.text);
    return row;
  };
  addIndexed(
    "csv-plan",
    "old",
    "08:00",
    "The CSV model is a proposed release requirement and needs to be built.",
  );
  addIndexed(
    "decision",
    "decision",
    "14:00",
    "The CSV requirement is removed. Data reaching sample metrics is sufficient for release.",
    "user",
  );
  for (let i = 0; i < 45; i++)
    addIndexed(
      "noise" + i,
      "other" + i,
      "15:00",
      "Researching another language model for an unrelated experiment.",
    );
  addIndexed(
    "rare-noise",
    "rare",
    "16:00",
    "The unrelated creation procedure is documented here.",
  );
  addIndexed(
    "future",
    "future",
    "18:00",
    "CSV future decision must stay outside the selected cutoff.",
  );
  addIndexed(
    "private",
    "private",
    "14:30",
    "CSV private release information must stay outside scope.",
    "user",
    "private",
  );
  const result = latestSubjectEvidence(
    db,
    "CSV model creation",
    "model status",
    { end: "2026-10-22T17:00:00Z" },
    ["app"],
  );
  assert.equal(result[0].id, "decision");
  assert.ok(result.some((row) => row.id === "csv-plan"));
  assert.ok(
    result.every(
      (row) =>
        !row.id.startsWith("noise") &&
        row.id !== "rare-noise" &&
        row.id !== "future" &&
        row.id !== "private",
    ),
  );
  db.close();
});
