export function visibleAgeRange(points) {
  let oldest = Infinity,
    newest = -Infinity;
  for (const point of points) {
    const time = Date.parse(point.timestamp);
    if (Number.isFinite(time)) {
      oldest = Math.min(oldest, time);
      newest = Math.max(newest, time);
    }
  }
  return { oldest, newest };
}
export function ageOpacity(timestamp, range) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 0.4;
  if (
    !Number.isFinite(range.oldest) ||
    !Number.isFinite(range.newest) ||
    range.newest <= range.oldest
  )
    return 1;
  const position = Math.max(
    0,
    Math.min(1, (time - range.oldest) / (range.newest - range.oldest)),
  );
  return 0.22 + 0.78 * position;
}
