import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { trackMcpCall, readMcpActivity } from "../server/mcp-activity.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE mcp_calls(id TEXT PRIMARY KEY,pid INTEGER,started INTEGER,data TEXT)",
  );
  return db;
}
test("MCP activity counts evidence and clipping without recording sensitive input or output", () => {
  const db = fixture();
  try {
    const tracking = trackMcpCall(
      db,
      "atlas_search",
      {
        query: "secret query",
        hypothesis: "secret hypothetical answer",
        project: "imaging",
        mode: "hybrid",
        budget: 4000,
      },
      { name: "test-assistant", version: "1" },
    );
    let snapshot = readMcpActivity(db);
    assert.equal(snapshot.summary.running, 1);
    tracking.finish({
      results: [
        { id: "1", session: "s", text: "secret source" },
        { id: "2", session: "s", text: "another source" },
      ],
      omitted: 3,
      moreAvailable: true,
      budget: 4000,
    });
    snapshot = readMcpActivity(db);
    assert.equal(snapshot.summary.running, 0);
    assert.equal(snapshot.summary.excerpts, 2);
    assert.equal(snapshot.summary.clipped, 1);
    assert.equal(snapshot.calls[0].sessions, 1);
    assert.equal(snapshot.calls[0].characters, 27);
    assert.equal(snapshot.calls[0].client, "test-assistant");
    assert.ok(snapshot.summary.payloadBytes > 26);
    assert.ok(snapshot.summary.median >= 0);
    const stored = db.prepare("SELECT data FROM mcp_calls").get().data;
    assert.ok(!stored.includes("secret"));
    assert.ok(!stored.includes("another source"));
    trackMcpCall(db, "atlas_sync").finish(null, { failed: true });
    trackMcpCall(db, "atlas_sync").finish(null, {
      failed: true,
      cancelled: true,
    });
    snapshot = readMcpActivity(db);
    assert.equal(snapshot.summary.errors, 1);
    assert.equal(snapshot.summary.cancelled, 1);
    assert.equal(snapshot.total, 3);
  } finally {
    db.close();
  }
});
test("MCP activity bounds storage, filters the period and detects an exited server", () => {
  const db = fixture();
  try {
    for (let i = 0; i < 1005; i++) trackMcpCall(db, "atlas_status").finish({});
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM mcp_calls").get().n,
      1000,
    );
    const latest = readMcpActivity(db);
    assert.equal(latest.calls.length, 100);
    db.prepare("UPDATE mcp_calls SET started=?").run(Date.now() - 48 * 3600000);
    assert.equal(readMcpActivity(db).total, 0);
    assert.equal(readMcpActivity(db, { hours: 168 }).total, 1000);
    const call = trackMcpCall(db, "atlas_sync");
    db.prepare("UPDATE mcp_calls SET pid=2147483647 WHERE started>?").run(
      Date.now() - 1000,
    );
    assert.equal(readMcpActivity(db).calls[0].status, "interrupted");
    call.finish({});
  } finally {
    db.close();
  }
});
test("a telemetry write failure cannot break retrieval", () => {
  const db = fixture();
  db.close();
  assert.doesNotThrow(() => trackMcpCall(db, "atlas_status").finish({}));
});
