import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  initTodaySchema,
  readTodayVisibility,
  setTodayVisibility,
} from "../server/today-store.js";
import {
  focusedSessions,
  todayStatusCounts,
  streamActivity,
  compareStreamActivity,
  relevantArchives,
  openTaskStreamIds,
} from "../shared/today-focus.js";

test("archive list follows the day's snapshot without forgetting older preferences", () => {
  const hidden = [
    { kind: "session", id: "yesterday" },
    { kind: "session", id: "today" },
    { kind: "stream", id: "1" },
    { kind: "stream", id: "2" },
  ];
  const sessions = [{ id: "today", boardStreamId: 1 }];
  assert.deepEqual(relevantArchives(sessions, hidden), [hidden[1], hidden[2]]);
  assert.deepEqual(focusedSessions(sessions, [], hidden), []);
  assert.deepEqual(relevantArchives([], hidden), []);
  assert.deepEqual(
    relevantArchives([{ id: "yesterday", boardStreamId: 2 }], hidden),
    [hidden[0], hidden[3]],
  );
  assert.equal(hidden.length, 4);
});

test("task stream tabs disappear when their last open task is completed or moved", () => {
  const tasks = [
    { streamId: 1, status: "todo" },
    { streamId: 2, status: "doing" },
    { streamId: 3, status: "done" },
  ];
  assert.deepEqual([...openTaskStreamIds(tasks)], [1, 2]);
  tasks[1].status = "done";
  assert.deepEqual([...openTaskStreamIds(tasks)], [1]);
  tasks[0].streamId = 4;
  assert.deepEqual([...openTaskStreamIds(tasks)], [4]);
});

test("dismissal persists and restores independently for a session, its descendants and a stream", () => {
  const db = new DatabaseSync(":memory:");
  initTodaySchema(db);
  const sessions = [
    { id: "root", boardStreamId: 1 },
    { id: "child", boardStreamId: 1 },
    { id: "grandchild", boardStreamId: 1 },
    { id: "other", boardStreamId: 2 },
  ];
  const edges = [
    { parent: "root", child: "child" },
    { parent: "child", child: "grandchild" },
  ];
  setTodayVisibility(db, {
    kind: "session",
    id: "child",
    label: "Check tests",
    hidden: true,
  });
  assert.deepEqual(
    focusedSessions(sessions, edges, readTodayVisibility(db)).map((s) => s.id),
    ["root", "other"],
  );
  setTodayVisibility(db, {
    kind: "stream",
    id: "2",
    label: "Other work",
    hidden: true,
  });
  assert.deepEqual(
    focusedSessions(sessions, edges, readTodayVisibility(db)).map((s) => s.id),
    ["root"],
  );
  setTodayVisibility(db, { kind: "session", id: "child", hidden: false });
  assert.deepEqual(
    focusedSessions(sessions, edges, readTodayVisibility(db)).map((s) => s.id),
    ["root", "child", "grandchild"],
  );
  setTodayVisibility(db, { kind: "session", id: "root", hidden: true });
  assert.equal(
    focusedSessions(sessions, edges, readTodayVisibility(db)).length,
    0,
  );
  // Reinitializing the schema is safe and leaves focus preferences intact.
  initTodaySchema(db);
  assert.equal(readTodayVisibility(db).length, 2);
  assert.throws(() =>
    setTodayVisibility(db, { kind: "stream", id: "bad", hidden: true }),
  );
  assert.throws(() =>
    setTodayVisibility(db, { kind: "session", id: "root", hidden: "yes" }),
  );
  setTodayVisibility(db, { kind: "session", id: "root", hidden: false });
  setTodayVisibility(db, { kind: "stream", id: "2", hidden: false });
  assert.equal(
    focusedSessions(sessions, edges, readTodayVisibility(db)).length,
    4,
  );
  db.close();
});
test("stream ordering counts returns to human work, deduplicates history and excludes delegated agents", () => {
  const start = Date.parse("2026-10-28T00:00:00Z"),
    end = start + 86400000;
  const r = (id, hour) => ({
    id,
    at: new Date(start + hour * 3600000).toISOString(),
  });
  const activity = streamActivity(
    [
      {
        boardStreamId: 1,
        activity: [r("a", 9), r("b", 10), r("c", 11), r("old", -3)],
      },
      {
        boardStreamId: 1,
        child: true,
        relationship: "shared_history",
        activity: [r("a", 9), r("b", 10), r("c", 11)],
      },
      {
        boardStreamId: 2,
        activity: Array.from({ length: 20 }, (_, i) => r("x" + i, 12)),
      },
      {
        boardStreamId: 2,
        child: true,
        activity: [r("agent", 13), r("agent2", 14)],
      },
    ],
    start,
    end,
  );
  assert.equal(activity.get(1).requests, 3);
  assert.equal(activity.get(1).periods, 3);
  assert.equal(activity.get(2).periods, 1);
  assert.equal(activity.get(2).requests, 20);
  const streams = [
    { id: 2, name: "B", activity: activity.get(2) },
    { id: 1, name: "A", activity: activity.get(1) },
  ].sort(compareStreamActivity);
  assert.equal(streams[0].id, 1);
});

test("Today status totals exclude archived streams and session families, and restoring them restores counts", () => {
  const sessions = [
    { id: "active", status: "running", boardStreamId: 1 },
    { id: "archived", status: "running", boardStreamId: 2 },
    { id: "parent", status: "idle", boardStreamId: 3 },
    { id: "child", status: "running", boardStreamId: 3 },
  ];
  const edges = [{ parent: "parent", child: "child", kind: "delegated" }];
  const hidden = [
    { kind: "stream", id: "2" },
    { kind: "session", id: "parent" },
  ];
  assert.deepEqual(todayStatusCounts(sessions, edges, hidden), {
    all: 1,
    running: 1,
    unread: 0,
  });
  assert.deepEqual(
    todayStatusCounts(sessions, edges, [{ kind: "session", id: "archived" }]),
    { all: 3, running: 2, unread: 0 },
  );
  assert.deepEqual(todayStatusCounts(sessions, edges, []), {
    all: 4,
    running: 3,
    unread: 0,
  });
  assert.equal(sessions.length, 4);
});
