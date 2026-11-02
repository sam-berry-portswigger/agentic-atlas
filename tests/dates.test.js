import test from "node:test";
import assert from "node:assert/strict";
import { dateRange } from "../shared/dates.js";
import { parseScope, scopeWhere } from "../server/scope.js";
import { cleanTopic, sampleEvidence } from "../server/insights.js";
process.env.TZ = "Europe/London";
test("this week starts on Monday in local time, not Sunday or a rolling seven days", () => {
  const r = dateRange("week", "", "", new Date("2026-10-21T12:00:00Z"));
  assert.equal(r.start, "2026-10-18T23:00:00.000Z");
  assert.equal(r.end, "2026-10-21T23:00:00.000Z");
  const sunday = dateRange("week", "", "", new Date("2026-10-25T12:00:00Z"));
  assert.equal(sunday.start, r.start);
  assert.equal(sunday.end, "2026-10-26T00:00:00.000Z");
});
test("custom date end is inclusive and daylight saving boundaries retain local calendar days", () => {
  const r = dateRange("custom", "2026-10-24", "2026-10-25");
  assert.equal(r.start, "2026-10-23T23:00:00.000Z");
  assert.equal(r.end, "2026-10-26T00:00:00.000Z");
  assert.equal((Date.parse(r.end) - Date.parse(r.start)) / 3600000, 49);
  assert.ok(dateRange("custom", "2026-02-30", "2026-03-02").error);
  assert.ok(dateRange("custom", "2026-10-25", "2026-10-24").error);
  assert.deepEqual(dateRange("all"), { start: "", end: "", error: "" });
});
test("scope rejects invalid/reversed dates and parameterizes project input", () => {
  assert.throws(() => parseScope({ start: "yesterday" }), /Invalid/);
  assert.throws(
    () =>
      parseScope({
        start: "2026-10-25T00:00:00Z",
        end: "2026-10-24T00:00:00Z",
      }),
    /Start/,
  );
  assert.throws(() => parseScope({ start: "2026-02-30T00:00:00Z" }), /Invalid/);
  const scope = parseScope({
    project: "x' OR 1=1",
    start: "2026-10-21T00:00:00+01:00",
  });
  const where = scopeWhere(scope);
  assert.ok(!where.sql.includes(scope.project));
  assert.equal(where.params[0], scope.project);
  assert.equal(scope.start, "2026-10-20T23:00:00.000Z");
});
test("work summaries discard unsupported citations and cannot keep uncited decisions", () => {
  const source = { id: "real", session: "s", text: "We chose SQLite." };
  const result = cleanTopic(
    {
      title: "Local storage",
      summary: "SQLite was chosen.",
      category: "Design",
      sourceIds: ["real", "made-up"],
      decisions: [
        { text: "Chosen SQLite", sourceIds: ["real"] },
        { text: "Made-up commitment", sourceIds: ["fake"] },
      ],
      openQuestions: [],
      nextSteps: [],
    },
    [source],
  );
  assert.deepEqual(result.sourceIds, ["real"]);
  assert.equal(result.decisions.length, 1);
  assert.throws(
    () =>
      cleanTopic({ title: "X", summary: "Y", sourceIds: ["fake"] }, [source]),
    /uncited/,
  );
});
test("evidence sampling collapses fork duplicates and includes recent intent and earlier evidence", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    role: i % 2 ? "assistant" : "user",
    session: "s" + Math.floor(i / 3),
    text: "Distinct passage " + i,
  }));
  const sampled = sampleEvidence([...rows, { ...rows[0], id: "fork" }], 14);
  assert.ok(sampled.length <= 14);
  assert.ok(new Set(sampled.map((s) => s.session)).size >= 7);
  assert.ok(sampled.some((s) => s.role === "user"));
  assert.ok(sampled.some((s) => s.role === "assistant"));
  assert.ok(!sampled.some((s) => s.id === "fork"));
});
