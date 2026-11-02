import { createHash } from "node:crypto";
import { SUMMARY_POLICY } from "./summary-context.js";
import { isCompactSummary } from "./summary-style.js";

// Include all supporting content, not just the sampled prompt. A new outcome
// must invalidate the summary even if it would fall outside the context cap.
export function summaryFingerprint(rows, metadata) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      metadata.kind === "work" ? "work" : "stream",
      metadata.streamId ?? metadata.topicId ?? metadata.cluster ?? null,
      metadata.title,
    ]),
  );
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id)))
    hash.update(
      JSON.stringify([
        row.id,
        row.session,
        row.project,
        row.title,
        row.role,
        row.timestamp,
        row.text,
      ]),
    );
  return `content:${hash.digest("hex")}`;
}
export function summaryCacheAddress(topic, model) {
  return [
    topic.summaryFingerprint,
    "summary",
    JSON.stringify({ model, policy: SUMMARY_POLICY }),
  ];
}
export function cachedSummary(db, topic, model) {
  const cached = db
    .prepare(
      "SELECT data FROM analysis_summaries WHERE version=? AND selection=? AND scope=?",
    )
    .get(...summaryCacheAddress(topic, model));
  if (cached) return JSON.parse(cached.data);
  const legacy = db
    .prepare(
      "SELECT data FROM analysis_summaries WHERE version=? AND selection='summary' AND scope=?",
    )
    .get(
      topic.summaryFingerprint,
      JSON.stringify({ model, policy: "recent-relevant-stream-v2" }),
    );
  const result = legacy ? JSON.parse(legacy.data) : null;
  return isCompactSummary(result?.summary) ? result : null;
}
export function saveSummary(db, topic, model, result) {
  db.prepare("INSERT OR REPLACE INTO analysis_summaries VALUES(?,?,?,?)").run(
    ...summaryCacheAddress(topic, model),
    JSON.stringify(result),
  );
}
