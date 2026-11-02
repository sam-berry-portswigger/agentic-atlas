import { createHash } from "node:crypto";
import { conversationName } from "./names.js";

export const SESSION_LABEL_VERSION = "session-labels-v1";
export function needsSessionLabel(title) {
  return (
    /…|\.\.\./.test(title) ||
    title.split(/\s+/).length > 9 ||
    /^(?:(?:implement|execute|follow|continue|review) (?:the |this )?plan|plan my day(?: standup brief)?|continue|untitled session|conversation in .+|(?:claude |codex )?subagent(?: .*)?)$/i.test(
      title.trim(),
    )
  );
}
export function sessionLabelInputHash(rows) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .filter((r) => r.role === "user")
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((r) => [r.id, r.title, r.text]),
      ),
    )
    .digest("hex");
}
// Labels are optional presentation improvements. Discard unusable suggestions
// without retrying or rejecting otherwise valid work-stream analysis.
export function validateSessionLabels(value, byKey, targets) {
  if (value === undefined) return []; // Older cached/legacy interpretation responses.
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((label) => {
      if (!label || typeof label !== "object") return null;
      const row = byKey.get(label.source),
        title = typeof label.title === "string" ? label.title.trim() : null;
      if (
        !row ||
        !targets.has(label.source) ||
        seen.has(row.session) ||
        title === null ||
        title.length > 64 ||
        title.split(/\s+/).length > 9 ||
        (title &&
          (title.length < 4 ||
            needsSessionLabel(title) ||
            /[\n<>]/.test(title)))
      )
        return null;
      seen.add(row.session);
      return { session: row.session, title };
    })
    .filter((label) => label?.title);
}
// Publish labels with the catalogue. Reuse old labels only for unchanged intent.
export function publishSessionLabels(
  db,
  version,
  labels,
  rows,
  previousVersion,
) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.session)) groups.set(row.session, []);
    groups.get(row.session).push(row);
  }
  const proposed = new Map(labels.map((l) => [l.session, l.title]));
  const old = new Map(
    previousVersion
      ? db
          .prepare("SELECT * FROM analysis_session_labels WHERE version=?")
          .all(previousVersion)
          .map((l) => [l.session, l])
      : [],
  );
  const put = db.prepare(
    "INSERT INTO analysis_session_labels(version,session,title,input_hash) VALUES(?,?,?,?)",
  );
  for (const [session, group] of groups) {
    if (!needsSessionLabel(conversationName(group[0].title, group[0].project)))
      continue;
    const hash = sessionLabelInputHash(group);
    const title =
      proposed.get(session) ||
      (old.get(session)?.input_hash === hash ? old.get(session).title : null);
    if (title) put.run(version, session, title, hash);
  }
}
// A single presentation resolver for every view; opening a view never generates.
export function sessionNameResolver(db, version = null) {
  const overrides = new Map(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_title_overrides'",
      )
      .get()
      ? db
          .prepare("SELECT session,title FROM session_title_overrides")
          .all()
          .map((r) => [r.session, r.title])
      : [],
  );
  const available =
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('analysis_session_labels','analysis_state')",
      )
      .get().n === 2;
  const labels = new Map(
    available
      ? db
          .prepare(
            "SELECT session,title FROM analysis_session_labels WHERE version=coalesce(?,(SELECT value FROM analysis_state WHERE key='active'))",
          )
          .all(version)
          .map((l) => [l.session, l.title])
      : [],
  );
  return (session, title, project, request = "") => {
    if (overrides.has(session)) return overrides.get(session);
    const native = conversationName(title, project, request);
    return needsSessionLabel(native) ? labels.get(session) || native : native;
  };
}
