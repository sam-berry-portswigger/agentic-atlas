import { freshness, recencyReference } from "./recency.js";
import { cosine, getConfig, normalize, vectorArray } from "./db.js";
import { usefulText } from "./evidence.js";
import { scopeWhere } from "./scope.js";

const rankingCache = new WeakMap();

// Discussion intensity is an estimate, not time spent. Use existing embeddings
// to attribute content to work items; session titles and citation counts aren't votes.
export function orderFocus(
  items,
  rows,
  scope = {},
  now = Date.now(),
  seeds = rows,
) {
  const byId = new Map(seeds.map((row) => [row.id, row]));
  const candidates = items.map((item) => {
    const cited = (item.sourceIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean);
    const vectors = cited.filter((row) => row.vector).map((row) => row.vector);
    const center = vectors.length
      ? normalize(
          vectors[0].map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0)),
        )
      : null;
    return {
      item,
      center,
      projects: new Set(cited.map((row) => row.project)),
      score: 0,
    };
  });
  const reference = Math.min(now, recencyReference(rows, scope.end));
  const messages = new Map();
  const seenParts = new Set();
  for (const row of rows) {
    const instant = Date.parse(row.timestamp);
    if (
      !Number.isFinite(instant) ||
      (scope.start && instant < Date.parse(scope.start)) ||
      (scope.end && instant >= Date.parse(scope.end)) ||
      (scope.project && row.project !== scope.project) ||
      !usefulText(row.text) ||
      !row.vector
    )
      continue;
    const text = row.text.replace(/\s+/g, " ").trim();
    const partKey = JSON.stringify([row.project, row.role, text]);
    if (seenParts.has(partKey)) continue;
    seenParts.add(partKey);
    const key = JSON.stringify([
      row.project,
      row.session,
      row.role,
      row.timestamp,
    ]);
    if (!messages.has(key)) messages.set(key, { ...row, parts: new Map() });
    messages.get(key).parts.set(text, row.vector);
  }
  const seen = new Set();
  for (const message of messages.values()) {
    const parts = [...message.parts].sort(([a], [b]) => a.localeCompare(b));
    const text = parts.map(([text]) => text).join(" ");
    const key = JSON.stringify([message.project, message.role, text]);
    if (seen.has(key)) continue;
    seen.add(key);
    // A multi-topic planning session can support different work items. Assign
    // each passage by its content, never the whole session by its title.
    const shares = new Map();
    for (const [text, vector] of parts) {
      let best = null,
        similarity = 0.4;
      for (const candidate of candidates) {
        if (!candidate.center || !candidate.projects.has(message.project))
          continue;
        const score = cosine(vector, candidate.center);
        if (score > similarity) {
          best = candidate;
          similarity = score;
        }
      }
      if (best) shares.set(best, (shares.get(best) || 0) + text.length);
    }
    const recency = 1 + 0.18 * freshness(message.timestamp, reference);
    // Cap long replies so code dumps and chunk splitting can't dominate.
    const volume = Math.min(text.length, 2000) / 1000;
    for (const [candidate, characters] of shares)
      candidate.score += ((volume * characters) / text.length) * recency;
  }
  return candidates.sort((a, b) => b.score - a.score).map(({ item }) => item);
}

export function rankedFocus(db, scope, items) {
  if (items.length < 2) return items;
  if (!rankingCache.has(db)) rankingCache.set(db, new Map());
  const cache = rankingCache.get(db);
  const key = JSON.stringify(scope);
  const version = JSON.stringify([
    db.prepare("PRAGMA data_version").get(),
    db.prepare("SELECT total_changes() AS changes").get(),
    Math.floor(Date.now() / 3600000),
    items.map((item) => [item.id, item.sourceIds]),
  ]);
  const cached = cache.get(key);
  if (cached?.version === version) return cached.order.map((i) => items[i]);
  const model = getConfig(db).embeddingModel;
  const { sql, params } = scopeWhere(scope);
  const rows = db
    .prepare(
      `SELECT id,project,session,role,timestamp,text,vector
    FROM chunks WHERE ${sql} AND model=? AND vector IS NOT NULL ORDER BY timestamp DESC,id`,
    )
    .all(...params, model)
    .map((row) => ({ ...row, vector: vectorArray(row.vector) }));
  const lookup = db.prepare(
    "SELECT id,project,vector FROM chunks WHERE id=? AND model=? AND vector IS NOT NULL",
  );
  const seeds = [...new Set(items.flatMap((item) => item.sourceIds || []))]
    .map((id) => lookup.get(id, model))
    .filter(Boolean)
    .map((row) => ({ ...row, vector: vectorArray(row.vector) }));
  const ordered = orderFocus(items, rows, scope, Date.now(), seeds);
  cache.set(key, {
    version,
    order: ordered.map((item) => items.indexOf(item)),
  });
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return ordered;
}
