import { nextWorkstreamId } from "./workstream-identity.js";
import { fileURLToPath } from "node:url";
import { runMap } from "./map-runner.js";
import { activeAnalysis } from "./analysis-store.js";
import { cosine, normalize, vectorArray, vectorBuffer } from "./db.js";
import { sessionNameResolver } from "./session-labels.js";
import { isFallback, OTHER_DESCRIPTION } from "./semantic-policy.js";
import { nextTopicColor } from "../shared/topic-colors.js";
import { invalidateSessionStreams } from "./session-streams.js";

// Map geometry must not replace already published workstream identities.
export const hasSavedWorkstreams = (data) =>
  !!(data.densityPolicy || data.localClusterPolicy || data.workstreamPolicy);

export const LOCAL_CLUSTER_POLICY = "saved-map-density-leaves-v1";
export const DENSITY_POLICY = "umap15-min008-ns30-hdbscan6-3-leaf-v1";
export const DENSITY_PLACEHOLDER_DESCRIPTION =
  "Named after a representative conversation in this group.";

// Called inside the projection publication transaction. Density labels determine
// membership; representative titles describe the source, without model claims.
export function publishDensityGroups(db, version, ids, result) {
  if (
    !Array.isArray(result.labels) ||
    result.labels.length !== ids.length ||
    result.labels.some((label) => !Number.isInteger(label)) ||
    new Set(ids).size !== ids.length
  )
    throw Error("Invalid density grouping labels.");
  const rows = db
    .prepare(
      "SELECT s.*,c.title,c.project,m.topic_id FROM analysis_conversations s JOIN chunks c ON c.id=s.representative_id JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=? ORDER BY s.session",
    )
    .all(version);
  const byId = new Map(rows.map((row) => [row.representative_id, row]));
  if (ids.some((id) => !byId.has(id)))
    throw Error("Density grouping refers to an unknown conversation.");
  const previous = db
    .prepare("SELECT * FROM analysis_topics WHERE version=?")
    .all(version);
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  const metadata = JSON.parse(
    db.prepare("SELECT data FROM analysis_runs WHERE id=?").get(version)
      ?.data || "{}",
  );
  const previousById = new Map(previous.map((t) => [t.id, t]));
  const manual = new Map(
    Object.entries(corrections).filter(([, id]) => previousById.has(id)),
  );
  const groups = new Map(),
    assignments = new Map();
  ids.forEach((id, index) => {
    const row = byId.get(id);
    if (manual.has(row.session)) return;
    const label = Math.max(-1, result.labels[index]);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  });
  for (const row of rows)
    assignments.set(row.session, manual.get(row.session) ?? row.topic_id);
  let nextId = nextWorkstreamId(db);
  const protectedIds = new Set(manual.values()),
    used = new Set(previous.map((t) => t.color)),
    reused = new Set();
  const projectedIds = new Set(ids),
    oldCounts = new Map();
  for (const row of rows) {
    if (!projectedIds.has(row.representative_id))
      protectedIds.add(row.topic_id);
    if (!manual.has(row.session))
      oldCounts.set(row.topic_id, (oldCounts.get(row.topic_id) || 0) + 1);
  }
  const resolveName = sessionNameResolver(db, version),
    topics = [];
  const centroid = (members) => {
    const vectors = members.map((row) => vectorArray(row.vector));
    const sum = new Float64Array(vectors[0].length);
    for (const vector of vectors)
      vector.forEach((value, index) => {
        sum[index] += value;
      });
    return normalize(sum);
  };
  for (const [label, members] of [...groups].sort((a, b) => a[0] - b[0])) {
    const center = centroid(members);
    const medoid = [...members].sort(
      (a, b) =>
        cosine(vectorArray(b.vector), center) -
          cosine(vectorArray(a.vector), center) ||
        a.session.localeCompare(b.session),
    )[0];
    // Preserve orientation when a density refresh finds substantially the
    // same group, regardless of the numerical label assigned by the worker.
    const overlap = new Map();
    for (const row of members)
      overlap.set(row.topic_id, (overlap.get(row.topic_id) || 0) + 1);
    const prior = [...overlap]
      .filter(
        ([id, count]) =>
          count === oldCounts.get(id) &&
          !protectedIds.has(id) &&
          !reused.has(id) &&
          label < 0 === isFallback(previousById.get(id) || {}) &&
          count / members.length >= 0.5,
      )
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const id = prior ? prior[0] : nextId++,
      color = prior ? previousById.get(id).color : nextTopicColor(used);
    reused.add(id);
    used.add(color);
    const previousTopic = prior ? previousById.get(id) : null;
    const keepName =
      label >= 0 &&
      !!prior &&
      previousTopic?.description?.trim() &&
      previousTopic.description !== DENSITY_PLACEHOLDER_DESCRIPTION;
    topics.push({
      id,
      name:
        label < 0
          ? "Other sessions"
          : keepName
            ? previousTopic.name
            : resolveName(medoid.session, medoid.title, medoid.project).slice(
                0,
                100,
              ),
      description:
        label < 0
          ? OTHER_DESCRIPTION
          : keepName
            ? previousTopic.description
            : DENSITY_PLACEHOLDER_DESCRIPTION,
      color,
      center,
    });
    for (const row of members) assignments.set(row.session, id);
  }
  // If a split leaves unplotted sessions behind, they are another fragment,
  // not the owner of the old identity and its task board.
  for (const previousTopic of previous) {
    if (
      new Set(manual.values()).has(previousTopic.id) ||
      isFallback(previousTopic) ||
      (metadata.residualTopicIds || []).includes(previousTopic.id)
    )
      continue;
    const remaining = rows.filter(
      (row) =>
        row.topic_id === previousTopic.id &&
        !projectedIds.has(row.representative_id) &&
        !manual.has(row.session),
    );
    if (
      !remaining.length ||
      !rows.some(
        (row) =>
          row.topic_id === previousTopic.id &&
          assignments.get(row.session) !== previousTopic.id,
      )
    )
      continue;
    const id = nextId++,
      center = centroid(remaining);
    const representative = [...remaining].sort(
      (a, b) =>
        cosine(vectorArray(b.vector), center) -
          cosine(vectorArray(a.vector), center) ||
        a.session.localeCompare(b.session),
    )[0];
    const color = nextTopicColor(used);
    used.add(color);
    topics.push({
      id,
      name: resolveName(
        representative.session,
        representative.title,
        representative.project,
      ),
      description: DENSITY_PLACEHOLDER_DESCRIPTION,
      color,
      center,
    });
    for (const row of remaining) assignments.set(row.session, id);
    protectedIds.delete(previousTopic.id);
  }
  const put = db.prepare(
    "INSERT OR REPLACE INTO analysis_topics(version,id,name,description,color,centroid) VALUES(?,?,?,?,?,?)",
  );
  for (const topic of topics)
    put.run(
      version,
      topic.id,
      topic.name,
      topic.description,
      topic.color,
      vectorBuffer(topic.center),
    );
  const update = db.prepare(
    "UPDATE analysis_members SET topic_id=? WHERE version=? AND chunk_id IN (SELECT id FROM chunks WHERE session=?)",
  );
  const legacy = db.prepare("UPDATE chunks SET cluster=? WHERE session=?");
  for (const [session, target] of assignments) {
    update.run(target, version, session);
    legacy.run(target, session);
  }
  const membersByTopic = new Map();
  for (const row of rows) {
    const id = assignments.get(row.session);
    if (!membersByTopic.has(id)) membersByTopic.set(id, []);
    membersByTopic.get(id).push(row);
  }
  const recenter = db.prepare(
    "UPDATE analysis_topics SET centroid=? WHERE version=? AND id=?",
  );
  for (const [id, members] of membersByTopic)
    recenter.run(vectorBuffer(centroid(members)), version, id);
  // Only derived catalogue caches are discarded; archives, overrides, tasks,
  // original embeddings and stored map coordinates are left intact.
  const remove = db.prepare(
    "DELETE FROM analysis_topics WHERE version=? AND id=?",
  );
  for (const topic of previous)
    if (!protectedIds.has(topic.id) && !membersByTopic.has(topic.id)) {
      db.prepare(
        "INSERT OR REPLACE INTO retired_workstreams VALUES(?,?,?,?,?)",
      ).run(
        topic.id,
        topic.name,
        topic.description,
        topic.color,
        JSON.stringify(
          rows.filter((r) => r.topic_id === topic.id).map((r) => r.session),
        ),
      );
      remove.run(version, topic.id);
    }
  for (const table of [
    "analysis_work_members",
    "analysis_work",
    "analysis_summaries",
  ])
    db.prepare(`DELETE FROM ${table} WHERE version=?`).run(version);
  const finalTopics = db
    .prepare("SELECT id,name,description FROM analysis_topics WHERE version=?")
    .all(version);
  invalidateSessionStreams(db);
  return {
    topics: finalTopics.length,
    backgroundIds: [
      ...new Set([
        ...finalTopics.filter(isFallback).map((t) => t.id),
        ...(metadata.backgroundIds || []).filter(
          (id) =>
            finalTopics.some((t) => t.id === id) &&
            !new Set(manual.values()).has(id),
        ),
      ]),
    ],
    residualTopicIds: finalTopics.filter(isFallback).map((t) => t.id),
    assignmentsUpdatedAt: new Date().toISOString(),
    densityPolicy: DENSITY_POLICY,
    localClusterPolicy: LOCAL_CLUSTER_POLICY,
    workstreamPolicy: undefined,
    workstreamNamingIds: undefined,
    workstreamSourceTopics: undefined,
    clusterNamingIds: finalTopics
      .filter(
        (t) =>
          !isFallback(t) && t.description === DENSITY_PLACEHOLDER_DESCRIPTION,
      )
      .map((t) => t.id),
    namingPending: finalTopics.some(
      (topic) =>
        !isFallback(topic) &&
        topic.description === DENSITY_PLACEHOLDER_DESCRIPTION,
    ),
    warnings: (metadata.warnings || []).filter(
      (w) =>
        w.stage !== "naming" &&
        !/naming|objective-refinement/.test(w.code || ""),
    ),
  };
}

// One migration of saved coordinates. No new projection, embeddings or text.
export async function refreshSavedDensityGroups(db, run, options = {}) {
  if (hasSavedWorkstreams(JSON.parse(run.data))) return;
  const rows = db
    .prepare(
      "SELECT representative_id AS id,x,y FROM analysis_conversations WHERE version=? AND x IS NOT NULL AND y IS NOT NULL ORDER BY session LIMIT 1800",
    )
    .all(run.id);
  if (rows.length < 6) return;
  const result = await runMap(
    rows.map((r) => [r.x, r.y]),
    {
      ...options,
      script: fileURLToPath(new URL("./density-saved.py", import.meta.url)),
    },
  );
  options.signal?.throwIfAborted();
  if (options.isStopped?.()) throw Error("Clustering cancelled.");
  if (activeAnalysis(db)?.id !== run.id)
    throw Error("The catalogue changed during clustering.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const data = JSON.parse(activeAnalysis(db).data);
    const changes = publishDensityGroups(
      db,
      run.id,
      rows.map((r) => r.id),
      result,
    );
    db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
      JSON.stringify({ ...data, ...changes }),
      run.id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
