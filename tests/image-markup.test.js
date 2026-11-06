import test from "node:test";
import assert from "node:assert/strict";
import { imagePoint, arrowHead } from "../shared/image-markup.js";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { initTodaySchema, createTodayService } from "../server/today-store.js";

test("markup coordinates preserve image pixels across fit, zoom and scrolling, with out-of-image points clamped", () => {
  const image = { width: 3024, height: 1964 };
  // A point at the same original pixel location is unchanged after zoom/pan.
  assert.deepEqual(
    imagePoint(
      478,
      345.5,
      { left: 100, top: 100, width: 1512, height: 982 },
      image.width,
      image.height,
    ),
    [756, 491],
  );
  assert.deepEqual(
    imagePoint(
      512,
      782,
      { left: -1000, top: -200, width: 6048, height: 3928 },
      image.width,
      image.height,
    ),
    [756, 491],
  );
  assert.deepEqual(
    imagePoint(
      -100,
      -100,
      { left: 10, top: 10, width: 100, height: 100 },
      300,
      200,
    ),
    [0, 0],
  );
  assert.deepEqual(
    imagePoint(
      500,
      500,
      { left: 10, top: 10, width: 100, height: 100 },
      300,
      200,
    ),
    [300, 200],
  );
});

test("arrow heads point at the marked location in every direction without changing the stroke", () => {
  for (const end of [
    [100, 0],
    [-100, 0],
    [0, 100],
    [0, -100],
  ]) {
    const start = [0, 0],
      before = JSON.stringify([start, end]);
    const head = arrowHead(start, end, 20);
    assert.deepEqual(head[0], end);
    for (const point of head.slice(1)) {
      assert.ok(
        Math.abs(Math.hypot(point[0] - end[0], point[1] - end[1]) - 20) < 1e-8,
      );
      assert.ok(
        point[0] * end[0] + point[1] * end[1] < end[0] ** 2 + end[1] ** 2,
      );
    }
    assert.equal(JSON.stringify([start, end]), before);
  }
});

test("saving a marked-up copy keeps the original attachment and rejects competing saves without partial copies", () => {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  initTodaySchema(db);
  db.exec("CREATE TABLE chunks(session TEXT,project TEXT)");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
  try {
    const service = createTodayService(db, { actor: "user" });
    const original = service.createTask({
      title: "Review screenshot",
      attachments: [{ name: "Original.png", data: png }],
    }).task;
    const first = original.attachments[0];
    const saved = service.updateTask({
      id: original.id,
      revision: original.revision,
      attachments: [
        { id: first.id },
        { name: "Original annotated.png", data: png },
      ],
    }).task;
    assert.equal(saved.attachments.length, 2);
    assert.equal(saved.attachments[0].id, first.id);
    assert.equal(saved.attachments[1].name, "Original annotated.png");
    assert.equal(
      service.readTaskImage({ taskId: original.id, attachmentId: first.id })
        .data,
      png,
    );
    assert.throws(
      () =>
        service.updateTask({
          id: original.id,
          revision: original.revision,
          attachments: [
            { id: first.id },
            { name: "Conflicting annotated.png", data: png },
          ],
        }),
      { status: 409 },
    );
    assert.equal(service.listTasks().tasks[0].attachments.length, 2);
    assert.equal(
      db.prepare("SELECT count(*) n FROM today_task_images").get().n,
      2,
    );
  } finally {
    db.close();
  }
});
