import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { mergeObjectiveContinuations } from "../server/objective-continuity.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec("CREATE TABLE settings(key TEXT,value TEXT)");
  const topics = [
    "Implement document export",
    "Review document export",
    "Research document import",
  ].map((name, i) => ({
    name,
    description: "A concrete independently described objective for DEMO-123.",
    rows: [
      {
        id: String(i),
        role: "user",
        text: `${name} for DEMO-123 and verify the explicitly requested deliverable.`,
      },
    ],
  }));
  return { db, topics };
}
const reply = (prompt, relation) => ({
  matches: JSON.parse(prompt).pairs.map((p) => ({
    key: p.key,
    relation: relation(p),
    name: "Deliver document export",
    description: "Implement and verify the same document export change.",
  })),
});
test("implementation and review of a confirmed concrete task reunite", async () => {
  const { db, topics } = fixture();
  try {
    const result = await mergeObjectiveContinuations(db, topics.slice(0, 2), {
      nameGenerator: async (_db, _system, prompt) =>
        reply(prompt, () => "same"),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].rows.length, 2);
  } finally {
    db.close();
  }
});
test("a shared identifier does not merge related independent objectives", async () => {
  const { db, topics } = fixture();
  try {
    const result = await mergeObjectiveContinuations(db, topics, {
      nameGenerator: async (_db, _system, prompt) =>
        reply(prompt, () => "related"),
    });
    assert.equal(result.length, 3);
  } finally {
    db.close();
  }
});
test("pairwise confirmation cannot chain unrelated work into a broad category", async () => {
  const { db, topics } = fixture();
  try {
    const result = await mergeObjectiveContinuations(db, topics, {
      nameGenerator: async (_db, _system, prompt) =>
        reply(prompt, (p) => (p.key === 1 ? "different" : "same")),
    });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((t) => t.rows.length).sort(), [1, 2]);
  } finally {
    db.close();
  }
});
test("incomplete confirmations cannot silently merge or discard work", async () => {
  const { db, topics } = fixture();
  try {
    await assert.rejects(
      mergeObjectiveContinuations(db, topics, {
        nameGenerator: async () => ({ matches: [] }),
      }),
      /incomplete pair coverage/,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
      0,
    );
    assert.ok(topics.every((t) => t.rows.length === 1));
  } finally {
    db.close();
  }
});
