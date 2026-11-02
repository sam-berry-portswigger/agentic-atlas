import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initTodaySchema, createTodayService } from "../server/today-store.js";
import { initAnalysisSchema } from "../server/analysis-store.js";
test("MCP delivers task PNGs as image blocks and denies out-of-scope image reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-images-mcp-")),
    clients = [];
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
  const db = new DatabaseSync(path.join(root, "atlas.sqlite"));
  db.exec(
    "CREATE TABLE chunks(id TEXT PRIMARY KEY,file TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
  );
  initTodaySchema(db);
  initAnalysisSchema(db);
  const { task } = createTodayService(db).createTask({
    title: "PNG evidence",
    project: "work",
    attachments: [{ name: "Screenshot.png", data: png }],
  });
  db.close();
  async function connect(project) {
    const client = new Client({ name: "image-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../server/mcp.js", import.meta.url))],
        env: {
          ...process.env,
          ATLAS_DATA_DIR: root,
          ATLAS_MCP_PROJECTS: JSON.stringify([project]),
        },
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  }
  try {
    const allowed = await connect("work"),
      denied = await connect("other");
    const args = { taskId: task.id, attachmentId: task.attachments[0].id };
    const list = await allowed.callTool({ name: "atlas_tasks", arguments: {} });
    assert.equal(
      list.structuredContent.tasks[0].attachments[0].id,
      args.attachmentId,
    );
    const result = await allowed.callTool({
      name: "atlas_task_image",
      arguments: args,
    });
    assert.ok(!result.isError);
    assert.deepEqual(result.content, [
      { type: "image", mimeType: "image/png", data: png },
    ]);
    assert.equal(result.structuredContent.data, undefined);
    assert.ok(
      (await denied.callTool({ name: "atlas_task_image", arguments: args }))
        .isError,
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await rm(root, { recursive: true, force: true });
  }
});
