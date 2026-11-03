import { atlasSkill } from "../shared/atlas-skill.js";
import { searchWorkflow } from "../shared/atlas-search-workflow.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { createTodayService } from "../server/today-store.js";
test("Today MCP tools share persisted tasks across clients, reject stale revisions and enforce project scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-today-mcp-")),
    clients = [];
  async function connect(projects) {
    const client = new Client({ name: "today-test", version: "1" }),
      env = { ...process.env, ATLAS_DATA_DIR: root };
    if (projects === null) delete env.ATLAS_MCP_PROJECTS;
    else env.ATLAS_MCP_PROJECTS = JSON.stringify(projects);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../server/mcp.js", import.meta.url))],
      env,
      stderr: "pipe",
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  const call = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return r.structuredContent;
  };
  try {
    const a = await connect(null),
      b = await connect(["work"]);
    assert.match(
      a.getInstructions(),
      /proactively during substantive user-requested work/,
    );
    assert.match(a.getInstructions(), /latest revision/);
    assert.ok(a.getInstructions().includes(searchWorkflow));
    assert.ok(atlasSkill().includes(searchWorkflow));
    assert.match(a.getInstructions(), /do not fabricate one/);
    const { task } = await call(a, "atlas_create_task", {
      title: "Shared context",
      project: "work",
    });
    assert.equal(
      task.createdBy,
      "ai",
      "MCP tasks record AI origin without an extra tool argument",
    );
    const list = await call(b, "atlas_tasks");
    assert.equal(list.tasks[0].id, task.id);
    await call(b, "atlas_update_task", {
      id: task.id,
      revision: 1,
      status: "doing",
    });
    const stale = await a.callTool({
      name: "atlas_update_task",
      arguments: { id: task.id, revision: 1, status: "done" },
    });
    assert.ok(stale.isError);
    assert.equal((await call(a, "atlas_tasks")).tasks[0].status, "doing");
    const report = await call(b, "atlas_report_session", {
      session: "codex:known-id",
      project: "work",
      provider: "codex",
      status: "needs_input",
      title: "Needs a decision",
    });
    assert.ok(Date.parse(report.expiresAt) > Date.now());
    const pickedUp = (
      await call(b, "atlas_update_task", {
        id: task.id,
        revision: 2,
        status: "doing",
      })
    ).task;
    assert.deepEqual(pickedUp.sessions, ["codex:known-id"]);
    assert.equal(
      pickedUp.createdSession,
      null,
      "pickup must not invent a creator",
    );
    const created = (
      await call(b, "atlas_create_task", {
        title: "Traceable task",
        project: "work",
      })
    ).task;
    assert.equal(created.createdSession, "codex:known-id");
    await call(b, "atlas_report_session", {
      session: "codex:second-chat",
      project: "work",
      provider: "codex",
      status: "running",
    });
    const ambiguous = (
      await call(b, "atlas_create_task", {
        title: "No guessed chat",
        project: "work",
      })
    ).task;
    assert.equal(
      ambiguous.createdSession,
      null,
      "shared connections must not use another chat's last heartbeat",
    );
    const explicit = (
      await call(b, "atlas_create_task", {
        title: "Explicit creating chat",
        project: "work",
        session: "codex:known-id",
      })
    ).task;
    assert.equal(explicit.createdSession, "codex:known-id");
    const explicitPickup = (
      await call(b, "atlas_update_task", {
        id: ambiguous.id,
        revision: ambiguous.revision,
        status: "doing",
        session: "codex:second-chat",
      })
    ).task;
    assert.deepEqual(explicitPickup.sessions, ["codex:second-chat"]);
    const ambiguousPickup = (
      await call(b, "atlas_update_task", {
        id: explicit.id,
        revision: explicit.revision,
        status: "doing",
      })
    ).task;
    assert.deepEqual(
      ambiguousPickup.sessions,
      [],
      "shared connection pickup must not guess a chat",
    );
    const updated = (
      await call(a, "atlas_update_task", {
        id: created.id,
        revision: created.revision,
        sessions: [],
        notes: "Handover",
      })
    ).task;
    assert.equal(
      updated.createdSession,
      "codex:known-id",
      "edits cannot erase creator provenance",
    );
    const unknown = await b.callTool({
      name: "atlas_create_task",
      arguments: {
        title: "Not reported",
        project: "work",
        session: "codex:not-reported",
      },
    });
    assert.ok(unknown.isError);
    const denied = await b.callTool({
      name: "atlas_create_task",
      arguments: { title: "No access", project: "secret" },
    });
    assert.ok(denied.isError);
    const empty = await connect([]);
    assert.equal((await call(empty, "atlas_tasks")).tasks.length, 0);
    const db = new DatabaseSync(path.join(root, "atlas.sqlite"));
    try {
      const user = createTodayService(db, { actor: "user" });
      const held = user.updateTask({
        id: updated.id,
        revision: updated.revision,
        suspended: true,
      }).task;
      assert.ok(
        !(await call(b, "atlas_tasks")).tasks.some((t) => t.id === held.id),
      );
      assert.ok(
        (await call(b, "atlas_tasks", { includeSuspended: true })).tasks.some(
          (t) => t.id === held.id && t.suspended,
        ),
      );
      assert.equal(
        (await call(empty, "atlas_tasks", { includeSuspended: true })).tasks
          .length,
        0,
      );
      const pickup = await b.callTool({
        name: "atlas_update_task",
        arguments: {
          id: held.id,
          revision: held.revision,
          status: "doing",
          session: "codex:known-id",
        },
      });
      assert.ok(pickup.isError);
      user.updateTask({
        id: held.id,
        revision: held.revision,
        suspended: false,
      });
      assert.ok(
        (await call(b, "atlas_tasks")).tasks.some((t) => t.id === held.id),
      );
    } finally {
      db.close();
    }
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await rm(root, { recursive: true, force: true });
  }
});
