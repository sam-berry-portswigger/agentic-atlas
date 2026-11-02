import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { createSessionBrief, briefEvidence } from "../server/session-brief.js";

test("session TLDR bounds recent evidence, coalesces requests and invalidates on new messages", async () => {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  try {
    let calls = 0;
    const brief = createSessionBrief(
      db,
      async (model, system, prompt, tokens) => {
        calls++;
        assert.equal(model, "local-model");
        assert.match(system, /untrusted evidence/);
        assert.ok(prompt.length < 12000);
        assert.equal(tokens, 150);
        return "The fix passed its checks. A review remains.";
      },
    );
    const messages = Array.from({ length: 20 }, (_, i) => ({
      session: "one",
      role: "assistant",
      timestamp: new Date(100000 + i * 1000).toISOString(),
      text: "x".repeat(2000),
    }));
    assert.equal(briefEvidence(messages).length, 12);
    const args = { session: "one", model: "local-model", messages };
    const [a, b] = await Promise.all([brief(args), brief(args)]);
    assert.equal(calls, 1);
    assert.equal(a.summary, b.summary);
    assert.equal((await brief(args)).cached, true);
    assert.equal(calls, 1);
    await brief({
      ...args,
      messages: [
        ...messages,
        {
          session: "one",
          role: "user",
          text: "Review approved",
          timestamp: new Date(200000).toISOString(),
        },
      ],
    });
    assert.equal(calls, 2);
    await assert.rejects(
      brief({ ...args, messages: [] }),
      (e) => e.status === 404,
    );
  } finally {
    db.close();
  }
});

test("streamed TLDR shares partial output with concurrent readers and caches only completed output", async () => {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  try {
    let finish;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    const brief = createSessionBrief(
      db,
      async (_model, _system, _prompt, _tokens, token) => {
        token("The checks passed.");
        await gate;
        token("The checks passed. Review remains.");
        return "The checks passed. Review remains.";
      },
    );
    const args = {
      session: "one",
      model: "local",
      messages: [
        {
          session: "one",
          role: "assistant",
          text: "Checks pass, awaiting review.",
          timestamp: "2026-10-29T12:00:00Z",
        },
      ],
    };
    const first = [],
      second = [];
    const a = brief({ ...args, onToken: (text) => first.push(text) });
    const b = brief({ ...args, onToken: (text) => second.push(text) });
    assert.deepEqual(first, ["The checks passed."]);
    assert.deepEqual(second, first);
    finish();
    await Promise.all([a, b]);
    assert.deepEqual(second, first);
    assert.equal(first.length, 2);
    const cached = await brief(args);
    assert.equal(cached.cached, true);
    assert.equal(cached.summary, first.at(-1));
  } finally {
    db.close();
  }
});
