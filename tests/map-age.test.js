import test from "node:test";
import assert from "node:assert/strict";
import { visibleAgeRange, ageOpacity } from "../shared/map-age.js";
test("older visible conversations fade progressively while the newest stays opaque", () => {
  const points = [
    { timestamp: "2026-10-01T00:00:00Z" },
    { timestamp: "2026-10-08T00:00:00Z" },
    { timestamp: "2026-10-15T00:00:00Z" },
  ];
  const range = visibleAgeRange(points);
  const opacity = points.map((point) => ageOpacity(point.timestamp, range));
  assert.ok(opacity[0] >= 0.2, "old points remain discoverable");
  assert.ok(opacity[0] < opacity[1] && opacity[1] < opacity[2]);
  assert.equal(opacity[2], 1);
  assert.deepEqual(
    visibleAgeRange([...points].reverse()),
    range,
    "fading is independent of rendering order",
  );
});
test("age fading handles a single date, missing dates, and dates outside the current range", () => {
  const range = visibleAgeRange([
    { timestamp: "2026-10-01" },
    { timestamp: "2026-10-15" },
    { timestamp: "" },
  ]);
  assert.ok(Number.isFinite(ageOpacity("", range)));
  assert.ok(ageOpacity("2020-01-01", range) > 0);
  assert.equal(ageOpacity("2030-01-01", range), 1);
  assert.equal(
    ageOpacity("2026-10-01", visibleAgeRange([{ timestamp: "2026-10-01" }])),
    1,
  );
  assert.equal(ageOpacity("2026-10-01", visibleAgeRange([])), 1);
});
