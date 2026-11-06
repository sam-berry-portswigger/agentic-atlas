import { extendProjection } from "./stable-projection.js";
import {
  publishDensityGroups,
  hasSavedWorkstreams,
} from "./numerical-streams.js";
import { vectorArray } from "./db.js";
import { PROJECTION_POLICY, projectTopics } from "./projection.js";
export const projectionNeedsRefresh = (data) =>
  !!data.mapPending || data.projection?.policy !== PROJECTION_POLICY;

export function publishProjection(db, version, ids, result) {
  const current = db
    .prepare("SELECT value FROM analysis_state WHERE key='active'")
    .get()?.value;
  if (current !== version)
    throw new Error(
      "The active analysis changed while comparing layouts. Retry the projection.",
    );
  const run = db
    .prepare("SELECT data FROM analysis_runs WHERE id=?")
    .get(version);
  const data = {
    ...JSON.parse(run.data),
    mapPending: false,
    mapUpdatedAt: new Date().toISOString(),
    plotted: ids.length,
    projection: {
      policy: PROJECTION_POLICY,
      selected: result.selected,
      candidates: result.candidates,
    },
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const saved = new Map(
      db
        .prepare(
          "SELECT representative_id,x,y FROM analysis_conversations WHERE version=?",
        )
        .all(version)
        .map((r) => [r.representative_id, r]),
    );
    const member = db.prepare(
        "UPDATE analysis_members SET x=?,y=? WHERE version=? AND chunk_id=?",
      ),
      legacy = db.prepare("UPDATE chunks SET x=?,y=? WHERE id=?");
    const conversation = db.prepare(
      "UPDATE analysis_conversations SET x=?,y=? WHERE version=? AND representative_id=?",
    );
    ids.forEach((id, index) => {
      const [x, y] = result.points[index];
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new Error("Invalid projected coordinates.");
      const old = saved.get(id);
      if (old && Number.isFinite(old.x) && Number.isFinite(old.y)) return;
      member.run(x, y, version, id);
      conversation.run(x, y, version, id);
      legacy.run(x, y, id);
    });
    data.plotted = db
      .prepare(
        "SELECT count(*) n FROM analysis_conversations WHERE version=? AND x IS NOT NULL AND y IS NOT NULL",
      )
      .get(version).n;
    // Density establishes the initial groups only. Refreshes place new points;
    // they cannot retire IDs used by archives, manual names and task boards.
    if (!hasSavedWorkstreams(data) && result.labels && ids.length >= 6)
      Object.assign(data, publishDensityGroups(db, version, ids, result));
    db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
      JSON.stringify(data),
      version,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export async function upgradeProjection(db, run, options = {}) {
  if (!projectionNeedsRefresh(JSON.parse(run.data))) return;
  const conversations = JSON.parse(run.data).mapUnit === "conversation";
  const rows = db
    .prepare(
      conversations
        ? "SELECT s.representative_id AS id,m.topic_id,s.vector,s.x,s.y FROM analysis_conversations s JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=? ORDER BY CASE WHEN s.x IS NOT NULL AND s.y IS NOT NULL THEN 0 ELSE 1 END,s.session LIMIT 1800"
        : "SELECT m.chunk_id AS id,m.topic_id,c.vector,m.x,m.y FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND m.x IS NOT NULL ORDER BY m.chunk_id",
    )
    .all(run.id);
  options.signal?.throwIfAborted();
  if (options.isStopped?.()) throw Error("Projection cancelled.");
  const anchored = rows.some(
    (r) => Number.isFinite(r.x) && Number.isFinite(r.y),
  );
  const vectors = rows.map((row) => vectorArray(row.vector));
  const result = anchored
    ? {
        points: extendProjection(
          rows.map((row, i) => ({ ...row, vector: vectors[i] })),
        ),
        selected: "fixed-map-neighbors-v1",
        candidates: [],
      }
    : await projectTopics(
        vectors,
        rows.map((row) => row.topic_id),
        options,
      );
  options.signal?.throwIfAborted();
  if (options.isStopped?.()) throw Error("Projection cancelled.");
  publishProjection(
    db,
    run.id,
    rows.map((row) => row.id),
    result,
  );
}
