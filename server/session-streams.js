import { activeAnalysis } from "./analysis-store.js";

const reconciled = new WeakMap();
export const invalidateSessionStreams = (db) => reconciled.delete(db);

// Recorded ancestry is navigation metadata, never a second semantic classifier.
export function rememberRelationships(db, edges) {
  const put = db.prepare(
    "INSERT OR IGNORE INTO session_relationships(parent,child,kind) VALUES(?,?,?)",
  );
  for (const e of edges)
    if (
      ["spawned", "delegated"].includes(e.kind) &&
      typeof e.parent === "string" &&
      typeof e.child === "string" &&
      e.parent !== e.child &&
      e.parent.length <= 200 &&
      e.child.length <= 200
    )
      put.run(e.parent, e.child, e.kind);
}
export function reconcileSessionStreams(db, version = activeAnalysis(db)?.id) {
  if (!version) return 0;
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  const recorded = db
    .prepare(
      "SELECT parent,child FROM session_relationships ORDER BY parent,child",
    )
    .all();
  const densityPolicy = JSON.parse(
    activeAnalysis(db, version)?.data || "{}",
  ).densityPolicy;
  const signature = JSON.stringify([
    version,
    corrections,
    recorded,
    densityPolicy,
  ]);
  if (reconciled.get(db) === signature) return 0;
  const groups = db
    .prepare(
      "SELECT c.session,m.topic_id,sum(CASE WHEN c.role='user' THEN 2 ELSE 1 END) weight,max(c.timestamp) latest FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? GROUP BY c.session,m.topic_id ORDER BY weight DESC,latest DESC,m.topic_id",
    )
    .all(version);
  // Published conversation assignments win over passage counts. Reconciliation
  // can propagate recorded delegation, but must not reinterpret saved topics.
  const own = new Map(
    db
      .prepare(
        "SELECT s.session,m.topic_id FROM analysis_conversations s JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=?",
      )
      .all(version)
      .map((r) => [r.session, r.topic_id]),
  );
  const published = new Set(own.keys());
  for (const r of groups)
    if (!own.has(r.session)) own.set(r.session, r.topic_id);
  const valid = new Set(
    db
      .prepare("SELECT id FROM analysis_topics WHERE version=?")
      .all(version)
      .map((t) => t.id),
  );
  for (const [sid, id] of Object.entries(corrections))
    if (valid.has(id)) own.set(sid, id);
  const parents = new Map();
  for (const e of recorded) {
    if (!parents.has(e.child)) parents.set(e.child, new Set());
    parents.get(e.child).add(e.parent);
  }
  const cycle = Symbol("cycle");
  const resolve = (sid, seen = new Set()) => {
    if (Object.hasOwn(corrections, sid) && valid.has(corrections[sid]))
      return corrections[sid];
    // Density publication already classified each conversation. Ancestry is
    // navigation metadata and cannot replace that saved assignment.
    if ((densityPolicy || published.has(sid)) && own.has(sid))
      return own.get(sid);
    if (seen.has(sid)) return cycle;
    seen.add(sid);
    const ps = parents.get(sid);
    if (ps?.size === 1) {
      const inherited = resolve([...ps][0], seen);
      if (inherited === cycle) return cycle;
      if (inherited !== null && inherited !== undefined) return inherited;
    }
    return own.get(sid);
  };
  const update = db.prepare(
    "UPDATE analysis_members SET topic_id=? WHERE version=? AND topic_id<>? AND chunk_id IN (SELECT id FROM chunks WHERE session=?)",
  );
  const legacy = db.prepare(
    "UPDATE chunks SET cluster=? WHERE session=? AND cluster IS NOT ?",
  );
  let changed = 0;
  db.exec("SAVEPOINT session_stream_reconcile");
  try {
    for (const sid of own.keys()) {
      const resolved = resolve(sid),
        target = resolved === cycle ? own.get(sid) : resolved;
      if (!valid.has(target)) continue;
      const result = update.run(target, version, target, sid);
      changed += result.changes;
      if (result.changes) legacy.run(target, sid, target);
    }
    db.exec("RELEASE session_stream_reconcile");
  } catch (e) {
    db.exec(
      "ROLLBACK TO session_stream_reconcile; RELEASE session_stream_reconcile",
    );
    throw e;
  }
  reconciled.set(db, signature);
  return changed;
}
// Reuse the same native relationship discovery as Today; changed logs only after
// the initial import. No embeddings, naming or model inference is involved.
export async function refreshSessionRelationships(db, config) {
  // Analysis-only fixtures/archives without an imported file catalogue have no
  // native logs to discover. Never fall back to the host's archive for them.
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'",
      )
      .get()
  )
    return;
  const since = Number(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='relationships_checked'",
      )
      .get()?.value || 0,
  );
  const { discoverToday } = await import("./today.js");
  const now = Date.now();
  const snapshot = await discoverToday(config, {
    start: Math.max(0, since - 1000),
    end: now + 1000,
    now,
  });
  rememberRelationships(db, snapshot.edges);
  db.prepare(
    "INSERT OR REPLACE INTO analysis_state VALUES('relationships_checked',?)",
  ).run(String(now));
}
