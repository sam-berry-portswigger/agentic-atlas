export function mapBounds(points) {
  if (!points.length) return { cx: 0.5, cy: 0.5, width: 1, height: 1, span: 1 };
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  return {
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
    span: Math.max(right - left, bottom - top) || 1,
  };
}
export function mapTransform(points, size, view = { zoom: 1, x: 0, y: 0 }) {
  const bounds = mapBounds(points),
    scale =
      Math.max(
        1,
        Math.min(
          Math.max(1, size.w - 150) /
            Math.max(bounds.width, bounds.span * 0.05),
          Math.max(1, size.h - 110) /
            Math.max(bounds.height, bounds.span * 0.05),
        ),
      ) * view.zoom;
  return {
    scale,
    point: (p) => ({
      x: (p.x - bounds.cx) * scale + size.w / 2 + view.x,
      y: (p.y - bounds.cy) * scale + size.h / 2 + view.y,
    }),
    inverse: (x, y) => ({
      x: (x - size.w / 2 - view.x) / scale + bounds.cx,
      y: (y - size.h / 2 - view.y) / scale + bounds.cy,
    }),
  };
}
export function insideRings(point, rings) {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  return inside;
}
// A bounded nearest-site field gives topics non-overlapping outlines. Empty
// space remains empty; disconnected components remain separate islands.
export function topicRegions(points, resolution = 90) {
  if (!points.length) return [];
  const b = mapBounds(points),
    step = b.span / (resolution - 10),
    left = b.cx - b.span / 2 - step * 5,
    top = b.cy - b.span / 2 - step * 5,
    n = resolution;
  const sites = points.map((p) => ({
    ...p,
    gx: (p.x - left) / step,
    gy: (p.y - top) / step,
  }));
  const grid = new Int32Array(n * n).fill(-1),
    topics = [...new Set(points.map((p) => p.cluster))].sort((a, b) => a - b),
    lookup = new Map(topics.map((id, i) => [id, i]));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let best = Infinity,
        topic = -1;
      for (const p of sites) {
        const d = (p.gx - x - 0.5) ** 2 + (p.gy - y - 0.5) ** 2;
        if (d < best) {
          best = d;
          topic = lookup.get(p.cluster);
        }
      }
      if (best <= 25) grid[y * n + x] = topic;
    }
  // Remove single-cell noise without expanding outlines into unsupported space.
  for (let pass = 0; pass < 2; pass++) {
    const copy = grid.slice();
    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        if (grid[i] < 0) continue;
        const counts = new Map();
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const label = grid[(y + dy) * n + x + dx];
            if (label >= 0) counts.set(label, (counts.get(label) || 0) + 1);
          }
        const winner = [...counts].sort(
          (a, b) => b[1] - a[1] || a[0] - b[0],
        )[0];
        if (winner && winner[1] >= 6) copy[i] = winner[0];
      }
    grid.set(copy);
  }
  const regions = [];
  topics.forEach((cluster, label) => {
    const edges = new Map();
    const key = (x, y) => `${x},${y}`;
    const add = (x, y, xx, yy) => {
      const k = key(x, y);
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push([xx, yy]);
    };
    const center = {
      x: membersCenter(
        points.filter((p) => p.cluster === cluster),
        "x",
      ),
      y: membersCenter(
        points.filter((p) => p.cluster === cluster),
        "y",
      ),
    };
    let anchor = null,
      best = -1,
      bestDistance = Infinity,
      cells = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (grid[y * n + x] !== label) continue;
        cells++;
        let clearance = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            if (
              x + dx >= 0 &&
              y + dy >= 0 &&
              x + dx < n &&
              y + dy < n &&
              grid[(y + dy) * n + x + dx] === label
            )
              clearance++;
        const candidate = {
            x: left + (x + 0.5) * step,
            y: top + (y + 0.5) * step,
          },
          distance =
            (candidate.x - center.x) ** 2 + (candidate.y - center.y) ** 2;
        if (
          clearance > best ||
          (clearance === best && distance < bestDistance)
        ) {
          bestDistance = distance;
          best = clearance;
          anchor = { x: left + (x + 0.5) * step, y: top + (y + 0.5) * step };
        }
        if (y === 0 || grid[(y - 1) * n + x] !== label) add(x, y, x + 1, y);
        if (x === n - 1 || grid[y * n + x + 1] !== label)
          add(x + 1, y, x + 1, y + 1);
        if (y === n - 1 || grid[(y + 1) * n + x] !== label)
          add(x + 1, y + 1, x, y + 1);
        if (x === 0 || grid[y * n + x - 1] !== label) add(x, y + 1, x, y);
      }
    const rings = [];
    while (edges.size) {
      const start = edges.keys().next().value;
      let current = start,
        ring = [];
      for (let guard = 0; guard < n * n * 4; guard++) {
        const [x, y] = current.split(",").map(Number);
        ring.push({ x: left + x * step, y: top + y * step });
        const links = edges.get(current);
        if (!links?.length) break;
        const next = links.pop();
        if (!links.length) edges.delete(current);
        current = key(...next);
        if (current === start) break;
      }
      if (ring.length >= 4) rings.push(ring);
    }
    const members = points.filter((p) => p.cluster === cluster);
    if (rings.length)
      regions.push({
        cluster,
        rings,
        anchor,
        cells,
        points: members,
        color: members[0].color,
        name: members[0].topicName,
      });
  });
  return regions;
}

function membersCenter(points, axis) {
  return (
    points.reduce((sum, point) => sum + point[axis], 0) /
    Math.max(1, points.length)
  );
}
