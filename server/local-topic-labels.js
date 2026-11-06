import { isFallback } from "./semantic-policy.js";

// A date/project filter selects evidence, never a different workstream identity
// or name. Naming is published by the bounded sync/refresh worker.
export function visibleTopicLabel(db, version, topic) {
  const metadata = JSON.parse(
    db.prepare("SELECT data FROM analysis_runs WHERE id=?").get(version)
      ?.data || "{}",
  );
  if (isFallback(topic) || (metadata.residualTopicIds || []).includes(topic.id))
    return { ...topic, background: true };
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  return {
    ...topic,
    background: Object.values(corrections).includes(topic.id)
      ? false
      : (metadata.backgroundIds || []).includes(topic.id),
  };
}
