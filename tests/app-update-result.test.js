import test from "node:test";
import assert from "node:assert/strict";
import { appliedUpdate } from "../shared/app-update-result.js";

test("lost update responses reconcile only the exact approved commit", () => {
  const expected = "a".repeat(40),
    other = "b".repeat(40);
  assert.equal(
    appliedUpdate({ currentSha: expected, restartRequired: true }, expected),
    true,
  );
  assert.equal(
    appliedUpdate(
      {
        currentSha: expected,
        updatedVersion: expected,
        restartRequired: false,
      },
      expected,
    ),
    true,
  );
  assert.equal(
    appliedUpdate(
      { currentSha: other, updatedVersion: expected, restartRequired: true },
      expected,
    ),
    false,
  );
  assert.equal(
    appliedUpdate({ currentSha: expected, updatedVersion: other }, expected),
    false,
  );
  assert.equal(appliedUpdate({ currentSha: expected }, expected), false);
  assert.equal(appliedUpdate(null, expected), false);
});
