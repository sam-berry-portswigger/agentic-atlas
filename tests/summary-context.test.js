import test from "node:test";
import assert from "node:assert/strict";
import { summaryContext } from "../server/summary-context.js";
const row = (id, text, timestamp = "2026-10-27T12:00:00Z", session = id) => ({
  id,
  session,
  project: "desktop",
  title: "Database review",
  role: "assistant",
  timestamp,
  text,
});
test("summary context has an exact hard cap, source cap, diversity and stable citations", () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    row(
      String(i),
      "Database review fixed a regression. " +
        String(i) +
        " " +
        "evidence ".repeat(170),
      "2026-10-27T12:00:00Z",
      String(i % 8),
    ),
  );
  const selected = summaryContext(rows, { title: "Database review" });
  assert.ok(selected.prompt.length <= 12000);
  assert.ok(selected.sources.length <= 16);
  assert.ok(selected.sources.length > 1);
  assert.equal(selected.selection.promptChars, selected.prompt.length);
  for (const [i, source] of selected.sources.entries())
    assert.ok(selected.prompt.includes(`[${i + 1}] desktop`));
  assert.ok(new Set(selected.sources.map((r) => r.session)).size > 1);
  assert.deepEqual(
    summaryContext(rows, { title: "Database review" }),
    selected,
  );
});
test("selection favors relevant recent outcomes, deduplicates forks and retains defining evidence", () => {
  const anchor = row(
    "anchor",
    "We agreed to use SQLite to keep database storage local.",
    "2025-01-01T00:00:00Z",
  );
  const old = row(
    "old",
    "Database review verified the migration and fixed the regression.",
    "2024-01-01T00:00:00Z",
  );
  const fresh = row("fresh", old.text);
  const recent = row(
    "recent",
    "Database review decided to fix the SQLite WAL migration today.",
  );
  const irrelevant = row(
    "other",
    "We discussed lunch and the weather and other unrelated matters.",
  );
  const result = summaryContext([old, fresh, recent, irrelevant, anchor], {
    title: "Database review",
    anchors: new Set(["anchor"]),
  });
  assert.equal(result.sources[0].id, "anchor");
  assert.ok(!result.sources.some((r) => r.id === "old"));
  assert.ok(
    result.sources.findIndex((r) => r.id === "recent") <
      result.sources.findIndex((r) => r.id === "other"),
  );
  assert.ok(
    !summaryContext([row("huge", "database ".repeat(20000))], {
      title: "Database",
    }).sources.length,
  );
});
