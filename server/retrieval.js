import { rankRecent } from "./recency.js";
import { getConfig, normalize, cosine, vectorArray } from "./db.js";
import { parseScope, scopeWhere } from "./scope.js";
import { ollama, queryInput, documentInput } from "./ollama.js";
export const sourceFields = "id,session,project,title,role,timestamp,text";

// The web UI and MCP adapter rank the same original vectors. No map coordinates
// or generated summaries enter retrieval, and caller-supplied HyDE is never evidence.
export async function embedQuery(db, query, { hypothesis, signal } = {}) {
  const model = getConfig(db).embeddingModel;
  const embedded = await ollama(
    "embed",
    {
      model,
      input: hypothesis
        ? documentInput(model, hypothesis, "Hypothetical answer")
        : queryInput(model, query),
      keep_alive: "10m",
    },
    180000,
    signal,
  );
  const values = embedded.embeddings?.[0];
  if (!values?.length || values.some((x) => !Number.isFinite(x)))
    throw new Error(
      "The local embedding model returned no valid query vector.",
    );
  return normalize(values);
}
export function scopedWhere(scope, allowedProjects = null, alias = "") {
  const { sql, params } = scopeWhere(parseScope(scope));
  const prefix = alias ? `${alias}.` : "";
  const base = alias ? scopeWhere(parseScope(scope), alias) : { sql, params };
  if (!allowedProjects) return base;
  if (scope.project && !allowedProjects.includes(scope.project))
    throw new Error("This project is not available through this MCP server.");
  return {
    sql: `(${base.sql}) AND ${prefix}project IN (${allowedProjects.map(() => "?").join(",")})`,
    params: [...base.params, ...allowedProjects],
  };
}
export async function searchEvidence(
  db,
  {
    query,
    mode = "semantic",
    hypothesis,
    limit = 12,
    project = "",
    start = "",
    end = "",
    allowedProjects = null,
    streamId,
    signal,
  },
) {
  if (typeof query !== "string" || !query.trim() || query.length > 4000)
    throw new Error("Enter a search query up to 4,000 characters.");
  if (!["semantic", "keyword", "hybrid"].includes(mode))
    throw new Error("Unknown search mode.");
  if (
    hypothesis !== undefined &&
    (typeof hypothesis !== "string" || hypothesis.length > 6000)
  )
    throw new Error(
      "Hypothetical passages must be text up to 6,000 characters.",
    );
  const scope = {
    project,
    start,
    end,
    ...(streamId !== undefined ? { streamId } : {}),
  };
  const { sql, params } = scopedWhere(scope, allowedProjects);
  const model = getConfig(db).embeddingModel;
  const count = db
    .prepare(`SELECT count(*) AS n FROM chunks WHERE ${sql}`)
    .get(...params).n;
  const semantic = [],
    lexical = [];
  if (mode !== "keyword") {
    const rows = db
      .prepare(
        `SELECT ${sourceFields},vector FROM chunks WHERE ${sql} AND model=? AND vector IS NOT NULL`,
      )
      .all(...params, model);
    if (rows.length) {
      const vector = await embedQuery(db, query, { hypothesis, signal });
      for (const { vector: blob, ...row } of rows)
        semantic.push({ ...row, score: cosine(vector, vectorArray(blob)) });
      semantic.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    } else if (count)
      throw new Error(
        "Sync sessions first: this scope has no embeddings for the configured model. Keyword search is available without Ollama.",
      );
  }
  if (mode !== "semantic") {
    // Escape every token as a literal FTS term; callers cannot inject FTS syntax.
    const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].slice(
      0,
      32,
    );
    if (terms.length) {
      const where = scopedWhere(scope, allowedProjects, "c");
      lexical.push(
        ...db
          .prepare(
            `SELECT ${sourceFields
              .split(",")
              .map((f) => `c.${f}`)
              .join(
                ",",
              )},bm25(chunks_fts) AS keywordScore FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id WHERE chunks_fts MATCH ? AND ${where.sql} ORDER BY keywordScore,c.id`,
          )
          .all(terms.map((t) => `"${t}"`).join(" OR "), ...where.params),
      );
    }
  }
  let ranked;
  if (mode === "hybrid") {
    const fused = new Map();
    for (const list of [semantic, lexical])
      list.forEach((row, index) => {
        const prior = fused.get(row.id);
        fused.set(row.id, {
          ...prior,
          ...row,
          rankScore: (prior?.rankScore || 0) + 1 / (60 + index + 1),
        });
      });
    ranked = [...fused.values()].sort(
      (a, b) => b.rankScore - a.rankScore || a.id.localeCompare(b.id),
    );
  } else ranked = mode === "semantic" ? semantic : lexical;
  const maximum = ranked.reduce(
    (max, row) =>
      Math.max(
        max,
        mode === "hybrid"
          ? row.rankScore
          : mode === "keyword"
            ? -row.keywordScore
            : row.score,
      ),
    1e-12,
  );
  ranked = rankRecent(
    ranked,
    (row) =>
      mode === "semantic"
        ? row.score
        : (mode === "hybrid" ? row.rankScore : -row.keywordScore) / maximum,
    end,
  );
  const seen = new Set();
  const unique = ranked.filter((row) => {
    const key = row.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    results: unique.slice(0, Math.min(30, Math.max(1, Number(limit) || 12))),
    matched: unique.length,
    scopeCount: count,
  };
}
