import { publishDensityGroups } from "./numerical-streams.js";
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
    db.prepare(
      "UPDATE analysis_members SET x=NULL,y=NULL WHERE version=? AND (x IS NOT NULL OR y IS NOT NULL)",
    ).run(version);
    db.prepare(
      "UPDATE analysis_conversations SET x=NULL,y=NULL WHERE version=? AND (x IS NOT NULL OR y IS NOT NULL)",
    ).run(version);
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
      member.run(x, y, version, id);
      conversation.run(x, y, version, id);
      legacy.run(x, y, id);
    });
    if (result.labels && ids.length >= 6)
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
        ? "SELECT s.representative_id AS id,m.topic_id,s.vector FROM analysis_conversations s JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=? ORDER BY s.session LIMIT 1800"
        : "SELECT m.chunk_id AS id,m.topic_id,c.vector FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND m.x IS NOT NULL ORDER BY m.chunk_id",
    )
    .all(run.id);
  const result = await projectTopics(
    rows.map((row) => vectorArray(row.vector)),
    rows.map((row) => row.topic_id),
    options,
  );
  publishProjection(
    db,
    run.id,
    rows.map((row) => row.id),
    result,
  );
}
