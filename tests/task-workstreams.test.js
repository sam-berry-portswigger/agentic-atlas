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

test("retired task links follow complete conversation lineage without rewriting tasks or guessing splits", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE chunks(session TEXT,project TEXT)");
    initAnalysisSchema(db);
    initTodaySchema(db);
    for (const version of ["old", "new"])
      db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
        version,
        version,
        "e",
        "g",
        version === "old" ? "2026-11-01" : "2026-11-02",
        "{}",
      );
    for (const [version, id, name] of [
      ["old", 136, "Agentic pentesting harness"],
      ["new", 177, "Agentic pentesting"],
      ["new", 178, "Independent task"],
    ])
      db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
        version,
        id,
        name,
        "Substantive workstream scope.",
        "purple",
        new Uint8Array(),
      );
    for (const version of ["old", "new"])
      for (const session of ["a", "b"]) {
        db.prepare(
          "INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)",
        ).run(version, session, session, new Uint8Array(), null, null);
        db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
          version,
          session,
          version === "old" ? 136 : 177,
          null,
          null,
        );
      }
    db.exec("INSERT INTO analysis_state VALUES('active','old')");
    const service = createTodayService(db, { actor: "user" });
    const original = service.createTask({
      title: "Build MVP",
      streamId: 136,
    }).task;
    const stored = () => db.prepare("SELECT * FROM today_tasks").get();
    const before = stored();
    db.exec("UPDATE analysis_state SET value='new' WHERE key='active'");
    const snapshot = service.listTasks();
    assert.equal(snapshot.tasks[0].streamId, 177);
    assert.equal(snapshot.tasks[0].revision, original.revision);
    assert.equal(snapshot.taskWorkstreams[0].id, 177);
    assert.equal(snapshot.taskWorkstreams[0].name, "Agentic pentesting");
    assert.deepEqual(stored(), before);
    assert.equal(
      service.createTask({ title: "Old client link", streamId: 136 }).task
        .streamId,
      177,
    );
    const changed = service.updateTask({
      id: original.id,
      revision: original.revision,
      status: "doing",
    }).task;
    assert.equal(changed.streamId, 177);
    assert.equal(changed.revision, original.revision + 1);
    // A split must keep the historical board. No majority or title guessing.
    db.exec(
      "UPDATE today_tasks SET stream_id=136; UPDATE analysis_members SET topic_id=178 WHERE version='new' AND chunk_id='b'",
    );
    assert.equal(service.listTasks().tasks[0].streamId, 136);
    db.exec(
      "DELETE FROM analysis_members WHERE version='new' AND chunk_id='b'",
    );
    assert.equal(
      service.listTasks().tasks[0].streamId,
      136,
      "missing membership is ambiguous",
    );
    db.exec(
      "UPDATE analysis_members SET topic_id=178 WHERE version='new'; UPDATE analysis_topics SET name='Other sessions' WHERE version='new' AND id=178",
    );
    assert.equal(service.listTasks().tasks[0].streamId, 136);
  } finally {
    db.close();
  }
});
