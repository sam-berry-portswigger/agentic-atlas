import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import {
  representObjectives,
  objectiveEvidence,
} from "../server/conversation-objectives.js";
import { conversationVectors } from "../server/conversation-vectors.js";
import { assignStreamRows } from "../server/stream-analysis.js";
const row = (session, text, role = "user", id = session) => ({
  id,
  session,
  text,
  role,
  timestamp: id,
  title: "Shared tool used in this chat",
  vector: [1, 0],
  project: "same-checkout",
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec("CREATE TABLE settings(key TEXT,value TEXT)");
  return db;
}
const conversations = () =>
  conversationVectors([
    row(
      "build",
      "Implement document import in the shared tool and preserve existing documents.",
    ),
    row(
      "review",
      "Review the document import change for correctness before we ship it.",
    ),
    row(
      "coaching",
      "Help me set personal development goals; the shared tool is an example of work I can present.",
    ),
  ]);
const options = (counter = {}) => ({
  nameGenerator: async (_db, system, prompt) => {
    counter.generate = (counter.generate || 0) + 1;
    assert.match(system, /coaching/);
    const input = JSON.parse(prompt);
    return {
      goals: input.conversations.map(({ key, requests }) => ({
        key,
        objective: /personal development/.test(requests[0].text)
          ? "Define personal development goals for professional growth"
          : "Deliver reliable document import in the shared tool",
        sources: [1],
      })),
    };
  },
  embed: async (_model, inputs) => {
    counter.embed = (counter.embed || 0) + 1;
    return {
      embeddings: inputs.map((text) =>
        text.includes("personal development") ? [0, 1] : [1, 0],
      ),
    };
  },
});
test("objectives join implementation and review while separating coaching about the same tool", async () => {
  const db = fixture();
  try {
    const result = await representObjectives(db, conversations(), options());
    assert.deepEqual(result[0].vector, result[2].vector); // Sorted sessions: build, coaching, review.
    assert.notDeepEqual(result[0].vector, result[1].vector);
    assert.deepEqual(
      result[0].rows,
      conversations()[0].rows,
      "source text and passage vectors stay unchanged",
    );
    const plans = [
      {
        name: "Document import",
        description: "Deliver reliable import",
        exemplars: [{ ...result[0].representative, vector: result[0].vector }],
      },
    ];
    const groups = assignStreamRows(
      plans,
      [{ center: [1, 0], rows: result.flatMap((c) => c.rows) }],
      { conversations: result },
    );
    assert.deepEqual(
      [
        ...new Set(
          groups
            .find((g) => g.name === "Document import")
            .rows.map((r) => r.session),
        ),
      ].sort(),
      ["build", "review"],
    );
    assert.equal(groups.find((g) => g.background).rows[0].session, "coaching");
  } finally {
    db.close();
  }
});
test("validated objectives and embeddings are reused and request changes invalidate only affected entries", async () => {
  const db = fixture(),
    counter = {};
  try {
    const opts = options(counter);
    await representObjectives(db, conversations(), opts);
    await representObjectives(db, conversations(), opts);
    assert.deepEqual(counter, { generate: 1, embed: 1 });
    const changed = conversations();
    changed[0].rows[0] = {
      ...changed[0].rows[0],
      text: "Implement document import with a revised error recovery requirement.",
    };
    await representObjectives(db, changed, opts);
    assert.deepEqual(counter, { generate: 2, embed: 2 });
  } finally {
    db.close();
  }
});
test("objective evidence excludes assistant narration, ambient UI context and inherited summary headers", () => {
  const c = conversationVectors([
    row(
      "a",
      "Help me define professional development goals based on my feedback.",
    ),
    row(
      "a",
      "I will modify the shared tool and deploy its new interface.",
      "assistant",
      "b",
    ),
    row(
      "a",
      "<in-app-browser-context>Develop the shared tool interface and grouping.</in-app-browser-context>\nHelp me define professional development goals based on my feedback.",
      "user",
      "c",
    ),
    row(
      "a",
      "This session is being continued from a previous conversation about unrelated development work.",
      "user",
      "d",
    ),
  ])[0];
  assert.deepEqual(
    objectiveEvidence(c).map((r) => r.text),
    ["Help me define professional development goals based on my feedback."],
  );
});
test("malformed individual goals abstain without blocking valid siblings; invalid vectors fail safely", async () => {
  for (const broken of ["missing", "source", "vector"]) {
    const db = fixture();
    try {
      const opts = options();
      const generate = opts.nameGenerator;
      opts.nameGenerator = async (...args) => {
        const result = await generate(...args);
        if (broken === "missing") result.goals.pop();
        if (broken === "source") result.goals[0].sources = [999];
        return result;
      };
      if (broken === "vector")
        opts.embed = async () => ({
          embeddings: [
            [NaN, 0],
            [0, 1],
            [1, 0],
          ],
        });
      if (broken === "vector") {
        await assert.rejects(
          representObjectives(db, conversations(), opts),
          /Invalid/,
        );
        assert.equal(
          db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
          0,
        );
      } else {
        const result = await representObjectives(db, conversations(), opts);
        assert.equal(result.filter((c) => c.objectiveUnclear).length, 1);
        assert.equal(
          db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
          2,
        );
      }
    } finally {
      db.close();
    }
  }
});
test("unclear goals abstain even when raw conversation vectors have a close match", async () => {
  const db = fixture();
  try {
    const result = await representObjectives(db, conversations().slice(0, 1), {
      nameGenerator: async () => ({
        goals: [{ key: 0, objective: "", sources: [] }],
      }),
      embed: () => {
        throw Error("must not embed");
      },
    });
    const groups = assignStreamRows(
      [
        {
          name: "Document import",
          description: "Import work",
          exemplars: [result[0].representative],
        },
      ],
      [{ center: [1, 0], rows: result[0].rows }],
      { conversations: result },
    );
    assert.equal(groups[0].background, true);
  } finally {
    db.close();
  }
});
test("cancellation during inference leaves no partially cached batch", async () => {
  const db = fixture(),
    controller = new AbortController();
  try {
    const opts = options();
    opts.signal = controller.signal;
    opts.nameGenerator = async () => {
      controller.abort();
      return { goals: [] };
    };
    await assert.rejects(
      representObjectives(db, conversations(), opts),
      /abort/i,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM analysis_name_cache").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
