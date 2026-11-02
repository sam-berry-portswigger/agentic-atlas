import { createHash } from "node:crypto";
import { activeAnalysis } from "./analysis-store.js";
import { vectorArray, vectorBuffer } from "./db.js";
import {
  averageVectors,
  distinctConversationVectors,
} from "./conversation-vectors.js";
import { acquireIndexLock } from "./index-lock.js";
import { invalidateSessionStreams } from "./session-streams.js";
import { topicColors } from "../shared/topic-colors.js";

// An explicit, reviewed correction, never an automatic re-clustering step.
// Saved IDs and corrections let routine sync and a later rebuild preserve it.
export function splitWorkStream(
  db,
  { sourceId, sessions, name, description },
  { acquireLock = acquireIndexLock } = {},
) {
  if (
    !Number.isInteger(sourceId) ||
    !Array.isArray(sessions) ||
    !sessions.length ||
    sessions.some((s) => typeof s !== "string" || !s || s.length > 200) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 100 ||
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1000
  )
    throw Error(
      "Supply a source stream, reviewed sessions, name and description.",
    );
  const release = acquireLock();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = activeAnalysis(db);
      if (!run) throw Error("Build the catalogue first.");
      const topics = db
        .prepare("SELECT * FROM analysis_topics WHERE version=?")
        .all(run.id);
      if (!topics.some((t) => t.id === sourceId))
        throw Error("The source stream no longer exists.");
      if (
        topics.some((t) => t.name.toLowerCase() === name.trim().toLowerCase())
      )
        throw Error("A stream with this name already exists.");
      const conversations = db
        .prepare(
          "SELECT c.session,c.vector,m.topic_id FROM analysis_conversations c JOIN analysis_members m ON m.version=c.version AND m.chunk_id=c.representative_id WHERE c.version=?",
        )
        .all(run.id);
      const wanted = new Set(sessions);
      const corrections = JSON.parse(
        db
          .prepare(
            "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
          )
          .get()?.value || "{}",
      );
      for (const session of wanted) {
        const c = conversations.find((c) => c.session === session);
        if (!c || c.topic_id !== sourceId)
          throw Error(
            "Every selected session must belong to the source stream.",
          );
        if (
          Object.hasOwn(corrections, session) &&
          corrections[session] !== sourceId
        )
          throw Error(
            "A selected session has a conflicting manual correction.",
          );
        if (
          db
            .prepare(
              "SELECT 1 FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND c.session=? AND m.topic_id<>? LIMIT 1",
            )
            .get(run.id, session, sourceId)
        )
          throw Error("A selected session has mixed saved memberships.");
      }
      const members = conversations.filter((c) => c.topic_id === sourceId);
      const remaining = members.filter((c) => !wanted.has(c.session));
      if (!remaining.length)
        throw Error("A split must leave evidence in the source stream.");
      const center = (items) =>
        averageVectors(
          distinctConversationVectors(
            items.map((c) => ({
              session: c.session,
              evidenceKey: createHash("sha256").update(c.vector).digest("hex"),
              vector: vectorArray(c.vector),
            })),
          ),
        );
      const id =
        (db.prepare("SELECT max(id) n FROM analysis_topics").get().n ?? -1) + 1;
      const used = new Set(topics.map((t) => t.color));
      const color = topicColors.find((c) => !used.has(c));
      if (!color) throw Error("Too many simultaneous work streams.");
      db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
        run.id,
        id,
        name.trim(),
        description.trim(),
        color,
        vectorBuffer(center(members.filter((c) => wanted.has(c.session)))),
      );
      const put = db.prepare(
        "UPDATE analysis_members SET topic_id=? WHERE version=? AND chunk_id IN (SELECT id FROM chunks WHERE session=?)",
      );
      const legacy = db.prepare("UPDATE chunks SET cluster=? WHERE session=?");
      let passages = 0;
      for (const session of wanted) {
        corrections[session] = id;
        passages += put.run(id, run.id, session).changes;
        legacy.run(id, session);
      }
      db.prepare(
        "UPDATE analysis_topics SET centroid=? WHERE version=? AND id=?",
      ).run(vectorBuffer(center(remaining)), run.id, sourceId);
      db.prepare(
        "INSERT OR REPLACE INTO analysis_state VALUES('stream_session_assignments',?)",
      ).run(JSON.stringify(corrections));
      const metadata = JSON.parse(run.data);
      metadata.topics = topics.length + 1;
      metadata.assignmentsUpdatedAt = new Date().toISOString();
      db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
        JSON.stringify(metadata),
        run.id,
      );
      db.exec("COMMIT");
      invalidateSessionStreams(db);
      return {
        version: run.id,
        streamId: id,
        sourceId,
        sessions: [...wanted],
        passages,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    release();
  }
}
