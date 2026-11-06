import { isFallback } from "./semantic-policy.js";

// IDs must never be recycled, including IDs removed by an in-place map refresh.
export function nextWorkstreamId(db) {
  return (
    (db
      .prepare(
        `SELECT max(id) AS id FROM (
    SELECT id FROM analysis_topics UNION ALL SELECT id FROM retired_workstreams
  )`,
      )
      .get().id ?? 0) + 1
  );
}

export function workstreamResolver(db, version) {
  const overrides = new Map(
    db
      .prepare("SELECT stream_id,title FROM workstream_title_overrides")
      .all()
      .map((o) => [o.stream_id, o.title]),
  );
  const topics = new Map(
    db
      .prepare(
        "SELECT id,name,description,color FROM analysis_topics WHERE version=?",
      )
      .all(version)
      .map((t) => [t.id, { ...t, name: overrides.get(t.id) ?? t.name }]),
  );
  const current = new Map(
    db
      .prepare(
        `SELECT s.session,m.topic_id
    FROM analysis_conversations s JOIN analysis_members m
    ON m.version=s.version AND m.chunk_id=s.representative_id
    WHERE s.version=?`,
      )
      .all(version)
      .map((r) => [r.session, r.topic_id]),
  );
  const resolved = new Map();
  return (id) => {
    if (topics.has(id)) return topics.get(id);
    if (resolved.has(id)) return resolved.get(id);
    const retired = db
      .prepare("SELECT * FROM retired_workstreams WHERE id=?")
      .get(id);
    const historical =
      retired ||
      db
        .prepare(
          `SELECT t.* FROM analysis_topics t
      JOIN analysis_runs r ON r.id=t.version WHERE t.id=?
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
        )
        .get(id);
    if (!historical) return null;
    const sessions = retired
      ? JSON.parse(retired.sessions)
      : db
          .prepare(
            `
      SELECT s.session FROM analysis_conversations s JOIN analysis_members m
      ON m.version=s.version AND m.chunk_id=s.representative_id
      WHERE s.version=? AND m.topic_id=?`,
          )
          .all(historical.version, id)
          .map((r) => r.session);
    // Only complete, unambiguous lineage may reconnect a retired task board.
    // Similar names, partial imports, splits and residual buckets are insufficient.
    const targets = new Set(sessions.map((s) => current.get(s)));
    const target =
      sessions.length && targets.size === 1
        ? topics.get([...targets][0])
        : null;
    const result =
      target && !isFallback(historical) && !isFallback(target)
        ? target
        : {
            id,
            name: overrides.get(id) ?? historical.name,
            description: historical.description,
            color: historical.color,
          };
    resolved.set(id, result);
    return result;
  };
}
