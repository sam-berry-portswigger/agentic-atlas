import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  summaryFingerprint,
  cachedSummary,
  saveSummary,
} from "../server/summary-cache.js";
const row = {
  id: "a",
  session: "session",
  project: "desktop",
  title: "Review",
  role: "assistant",
  timestamp: "2026-10-27T12:00:00Z",
  text: "The review found a regression.",
};
const metadata = { kind: "work", title: "Reviewing the scheduling change" };
const topic = (rows = [row], analysisVersion = "first") => ({
  ...metadata,
  analysisVersion,
  summaryFingerprint: summaryFingerprint(rows, metadata),
});
test("completed summaries survive rebuilds and invalidate when supporting content changes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE analysis_summaries(version TEXT,selection TEXT,scope TEXT,data TEXT,PRIMARY KEY(version,selection,scope))",
  );
  const result = { summary: "Reviewed the change [1].", sources: [row] };
  saveSummary(db, topic(), "local-model", result);
  assert.deepEqual(
    cachedSummary(db, topic([row], "rebuilt"), "local-model"),
    result,
  );
  assert.equal(cachedSummary(db, topic(), "different-model"), null);
  for (const rows of [
    [{ ...row, text: "Regression fixed." }],
    [row, { ...row, id: "b", text: "New outcome." }],
    [],
  ])
    assert.equal(cachedSummary(db, topic(rows), "local-model"), null);
  assert.notEqual(
    summaryFingerprint([row], metadata),
    summaryFingerprint([row], { ...metadata, title: "A different work item" }),
  );
  assert.equal(
    summaryFingerprint([row, { ...row, id: "b" }], metadata),
    summaryFingerprint([{ ...row, id: "b" }, row], metadata),
  );
  db.close();
});

test("compact legacy summaries remain reusable while report-style summaries are regenerated", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE analysis_summaries(version TEXT,selection TEXT,scope TEXT,data TEXT,PRIMARY KEY(version,selection,scope))",
    );
    const key = JSON.stringify({
      model: "local-model",
      policy: "recent-relevant-stream-v2",
    });
    const put = db.prepare(
      "INSERT OR REPLACE INTO analysis_summaries VALUES(?,?,?,?)",
    );
    const good = {
      summary:
        "The feature flag exposed outdated scheduling tests. The UI tests need to match the new screen [1].",
      sources: [row],
    };
    put.run(topic().summaryFingerprint, "summary", key, JSON.stringify(good));
    assert.deepEqual(cachedSummary(db, topic(), "local-model"), good);
    for (const summary of [
      "## Shared Themes\n\n- UI refinements [1].",
      Array(180).fill("detail").join(" "),
    ]) {
      put.run(
        topic().summaryFingerprint,
        "summary",
        key,
        JSON.stringify({ summary, sources: [row] }),
      );
      assert.equal(cachedSummary(db, topic(), "local-model"), null);
    }
  } finally {
    db.close();
  }
});
