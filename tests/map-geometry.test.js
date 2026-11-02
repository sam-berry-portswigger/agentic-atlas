import test from "node:test";
import assert from "node:assert/strict";
import {
  mapTransform,
  topicRegions,
  insideRings,
} from "../shared/map-geometry.js";
import {
  normalizeProjection,
  projectionReference,
  projectionMetrics,
  chooseProjection,
  projectTopics,
} from "../server/projection.js";
test("normalization and viewport fitting preserve distances and inverse coordinates", () => {
  const normalized = normalizeProjection([
    [0, 0],
    [10, 0],
    [0, 5],
  ]);
  assert.equal(
    (normalized[1][0] - normalized[0][0]) /
      (normalized[2][1] - normalized[0][1]),
    2,
  );
  const points = normalized.map(([x, y]) => ({ x, y }));
  for (const size of [
    { w: 1500, h: 400 },
    { w: 400, h: 900 },
  ]) {
    const transform = mapTransform(points, size, { zoom: 1.7, x: 25, y: -12 });
    const p = transform.point(points[0]),
      q = transform.point(points[1]),
      r = transform.point(points[2]);
    assert.ok(
      Math.abs(
        Math.hypot(q.x - p.x, q.y - p.y) / Math.hypot(r.x - p.x, r.y - p.y) - 2,
      ) < 1e-9,
    );
    const inverse = transform.inverse(q.x, q.y);
    assert.ok(Math.abs(inverse.x - points[1].x) < 1e-9);
  }
});
test("regions remain disjoint, retain separated islands and are deterministic", () => {
  const point = (x, y, cluster) => ({
    x,
    y,
    cluster,
    color: "#aabbcc",
    topicName: "Topic " + cluster,
  });
  const points = [
    point(0, 0, 0),
    point(0.02, 0.01, 0),
    point(1, 0, 0),
    point(0.98, 0.02, 0),
    point(0.5, 0.5, 1),
    point(0.52, 0.5, 1),
  ];
  const regions = topicRegions(points, 60);
  assert.deepEqual(topicRegions(points, 60), regions);
  assert.equal(regions.length, 2);
  assert.ok(regions[0].rings.length >= 2);
  assert.ok(!insideRings({ x: 0.5, y: 0 }, regions[0].rings));
  for (const region of regions)
    assert.ok(insideRings(region.anchor, region.rings));
  for (let y = -0.1; y < 0.7; y += 0.02)
    for (let x = -0.1; x < 1.1; x += 0.02)
      assert.ok(
        regions.filter((region) => insideRings({ x, y }, region.rings))
          .length <= 1,
      );
  assert.deepEqual(topicRegions([]), []);
});
test("layout selection uses embedding fidelity independently of topic labels", () => {
  const baseline = {
      name: "base",
      metrics: { neighborRecall: 0.6, topicCohesion: 0.6 },
    },
    bad = {
      name: "bad",
      metrics: { neighborRecall: 0.3, topicCohesion: 0.99 },
    },
    good = {
      name: "good",
      metrics: { neighborRecall: 0.65, topicCohesion: 0.2 },
    };
  assert.equal(chooseProjection([baseline, bad, good]).name, "good");
  const vectors = [
      [1, 0],
      [0.99, 0.01],
      [0, 1],
      [0.01, 0.99],
    ],
    labels = [0, 0, 1, 1],
    reference = projectionReference(vectors, labels);
  const metrics = projectionMetrics(
    [
      [0, 0],
      [0.01, 0],
      [1, 1],
      [1, 1.01],
    ],
    reference,
  );
  assert.equal(metrics.neighborRecall, 1);
});

test("publishing a layout preserves topic identities and rolls back invalid coordinates", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { initAnalysisSchema } = await import("../server/analysis-store.js");
  const { publishProjection } = await import("../server/projection-store.js");
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  db.exec(
    "CREATE TABLE chunks(id TEXT,x REAL,y REAL);INSERT INTO chunks VALUES('a',0,0),('b',1,1);INSERT INTO analysis_state VALUES('active','v');INSERT INTO analysis_runs VALUES('v','fingerprint','embedding','generation','date','{}');INSERT INTO analysis_members VALUES('v','a',5,0,0),('v','b',5,1,1);",
  );
  db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
    "v",
    5,
    "Saved topic",
    "Description",
    "#aabbcc",
    new Uint8Array([0, 0, 0, 0]),
  );
  const result = {
    points: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    selected: "semantic-30",
    candidates: [],
  };
  publishProjection(db, "v", ["a", "b"], result);
  assert.equal(
    db.prepare("SELECT name FROM analysis_topics").get().name,
    "Saved topic",
  );
  assert.deepEqual(
    db
      .prepare("SELECT DISTINCT topic_id FROM analysis_members")
      .all()
      .map((row) => row.topic_id),
    [5],
  );
  assert.throws(
    () =>
      publishProjection(db, "v", ["a", "b"], {
        ...result,
        points: [
          [0.9, 0.9],
          [NaN, 0],
        ],
      }),
    /Invalid/,
  );
  assert.equal(
    db.prepare("SELECT x FROM analysis_members WHERE chunk_id='a'").get().x,
    0.1,
  );
  assert.throws(
    () => publishProjection(db, "old", ["a"], result),
    /active analysis changed/,
  );
  db.close();
});

test("projection positions are independent of topic assignments", async () => {
  const vectors = [
    [1, 0, 0],
    [0.99, 0.1, 0],
    [0, 1, 0],
    [0, 0.99, 0.1],
    [0, 0, 1],
    [0.1, 0, 0.99],
  ];
  const first = await projectTopics(vectors, [0, 0, 1, 1, 2, 2]);
  const recolored = await projectTopics(vectors, [2, 1, 0, 2, 1, 0]);
  assert.deepEqual(first.points, recolored.points);
  assert.equal(first.selected, "semantic-exact-100");
  assert.equal(first.candidates[0].metrics.samples, vectors.length);
  assert.ok(first.points.flat().every(Number.isFinite));
});
