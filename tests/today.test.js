import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  initTodaySchema,
  createTodayService,
  saveTodayLayout,
} from "../server/today-store.js";
import { discoverToday, logStatus, attachSemantics } from "../server/today.js";
import { settleToday, familyOutline } from "../shared/today-layout.js";
import { initAnalysisSchema } from "../server/analysis-store.js";
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,provider TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT)",
  );
  initTodaySchema(db);
  initAnalysisSchema(db);
  return db;
}
test("family outline preserves nested delegation and folds shared history into the display family", () => {
  const sessions = ["root", "first", "nested", "branch"].map((id) => ({ id }));
  const edges = [
    { parent: "root", child: "first", kind: "delegated" },
    { parent: "first", child: "nested", kind: "spawned" },
    { parent: "root", child: "branch", kind: "shared_history" },
  ];
  assert.deepEqual(familyOutline(sessions, edges, "root"), [
    { id: "root", depth: 0, parent: null, kind: null },
    { id: "first", depth: 1, parent: "root", kind: "delegated" },
    { id: "nested", depth: 2, parent: "first", kind: "spawned" },
    { id: "branch", depth: 1, parent: "root", kind: "shared_history" },
  ]);
  const malformed = familyOutline(
    sessions,
    [
      ...edges,
      { parent: "nested", child: "root", kind: "spawned" },
      { parent: "missing", child: "branch", kind: "spawned" },
    ],
    "root",
  );
  assert.equal(malformed.length, sessions.length);
  assert.equal(new Set(malformed.map((r) => r.id)).size, sessions.length);
});
test("shared tasks preserve concurrent edits, validate fields and never follow turn completion", () => {
  const db = database(),
    a = createTodayService(db),
    b = createTodayService(db);
  const { task } = a.createTask({
    title: "Review",
    notes: "Context",
    sessions: ["codex:one"],
  });
  assert.equal(task.revision, 1);
  const next = b.updateTask({ id: task.id, revision: 1, status: "doing" }).task;
  assert.equal(next.revision, 2);
  assert.throws(
    () => a.updateTask({ id: task.id, revision: 1, status: "done" }),
    (e) => e.status === 409,
  );
  assert.equal(a.listTasks().tasks[0].status, "doing");
  a.reportSession({ session: "codex:one", provider: "codex", status: "done" });
  assert.equal(a.listTasks().tasks[0].status, "doing");
  assert.throws(() => a.createTask({ title: "  " }));
  assert.throws(() =>
    a.updateTask({ id: task.id, revision: 2, status: "running" }),
  );
  assert.throws(() =>
    a.createTask({ title: "x", sessions: ["x".repeat(201)] }),
  );
  db.close();
});
test("suspension persists, preserves task state, and blocks agent pickup and edits until the user resumes", () => {
  const db = database();
  try {
    const user = createTodayService(db, { actor: "user" });
    const ai = createTodayService(db, { actor: "ai" });
    const restricted = createTodayService(db, {
      actor: "ai",
      allowedProjects: ["other"],
    });
    const { task } = user.createTask({
      title: "Deferred work",
      project: "work",
      status: "doing",
      notes: "Keep context",
    });
    assert.equal(task.suspended, false);
    const held = user.updateTask({
      id: task.id,
      revision: task.revision,
      suspended: true,
    }).task;
    initTodaySchema(db);
    assert.equal(user.listTasks().tasks[0].suspended, true);
    assert.deepEqual(ai.listTasks().tasks, []);
    assert.equal(ai.listTasks({ includeSuspended: true }).tasks[0].id, task.id);
    assert.deepEqual(
      restricted.listTasks({ includeSuspended: true }).tasks,
      [],
    );
    for (const change of [
      { status: "doing" },
      { status: "done" },
      { suspended: false },
      { notes: "Agent edit" },
    ]) {
      assert.throws(
        () =>
          ai.updateTask({ id: task.id, revision: held.revision, ...change }),
        /suspended/,
      );
    }
    assert.throws(
      () => ai.deleteTask({ id: task.id, revision: held.revision }),
      /suspended/,
    );
    assert.throws(
      () =>
        user.updateTask({
          id: task.id,
          revision: task.revision,
          suspended: false,
        }),
      (e) => e.status === 409,
    );
    const resumed = user.updateTask({
      id: task.id,
      revision: held.revision,
      suspended: false,
    }).task;
    assert.equal(resumed.status, "doing");
    assert.equal(resumed.notes, "Keep context");
    assert.equal(ai.listTasks().tasks[0].suspended, false);
    assert.throws(
      () =>
        ai.updateTask({
          id: task.id,
          revision: resumed.revision,
          suspended: true,
        }),
      /Only the user/,
    );
    assert.equal(
      ai.updateTask({ id: task.id, revision: resumed.revision, status: "done" })
        .task.status,
      "done",
    );
  } finally {
    db.close();
  }
});

test("MCP project restrictions apply to tasks, linked sessions, and live reports", () => {
  const db = database();
  db.prepare("INSERT INTO chunks(id,session,project) VALUES(?,?,?)").run(
    "x",
    "private",
    "secret",
  );
  const all = createTodayService(db),
    limited = createTodayService(db, { allowedProjects: ["work"] }),
    empty = createTodayService(db, { allowedProjects: [] });
  all.createTask({ title: "Hidden", project: "secret" });
  assert.equal(limited.listTasks().tasks.length, 0);
  assert.equal(empty.listTasks().tasks.length, 0);
  assert.throws(
    () => limited.createTask({ title: "Bad", project: "secret" }),
    (e) => e.status === 403,
  );
  assert.throws(
    () =>
      limited.createTask({
        title: "Bad link",
        project: "work",
        sessions: ["private"],
      }),
    (e) => e.status === 403,
  );
  assert.throws(
    () =>
      limited.reportSession({
        session: "private",
        project: "work",
        provider: "claude",
        status: "running",
      }),
    (e) => e.status === 403,
  );
  const task = limited.createTask({ title: "Allowed", project: "work" }).task;
  assert.equal(limited.listTasks().tasks[0].id, task.id);
  assert.throws(
    () => empty.updateTask({ id: task.id, revision: 1, status: "done" }),
    (e) => e.status === 404,
  );
  db.close();
});
test("status distinguishes a pending question, answer, completion and stale activity", () => {
  const now = Date.now(),
    event = (type, offset = 0) => ({
      type: "event_msg",
      timestamp: new Date(now + offset).toISOString(),
      payload: { type },
    });
  let rows = [event("task_started", -1000)];
  assert.equal(logStatus(rows, "codex", now).status, "running");
  assert.equal(
    logStatus([event("task_started", -200000)], "codex", now).status,
    "unknown",
  );
  rows.push({
    type: "response_item",
    timestamp: new Date(now).toISOString(),
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: "a",
    },
  });
  assert.equal(logStatus(rows, "codex", now).status, "needs_input");
  rows.push({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "a" },
  });
  assert.equal(logStatus(rows, "codex", now).status, "running");
  rows.push(event("task_complete"));
  assert.equal(logStatus(rows, "codex", now).status, "done");
  assert.equal(logStatus([], "claude", now).status, "unknown");
});
test("discovery includes live sessions and native subagents without inventing project links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-today-"));
  try {
    const source = path.join(root, "projects"),
      project = path.join(source, "workspace");
    await mkdir(project, { recursive: true });
    const now = Date.now(),
      stamp = new Date(now).toISOString(),
      row = {
        type: "user",
        sessionId: "one",
        timestamp: stamp,
        cwd: "/tmp/project",
        message: { content: "Review scheduling" },
      };
    await writeFile(
      path.join(project, "one.jsonl"),
      JSON.stringify(row) +
        "\n" +
        JSON.stringify({
          type: "custom-title",
          customTitle: "Scheduling review",
        }) +
        "\n",
    );
    await writeFile(
      path.join(project, "two.jsonl"),
      JSON.stringify({ ...row, sessionId: "two" }) + "\n",
    );
    const childDir = path.join(project, "one", "subagents");
    await mkdir(childDir, { recursive: true });
    await writeFile(
      path.join(childDir, "agent-abc.jsonl"),
      JSON.stringify({ ...row, isSidechain: true }),
    );
    const data = await discoverToday(
      { source, codexSource: "" },
      { start: now - 10000, end: now + 10000, now },
    );
    assert.equal(data.sessions.length, 3);
    assert.equal(data.edges.length, 1);
    assert.equal(
      data.sessions.find((s) => s.id === "one:agent-abc").title,
      "Review scheduling",
    );
    assert.deepEqual(data.edges[0], {
      parent: "one",
      child: "one:agent-abc",
      kind: "spawned",
    });
    assert.ok(
      data.sessions.find((s) => s.id === "one").title.includes("Scheduling"),
    );
    assert.equal(
      data.sessions.find((s) => s.id === "one").inclusion,
      "User interaction today",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("settled layout is deterministic, finite, preserves saved positions and pins", () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      topic: { id: String(i % 5) },
    })),
    edges = [{ parent: "0", child: "1" }],
    semantic = [{ a: "0", b: "2", score: 0.9 }];
  const a = settleToday(sessions, edges, semantic),
    b = settleToday(sessions, edges, semantic);
  assert.deepEqual(a, b);
  assert.ok(a.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  const pinned = { id: "0", x: 150, y: 200, pinned: true };
  const next = settleToday([...sessions, { id: "new" }], edges, semantic, [
    pinned,
    ...a.slice(1),
  ]);
  assert.deepEqual(next[0], pinned);
  assert.deepEqual(
    next.find((p) => p.id === "20"),
    a[20],
  );
  const db = database();
  saveTodayLayout(db, { positions: next });
  assert.equal(
    db.prepare("SELECT pinned FROM today_card_layout WHERE session=?").get("0")
      .pinned,
    1,
  );
  assert.throws(() =>
    saveTodayLayout(db, {
      positions: [{ id: "x", x: NaN, y: 1, pinned: false }],
    }),
  );
  db.close();
});
test("Today does not invent another grouping from session vector similarity", () => {
  const db = database(),
    vec = (v) => Buffer.from(new Float32Array(v).buffer),
    put = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (const [sid, v, model] of [
    ["a", [1, 0], "current"],
    ["b", [1, 0], "current"],
    ["c", [0, 1], "current"],
    ["d", [1, 0], "old"],
  ])
    put.run(
      sid,
      sid,
      "same-project",
      "title",
      "claude",
      "user",
      new Date().toISOString(),
      "Substantive evidence " + sid,
      vec(v),
      model,
    );
  const sessions = ["a", "b", "c", "d"].map((id) => ({ id }));
  const result = attachSemantics(db, sessions, "current");
  assert.equal(result.semantic.length, 0);
  assert.equal(result.catalogueReady, false);
  assert.equal(result.topics.length, 0);
  db.close();
});

test("restricted clients cannot reveal a task linked to a private session or relabel a private heartbeat", () => {
  const db = database(),
    all = createTodayService(db),
    limited = createTodayService(db, { allowedProjects: ["work"] });
  db.prepare("INSERT INTO chunks(id,session,project) VALUES(?,?,?)").run(
    "x",
    "private",
    "secret",
  );
  const task = all.createTask({
    title: "Cross-project context",
    project: "work",
    sessions: ["private"],
  }).task;
  assert.equal(limited.listTasks().tasks.length, 0);
  assert.throws(
    () => limited.updateTask({ id: task.id, revision: 1, title: "overwrite" }),
    (e) => e.status === 404,
  );
  all.reportSession({
    session: "unindexed-private",
    provider: "claude",
    project: "secret",
    status: "running",
  });
  assert.throws(
    () =>
      limited.reportSession({
        session: "unindexed-private",
        provider: "claude",
        project: "work",
        status: "idle",
      }),
    (e) => e.status === 403,
  );
  db.close();
});

test("rooted card families keep unrelated rectangles separate and route links away from cards", async () => {
  const { CARD, cardBounds, routeTodayEdges, familyRoots } =
    await import("../shared/today-layout.js");
  const sessions = Array.from({ length: 18 }, (_, i) => ({ id: String(i) })),
    edges = Array.from({ length: 10 }, (_, i) => ({
      parent: "0",
      child: String(i + 1),
    }));
  edges.push({ parent: "1", child: "11" });
  const positions = settleToday(sessions, edges, []),
    forest = familyRoots(sessions, edges),
    byId = new Map(positions.map((p) => [p.id, p]));
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++) {
      const a = cardBounds(positions[i], !forest.parent.has(positions[i].id)),
        b = cardBounds(positions[j], !forest.parent.has(positions[j].id));
      assert.ok(
        a.right <= b.left ||
          b.right <= a.left ||
          a.bottom <= b.top ||
          b.bottom <= a.top,
        "Cards must not overlap",
      );
    }
  const routes = routeTodayEdges(sessions, edges, positions);
  assert.equal(routes.length, edges.length);
  for (const route of routes)
    for (const segment of route.segments)
      for (const p of positions) {
        if (p.id === route.parent || p.id === route.child) continue;
        const b = cardBounds(p, !forest.parent.has(p.id));
        const [x1, y1, x2, y2] = segment;
        const intersects =
          x1 === x2
            ? x1 > b.left &&
              x1 < b.right &&
              Math.max(y1, y2) > b.top &&
              Math.min(y1, y2) < b.bottom
            : y1 > b.top &&
              y1 < b.bottom &&
              Math.max(x1, x2) > b.left &&
              Math.min(x1, x2) < b.right;
        assert.ok(!intersects, "Link must not pass through another card");
      }
});

test("tasks use canonical stream IDs, preserve assignment on status edits, and support the All board", () => {
  const db = database();
  db.exec(
    "INSERT INTO analysis_runs VALUES('run','fingerprint','embed','generate','2026-10-29','{}'); INSERT INTO analysis_state VALUES('active','run'); INSERT INTO analysis_topics VALUES('run',1,'Release','Ship release','#fff',X'00000000'); INSERT INTO analysis_topics VALUES('run',2,'Atlas','Build Atlas','#fff',X'00000000');",
  );
  const service = createTodayService(db);
  const task = service.createTask({
    title: "Verify release",
    streamId: 1,
  }).task;
  assert.equal(task.streamId, 1);
  assert.equal(
    service.createTask({ title: "General reminder" }).task.streamId,
    null,
  );
  const moved = service.updateTask({
    id: task.id,
    revision: 1,
    status: "doing",
  }).task;
  assert.equal(moved.streamId, 1);
  const reassigned = service.updateTask({
    id: task.id,
    revision: 2,
    streamId: 2,
  }).task;
  assert.equal(reassigned.streamId, 2);
  assert.equal(
    service.updateTask({ id: task.id, revision: 3, streamId: null }).task
      .streamId,
    null,
  );
  assert.throws(
    () => service.createTask({ title: "Invalid", streamId: 999 }),
    (e) => e.status === 404,
  );
  assert.throws(() => service.createTask({ title: "Invalid", streamId: "1" }));
  db.close();
});
test("adding stream boards migrates existing tasks without changing their revisions", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE today_tasks(id TEXT PRIMARY KEY,title TEXT,notes TEXT,status TEXT,project TEXT,sessions TEXT,revision INTEGER,created TEXT,updated TEXT); INSERT INTO today_tasks VALUES('old','Keep this task','','todo','','[]',7,'2026-10-28','2026-10-28');",
  );
  initTodaySchema(db);
  const task = createTodayService(db).listTasks().tasks[0];
  assert.equal(task.title, "Keep this task");
  assert.equal(task.revision, 7);
  assert.equal(task.streamId, null);
  db.close();
});

test("task origin comes from the trusted creation channel and survives edits by another actor", () => {
  const db = database();
  try {
    const user = createTodayService(db, { actor: "user" });
    const ai = createTodayService(db, { actor: "ai" });
    const { task } = user.createTask({ title: "My request", createdBy: "ai" });
    assert.equal(task.createdBy, "user", "payload cannot spoof the channel");
    const changed = ai.updateTask({
      id: task.id,
      revision: 1,
      status: "doing",
      createdBy: "ai",
    }).task;
    assert.equal(
      changed.createdBy,
      "user",
      "editing does not change who created a task",
    );
    const suggested = ai.createTask({
      title: "Assistant follow-up",
      createdBy: "user",
    }).task;
    assert.equal(suggested.createdBy, "ai");
    assert.equal(
      createTodayService(db).createTask({ title: "Unattributed import" }).task
        .createdBy,
      "unknown",
    );
  } finally {
    db.close();
  }
});

test("origin migration leaves old tasks unattributed and preserves their data and revisions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE chunks(id TEXT,session TEXT,project TEXT); CREATE TABLE today_tasks(id TEXT PRIMARY KEY,title TEXT,notes TEXT,status TEXT,project TEXT,sessions TEXT,revision INTEGER,created TEXT,updated TEXT,stream_id INTEGER); INSERT INTO today_tasks VALUES('old','Original task','Keep these notes','doing','','[]',9,'2026-10-28','2026-10-29',null)",
    );
    initTodaySchema(db);
    initTodaySchema(db);
    const task = createTodayService(db).listTasks().tasks[0];
    assert.equal(task.createdBy, "unknown");
    assert.equal(task.createdSession, null);
    assert.equal(task.revision, 9);
    assert.equal(task.notes, "Keep these notes");
    assert.equal(task.status, "doing");
  } finally {
    db.close();
  }
});
test("creator-session provenance is immutable, scope checked and not supplied by task payloads", () => {
  const db = database();
  const admin = createTodayService(db);
  admin.reportSession({
    session: "codex:private",
    provider: "codex",
    project: "secret",
    status: "running",
  });
  const ai = createTodayService(db, {
    actor: "ai",
    creatorSession: "codex:private",
  });
  const task = ai.createTask({
    title: "Traceable",
    project: "work",
    createdSession: "spoof",
  }).task;
  assert.equal(task.createdSession, "codex:private");
  assert.equal(
    createTodayService(db, { allowedProjects: ["work"] }).listTasks().tasks
      .length,
    0,
  );
  assert.throws(
    () =>
      createTodayService(db, {
        allowedProjects: ["work"],
        creatorSession: "codex:private",
      }).createTask({ title: "Forbidden", project: "work" }),
    (e) => e.status === 403,
  );
  const changed = admin.updateTask({
    id: task.id,
    revision: 1,
    sessions: [],
    createdSession: "spoof",
  }).task;
  assert.equal(changed.createdSession, "codex:private");
  assert.equal(
    admin.createTask({ title: "No invented origin", createdSession: "spoof" })
      .task.createdSession,
    null,
  );
  db.close();
});

test("task pickup appends the trusted working session without erasing links or bypassing scope", () => {
  const db = database(),
    user = createTodayService(db);
  try {
    for (const [session, project] of [
      ["codex:working", "work"],
      ["codex:private", "secret"],
    ])
      user.reportSession({
        session,
        project,
        provider: "codex",
        status: "running",
      });
    const task = user.createTask({
      title: "User task",
      project: "work",
      sessions: ["codex:working"],
    }).task;
    const ai = createTodayService(db, {
      actor: "ai",
      workingSession: "codex:working",
      allowedProjects: ["work"],
    });
    const next = ai.updateTask({
      id: task.id,
      revision: 1,
      status: "doing",
    }).task;
    assert.deepEqual(next.sessions, ["codex:working"]);
    assert.equal(next.createdSession, null);
    assert.throws(
      () =>
        createTodayService(db, {
          actor: "ai",
          workingSession: "codex:private",
          allowedProjects: ["work"],
        }).updateTask({ id: task.id, revision: 2, status: "doing" }),
      (e) => e.status === 403,
    );
    assert.equal(user.listTasks().tasks[0].revision, 2);
    const edited = user.updateTask({
      id: task.id,
      revision: 2,
      sessions: [],
    }).task;
    assert.deepEqual(edited.sessions, [], "manual edits stay explicit");
  } finally {
    db.close();
  }
});

test("deletion requires a visible task and its current revision, and never deletes linked sessions", () => {
  const db = database(),
    user = createTodayService(db);
  try {
    user.reportSession({
      session: "codex:work",
      project: "work",
      provider: "codex",
      status: "running",
    });
    const task = user.createTask({
      title: "Remove me",
      project: "work",
      sessions: ["codex:work"],
    }).task;
    assert.throws(
      () =>
        createTodayService(db, { allowedProjects: ["elsewhere"] }).deleteTask({
          id: task.id,
          revision: 1,
        }),
      (e) => e.status === 404,
    );
    user.updateTask({ id: task.id, revision: 1, notes: "New edit" });
    assert.throws(
      () => user.deleteTask({ id: task.id, revision: 1 }),
      (e) => e.status === 409,
    );
    assert.equal(user.listTasks().tasks.length, 1);
    assert.deepEqual(user.deleteTask({ id: task.id, revision: 2 }), {
      deleted: true,
      id: task.id,
    });
    assert.equal(user.listTasks().tasks.length, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM today_events").get().n, 1);
  } finally {
    db.close();
  }
});
