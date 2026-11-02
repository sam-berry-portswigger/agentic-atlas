import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initTodaySchema } from "../server/today-store.js";
import { attachUnread, markSessionRead } from "../server/session-read.js";
test("unread tracks unseen replies, clears on opening, and reappears only for a newer reply", () => {
  const db = new DatabaseSync(":memory:");
  initTodaySchema(db);
  try {
    const start = Date.parse("2026-10-01"),
      end = start + 86400000,
      s = {
        id: "one",
        status: "done",
        lastResponseAt: "2026-10-01T12:00:00Z",
        lastRequestAt: "2026-10-01T11:59:00Z",
      };
    attachUnread(db, [s], start, end);
    assert.equal(s.unread, true);
    markSessionRead(db, { session: s.id, responseAt: s.lastResponseAt });
    attachUnread(db, [s], start, end);
    assert.equal(s.unread, false);
    markSessionRead(db, { session: s.id, responseAt: "2026-10-01T11:00:00Z" });
    attachUnread(db, [s], start, end);
    assert.equal(s.unread, false);
    s.lastResponseAt = "2026-10-01T13:00:00Z";
    attachUnread(db, [s], start, end);
    assert.equal(s.unread, true);
    s.status = "running";
    attachUnread(db, [s], start, end);
    assert.equal(s.unread, false);
    s.status = "done";
    s.lastRequestAt = "2026-10-01T14:00:00Z";
    attachUnread(db, [s], start, end);
    assert.equal(s.unread, false);
    assert.throws(
      () => markSessionRead(db, { session: "one", responseAt: "invalid" }),
      (e) => e.status === 400,
    );
    assert.throws(
      () => markSessionRead(db, { session: "one", responseAt: "2099-01-01" }),
      (e) => e.status === 400,
    );
  } finally {
    db.close();
  }
});
