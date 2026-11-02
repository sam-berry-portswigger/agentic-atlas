import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initTodaySchema, createTodayService } from "../server/today-store.js";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { pngImage } from "../server/task-images.js";
export const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
test("task PNGs persist atomically, list metadata only, enforce scope and preserve concurrent edits", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE chunks(session TEXT,project TEXT)");
  initTodaySchema(db);
  initAnalysisSchema(db);
  try {
    const all = createTodayService(db),
      restricted = createTodayService(db, { allowedProjects: ["other"] });
    const { task } = all.createTask({
      title: "Screenshot issue",
      project: "work",
      attachments: [{ name: "Screenshot.png", data: pixel }],
    });
    assert.equal(task.attachments.length, 1);
    assert.equal(task.attachments[0].data, undefined);
    const args = { taskId: task.id, attachmentId: task.attachments[0].id };
    assert.equal(all.readTaskImage(args).data, pixel);
    assert.equal(all.readTaskImage(args).mimeType, "image/png");
    assert.throws(
      () => restricted.readTaskImage(args),
      (e) => e.status === 404,
    );
    assert.deepEqual(restricted.listTasks().tasks, []);
    const updated = all.updateTask({
      id: task.id,
      revision: 1,
      status: "doing",
    }).task;
    assert.equal(
      updated.attachments.length,
      1,
      "MCP edits preserve omitted attachments",
    );
    assert.throws(
      () => all.updateTask({ id: task.id, revision: 1, attachments: [] }),
      (e) => e.status === 409,
    );
    assert.equal(all.readTaskImage(args).data, pixel);
    assert.throws(() =>
      all.createTask({
        title: "Bad image",
        attachments: [{ data: "not png" }],
      }),
    );
    assert.equal(all.listTasks().tasks.length, 1);
    const other = all.createTask({ title: "Another task" }).task;
    assert.throws(() =>
      all.updateTask({
        id: other.id,
        revision: 1,
        attachments: [{ id: args.attachmentId }],
      }),
    );
    assert.equal(
      all.listTasks().tasks.find((t) => t.id === other.id).revision,
      1,
    );
    all.deleteTask({ id: task.id, revision: updated.revision });
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM today_task_images").get().n,
      0,
    );
    assert.throws(
      () => all.readTaskImage(args),
      (e) => e.status === 404,
    );
    assert.throws(() =>
      pngImage(Buffer.from("<svg></svg>").toString("base64")),
    );
    assert.throws(() =>
      pngImage(Buffer.from(pixel, "base64").subarray(0, 40).toString("base64")),
    );
  } finally {
    db.close();
  }
});
