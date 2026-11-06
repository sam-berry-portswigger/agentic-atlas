import { isFallback } from "./semantic-policy.js";
import {
  topicNameRequest,
  cachedTopicName,
  requestTopicName,
} from "./topic-name-context.js";

// Read cached contextual names only. API callers batch missing names once;
// repeated reads do not copy titles, infer labels, or mutate source records.
export function visibleTopicLabel(db, version, topic, sessions, scope = {}) {
  const metadata = JSON.parse(
    db.prepare("SELECT data FROM analysis_runs WHERE id=?").get(version)
      ?.data || "{}",
  );
  if (!metadata.localClusterPolicy || !sessions.length) return topic;
  if (isFallback(topic) || (metadata.residualTopicIds || []).includes(topic.id))
    return { ...topic, background: true };
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  if (Object.values(corrections).includes(topic.id))
    return { ...topic, background: false };
  const request = topicNameRequest(
    db,
    version,
    topic,
    sessions.map((s) => s.session || s.id),
    scope,
  );
  const cached = cachedTopicName(db, request);
  if (cached) return { ...topic, ...cached };
  requestTopicName(db, request);
  return {
    ...topic,
    name: "Work stream",
    description: "",
    background: true,
    namingPending: true,
  };
}
