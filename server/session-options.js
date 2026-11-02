import { sessionNameResolver } from "./session-labels.js";

// Metadata-only lookup for the manual task picker. No model or transcript read.
export function sessionOptions(db, { query = "", ids = [] } = {}) {
  const displayName = sessionNameResolver(db);
  if (
    typeof query !== "string" ||
    query.length > 200 ||
    !Array.isArray(ids) ||
    ids.length > 21 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 200)
  )
    throw Object.assign(new Error("Invalid session search."), { status: 400 });
  const term = "%" + query.trim().replace(/[\\%_]/g, "\\$&") + "%";
  const fields = "session AS id,title,project,timestamp AS updated";
  const select = (where, params, limit) =>
    db
      .prepare(
        `SELECT ${fields} FROM (SELECT *,row_number() OVER (PARTITION BY session ORDER BY timestamp DESC,id DESC) AS position FROM chunks WHERE ${where}) WHERE position=1 ORDER BY timestamp DESC,session LIMIT ?`,
      )
      .all(...params, limit);
  const selected = ids.length
    ? select(`session IN (${ids.map(() => "?").join(",")})`, ids, 21)
    : [];
  const labelsAvailable =
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('analysis_session_labels','analysis_state')",
      )
      .get().n === 2;
  const overridesAvailable = !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_title_overrides'",
    )
    .get();
  const matching = select(
    "title LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR session LIKE ? ESCAPE '\\'" +
      (labelsAvailable
        ? " OR session IN (SELECT session FROM analysis_session_labels WHERE version=(SELECT value FROM analysis_state WHERE key='active') AND title LIKE ? ESCAPE '\\')"
        : "") +
      (overridesAvailable
        ? " OR session IN (SELECT session FROM session_title_overrides WHERE title LIKE ? ESCAPE '\\')"
        : ""),
    [
      term,
      term,
      term,
      ...(labelsAvailable ? [term] : []),
      ...(overridesAvailable ? [term] : []),
    ],
    30,
  );
  return {
    sessions: [
      ...new Map(
        [...selected, ...matching].map((row) => [row.id, row]),
      ).values(),
    ].map((row) => ({
      ...row,
      title: displayName(row.id, row.title, row.project),
      provider: row.id.startsWith("codex:") ? "codex" : "claude",
      nativeId: row.id.replace(/^codex:/, ""),
    })),
  };
}
