import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionReadTargets,
  unreadFamilyCount,
} from "../shared/session-read.js";

test("reading a parent acknowledges descendants but preserves separate streams and sibling reads", () => {
  const sessions = ["root", "child", "nested", "sibling", "other"].map(
    (id) => ({
      id,
      lastResponseAt: "2026-10-29T12:00:00Z",
      topic: { id: id === "other" ? 2 : 1 },
    }),
  );
  const edges = [
    { parent: "root", child: "child" },
    { parent: "child", child: "nested" },
    { parent: "root", child: "sibling" },
    { parent: "root", child: "other" },
    { parent: "nested", child: "root" },
  ];
  const targets = (id) =>
    sessionReadTargets(id, sessions, edges).map((s) => s.id);
  assert.deepEqual(targets("root"), ["root", "child", "nested", "sibling"]);
  assert.deepEqual(targets("child"), ["child", "nested"]);
  assert.deepEqual(targets("absent"), []);
  sessions[2].lastResponseAt = null;
  assert.deepEqual(targets("child"), ["child"]);
  for (const s of sessions) s.unread = true;
  assert.equal(unreadFamilyCount(sessions, edges), 2);
  sessions.find((s) => s.id === "other").unread = false;
  assert.equal(unreadFamilyCount(sessions, edges), 1);
});
