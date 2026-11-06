import { visibleTopicLabel } from "./local-topic-labels.js";
import { createHash } from "node:crypto";
import { scopeWhere } from "./scope.js";
import { SEMANTIC_POLICY } from "./semantic-policy.js";
import {
  sessionNameResolver,
  SESSION_LABEL_VERSION,
} from "./session-labels.js";

export function initAnalysisSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS analysis_runs(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, model TEXT NOT NULL, generation_model TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workstream_title_overrides(stream_id INTEGER PRIMARY KEY,title TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retired_workstreams(id INTEGER PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,color TEXT NOT NULL,sessions TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analysis_name_cache(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analysis_session_labels(version TEXT NOT NULL,session TEXT NOT NULL,title TEXT NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(version,session));
    CREATE TABLE IF NOT EXISTS analysis_conversations(version TEXT NOT NULL,session TEXT NOT NULL,representative_id TEXT NOT NULL,vector BLOB NOT NULL,x REAL,y REAL,PRIMARY KEY(version,session));
    CREATE TABLE IF NOT EXISTS analysis_conversation_inputs(version TEXT NOT NULL,session TEXT NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(version,session));
    CREATE TABLE IF NOT EXISTS analysis_dirty_sessions(session TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS analysis_text_documents(model TEXT NOT NULL,hash TEXT NOT NULL,session TEXT NOT NULL,PRIMARY KEY(model,hash,session));
    CREATE INDEX IF NOT EXISTS analysis_text_document_session ON analysis_text_documents(model,session);
    CREATE TABLE IF NOT EXISTS session_title_overrides(session TEXT PRIMARY KEY,title TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_relationships(parent TEXT NOT NULL,child TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(parent,child,kind));
    CREATE TABLE IF NOT EXISTS analysis_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analysis_topics(version TEXT NOT NULL,id INTEGER NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,color TEXT NOT NULL,centroid BLOB NOT NULL,PRIMARY KEY(version,id));
    CREATE TABLE IF NOT EXISTS analysis_members(version TEXT NOT NULL,chunk_id TEXT NOT NULL,topic_id INTEGER NOT NULL,x REAL,y REAL,PRIMARY KEY(version,chunk_id));
    CREATE INDEX IF NOT EXISTS analysis_member_topic ON analysis_members(version,topic_id);
    CREATE TABLE IF NOT EXISTS analysis_work(version TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,title TEXT NOT NULL,source_ids TEXT NOT NULL,topic_ids TEXT NOT NULL,PRIMARY KEY(version,id));
    CREATE TABLE IF NOT EXISTS analysis_work_members(version TEXT NOT NULL,work_id TEXT NOT NULL,chunk_id TEXT NOT NULL,PRIMARY KEY(version,work_id,chunk_id));
    CREATE TABLE IF NOT EXISTS analysis_summaries(version TEXT NOT NULL,selection TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(version,selection,scope));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS analysis_conversation_policy_guard
    BEFORE INSERT ON analysis_runs
    WHEN json_extract(NEW.data,'$.conversationPolicy') IS NULL
      AND json_extract((SELECT data FROM analysis_runs WHERE id=(SELECT value FROM analysis_state WHERE key='active')),'$.conversationPolicy') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'This Atlas client uses an older analysis policy. Reconnect Atlas before rebuilding the catalogue.'); END;`);
}
export function hasAnalysisSchema(db) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_state'",
    )
    .get();
}
export function activeAnalysis(db, version) {
  if (!hasAnalysisSchema(db)) return null;
  const id =
    version ||
    db.prepare("SELECT value FROM analysis_state WHERE key='active'").get()
      ?.value;
  return id
    ? db.prepare("SELECT * FROM analysis_runs WHERE id=?").get(id) || null
    : null;
}
export function analysisFingerprint(db, model) {
  const hash = createHash("sha256").update(
    "workstreams-v2:" +
      SEMANTIC_POLICY +
      ":session-intent-candidates:" +
      SESSION_LABEL_VERSION +
      ":" +
      model,
  );
  for (const row of db
    .prepare(
      "SELECT id,project,role,timestamp FROM chunks WHERE model=? AND vector IS NOT NULL ORDER BY id",
    )
    .iterate(model))
    hash.update(JSON.stringify(row));
  return hash.digest("hex");
}
export function catalogue(db, version) {
  const run = activeAnalysis(db, version);
  if (!run) return [];
  return db
    .prepare(
      "SELECT t.id AS cluster,t.id,coalesce(o.title,t.name) AS title,t.description,t.color,t.version AS analysisVersion FROM analysis_topics t LEFT JOIN workstream_title_overrides o ON o.stream_id=t.id WHERE t.version=? ORDER BY t.id",
    )
    .all(run.id);
}
export function workIdentity(scope, title, sourceIds) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.project || "",
        scope.start || "",
        scope.end || "",
        title,
        [...new Set(sourceIds)].sort(),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}
export function readMap(db, scope, model) {
  const run = activeAnalysis(db);
  if (!run || run.model !== model)
    return { points: [], topics: [], analysisVersion: null, pending: true };
  const { sql, params } = scopeWhere(scope, "c");
  const displayName = sessionNameResolver(db, run.id);
  if (JSON.parse(run.data).mapUnit === "conversation") {
    const points = db
      .prepare(
        `WITH visible AS (
      SELECT c.id,c.session,c.project,c.title,c.role,c.timestamp,c.text,m.topic_id,
        max(c.timestamp) OVER (PARTITION BY c.session) AS latest,
        count(*) OVER (PARTITION BY c.session) AS passages,
        row_number() OVER (PARTITION BY c.session ORDER BY CASE WHEN c.id=s.representative_id THEN 0 WHEN c.role='user' THEN 1 ELSE 2 END,c.timestamp DESC,c.id) AS position
      FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id
      JOIN analysis_conversations s ON s.version=m.version AND s.session=c.session
      WHERE m.version=? AND s.x IS NOT NULL AND ${sql}
    ) SELECT v.id,v.session,v.project,v.title,v.role,v.latest AS timestamp,v.passages,s.x,s.y,v.topic_id AS cluster,t.name AS topicName,t.color,substr(v.text,1,180) AS preview
      FROM visible v JOIN analysis_conversations s ON s.version=? AND s.session=v.session
      JOIN analysis_topics t ON t.version=s.version AND t.id=v.topic_id
      WHERE v.position=1 ORDER BY v.session`,
      )
      .all(run.id, ...params, run.id)
      .map((p) => ({
        ...p,
        title: displayName(p.session, p.title, p.project),
        analysisVersion: run.id,
      }));
    const topics = catalogue(db, run.id).map((t) => {
      const visible = points.filter((p) => p.cluster === t.id);
      const label = visibleTopicLabel(
        db,
        run.id,
        { id: t.id, name: t.title, description: t.description },
        visible,
        scope,
      );
      for (const p of visible) p.topicName = label.name;
      return { ...t, title: label.name, description: label.description };
    });
    return {
      points,
      topics,
      analysisVersion: run.id,
      pending: false,
      unit: "conversation",
    };
  }
  const points = db
    .prepare(
      `SELECT c.id,c.session,c.project,c.title,c.role,c.timestamp,m.x,m.y,m.topic_id AS cluster,t.name AS topicName,t.color,substr(c.text,1,180) AS preview FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id JOIN analysis_topics t ON t.version=m.version AND t.id=m.topic_id WHERE m.version=? AND m.x IS NOT NULL AND ${sql} ORDER BY c.id`,
    )
    .all(run.id, ...params)
    .map(({ session, ...p }) => ({
      ...p,
      title: displayName(session, p.title, p.project),
      analysisVersion: run.id,
    }));
  const topics = catalogue(db, run.id);
  const names = new Map(topics.map((t) => [t.id, t.title]));
  for (const point of points)
    point.topicName = names.get(point.cluster) ?? point.topicName;
  return { points, topics, analysisVersion: run.id, pending: false };
}
export function pendingAnalysis(
  message = "Sync sessions to analyse these conversations before opening their topics.",
) {
  return Object.assign(new Error(message), { status: 409 });
}
export function summaryKey(selection) {
  return JSON.stringify(
    selection.kind === "work"
      ? ["work", selection.workId]
      : ["topic", selection.streamId ?? selection.cluster],
  );
}
