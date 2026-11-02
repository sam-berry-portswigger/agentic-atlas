import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sessionOptions } from "../server/session-options.js";
test("session picker searches archive metadata, deduplicates sessions and resolves selected older links", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE chunks(id TEXT,session TEXT,title TEXT,project TEXT,timestamp TEXT)",
    );
    const put = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?)");
    put.run("a", "old", "Earlier design", "atlas", "2025-01-01");
    put.run("b", "codex:new", "Scheduling tests", "desktop", "2026-10-29");
    put.run(
      "c",
      "codex:new",
      "Scheduling tests",
      "desktop",
      "2026-10-29T11:00:00Z",
    );
    put.run("d", "literal", "Check 100% coverage", "atlas", "2026-10-28");
    const found = sessionOptions(db, {
      query: "desktop",
      ids: ["old"],
    }).sessions;
    assert.deepEqual(
      found.map((s) => s.id),
      ["old", "codex:new"],
    );
    assert.equal(found[1].nativeId, "new");
    assert.equal(found[1].provider, "codex");
    assert.equal(found[0].title, "Earlier design");
    assert.equal(found[0].text, undefined, "no transcript contents returned");
    assert.equal(
      sessionOptions(db, { query: "%" }).sessions.length,
      1,
      "SQL wildcards are literal search text",
    );
    assert.equal(
      sessionOptions(db, { query: "' OR 1=1 --" }).sessions.length,
      0,
    );
    assert.doesNotThrow(
      () => sessionOptions(db, { ids: Array(21).fill("old") }),
      "20 manual links plus creator provenance fit in one metadata request",
    );
    assert.throws(() => sessionOptions(db, { ids: Array(22).fill("old") }), {
      status: 400,
    });
    assert.throws(() => sessionOptions(db, { query: 1 }), { status: 400 });
    assert.ok(sessionOptions(db).sessions.length <= 30);
  } finally {
    db.close();
  }
});
