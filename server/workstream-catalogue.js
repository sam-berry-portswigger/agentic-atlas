import { randomUUID } from "node:crypto";
import { activeAnalysis } from "./analysis-store.js";
import { topicHierarchy } from "./topic-hierarchy.js";
import { vectorArray, vectorBuffer, normalize } from "./db.js";
import { invalidateSessionStreams } from "./session-streams.js";

export const WORKSTREAM_POLICY = "named-workstream-clusters-v1";

// Promote the already accepted map groups into the shared catalogue. This is a
// versioned merge of saved assignments, never a new clustering or projection.
export function publishWorkstreamCatalogue(db, version) {
  const run = activeAnalysis(db);
  if (run?.id !== version)
    throw Error("The catalogue changed before publication.");
  const metadata = JSON.parse(run.data);
  if (metadata.workstreamPolicy === WORKSTREAM_POLICY) return version;
  const topics = db
    .prepare("SELECT * FROM analysis_topics WHERE version=? ORDER BY id")
    .all(version);
  const byId = new Map(topics.map((t) => [t.id, t]));
  const groups = topicHierarchy(db, version).map((g) => ({ ...g }));
  const covered = new Set(groups.flatMap((g) => g.topicIds));
  for (const t of topics)
    if (!covered.has(t.id))
      groups.push({ id: t.id, name: t.name, color: t.color, topicIds: [t.id] });
  const target = new Map(
    groups.flatMap((g) => g.topicIds.map((id) => [id, g.id])),
  );
  if (
    target.size !== topics.length ||
    new Set(groups.map((g) => g.id)).size !== groups.length
  )
    throw Error("Every saved topic must belong to exactly one work stream.");
  const conversations = db
    .prepare(
      "SELECT s.vector,m.topic_id FROM analysis_conversations s JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=?",
    )
    .all(version);
  const sums = new Map();
  for (const row of conversations) {
    const id = target.get(row.topic_id),
      v = vectorArray(row.vector);
    if (!sums.has(id)) sums.set(id, new Float64Array(v.length));
    v.forEach((x, i) => (sums.get(id)[i] += x));
  }
  const next = randomUUID(),
    now = new Date().toISOString();
  const pending = groups.filter((g) => g.topicIds.length > 1).map((g) => g.id);
  const nextMetadata = {
    ...metadata,
    previousVersion: version,
    incremental: false,
    workstreamPolicy: WORKSTREAM_POLICY,
    workstreamNamingIds: pending,
    workstreamSourceTopics: groups.map((g) => ({
      id: g.id,
      topicIds: g.topicIds,
    })),
    topics: groups.length,
    namingPending: pending.length > 0,
    assignmentsUpdatedAt: now,
    hierarchyUpdatedAt: now,
    backgroundIds: [
      ...new Set(
        (metadata.backgroundIds || []).map((id) => target.get(id) ?? id),
      ),
    ],
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (activeAnalysis(db)?.id !== version)
      throw Error("The catalogue changed during publication.");
    db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
      next,
      run.fingerprint,
      run.model,
      run.generation_model,
      now,
      JSON.stringify(nextMetadata),
    );
    const put = db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)");
    for (const g of groups) {
      const original = byId.get(g.topicIds[0]);
      put.run(
        next,
        g.id,
        g.name,
        original.description,
        g.color,
        sums.has(g.id)
          ? vectorBuffer(normalize(sums.get(g.id)))
          : original.centroid,
      );
    }
    db.prepare(
      "INSERT INTO analysis_members SELECT ?,chunk_id,topic_id,x,y FROM analysis_members WHERE version=?",
    ).run(next, version);
    db.prepare(
      "INSERT INTO analysis_conversations SELECT ?,session,representative_id,vector,x,y FROM analysis_conversations WHERE version=?",
    ).run(next, version);
    db.prepare(
      "INSERT INTO analysis_conversation_inputs SELECT ?,session,input_hash FROM analysis_conversation_inputs WHERE version=?",
    ).run(next, version);
    db.prepare(
      "INSERT INTO analysis_session_labels SELECT ?,session,title,input_hash FROM analysis_session_labels WHERE version=?",
    ).run(next, version);
    // One CASE expression prevents a retained ID from being remapped twice.
    const cases = [...target]
      .map(([from, to]) => `WHEN ${from} THEN ${to}`)
      .join(" ");
    if (target.size)
      db.prepare(
        `UPDATE analysis_members SET topic_id=CASE topic_id ${cases} ELSE topic_id END WHERE version=?`,
      ).run(next);
    db.prepare(
      "UPDATE chunks SET cluster=(SELECT topic_id FROM analysis_members WHERE version=? AND chunk_id=chunks.id) WHERE id IN (SELECT chunk_id FROM analysis_members WHERE version=?)",
    ).run(next, next);
    const corrections = JSON.parse(
      db
        .prepare(
          "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
        )
        .get()?.value || "{}",
    );
    for (const session of Object.keys(corrections))
      corrections[session] =
        target.get(corrections[session]) ?? corrections[session];
    if (Object.keys(corrections).length)
      db.prepare(
        "INSERT OR REPLACE INTO analysis_state VALUES('stream_session_assignments',?)",
      ).run(JSON.stringify(corrections));
    db.prepare("INSERT OR REPLACE INTO analysis_state VALUES('active',?)").run(
      next,
    );
    invalidateSessionStreams(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return next;
}
