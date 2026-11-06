import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import {
  refineStreamGoals,
  streamNeighborhoods,
} from "../server/refine-streams.js";
import { normalize } from "../server/db.js";
import { nextTopicColor, topicColors } from "../shared/topic-colors.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec("CREATE TABLE settings(key TEXT,value TEXT)");
  const conversations = [0, 1].flatMap((group) =>
    Array.from({ length: 8 }, (_, i) => {
      const session = `${group}-${i}`,
        vector = normalize(group ? [0.01 * i, 1, 0] : [1, 0.01 * i, 0]);
      const row = {
        id: session,
        session,
        role: "user",
        title: `Independent objective ${group}`,
        timestamp: i % 2 ? "2026-11-01" : "2024-01-01",
        text: `Deliver the independent objective ${group} with its own expected result and verification.`,
        vector,
      };
      return {
        session,
        vector,
        rows: [row],
        representative: row,
        evidence: [row],
      };
    }),
  );
  const topic = {
    id: 7,
    name: "Desktop development",
    description:
      "A broad historical category covering unrelated development work.",
    color: "#123456",
    rows: conversations.flatMap((c) => c.rows),
  };
  const generate = async (_db, _system, prompt) => ({
    objectives: JSON.parse(prompt).neighborhoods.map((g) => ({
      key: g.key,
      name: g.examples[0].title,
      description: `Complete the concrete ${g.examples[0].title.toLowerCase()} deliverable.`,
    })),
  });
  return { db, conversations, topic, generate };
}

test("local neighborhoods preserve separated objectives independently of dates, map coordinates and input order", () => {
  const { db, conversations } = fixture();
  try {
    const groups = streamNeighborhoods(conversations);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.length === 8));
    const changed = [...conversations]
      .reverse()
      .map((c) => ({ ...c, x: 0.5, y: 0.5 }));
    assert.deepEqual(
      streamNeighborhoods(changed).map((g) => g.map((c) => c.session)),
      groups.map((g) => g.map((c) => c.session)),
    );
  } finally {
    db.close();
  }
});

test("supported distinct goals split while sparse evidence retains its original stream", async () => {
  const { db, conversations, topic, generate } = fixture();
  const sparse = { ...conversations[0], session: "sparse", vector: [0, 0, 1] };
  sparse.rows = [
    {
      ...sparse.rows[0],
      id: "sparse",
      session: "sparse",
      vector: sparse.vector,
    },
  ];
  topic.rows.push(...sparse.rows);
  try {
    const result = await refineStreamGoals(
      db,
      [topic],
      [...conversations, sparse],
      { nameGenerator: generate },
    );
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.find((t) => t.id === 7).rows.map((r) => r.id),
      ["sparse"],
    );
    assert.equal(
      new Set(result.flatMap((t) => t.rows.map((r) => r.id))).size,
      17,
    );
    assert.ok(
      result
        .filter((t) => t.id === undefined)
        .every((t) => t.rows.length === 8),
    );
  } finally {
    db.close();
  }
});

test("separated neighborhoods describing the same concrete task stay one goal", async () => {
  const { db, conversations, topic } = fixture();
  try {
    const result = await refineStreamGoals(db, [topic], conversations, {
      nameGenerator: async (_db, _system, prompt) => ({
        objectives: JSON.parse(prompt).neighborhoods.map((g) => ({
          key: g.key,
          name: "Deliver calendar export",
          description:
            "Implement, review and verify the same calendar export change.",
        })),
      }),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].rows.length, 16);
  } finally {
    db.close();
  }
});

test("manual corrections and coherent existing work do not trigger automatic splits", async () => {
  const { db, conversations, topic } = fixture();
  try {
    db.prepare(
      "INSERT INTO analysis_state VALUES('stream_session_assignments',?)",
    ).run(
      JSON.stringify(
        Object.fromEntries(
          conversations.slice(0, 8).map((c) => [c.session, 7]),
        ),
      ),
    );
    const result = await refineStreamGoals(db, [topic], conversations, {
      nameGenerator: () =>
        assert.fail("only one uncorrected neighborhood remains"),
    });
    assert.equal(result[0].rows.length, 16);
    assert.equal(result[0].id, 7);
  } finally {
    db.close();
  }
});

test("invalid objective coverage and cancellation cannot silently publish partial groupings", async () => {
  const { db, conversations, topic } = fixture();
  try {
    await assert.rejects(
      refineStreamGoals(db, [topic], conversations, {
        nameGenerator: async () => ({ objectives: [] }),
      }),
      /incomplete neighborhood coverage/,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
      0,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      refineStreamGoals(db, [topic], conversations, {
        signal: controller.signal,
        nameGenerator: () => assert.fail("aborted"),
      }),
      { name: "AbortError" },
    );
    assert.equal(topic.rows.length, 16);
  } finally {
    db.close();
  }
});

test("color availability does not impose a hidden limit on genuine work objectives", () => {
  const used = new Set(topicColors);
  for (let i = 0; i < 80; i++) {
    const next = nextTopicColor(used);
    assert.match(next, /^#[0-9a-f]{6}$/);
    assert.ok(!used.has(next));
    used.add(next);
  }
});

test("naming reads representative requests instead of incidental setup and machine notifications", async () => {
  const { db, conversations, topic } = fixture();
  for (const c of conversations) {
    c.rows.push({
      ...c.rows[0],
      id: "!housekeeping-" + c.session,
      text: "Please note that this work does not have a ticket assigned yet.",
    });
    c.rows.push({
      ...c.rows[0],
      id: "000-notification-" + c.session,
      text: "<task-notification>Background command finished. This long machine-generated notification must never become the objective.</task-notification>",
    });
    c.rows.unshift({
      ...c.rows[0],
      id: "setup-" + c.session,
      timestamp: "2023-01-01",
      vector: normalize([1, 1, 1]),
      text: "Set the development environment to staging before continuing with the substantive work described later in the conversation.",
    });
  }
  try {
    await refineStreamGoals(db, [topic], conversations, {
      nameGenerator: async (_db, _system, prompt) => {
        const input = JSON.parse(prompt);
        assert.equal(
          input.knownObjectives,
          undefined,
          "previous labels cannot become a forced menu of categories",
        );
        assert.ok(
          input.neighborhoods.every((g) =>
            g.examples.every((e) =>
              e.objectiveRequest.startsWith(
                "Deliver the independent objective",
              ),
            ),
          ),
        );
        return {
          objectives: input.neighborhoods.map((g) => ({
            key: g.key,
            name: "",
            description: "",
          })),
        };
      },
    });
  } finally {
    db.close();
  }
});

test("a fresh catalogue can discover supported objectives from unclassified evidence", async () => {
  const { db, conversations, topic, generate } = fixture();
  try {
    const result = await refineStreamGoals(
      db,
      [{ ...topic, name: "Other sessions", background: true }],
      conversations,
      { nameGenerator: generate },
    );
    assert.equal(result.length, 2);
    assert.ok(result.every((goal) => !goal.background));
    assert.equal(
      result.reduce((total, goal) => total + goal.rows.length, 0),
      16,
    );
  } finally {
    db.close();
  }
});
