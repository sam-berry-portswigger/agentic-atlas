import test from "node:test";
import assert from "node:assert/strict";
import { scopeChanges, preserveScopeChanges } from "../server/scope-changes.js";
test("later scope changes and dependent access deferrals remain explicit, without reopening old plans", () => {
  const source = {
    id: "decision",
    timestamp: "2026-10-27T10:27:00Z",
    text: "Desktop traces are reaching sample metrics. The blocker is gone.\n\nThe CSV model, `dataproductowner` role and `ps-csv` work are now later unless product needs tables.\n\nsample metrics is sufficient for release.",
  };
  const changes = scopeChanges(
    [{ subject: "Start on CSV model", state: "superseded", verified: true }],
    [source],
  );
  const answer = preserveScopeChanges(
    "The CSV model is still open [1].\n\nThe data product owner role remains a blocker [1].\n\nRelease sign-off is unconfirmed [1].",
    changes,
  );
  assert.ok(answer.includes("sample metrics is sufficient for release"));
  assert.ok(answer.includes("now later"));
  assert.ok(!answer.includes("still open"));
  assert.ok(!answer.includes("remains a blocker"));
  assert.ok(answer.includes("Release sign-off"));
  assert.match(answer, /\[1\]/);
  assert.equal(
    scopeChanges(
      [{ subject: "CSV model", state: "superseded", verified: false }],
      [source],
    ).length,
    0,
  );
});
