import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { createTodayService, initTodaySchema } from "../server/today-store.js";
import { openTaskStreamIds } from "../shared/today-focus.js";

test("catalogue rebuilds preserve task board names, links, and usable retired streams", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE chunks(session TEXT,project TEXT)");
  initAnalysisSchema(db);
  initTodaySchema(db);
  const run = db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)");
  const topic = db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)");
  for (const [version, date, id, name] of [
    ["old", "2026-11-01", 43, "Schedule Feature Rollout"],
    ["new", "2026-11-02", 62, "Ticket Reproduction"],
  ]) {
    run.run(version, version, "embed", "generate", date, "{}");
    topic.run(version, id, name, "description", "purple", new Uint8Array());
  }
  db.prepare("INSERT INTO analysis_state VALUES('active','old')").run();
  const service = createTodayService(db, { actor: "user" });
  try {
    const original = service.createTask({
      title: "Ship scheduling",
      project: "private",
      streamId: 43,
    }).task;
    db.prepare(
      "UPDATE analysis_state SET value='new' WHERE key='active'",
    ).run();
    const snapshot = service.listTasks();
    assert.deepEqual(
      snapshot.tasks,
      [original],
      "rebuild must not rewrite task state or revisions",
    );
    assert.deepEqual(
      snapshot.taskWorkstreams.map((s) => [s.id, s.name]),
      [[43, "Schedule Feature Rollout"]],
    );
    assert.equal(
      openTaskStreamIds(snapshot.tasks).has(snapshot.taskWorkstreams[0].id),
      true,
    );
    assert.equal(
      service.createTask({ title: "Follow up", streamId: 43 }).task.streamId,
      43,
    );
    assert.equal(
      service.createTask({ title: "New topic", streamId: 62 }).task.streamId,
      62,
    );
    assert.throws(
      () => service.createTask({ title: "Invalid", streamId: 999 }),
      /not found/,
    );
    const restricted = createTodayService(db, { allowedProjects: ["public"] });
    // The second task above is in the empty project, also excluded from this scope.
    assert.deepEqual(restricted.listTasks().taskWorkstreams, []);
    assert.throws(
      () =>
        restricted.createTask({
          title: "Private stream",
          project: "public",
          streamId: 43,
        }),
      /not found/,
    );
    const done = service.updateTask({
      id: original.id,
      revision: original.revision,
      status: "done",
    }).task;
    assert.equal(
      service.listTasks().taskWorkstreams.find((s) => s.id === done.streamId)
        .name,
      "Schedule Feature Rollout",
    );
  } finally {
    db.close();
  }
});
