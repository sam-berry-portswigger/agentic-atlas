import { parseScope, scopeWhere } from "./scope.js";
import { activeAnalysis } from "./analysis-store.js";
import { sessionTitle } from "./session-rename.js";
import {
  topicNameRequest,
  resolveTopicNames,
  cachedTopicName,
} from "./topic-name-context.js";

const inflight = new WeakMap();
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
export function workstreamForRename(db, { streamId, analysisVersion } = {}) {
  if (!Number.isSafeInteger(streamId) || streamId < 0)
    fail("Invalid work stream.");
  const run = activeAnalysis(db);
  if (!run) fail("Sync sessions before renaming a work stream.", 404);
  if (analysisVersion && analysisVersion !== run.id)
    fail(
      "The catalogue changed. Reopen the work stream before renaming it.",
      409,
    );
  const topic = db
    .prepare("SELECT * FROM analysis_topics WHERE version=? AND id=?")
    .get(run.id, streamId);
  if (!topic) fail("Work stream not found.", 404);
  const override = db
    .prepare("SELECT title FROM workstream_title_overrides WHERE stream_id=?")
    .get(streamId);
  return { ...topic, name: override?.title ?? topic.name };
}
export function saveWorkstreamTitle(db, body) {
  const title = sessionTitle(body.title);
  db.exec("SAVEPOINT rename_workstream");
  try {
    const topic = workstreamForRename(db, body);
    if (
      typeof body.previousTitle !== "string" ||
      topic.name !== body.previousTitle
    )
      fail(
        "This work stream was renamed elsewhere. Reopen it before saving.",
        409,
      );
    const updated = new Date().toISOString();
    db.prepare(
      "INSERT INTO workstream_title_overrides VALUES(?,?,?) ON CONFLICT(stream_id) DO UPDATE SET title=excluded.title,updated=excluded.updated",
    ).run(topic.id, title, updated);
    const run = activeAnalysis(db);
    const data = JSON.parse(run.data);
    db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
      JSON.stringify({ ...data, assignmentsUpdatedAt: updated }),
      run.id,
    );
    db.exec("RELEASE rename_workstream");
    return { title, streamId: topic.id, analysisVersion: run.id };
  } catch (error) {
    db.exec("ROLLBACK TO rename_workstream; RELEASE rename_workstream");
    throw error;
  }
}
// Use the same prompt, evidence builder, schema and validation as initial naming.
// The current name and scope retain the original continuity policy. A result
// remains a preview until the user saves it.
export async function suggestWorkstreamTitle(db, body, options = {}) {
  const topic = workstreamForRename(db, body);
  const scope = parseScope(body.scope ?? {});
  const filter = scopeWhere(scope, "c");
  const sessions = db
    .prepare(
      `SELECT DISTINCT c.session FROM chunks c JOIN analysis_members m ON m.chunk_id=c.id WHERE m.version=? AND m.topic_id=? AND ${filter.sql}`,
    )
    .all(topic.version, topic.id, ...filter.params)
    .map((row) => row.session);
  if (!sessions.length)
    fail(
      "This work stream has no conversations in the selected date range or project.",
      404,
    );
  const evidence = topicNameRequest(db, topic.version, topic, sessions, scope);
  if (!evidence)
    fail(
      "No conversation text is available for a suggestion. You can still enter a name.",
      404,
    );
  const request = {
    ...evidence,
    key:
      "manual-workstream-name:visible-scope-v2:" +
      topic.name +
      ":" +
      evidence.key,
  };
  if (!inflight.has(db)) inflight.set(db, new Map());
  const pending = inflight.get(db);
  if (pending.has(request.key)) return pending.get(request.key);
  const promise = (async () => {
    await resolveTopicNames(db, [request], {
      ...options,
      refresh: body.force === true,
    });
    return { title: cachedTopicName(db, request).name };
  })();
  pending.set(request.key, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(request.key) === promise) pending.delete(request.key);
  }
}
