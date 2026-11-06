import {
  rememberRelationships,
  reconcileSessionStreams,
} from "./session-streams.js";
import { visibleTopicLabel } from "./local-topic-labels.js";
import { activeAnalysis, catalogue } from "./analysis-store.js";
import { STREAM_METHOD } from "./stream-analysis.js";
import { familyRoots } from "../shared/today-layout.js";
export function attachTodayStreams(db, sessions, edges = [], scope = {}) {
  const run = activeAnalysis(db);
  if (!run)
    return {
      semantic: [],
      topics: [],
      workstreams: [],
      analysisVersion: null,
      catalogueReady: false,
      streamsUpdatedAt: null,
      unclassifiedSessions: sessions.length,
    };
  rememberRelationships(db, edges);
  reconcileSessionStreams(db, run.id);
  const metadata = JSON.parse(run.data),
    topics = catalogue(db, run.id),
    byTopic = new Map(topics.map((t) => [t.id, t]));
  // Read the published conversation assignment used by Explore. Dates control
  // session visibility upstream, never which saved topic a conversation uses.
  const saved = db.prepare(
    "SELECT m.topic_id FROM analysis_conversations s JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=? AND s.session=?",
  );
  const legacy = db.prepare(
    "SELECT m.topic_id FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND c.session=? LIMIT 1",
  );
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  for (const s of sessions) {
    // Older catalogues have no conversation table entries. Reconciliation above
    // already gives all their passages one canonical assignment; no vote needed.
    const best = saved.get(run.id, s.id) || legacy.get(run.id, s.id);
    s.streamIds = best ? [best.topic_id] : [];
    const topic =
      byTopic.get(corrections[s.id]) || (best && byTopic.get(best.topic_id));
    if (topic)
      s.topic = { id: String(topic.id), name: topic.title, color: topic.color };
    else delete s.topic;
  }
  // Keep native parentage separate from the display family forest, which folds
  // related chats within the same work stream unless explicitly detached.
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  for (let i = edges.length - 1; i >= 0; i--) {
    const edge = edges[i];
    if (!["shared_history", "forked"].includes(edge.kind)) continue;
    const child = sessionsById.get(edge.child);
    if (child?.parent === edge.parent) {
      child.parent = null;
      child.child = false;
    }
  }
  const historyIds = new Set(
    edges
      .filter((e) => e.kind === "shared_history")
      .flatMap((e) => [e.parent, e.child]),
  );
  for (const s of sessions) if (!historyIds.has(s.id)) delete s.historyFamily;
  const forest = familyRoots(sessions, edges),
    byId = new Map(sessions.map((s) => [s.id, s]));
  for (const root of forest.roots) {
    const family = sessions.filter((s) => forest.root(s.id) === root.id),
      topic = root.topic || family.find((s) => s.topic)?.topic;
    for (const s of family) {
      s.boardStreamId = topic ? Number(topic.id) : null;
      if (!s.topic && topic) s.topic = topic;
    }
  }
  const labels = new Map(
    topics.map((t) => {
      const visible = forest.roots.filter((s) => s.boardStreamId === t.id);
      return [
        t.id,
        visibleTopicLabel(
          db,
          run.id,
          { id: t.id, name: t.title, description: t.description },
          visible,
          scope,
        ),
      ];
    }),
  );
  for (const s of sessions)
    if (s.topic)
      s.topic = {
        ...s.topic,
        name: labels.get(Number(s.topic.id))?.name || s.topic.name,
      };
  return {
    semantic: [],
    topics: topics.map((t) => ({
      id: String(t.id),
      name: labels.get(t.id).name,
      color: t.color,
    })),
    workstreams: topics.map((t) => ({
      id: t.id,
      name: labels.get(t.id).name,
      description: labels.get(t.id).description,
      color: t.color,
      background:
        labels.get(t.id).background ??
        (metadata.backgroundIds || []).includes(t.id),
    })),
    analysisVersion: run.id,
    streamsUpdatedAt: metadata.assignmentsUpdatedAt || run.created_at,
    unclassifiedSessions: forest.roots.filter((s) => !s.topic).length,
    catalogueReady: metadata.method === STREAM_METHOD,
  };
}
