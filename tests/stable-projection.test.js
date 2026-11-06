import test from "node:test";
import assert from "node:assert/strict";
import { extendProjection } from "../server/stable-projection.js";

test("new sessions are placed by saved evidence without moving or normalizing old points", () => {
  const anchors = [
    { id: "a", vector: [1, 0], x: 0.2, y: 0.3 },
    { id: "b", vector: [0, 1], x: 0.8, y: 0.7 },
  ];
  const rows = [...anchors, { id: "new", vector: [1, 0], x: null, y: null }];
  const points = extendProjection(rows);
  assert.deepEqual(points.slice(0, 2), [
    [0.2, 0.3],
    [0.8, 0.7],
  ]);
  assert.ok(Math.hypot(points[2][0] - 0.2, points[2][1] - 0.3) < 0.02);
  assert.deepEqual(extendProjection(rows), points);
  assert.deepEqual(extendProjection([...rows].reverse()).reverse(), points);
  assert.ok(points.every((p) => p.every(Number.isFinite)));
  assert.equal(rows[2].x, null);
});
test("a saved map is required before incremental placement", () => {
  assert.throws(
    () => extendProjection([{ id: "new", vector: [1, 0], x: null, y: null }]),
    /saved map/,
  );
});

test("a one-point map keeps its anchor and gives a new conversation a visible distinct position", () => {
  const points = extendProjection([
    { id: "a", vector: [1, 0], x: 0.5, y: 0.5 },
    { id: "new", vector: [1, 0], x: null, y: null },
  ]);
  assert.deepEqual(points[0], [0.5, 0.5]);
  assert.notDeepEqual(points[1], points[0]);
  assert.ok(Math.hypot(points[1][0] - 0.5, points[1][1] - 0.5) < 0.02);
});
