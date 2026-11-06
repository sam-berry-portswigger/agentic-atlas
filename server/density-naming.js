import { activeAnalysis } from "./analysis-store.js";
import { isFallback } from "./semantic-policy.js";
import {
  topicNameRequest,
  resolveTopicNames,
  cachedTopicName,
  TOPIC_NAME_POLICY,
  TOPIC_NAMING_INSTRUCTIONS,
} from "./topic-name-context.js";
export { TOPIC_NAMING_INSTRUCTIONS };

// Membership is fixed. Contextual naming may identify incidental activity, but
// can only update presentation fields and background visibility.
export async function nameDensityGroups(
  db,
  {
    nameGenerator,
    refresh = false,
    signal,
    isStopped = () => false,
    send = () => {},
  } = {},
) {
  const check = () => {
    signal?.throwIfAborted();
    if (isStopped()) throw Error("Naming cancelled.");
  };
  check();
  const run = activeAnalysis(db);
  if (!run) return;
  const data = JSON.parse(run.data);
  if (!data.densityPolicy && !data.workstreamPolicy) return;
  const manual = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  const protectedIds = new Set([
      ...Object.values(manual),
      ...db
        .prepare("SELECT stream_id FROM workstream_title_overrides")
        .all()
        .map((o) => o.stream_id),
    ]),
    residual = new Set(data.residualTopicIds || []);
  const topics = db
    .prepare("SELECT * FROM analysis_topics WHERE version=? ORDER BY id")
    .all(run.id)
    .filter(
      (t) =>
        !isFallback(t) &&
        !residual.has(t.id) &&
        !protectedIds.has(t.id) &&
        (refresh ||
          (!data.localClusterPolicy && !data.workstreamPolicy) ||
          (data.localClusterPolicy
            ? data.clusterNamingIds
            : data.workstreamNamingIds
          )?.includes(t.id)),
    );
  if (!topics.length) return;
  const requests = topics.map((t) => topicNameRequest(db, run.id, t));
  const remaining = new Set(topics.map((t) => t.id)),
    background = new Set(data.backgroundIds || []);
  const publish = (warnings = []) => {
    const current = JSON.parse(
      db.prepare("SELECT data FROM analysis_runs WHERE id=?").get(run.id).data,
    );
    db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
      JSON.stringify({
        ...current,
        backgroundIds: [...background],
        namingPending: remaining.size > 0,
        densityNamingPolicy: TOPIC_NAME_POLICY,
        ...(data.localClusterPolicy
          ? { clusterNamingIds: [...remaining] }
          : data.workstreamPolicy
            ? { workstreamNamingIds: [...remaining] }
            : {}),
        warnings: [
          ...(current.warnings || []).filter((w) => w.stage !== "naming"),
          ...warnings,
        ],
        assignmentsUpdatedAt: new Date().toISOString(),
      }),
      run.id,
    );
  };
  publish();
  try {
    await resolveTopicNames(db, requests, { nameGenerator, signal });
    check();
    if (activeAnalysis(db)?.id !== run.id)
      throw Error(
        "The catalogue changed during naming. Retry to reuse cached names.",
      );
    for (let i = 0; i < topics.length; i++) {
      check();
      const topic = topics[i],
        plan = cachedTopicName(db, requests[i]);
      if (!plan) continue;
      send(
        "naming",
        i,
        topics.length,
        "Naming saved clusters from conversation context",
      );
      db.prepare(
        "UPDATE analysis_topics SET name=?,description=? WHERE version=? AND id=?",
      ).run(plan.name, plan.description, run.id, topic.id);
      if (plan.background) background.add(topic.id);
      else background.delete(topic.id);
      remaining.delete(topic.id);
    }
    publish();
  } catch (error) {
    check();
    publish([
      {
        stage: "naming",
        code: "naming-pending",
        message: "Some work-stream names still need naming. Retry naming.",
        reason: error.message,
      },
    ]);
  }
}
