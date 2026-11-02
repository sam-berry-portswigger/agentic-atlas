import test from "node:test";
import assert from "node:assert/strict";
import {
  createTimings,
  modelMetrics,
  measureInference,
  indexTiming,
} from "../server/timings.js";

test("exclusive stages sum to wall time, live snapshots advance and completion freezes", () => {
  let now = 0;
  const updates = [];
  const timer = createTimings(
    (value) => updates.push(value),
    () => now,
  );
  timer.begin("Index");
  now = 150;
  assert.equal(timer.snapshot().stages[0].elapsedMs, 150);
  timer.begin("Generate");
  now = 1000;
  timer.model({ label: "Overview", elapsedMs: 850 });
  const result = timer.finish();
  assert.deepEqual(
    result.stages.map((s) => s.elapsedMs),
    [150, 850],
  );
  assert.equal(
    result.stages.reduce((sum, s) => sum + s.elapsedMs, 0),
    result.elapsedMs,
  );
  assert.equal(result.complete, true);
  assert.ok(result.stages.every((s) => !s.active));
  assert.equal(result.models.length, 1);
  now = 3000;
  assert.deepEqual(timer.finish(), result);
  assert.equal(updates.at(-1).elapsedMs, 1000);
});

test("model counters convert nanoseconds and never invent missing MLX statistics", () => {
  const metrics = modelMetrics(
    {
      load_duration: 1e9,
      prompt_eval_duration: 2e9,
      eval_duration: 4e9,
      prompt_eval_count: 500,
      eval_count: 80,
    },
    7300,
    3100,
  );
  assert.equal(metrics.loadMs, 1000);
  assert.equal(metrics.promptMs, 2000);
  assert.equal(metrics.generationMs, 4000);
  assert.equal(metrics.tokensPerSecond, 20);
  assert.equal(metrics.firstTokenMs, 3100);
  assert.equal(modelMetrics({}, 100).tokensPerSecond, undefined);
  assert.equal(modelMetrics({}, 100).loadMs, undefined);
  assert.equal(
    modelMetrics({ eval_duration: 0, eval_count: 2 }, 100).tokensPerSecond,
    undefined,
  );
});

test("each inference attempt is recorded, including errors and first streamed text", async () => {
  const metrics = [];
  await assert.rejects(
    measureInference(
      async () => {
        throw new Error("Unsupported schema");
      },
      (m) => metrics.push(m),
      "local-model",
    ),
  );
  await measureInference(
    async (firstToken) => {
      firstToken();
      firstToken();
      return { response: "Done", eval_count: 12, eval_duration: 1e9 };
    },
    (m) => metrics.push(m),
    "local-model",
  );
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].failed, true);
  assert.equal(metrics[0].model, "local-model");
  assert.equal(metrics[1].failed, false);
  assert.ok(metrics[1].firstTokenMs >= 0);
  assert.equal(metrics[1].tokensPerSecond, 12);
  assert.ok(metrics[1].firstTokenMs <= metrics[1].elapsedMs + 1);
});

test("index progress separates import and embedding without splitting every batch", () => {
  let now = 0;
  const timer = createTimings(
    () => {},
    () => now,
  );
  timer.begin("Update session index");
  now = 10;
  indexTiming(timer, { detail: "importing" });
  now = 30;
  indexTiming(timer, { detail: "importing" });
  now = 60;
  indexTiming(timer, { detail: "embedding" });
  now = 200;
  assert.deepEqual(
    timer.finish().stages.map((s) => [s.label, s.elapsedMs]),
    [
      ["Update session index", 10],
      ["Import changed sessions", 50],
      ["Embed new conversation text", 140],
    ],
  );
});
