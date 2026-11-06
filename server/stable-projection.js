import { createHash } from "node:crypto";
import { cosine } from "./db.js";

// Extend the saved map, never refit it. New points use nearby saved evidence;
// their small deterministic offset keeps identical vectors individually visible.
export function extendProjection(rows) {
  const anchors = rows.filter(
    (r) => Number.isFinite(r.x) && Number.isFinite(r.y),
  );
  if (!anchors.length)
    throw Error("A saved map is required for incremental placement.");
  const xs = anchors.map((r) => r.x),
    ys = anchors.map((r) => r.y);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  const radius = Math.min(
    0.012,
    Math.max(0.2, right - left, bottom - top) * 0.015,
  );
  const minX = left === right ? Math.max(0, left - 0.02) : left;
  const maxX = left === right ? Math.min(1, right + 0.02) : right;
  const minY = top === bottom ? Math.max(0, top - 0.02) : top;
  const maxY = top === bottom ? Math.min(1, bottom + 0.02) : bottom;
  return rows.map((row) => {
    if (Number.isFinite(row.x) && Number.isFinite(row.y)) return [row.x, row.y];
    const nearest = anchors
      .map((a) => ({ a, score: cosine(row.vector, a.vector) }))
      .sort((a, b) => b.score - a.score || a.a.id.localeCompare(b.a.id))[0].a;
    const hash = createHash("sha256").update(row.id).digest();
    const angle = (hash.readUInt32BE(0) / 0x100000000) * Math.PI * 2;
    const offset = radius * (0.4 + (hash.readUInt32BE(4) / 0x100000000) * 0.6);
    const place = (direction) => [
      Math.max(
        minX,
        Math.min(maxX, nearest.x + Math.cos(angle) * offset * direction),
      ),
      Math.max(
        minY,
        Math.min(maxY, nearest.y + Math.sin(angle) * offset * direction),
      ),
    ];
    const point = place(1);
    return point[0] === nearest.x && point[1] === nearest.y ? place(-1) : point;
  });
}
