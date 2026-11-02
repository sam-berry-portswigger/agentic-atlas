import { discussionSize } from "./discussion-size.js";
export { discussionSize } from "./discussion-size.js";
import { rankRecent } from "./recency.js";
import { createHash } from "node:crypto";
import { getConfig } from "./db.js";
import { selectContext, usefulText } from "./evidence.js";
import { scopeWhere } from "./scope.js";
import { workItems } from "./focus.js";
import { activeAnalysis } from "./analysis-store.js";
import { catalogue } from "./analysis-store.js";
import { attachWork } from "./work-store.js";
export const categories = [
  "Implementation",
  "Investigation",
  "Design",
  "Review",
  "Planning",
  "Research",
  "Mixed",
];
export function insightKey(scope) {
  return JSON.stringify(scope);
}
export function fingerprint(db, scope) {
  const { sql, params } = scopeWhere({ ...scope, start: "" });
  const config = getConfig(db);
  const hash = createHash("sha256")
    .update("shared-stream-summary-v1")
    .update(JSON.stringify(config));
  hash.update(
    JSON.stringify(catalogue(db).map((t) => [t.id, t.title, t.description])),
  );
  for (const row of db
    .prepare(
      `SELECT id,title,cluster FROM chunks WHERE ${sql} AND model=? ORDER BY id`,
    )
    .iterate(...params, config.embeddingModel))
    hash.update(JSON.stringify(row));
  // Cluster IDs may change after a projection, even when a filtered excerpt was not sampled.
  for (const row of db
    .prepare(
      "SELECT id,cluster FROM chunks WHERE x IS NOT NULL AND model=? ORDER BY id",
    )
    .iterate(config.embeddingModel))
    hash.update(JSON.stringify(row));
  return hash.digest("hex");
}
export function readInsights(db, scope) {
  const key = insightKey(scope),
    row = db.prepare("SELECT * FROM insights WHERE scope=?").get(key);
  if (!row) return { scope, topics: [], overview: null, stale: false };
  const data = JSON.parse(row.data);
  if (data.method !== "shared-stream-summary-v1")
    return { scope, topics: catalogue(db), overview: null, stale: true };
  const session = db.prepare("SELECT session FROM chunks WHERE id=?");
  for (const topic of data.topics)
    for (const source of topic.sources)
      if (!source.session)
        source.session =
          session.get(source.id)?.session || "Source no longer indexed";
  if (data.overview)
    data.overview.focus =
      data.method === "shared-stream-summary-v1" ? data.overview.focus : [];
  return {
    ...data,
    topics: catalogue(db).map((topic) => ({
      ...topic,
      sources: [],
      sourceIds: [],
    })),
    stale: row.fingerprint !== fingerprint(db, scope),
  };
}
// A chunk is not a discussion turn: one long reply may occupy dozens of chunks.
// Collapse messages first, then collapse copied/forked messages across sessions.

export function buildGroups(
  db,
  scope,
  totalBudget = null,
  {
    minimumDiscussion = false,
    allowedProjects = null,
    includeRows = false,
  } = {},
) {
  const model = getConfig(db).embeddingModel;
  const { sql, params } = scopeWhere(scope);
  const groups = new Map();
  let total = 0;
  for (const row of db
    .prepare(
      `SELECT id,session,project,title,role,timestamp,text,vector,cluster FROM chunks WHERE ${sql} ${allowedProjects ? `AND project IN (${allowedProjects.map(() => "?").join(",")})` : ""} AND model=? AND vector IS NOT NULL ORDER BY timestamp DESC,id`,
    )
    .iterate(...params, ...(allowedProjects || []), model)) {
    total++;
    const cluster = row.cluster ?? -1;
    const { vector, ...excerpt } = row;
    excerpt.cluster = cluster;
    if (!groups.has(cluster)) groups.set(cluster, []);
    groups.get(cluster).push(excerpt);
  }
  const allRows = [...groups.values()].flat();
  const assigned = new Map(allRows.map((row) => [row.id, row.cluster]));
  const projects = new Map();
  for (const row of allRows) {
    if (!projects.has(row.project)) projects.set(row.project, []);
    projects.get(row.project).push(row);
  }
  if (minimumDiscussion && !scope.project) {
    for (const [project, rows] of projects) {
      if (!discussionSize(rows).substantial) projects.delete(project);
    }
  }
  // Balance projects without giving tiny auxiliary projects the same budget as a
  // substantive body of work. Keep each project's research and implementation together.
  const weights = [...projects.values()].map((rows) =>
    Math.log1p(
      new Set(rows.map((row) => `${row.role}:${row.timestamp}:${row.text}`))
        .size,
    ),
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const projectGroups = totalBudget
    ? [...projects].map(([project, rows], i) => ({
        project,
        sources: selectContext(
          db,
          rows,
          scope,
          Math.floor(
            totalBudget *
              (0.2 / projects.size + (0.8 * weights[i]) / weightTotal),
          ),
          { diverse: true },
        ).map((source) => ({
          ...source,
          cluster: assigned.get(source.id) ?? source.cluster ?? rows[0].cluster,
        })),
      }))
    : [];
  return {
    total,
    projectGroups,
    groups: [...groups]
      .map(([cluster, rows]) => ({
        cluster,
        ...(includeRows ? { rows } : {}),
        count: new Set(
          rows.map((row) => `${row.role}:${row.timestamp}:${row.text}`),
        ).size,
        sessions: new Set(rows.map((r) => r.session)).size,
        latest: rows[0].timestamp,
        sources: includeRows
          ? []
          : selectContext(
              db,
              rows,
              scope,
              totalBudget ? Math.floor(totalBudget / groups.size) : 22000,
              { diverse: !!totalBudget },
            ),
      }))
      .sort((a, b) => b.count - a.count),
  };
}
export function sampleEvidence(rows, limit = 14) {
  // Balanced across sessions and time, with recent user intent first; collapse fork duplicates.
  const unique = [];
  const seen = new Set();
  for (const row of rankRecent(rows, () => 1)) {
    const key = row.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const chosen = [],
    ids = new Set(),
    sessions = new Map();
  function add(row) {
    if (!row || ids.has(row.id) || chosen.length >= limit) return;
    ids.add(row.id);
    chosen.push(row);
    sessions.set(row.session, (sessions.get(row.session) || 0) + 1);
  }
  for (const row of unique)
    if (row.role === "user" && !sessions.has(row.session)) add(row);
  // Reserve half the budget for assistant evidence and earlier points in the work.
  if (chosen.length > Math.ceil(limit / 2)) {
    chosen.splice(Math.ceil(limit / 2));
    ids.clear();
    sessions.clear();
    for (const row of chosen) {
      ids.add(row.id);
      sessions.set(row.session, 1);
    }
  }
  for (let i = 0; i < Math.ceil(limit / 2); i++)
    add(
      unique[
        Math.floor(
          (i * Math.max(0, unique.length - 1)) /
            Math.max(1, Math.ceil(limit / 2) - 1),
        )
      ],
    );
  for (const row of unique) if ((sessions.get(row.session) || 0) < 3) add(row);
  for (const row of unique) add(row);
  return chosen;
}
export const topicSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    category: { type: "string", enum: categories },
    summary: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["text", "sourceIds"],
      },
    },
    openQuestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["text", "sourceIds"],
      },
    },
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["text", "sourceIds"],
      },
    },
    sourceIds: { type: "array", items: { type: "string" } },
  },
  required: [
    "title",
    "category",
    "summary",
    "decisions",
    "openQuestions",
    "nextSteps",
    "sourceIds",
  ],
};
export function cleanTopic(value, sources) {
  const valid = new Set(sources.map((s) => s.id));
  const ids = (value) =>
    Array.isArray(value)
      ? [...new Set(value.filter((id) => valid.has(id)))].slice(0, 6)
      : [];
  const str = (value, max) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const facts = (items) =>
    (Array.isArray(items) ? items : [])
      .slice(0, 4)
      .map((item) => ({
        text: str(item?.text, 600),
        sourceIds: ids(item?.sourceIds),
      }))
      .filter((item) => item.text && item.sourceIds.length);
  const sourceIds = ids(value?.sourceIds);
  if (
    !str(value?.title, 100) ||
    !str(value?.summary, 1800) ||
    !sourceIds.length
  )
    throw new Error(
      "The local model returned an uncited work summary. Retry generation.",
    );
  return {
    title: str(value.title, 100),
    category: categories.includes(value.category) ? value.category : "Mixed",
    summary: str(value.summary, 1800),
    decisions: facts(value.decisions),
    openQuestions: facts(value.openQuestions),
    nextSteps: facts(value.nextSteps),
    sourceIds,
  };
}
