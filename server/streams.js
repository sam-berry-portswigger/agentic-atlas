import { activeAnalysis, catalogue } from "./analysis-store.js";
import { scopeWhere } from "./scope.js";
import { discussionSize } from "./discussion-size.js";
import { selectContext } from "./evidence.js";
import { STREAM_METHOD } from "./stream-analysis.js";
export function readStreams(
  db,
  scope = { project: "", start: "", end: "" },
  { allowedProjects = null, includeRows = false } = {},
) {
  const run = activeAnalysis(db);
  if (!run) return { analysisVersion: null, ready: false, streams: [] };
  const metadata = JSON.parse(run.data),
    filter = scopeWhere(scope, "c");
  const restriction =
    allowedProjects === null
      ? ""
      : ` AND c.project IN (${allowedProjects.map(() => "?").join(",")})`;
  const rows = db
    .prepare(
      `SELECT c.id,c.session,c.project,c.title,c.role,c.timestamp,c.text,m.topic_id FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND ${filter.sql}${restriction} ORDER BY c.timestamp DESC,c.id`,
    )
    .all(run.id, ...filter.params, ...(allowedProjects || []));
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.topic_id)) groups.set(row.topic_id, []);
    groups.get(row.topic_id).push(row);
  }
  return {
    analysisVersion: run.id,
    ready: metadata.method === STREAM_METHOD,
    streams: catalogue(db, run.id)
      .filter((t) => groups.has(t.id))
      .map((t) => {
        const evidence = groups.get(t.id),
          size = discussionSize(evidence);
        return {
          id: t.id,
          name: t.title,
          description: t.description,
          color: t.color,
          analysisVersion: run.id,
          background: (metadata.backgroundIds || []).includes(t.id),
          latest: evidence[0]?.timestamp,
          passages: evidence.length,
          sessions: new Set(evidence.map((r) => r.session)).size,
          ...size,
          ...(includeRows ? { rows: evidence } : {}),
        };
      })
      .sort(
        (a, b) =>
          Number(a.background) - Number(b.background) ||
          (b.latest || "").localeCompare(a.latest || ""),
      ),
  };
}
export function overviewStreamContext(db, scope, budget = 40000) {
  const snapshot = readStreams(db, scope, { includeRows: true }),
    sources = [],
    groups = [];
  const eligible = snapshot.streams.filter((s) => !s.background);
  let used = 0;
  for (const stream of eligible) {
    const share = Math.min(
        7500,
        Math.floor(budget / Math.max(1, eligible.length)),
      ),
      ids = new Set(stream.rows.map((r) => r.id));
    const chosen = selectContext(db, stream.rows, scope, share, {
      diverse: true,
    }).filter((r) => ids.has(r.id));
    if (!chosen.length) continue;
    const evidence = chosen.map((row) => {
      sources.push({ ...row, streamId: stream.id, clusters: [stream.id] });
      used += row.text.length;
      return sources.length;
    });
    groups.push({
      id: stream.id,
      name: stream.name,
      description: stream.description,
      color: stream.color,
      evidence,
    });
  }
  return { ...snapshot, groups, sources, characters: used };
}
export function savedStreamFocus(result, input, scope) {
  const returned = result.streams;
  if (!returned || Array.isArray(returned) || typeof returned !== "object")
    throw Error(
      "The summary omitted stream entries. Return the exact supplied stream keys.",
    );
  const expected = new Set(input.groups.map((group) => String(group.id)));
  if (Object.keys(returned).some((id) => !expected.has(id)))
    throw Error("The summary introduced an unknown work stream.");
  return input.groups.map((group) => {
    const item = returned[String(group.id)];
    if (!item || typeof item.text !== "string" || !item.text.trim())
      throw Error(
        `The summary omitted stream ${group.id}. Retry without regrouping the work.`,
      );
    if (!Array.isArray(item.sources))
      throw Error(
        `Stream ${group.id} needs a list of supporting source numbers.`,
      );
    const allowed = new Set(group.evidence),
      numbers = [...new Set(item.sources)];
    // Validate inline references as well as the structured source list. Never
    // silently drop a foreign citation while leaving its claim in the text.
    const inline = [...item.text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(
      (match) => match[1].split(",").map(Number),
    );
    if (
      [...numbers, ...inline].some(
        (n) => !Number.isInteger(n) || !allowed.has(n),
      )
    )
      throw Error("A summary cited evidence from a different work stream.");
    const cited = [...new Set([...numbers, ...inline])].map(
      (n) => input.sources[n - 1],
    );
    if (!cited.length)
      throw Error(
        "Each work-stream summary needs original supporting evidence.",
      );
    return {
      id: String(group.id),
      streamId: group.id,
      title: group.name,
      text: item.text.trim().slice(0, 1600),
      clusters: [group.id],
      sourceIds: cited.map((s) => s.id),
      links: [
        {
          title: group.name,
          sourceIds: cited.map((s) => s.id),
          cluster: group.id,
          streamId: group.id,
          analysisVersion: input.analysisVersion,
          color: group.color,
        },
      ],
    };
  });
}
export function canonicalOverviewSchema(groups) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string", minLength: 1 },
      streams: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          groups.map((group) => [
            String(group.id),
            {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string", minLength: 1 },
                sources: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: { type: "integer", enum: group.evidence },
                },
              },
              required: ["text", "sources"],
            },
          ]),
        ),
        required: groups.map((group) => String(group.id)),
      },
    },
    required: ["summary", "streams"],
  };
}

// A correction edits the same canonical membership; it is not another classifier.
export function assignSessionStream(db, { session, streamId }) {
  const run = activeAnalysis(db);
  if (!run)
    throw Object.assign(new Error("Build the catalogue first."), {
      status: 409,
    });
  if (
    typeof session !== "string" ||
    !session ||
    session.length > 200 ||
    !Number.isInteger(streamId) ||
    !db
      .prepare("SELECT 1 FROM analysis_topics WHERE version=? AND id=?")
      .get(run.id, streamId)
  )
    throw Object.assign(new Error("Choose an existing session and stream."), {
      status: 400,
    });
  const stored = db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get(),
    assignments = stored ? JSON.parse(stored.value) : {};
  assignments[session] = streamId;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT OR REPLACE INTO analysis_state VALUES('stream_session_assignments',?)",
    ).run(JSON.stringify(assignments));
    db.prepare(
      "UPDATE analysis_members SET topic_id=? WHERE version=? AND chunk_id IN (SELECT id FROM chunks WHERE session=?)",
    ).run(streamId, run.id, session);
    db.prepare("UPDATE chunks SET cluster=? WHERE session=?").run(
      streamId,
      session,
    );
    db.exec("COMMIT");
    return { ok: true, streamId };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
