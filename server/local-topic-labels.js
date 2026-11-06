import { isFallback } from "./semantic-policy.js";

// A date/project filter selects evidence, never a different workstream identity
// or name. Naming is published by the bounded sync/refresh worker.
export function visibleTopicLabel(db, version, topic) {
  const metadata = JSON.parse(
    db.prepare("SELECT data FROM analysis_runs WHERE id=?").get(version)
      ?.data || "{}",
  );
  const override = db
    .prepare("SELECT title FROM workstream_title_overrides WHERE stream_id=?")
    .get(topic.id);
  if (isFallback(topic) || (metadata.residualTopicIds || []).includes(topic.id))
    return {
      ...topic,
      ...(override ? { name: override.title } : {}),
      background: true,
    };
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  return {
    ...topic,
    ...(override ? { name: override.title } : {}),
    background: Object.values(corrections).includes(topic.id)
      ? false
      : (metadata.backgroundIds || []).includes(topic.id),
  };
}
