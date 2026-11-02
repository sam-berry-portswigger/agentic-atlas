// Rooted spring layout: cards keep their own space, and springs move whole families.
export const CARD = {
  width: 280,
  height: 190,
  rootWidth: 300,
  rootHeight: 200,
  gap: 110,
  rowGap: 48,
};
export function hashUnit(value) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}
// Recorded delegation remains distinct from fork/shared-history provenance.
// Display families below can include both without changing native parenthood.
export function isFamilyEdge(edge) {
  return edge.kind !== "shared_history" && edge.kind !== "forked";
}
export function familyRoots(sessions, edges) {
  const ids = new Set(sessions.map((s) => s.id)),
    byId = new Map(sessions.map((s) => [s.id, s])),
    parent = new Map(),
    componentTopics = new Map(
      sessions.filter((s) => s.topic).map((s) => [s.id, String(s.topic.id)]),
    );
  const sameTopic = (a, b) =>
    !(
      byId.get(a)?.topic &&
      byId.get(b)?.topic &&
      byId.get(a).topic.id !== byId.get(b).topic.id
    );
  function connect(a, b) {
    if (
      ids.has(a) &&
      ids.has(b) &&
      sameTopic(a, b) &&
      a !== b &&
      !parent.has(b)
    ) {
      let p = a,
        seen = new Set([b]);
      while (p && !seen.has(p)) {
        seen.add(p);
        p = parent.get(p);
      }
      if (!p) {
        const aRoot = root(a),
          bRoot = root(b),
          aTopic = componentTopics.get(aRoot),
          bTopic = componentTopics.get(bRoot);
        // Unassigned chats can join a named family, but cannot bridge two
        // families whose published work-stream assignments disagree.
        if (aTopic && bTopic && aTopic !== bTopic) return;
        parent.set(b, a);
        if (aTopic || bTopic) componentTopics.set(aRoot, aTopic || bTopic);
      }
    }
  }
  const root = (id) => {
    const seen = new Set();
    while (parent.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parent.get(id);
    }
    return id;
  };
  // Native delegation and recorded fork direction take precedence. Only a
  // fork's incoming display connection is detached, retaining its own agents.
  for (const e of edges.filter(isFamilyEdge)) connect(e.parent, e.child);
  for (const e of edges.filter((e) => e.kind === "forked"))
    if (!byId.get(e.child)?.familyDetached) connect(e.parent, e.child);
  // Shared history has no native parent direction. Its discovery anchor can
  // change as a chat grows; remove detached roots from the display component,
  // so an anchor change cannot absorb their former family into a detached card.
  const history = new Map();
  const historyRoot = (id) => {
    if (!history.has(id)) history.set(id, id);
    let p = id;
    while (history.get(p) !== p) p = history.get(p);
    while (id !== p) {
      const next = history.get(id);
      history.set(id, p);
      id = next;
    }
    return p;
  };
  const related = edges.filter(
    (e) =>
      e.kind === "shared_history" &&
      ids.has(e.parent) &&
      ids.has(e.child) &&
      sameTopic(e.parent, e.child),
  );
  for (const e of related)
    history.set(historyRoot(e.child), historyRoot(e.parent));
  const components = new Map();
  for (const id of history.keys()) {
    const r = historyRoot(id),
      current = root(id);
    if (byId.get(current)?.familyDetached) continue;
    if (!components.has(r)) components.set(r, new Set());
    components.get(r).add(current);
  }
  const preferred = new Map();
  for (const edge of related) {
    const component = historyRoot(edge.parent),
      candidate = root(edge.parent);
    if (!preferred.has(component) && components.get(component)?.has(candidate))
      preferred.set(component, candidate);
  }
  for (const [component, members] of components) {
    const choices = [...members];
    const anchor = preferred.get(component) || choices[0];
    for (const id of choices) if (id !== anchor) connect(anchor, id);
  }
  return { parent, root, roots: sessions.filter((s) => !parent.has(s.id)) };
}
// A readable outline uses the same recorded parent relationships as the tree.
export function familyOutline(sessions, edges, rootId) {
  const forest = familyRoots(sessions, edges);
  const children = new Map();
  for (const session of sessions) {
    const parent = forest.parent.get(session.id);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(session.id);
  }
  const rows = [],
    seen = new Set();
  function visit(id, depth) {
    if (seen.has(id) || !sessions.some((s) => s.id === id)) return;
    seen.add(id);
    const parent = forest.parent.get(id) ?? null;
    rows.push({
      id,
      depth,
      parent,
      kind:
        edges.find((e) => e.parent === parent && e.child === id)?.kind ??
        (parent ? "shared_history" : null),
    });
    for (const child of children.get(id) || []) visit(child, depth + 1);
  }
  visit(rootId, 0);
  // Keep any orphaned records accessible without claiming a new parent link.
  for (const session of sessions)
    if (!seen.has(session.id)) visit(session.id, 0);
  return rows;
}
export function settleToday(sessions, edges, semantic, saved = []) {
  const { parent, root, roots } = familyRoots(sessions, edges),
    children = new Map();
  for (const [c, p] of parent) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(c);
  }
  const old = new Map(saved.map((p) => [p.id, p])),
    positions = [],
    components = [];
  function span(id) {
    const cs = children.get(id) || [];
    return Math.max(
      CARD.height + CARD.rowGap,
      cs.reduce((n, c) => n + span(c), 0),
    );
  }
  function branch(id, x, y, side, local) {
    local.push({ id, x, y, pinned: false, root: root(id) });
    const cs = children.get(id) || [];
    let cursor = y - cs.reduce((n, c) => n + span(c), 0) / 2;
    for (const c of cs) {
      const size = span(c);
      branch(
        c,
        x + side * (CARD.width + CARD.gap),
        cursor + size / 2,
        side,
        local,
      );
      cursor += size;
    }
  }
  roots.forEach((s, index) => {
    const local = [
        {
          id: s.id,
          x: 0,
          y: 0,
          pinned: old.get(s.id)?.pinned || false,
          root: s.id,
        },
      ],
      left = [],
      right = [];
    let lh = 0,
      rh = 0;
    for (const c of children.get(s.id) || []) {
      const height = span(c);
      if (lh < rh) {
        left.push(c);
        lh += height;
      } else {
        right.push(c);
        rh += height;
      }
    }
    for (const [side, cs] of [
      [-1, left],
      [1, right],
    ]) {
      let cursor = -cs.reduce((n, c) => n + span(c), 0) / 2;
      for (const c of cs) {
        const height = span(c);
        branch(
          c,
          side * (CARD.width + CARD.gap),
          cursor + height / 2,
          side,
          local,
        );
        cursor += height;
      }
    }
    const minX = Math.min(...local.map((p) => p.x - CARD.rootWidth / 2)) - 60,
      maxX = Math.max(...local.map((p) => p.x + CARD.rootWidth / 2)) + 60,
      minY = Math.min(...local.map((p) => p.y - CARD.rootHeight / 2)) - 70,
      maxY = Math.max(...local.map((p) => p.y + CARD.rootHeight / 2)) + 70;
    const savedRoot = old.get(s.id),
      angle = index * 2.399;
    components.push({
      id: s.id,
      local,
      minX,
      maxX,
      minY,
      maxY,
      x: savedRoot?.x ?? Math.cos(angle) * Math.sqrt(index) * 500,
      y: savedRoot?.y ?? Math.sin(angle) * Math.sqrt(index) * 350,
      pinned: savedRoot?.pinned || false,
      vx: 0,
      vy: 0,
    });
  });
  const byRoot = new Map(components.map((c) => [c.id, c])),
    links = semantic
      .map((e) => ({ a: root(e.a), b: root(e.b), score: e.score }))
      .filter((e) => e.a !== e.b && byRoot.has(e.a) && byRoot.has(e.b));
  // Forces suggest neighbourhoods; strict rectangle separation resolves collisions.
  for (let tick = 0; tick < 90; tick++) {
    for (const l of links) {
      const a = byRoot.get(l.a),
        b = byRoot.get(l.b),
        dx = b.x - a.x,
        dy = b.y - a.y;
      if (!a.pinned) {
        a.vx += dx * 0.0008 * l.score;
        a.vy += dy * 0.0008 * l.score;
      }
      if (!b.pinned) {
        b.vx -= dx * 0.0008 * l.score;
        b.vy -= dy * 0.0008 * l.score;
      }
    }
    for (const c of components)
      if (!c.pinned) {
        c.x += c.vx *= 0.6;
        c.y += c.vy *= 0.6;
      }
    separate(components);
  }
  for (let i = 0; i < components.length * 5 + 10; i++)
    if (!separate(components)) break;
  for (const c of components)
    for (const p of c.local)
      positions.push({
        id: p.id,
        x: c.x + p.x,
        y: c.y + p.y,
        pinned: p.id === c.id && c.pinned,
      });
  return positions;
}
function separate(components) {
  let changed = false;
  for (let i = 0; i < components.length; i++)
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i],
        b = components[j],
        ax = a.x + (a.minX + a.maxX) / 2,
        ay = a.y + (a.minY + a.maxY) / 2,
        bx = b.x + (b.minX + b.maxX) / 2,
        by = b.y + (b.minY + b.maxY) / 2,
        ox = (a.maxX - a.minX + b.maxX - b.minX) / 2 + 75 - Math.abs(bx - ax),
        oy = (a.maxY - a.minY + b.maxY - b.minY) / 2 + 75 - Math.abs(by - ay);
      if (ox <= 0 || oy <= 0) continue;
      const weight =
          a.pinned && !b.pinned ? 0 : b.pinned && !a.pinned ? 1 : 0.5,
        axis = ox < oy ? "x" : "y",
        delta = (axis === "x" ? ox : oy) + 1,
        sign = (axis === "x" ? bx - ax : by - ay) >= 0 ? 1 : -1;
      a[axis] -= delta * sign * weight;
      b[axis] += delta * sign * (1 - weight);
      changed = true;
    }
  return changed;
}
export function cardBounds(p, isRoot = false, pad = 0) {
  const w = isRoot ? CARD.rootWidth : CARD.width,
    h = isRoot ? CARD.rootHeight : CARD.height;
  return {
    left: p.x - w / 2 - pad,
    right: p.x + w / 2 + pad,
    top: p.y - h / 2 - pad,
    bottom: p.y + h / 2 + pad,
  };
}
export function routeTodayEdges(sessions, edges, positions) {
  const { parent } = familyRoots(sessions, edges),
    ps = new Map(positions.map((p) => [p.id, p]));
  return [...parent]
    .map(
      ([child, p]) =>
        edges.find((e) => e.parent === p && e.child === child) || {
          parent: p,
          child,
          kind: "shared_history",
        },
    )
    .flatMap((e) => {
      const a = ps.get(e.parent),
        b = ps.get(e.child);
      if (!a || !b) return [];
      const side = b.x >= a.x ? 1 : -1,
        aw = parent.has(e.parent) ? CARD.width : CARD.rootWidth,
        bw = CARD.width,
        x1 = a.x + (side * aw) / 2,
        x2 = b.x - (side * bw) / 2,
        mx = (x1 + x2) / 2;
      return [
        {
          ...e,
          path: `M ${x1} ${a.y} H ${mx} V ${b.y} H ${x2}`,
          segments: [
            [x1, a.y, mx, a.y],
            [mx, a.y, mx, b.y],
            [mx, b.y, x2, b.y],
          ],
        },
      ];
    });
}
