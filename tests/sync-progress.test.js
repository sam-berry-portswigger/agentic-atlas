import test from "node:test";
import assert from "node:assert/strict";
import { createSyncProgress } from "../server/sync-progress.js";

test("waiting for a batch updates elapsed time without claiming uncommitted progress", () => {
  let now = 1000;
  const messages = [];
  const report = createSyncProgress((message) => messages.push(message), {
    clock: () => now,
  });
  report.progress("embedding", 0, 30, "Embedding new conversation text");
  now = 6000;
  report.heartbeat();
  assert.equal(messages.at(-1).done, 0);
  assert.equal(messages.at(-1).elapsedMs, 5000);
  assert.equal(messages.at(-1).lastProgressAt, new Date(1000).toISOString());
  // Only the worker's committed batch acknowledgement advances the count.
  report.progress("embedding", 24, 30, "Embedding new conversation text");
  now = 6500;
  report.progress("embedding", 30, 30, "Embedding new conversation text");
  report.progress("assigning", 0, 0, "Updating saved work streams", {
    contentReady: true,
  });
  assert.equal(messages.at(-1).stages[0].done, 30);
  assert.equal(messages.at(-1).stages[0].complete, true);
  assert.equal(messages.at(-1).indeterminate, true);
  assert.equal(messages.at(-1).contentReady, true);
});

test("optional naming failure preserves readiness and cannot turn success into indexing failure", () => {
  let now = 100;
  const messages = [];
  const report = createSyncProgress((message) => messages.push(message), {
    clock: () => now,
  });
  report.progress("assigning", 1, 1, "Saving work streams", {
    contentReady: true,
    assignmentsReady: true,
  });
  report.progress("naming", 0, 1, "Waiting for local model");
  report.progress("naming", 0, 1, "Waiting for local model", {
    model: {
      attempt: 1,
      elapsedMs: 16000,
      inputTokens: 1000,
      outputTokens: 40,
    },
  });
  now = 17100;
  report.heartbeat();
  assert.equal(messages.at(-1).indeterminate, true);
  assert.equal(messages.at(-1).assignmentsReady, true);
  report.progress(
    "warning",
    0,
    0,
    "Existing names retained; optional naming will retry later.",
  );
  assert.equal(messages.at(-1).phase, "naming");
  const complete = report.progress("complete", 0, 0, "Sessions ready", {
    mapPending: true,
  });
  assert.equal(complete.phase, "complete");
  assert.equal(complete.assignmentsReady, true);
  assert.equal(complete.warnings.length, 1);
  assert.equal(complete.mapPending, true);
  assert.equal(complete.models[0].attempt, 1);
  const count = messages.length;
  now += 5000;
  report.heartbeat();
  assert.equal(
    messages.length,
    count,
    "finished jobs stop publishing heartbeats",
  );
});

test("pause and failure finish the current stage without discarding a successful content import", () => {
  for (const phase of ["paused", "error"]) {
    const messages = [];
    const report = createSyncProgress((message) => messages.push(message));
    report.progress("assigning", 0, 0, "Updating work streams", {
      contentReady: true,
    });
    const final = report.progress(
      phase,
      0,
      0,
      "Stopped",
      phase === "error" ? { error: "Assignment failed" } : {},
    );
    assert.equal(final.contentReady, true);
    assert.equal(final.stages.at(-1).complete, true);
    assert.equal(final.indeterminate, false);
  }
});

test("successful local naming recovery replaces transient warnings with canonical catalogue warnings", () => {
  const report = createSyncProgress(() => {});
  report.progress("naming");
  report.progress("warning", 0, 0, "Global proposal was incomplete");
  const complete = report.progress("complete", 0, 0, "Ready", {
    contentReady: true,
    assignmentsReady: true,
    warnings: [],
  });
  assert.deepEqual(complete.warnings, []);
});

test("unfinished naming keeps its warning after map completion", () => {
  const report = createSyncProgress(() => {});
  report.progress("projecting");
  const complete = report.progress("complete", 0, 0, "Map ready", {
    contentReady: true,
    assignmentsReady: false,
    warnings: [{ code: "naming-pending", message: "Retry naming" }],
  });
  assert.equal(complete.assignmentsReady, false);
  assert.deepEqual(complete.warnings, ["Retry naming"]);
});
