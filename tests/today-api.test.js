import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initTodaySchema } from "../server/today-store.js";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { mountToday } from "../server/today.js";
test("Today API does not re-add rewound logs from indexed history or old heartbeats", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,provider TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT)",
  );
  initTodaySchema(db);
  initAnalysisSchema(db);
  const now = Date.now(),
    stamp = new Date(now).toISOString(),
    start = new Date(now - 60000).toISOString(),
    end = new Date(now + 60000).toISOString();
  for (const id of ["discarded", "indexed-only"])
    db.prepare(
      "INSERT INTO chunks(id,session,project,title,provider,role,timestamp,text) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      id,
      id,
      "project",
      "Review",
      "claude",
      "user",
      stamp,
      "Review release",
    );
  db.prepare("INSERT INTO today_events VALUES(?,?,?)").run(
    "discarded",
    JSON.stringify({
      session: "discarded",
      provider: "claude",
      status: "running",
    }),
    stamp,
  );
  const routes = new Map(),
    app = {
      use() {},
      post() {},
      get(route, handler) {
        routes.set(route, handler);
      },
    };
  mountToday(app, db, {
    discover: async () => ({
      sessions: [
        {
          id: "current",
          provider: "claude",
          title: "Release review",
          updated: stamp,
          status: "done",
        },
      ],
      edges: [],
      rewoundSessions: ["discarded"],
    }),
  });
  try {
    let result;
    await routes.get("/api/today")(
      { query: { start, end } },
      {
        json(value) {
          result = value;
        },
      },
      (error) => {
        throw error;
      },
    );
    assert.deepEqual(
      new Set(result.sessions.map((s) => s.id)),
      new Set(["current", "indexed-only"]),
    );
    assert.equal(
      result.sessions.find((s) => s.id === "current").status,
      "done",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM chunks WHERE session='discarded'")
        .get().n,
      1,
      "original evidence is retained",
    );
    assert.equal(result.rewoundSessions, undefined);
  } finally {
    db.close();
  }
});
test("Today HTTP API persists tasks and layout, returns conflicts and expires agent heartbeats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-today-api-")),
    db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,provider TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT)",
  );
  initTodaySchema(db);
  initAnalysisSchema(db);
  db.prepare("INSERT INTO settings VALUES(?,?)").run(
    "source",
    JSON.stringify(root),
  );
  db.prepare("INSERT INTO settings VALUES(?,?)").run("codexSource", '""');
  const app = express();
  app.use(express.json());
  mountToday(app, db);
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (route, body) =>
    fetch(base + "/api/today/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("tasks/create", {})).status, 400);
    assert.equal(
      (
        await fetch(base + "/api/today/tasks/create", {
          method: "POST",
          body: "title=x",
        })
      ).status,
      415,
    );
    const { task } = await (
      await post("tasks/create", { title: "Shared step" })
    ).json();
    assert.equal(
      task.createdBy,
      "user",
      "browser task creation records user origin",
    );
    assert.equal(
      (
        await post("tasks/update", {
          id: task.id,
          revision: 1,
          status: "doing",
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("tasks/update", { id: task.id, revision: 1, status: "done" }))
        .status,
      409,
    );
    assert.equal(
      (
        await post("layout", {
          positions: [{ id: "codex:one", x: 100, y: 200, pinned: true }],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post("session", {
          session: "codex:one",
          provider: "codex",
          title: "Live agent",
          status: "running",
        })
      ).status,
      200,
    );
    const now = new Date(),
      start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      ).toISOString(),
      end = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      ).toISOString(),
      url = base + "/api/today?" + new URLSearchParams({ start, end });
    let data = await (await fetch(url)).json();
    assert.equal(data.tasks[0].status, "doing");
    assert.equal(data.sessions[0].status, "running");
    assert.equal(data.positions[0].pinned, true);
    assert.equal(
      (await post("sessions/rename", { session: "missing", title: "Unknown" }))
        .status,
      404,
    );
    assert.equal(
      (await post("sessions/rename", { session: "codex:one", title: " " }))
        .status,
      400,
    );
    assert.equal(
      (
        await post("sessions/rename", {
          session: "codex:one",
          title: "Review session activity",
        })
      ).status,
      200,
    );
    const renamed = await (await fetch(url)).json();
    assert.equal(renamed.sessions[0].title, "Review session activity");
    assert.equal(renamed.sessions[0].originalTitle, "Live agent");
    assert.equal(
      (
        await post("visibility", {
          kind: "session",
          id: "codex:one",
          hidden: true,
          label: "Live agent",
        })
      ).status,
      200,
    );
    data = await (await fetch(url)).json();
    assert.equal(data.visibility[0].id, "codex:one");
    assert.equal(data.sessions[0].status, "running");
    assert.equal(
      (
        await post("visibility", {
          kind: "stream",
          id: "1",
          hidden: true,
          label: "Release",
        })
      ).status,
      200,
    );
    data = await (await fetch(url)).json();
    assert.equal(data.visibility.length, 2);
    assert.equal(
      (await post("visibility", { kind: "stream", id: "1", hidden: false }))
        .status,
      200,
    );
    assert.equal(
      (
        await post("visibility", {
          kind: "session",
          id: "codex:one",
          hidden: false,
        })
      ).status,
      200,
    );
    assert.equal((await (await fetch(url)).json()).visibility.length, 0);
    assert.equal(
      (await post("visibility", { kind: "stream", id: "x", hidden: true }))
        .status,
      400,
    );

    db.prepare("UPDATE today_events SET updated=?").run(
      new Date(Date.now() - 181000).toISOString(),
    );
    data = await (await fetch(url)).json();
    assert.equal(data.sessions[0].status, "unknown");
    assert.equal(
      (await fetch(base + "/api/today?start=bad&end=bad")).status,
      400,
    );
    assert.equal(
      (await post("tasks/delete", { id: task.id, revision: 1 })).status,
      409,
    );
    assert.equal(
      (await post("tasks/delete", { id: task.id, revision: 2 })).status,
      200,
    );
    assert.equal((await (await post("tasks/list", {})).json()).tasks.length, 0);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
