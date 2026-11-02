import { workItemRows } from "./work-item.js";
import {
  activeAnalysis,
  hasAnalysisSchema,
  workIdentity,
} from "./analysis-store.js";

export function prepareWork(db, scope, links, topicByMember) {
  const result = [];
  for (const link of links) {
    if (!link.title || !link.sourceIds?.length) continue;
    try {
      const selected = workItemRows(db, scope, {
        kind: "work",
        title: link.title,
        sourceIds: link.sourceIds,
      });
      const members = selected.rows
        .filter((row) => topicByMember.has(row.id))
        .map((row) => row.id);
      if (!members.length) continue;
      result.push({
        id: workIdentity(scope, link.title, link.sourceIds),
        scope,
        title: link.title,
        sourceIds: link.sourceIds,
        members,
        topicIds: [...new Set(members.map((id) => topicByMember.get(id)))].sort(
          (a, b) => a - b,
        ),
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return result;
}
export function saveWork(db, version, work) {
  const put = db.prepare(
    "INSERT OR REPLACE INTO analysis_work VALUES(?,?,?,?,?,?)",
  );
  const member = db.prepare(
    "INSERT OR IGNORE INTO analysis_work_members VALUES(?,?,?)",
  );
  for (const item of work) {
    put.run(
      version,
      item.id,
      JSON.stringify(item.scope),
      item.title,
      JSON.stringify(item.sourceIds),
      JSON.stringify(item.topicIds),
    );
    db.prepare(
      "DELETE FROM analysis_work_members WHERE version=? AND work_id=?",
    ).run(version, item.id);
    for (const id of item.members) member.run(version, item.id, id);
  }
}
export function persistFocus(db, scope, focus, version) {
  const run = activeAnalysis(db, version);
  if (!run) return focus;
  const assignments = new Map(
    db
      .prepare("SELECT chunk_id,topic_id FROM analysis_members WHERE version=?")
      .all(run.id)
      .map((row) => [row.chunk_id, row.topic_id]),
  );
  const work = prepareWork(
    db,
    scope,
    focus.flatMap((item) => item.links || []),
    assignments,
  );
  saveWork(db, run.id, work);
  return attachWork(db, scope, focus, run.id);
}
export function attachWork(db, scope, focus, version) {
  if (!hasAnalysisSchema(db)) return focus;
  const run = activeAnalysis(db, version);
  if (!run) return focus;
  const lookup = db.prepare(
    "SELECT id,topic_ids FROM analysis_work WHERE version=? AND id=?",
  );
  const color = db.prepare(
    "SELECT color FROM analysis_topics WHERE version=? AND id=?",
  );
  return focus.map((item) => ({
    ...item,
    links: (item.links || []).map((link) => {
      const work = lookup.get(
        run.id,
        workIdentity(scope, link.title, link.sourceIds || []),
      );
      const topicIds = work ? JSON.parse(work.topic_ids) : [];
      return {
        ...link,
        workId: work?.id,
        analysisVersion: run.id,
        topicIds,
        color:
          topicIds.length === 1 ? color.get(run.id, topicIds[0])?.color : null,
      };
    }),
  }));
}
