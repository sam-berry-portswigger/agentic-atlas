import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { interpretStreams, streamEvidence } from "../server/stream-analysis.js";
import { jsonGenerate } from "../server/work-model.js";
import { suggestSessionTitle } from "../server/session-rename.js";

function fixture(model = "naming-test") {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec("CREATE TABLE settings(key TEXT,value TEXT)");
  db.prepare("INSERT INTO settings VALUES('generationModel',?)").run(
    JSON.stringify(model),
  );
  return db;
}
function candidate(session = "one") {
  return {
    center: [1, 0],
    rows: [
      {
        id: session,
        session,
        role: "user",
        title: "Continue",
        project: "atlas",
        timestamp: "2026-11-02",
        text: "Improve Atlas session navigation, preserve saved conversation topics and show current work clearly.",
        vector: [1, 0],
      },
    ],
  };
}
const previous = [
  {
    id: 7,
    name: "Atlas navigation",
    description: "Improve navigation through the user's current conversations.",
    center: [1, 0],
    references: [],
  },
];
const plan = {
  streams: [
    {
      name: "Atlas navigation",
      description:
        "Improve navigation through the user's current conversations.",
      sources: [1],
      background: false,
    },
  ],
  sessionLabels: [],
};

test("optional invalid naming preserves saved topics, rejects invalid claims and backs off without restarting the timer", async () => {
  const db = fixture(),
    warnings = [];
  let calls = 0;
  const options = {
    previous,
    namingOptional: true,
    onWarning: (w) => warnings.push(w),
    nameGenerator: async (_db, _s, _p, schema) => {
      calls++;
      assert.deepEqual(
        schema.properties.streams.items.properties.sources.items.enum,
        [1],
      );
      return { ...plan, streams: [{ ...plan.streams[0], sources: [999] }] };
    },
  };
  try {
    const result = await interpretStreams(db, [candidate()], options);
    assert.equal(result[0].id, 7);
    assert.equal(result[0].rows[0].session, "one");
    assert.equal(result[0].namingWarning.category, "source-id");
    assert.equal(calls, 1, "optional labels get one bounded attempt");
    const expiry = warnings[0].retryAfter;
    await interpretStreams(db, [candidate()], {
      ...options,
      fingerprint: "unrelated-new-archive-content",
    });
    assert.equal(calls, 1);
    assert.equal(warnings[1].retryAfter, expiry);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM analysis_name_cache WHERE key NOT LIKE 'naming-failure:%'",
        )
        .get().n,
      0,
      "invalid plans are never success-cached",
    );
  } finally {
    db.close();
  }
});

test("optional runner failure publishes safe residuals on first sync but cancellation still stops", async () => {
  const db = fixture();
  try {
    const result = await interpretStreams(db, [candidate()], {
      namingOptional: true,
      nameGenerator: async () => {
        throw Error("Runner unavailable");
      },
    });
    assert.equal(result[0].background, true);
    assert.equal(result[0].rows.length, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      interpretStreams(db, [candidate("cancel")], {
        signal: controller.signal,
        namingOptional: true,
        nameGenerator: () => assert.fail("must not call model"),
      }),
      { name: "AbortError" },
    );
  } finally {
    db.close();
  }
});

test("full interpretation bounds evidence and caches naming inputs instead of the archive fingerprint", async () => {
  const db = fixture();
  let calls = 0;
  const generate = async () => {
    calls++;
    return plan;
  };
  try {
    const evidence = streamEvidence(
      Array.from({ length: 60 }, (_, i) => candidate("session" + i)),
    );
    assert.equal(evidence.evidence.length, 24);
    assert.ok(JSON.stringify(evidence.evidence).length < 20000);
    const compact = streamEvidence([
      {
        center: [1, 0],
        rows: Array.from(
          { length: 60 },
          (_, i) => candidate("session" + i).rows[0],
        ),
      },
    ]);
    assert.equal(compact.evidence.length, 16);
    await interpretStreams(db, [candidate()], {
      fingerprint: "first",
      nameGenerator: generate,
    });
    await interpretStreams(db, [candidate()], {
      fingerprint: "second",
      nameGenerator: generate,
    });
    assert.equal(calls, 1);
    await interpretStreams(db, [candidate("changed")], {
      fingerprint: "second",
      nameGenerator: generate,
    });
    assert.equal(
      calls,
      1,
      "identity-only archive changes do not change the naming prompt",
    );
  } finally {
    db.close();
  }
});

test("unsupported structured output capability persists across worker modules and metrics omit prompt text", async () => {
  const db = fixture("capability-test");
  const original = globalThis.fetch,
    requests = [],
    metrics = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.format)
      return Response.json(
        { error: "structured output unavailable" },
        { status: 501 },
      );
    return Response.json({
      response: '{"ok":true}',
      prompt_eval_count: 9,
      eval_count: 4,
    });
  };
  try {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    assert.deepEqual(
      await jsonGenerate(db, "instructions", "Private evidence", schema, 50, {
        onMetrics: (m) => metrics.push(m),
      }),
      { ok: true },
    );
    const fresh =
      await import("../server/work-model.js?fresh-worker-capability");
    await fresh.jsonGenerate(
      db,
      "instructions",
      "Private evidence",
      schema,
      50,
    );
    assert.equal(requests.length, 3);
    assert.equal(requests.filter((r) => r.format).length, 1);
    assert.ok(
      metrics.every((m) => !JSON.stringify(m).includes("Private evidence")),
    );
    assert.equal(metrics.at(-1).inputTokens, 9);
    assert.equal(metrics.at(-1).outputTokens, 4);
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});

test("manual name suggestions reuse unchanged evidence and share in-flight inference", async () => {
  let calls = 0;
  const infer = async () => {
    calls++;
    return "Improve Atlas navigation";
  };
  const input = {
    session: "one",
    title: "Continue",
    model: "local",
    messages: [
      {
        session: "one",
        role: "user",
        timestamp: "2026-11-02",
        text: "Improve navigation and current work visibility.",
      },
    ],
  };
  await Promise.all([
    suggestSessionTitle(input, infer),
    suggestSessionTitle(input, infer),
  ]);
  assert.equal(calls, 1);
  await suggestSessionTitle(
    {
      ...input,
      messages: [{ ...input.messages[0], text: "Investigate another topic." }],
    },
    infer,
  );
  assert.equal(calls, 2);
  await suggestSessionTitle({ ...input, force: true }, infer);
  assert.equal(
    calls,
    3,
    "Suggest again deliberately bypasses the inference cache",
  );
});

test("cancelling an in-flight naming request aborts the runner and never retries", async () => {
  const db = fixture("cancel-inflight"),
    original = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
      controller.abort();
    });
  };
  try {
    await assert.rejects(
      jsonGenerate(db, "instructions", "evidence", { type: "object" }, 50, {
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
