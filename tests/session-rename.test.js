import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { sessionNameResolver } from "../server/session-labels.js";
import { sessionOptions } from "../server/session-options.js";
import {
  saveSessionTitle,
  suggestSessionTitle,
} from "../server/session-rename.js";

test("an explicit rename survives catalogue changes, resolves across views and leaves source evidence intact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initAnalysisSchema(db);
    db.exec(
      "CREATE TABLE chunks(id TEXT,session TEXT,title TEXT,project TEXT,timestamp TEXT,text TEXT)",
    );
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?)").run(
      "a",
      "codex:one",
      "Native title",
      "atlas",
      "2026-10-30",
      "Original user request",
    );
    saveSessionTitle(db, "codex:one", "  Repair semantic clustering  ");
    db.prepare("INSERT INTO analysis_session_labels VALUES(?,?,?,?)").run(
      "new",
      "codex:one",
      "Automated label",
      "hash",
    );
    db.prepare("INSERT INTO analysis_state VALUES('active','new')").run();
    assert.equal(
      sessionNameResolver(db)("codex:one", "Native title", "atlas"),
      "Repair semantic clustering",
    );
    assert.equal(
      sessionNameResolver(db, "older")(
        "codex:one",
        "Changed native title",
        "atlas",
      ),
      "Repair semantic clustering",
    );
    assert.equal(
      sessionNameResolver(db)("unrelated", "Native title", "atlas"),
      "Native title",
    );
    assert.equal(
      sessionOptions(db, { query: "semantic clustering" }).sessions[0].title,
      "Repair semantic clustering",
    );
    assert.deepEqual(
      { ...db.prepare("SELECT title,text FROM chunks").get() },
      { title: "Native title", text: "Original user request" },
    );
    saveSessionTitle(db, "codex:one", "Check literal 100% coverage");
    assert.equal(sessionOptions(db, { query: "100%" }).sessions.length, 1);
    for (const title of ["", " ", "line\nbreak", "<tag>", "x".repeat(81), null])
      assert.throws(() => saveSessionTitle(db, "codex:one", title), {
        status: 400,
      });
    assert.equal(
      sessionNameResolver(db)("codex:one", "Native title", "atlas"),
      "Check literal 100% coverage",
    );
  } finally {
    db.close();
  }
});

test("suggestions use bounded evidence from only the selected session, validate output and do not save", async () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    session: "one",
    role: i % 2 ? "assistant" : "user",
    timestamp: new Date(100000 + i * 1000).toISOString(),
    text: "Evidence ".repeat(400),
  }));
  messages.push({
    session: "other",
    role: "user",
    timestamp: "2026-10-30",
    text: "Unrelated session secret",
  });
  const args = {
    session: "one",
    title: "Continue",
    model: "local-model",
    messages,
  };
  const result = await suggestSessionTitle(
    args,
    async (model, system, prompt) => {
      assert.equal(model, "local-model");
      assert.match(system, /untrusted evidence/);
      assert.match(system, /overall subject or sustained goal/);
      const input = JSON.parse(prompt);
      assert.equal(input.currentTitle, "Continue");
      assert.equal(input.messages.length, 12);
      assert.ok(
        input.messages.every(
          (m) => m.session === "one" && m.text.length <= 700,
        ),
      );
      assert.ok(!prompt.includes("Unrelated session secret"));
      assert.ok(
        input.messages.some((m) => m.timestamp === messages[0].timestamp),
        "the opening request reaches the model",
      );
      return "Repair session grouping";
    },
  );
  assert.deepEqual(result, { title: "Repair session grouping" });
  await assert.rejects(
    suggestSessionTitle({ ...args, messages: [] }, () =>
      assert.fail("must not infer without evidence"),
    ),
    { status: 404 },
  );
  await assert.rejects(
    suggestSessionTitle(args, async () => "Invalid\nname"),
    { status: 502 },
  );
  await assert.rejects(
    suggestSessionTitle(args, async () => {
      throw Error("Ollama unavailable");
    }),
    /Ollama unavailable/,
  );
});
