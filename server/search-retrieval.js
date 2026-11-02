import { rankRecent } from "./recency.js";
import { searchEvidence, scopedWhere, sourceFields } from "./retrieval.js";
import { uniqueEvidence, usefulText, machineText } from "./evidence.js";
const noise = new Set(
  "am i is are was were be been being a an the my me we our you your it its to for of on in at and or with do did does can could should would will have has had how what when where why ready merge merged status latest currently now still finished done resolved unresolved remaining check tell about work working outcome outcomes result results current final happened".split(
    " ",
  ),
);
export function subjectTerms(query) {
  const words = (
    query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || []
  ).filter((word) => !noise.has(word));
  return [
    ...new Set(
      words.map((word) =>
        /^licen[cs]/.test(word) ? "licens" : word.replace(/(?:ing|ed|s)$/, ""),
      ),
    ),
  ].slice(0, 10);
}
export function isStatusQuestion(query) {
  return (
    /\b(ready|status|latest|currently|unresolved|remaining|remains|blocked|outstanding|outcome|results?)\b/i.test(
      query,
    ) ||
    /\b(is|are|have|has|was|were|did|can|should|what|which)\b.*\b(resolved|finished|done|merged|merge|left|still|complete|completed)\b/i.test(
      query,
    )
  );
}

function identifiers(rows) {
  const found = new Map();
  for (const row of rows.slice(0, 12)) {
    for (const id of new Set(
      row.text.match(
        /\b(?:PR\s*#?\s*\d{3,7}|[A-Z][A-Z0-9]{1,10}-\d{3,7})\b/g,
      ) || [],
    )) {
      found.set(id, (found.get(id) || 0) + 1);
    }
  }
  return [...found]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id]) => id);
}

// Read the end of relevant conversations and recent mentions of their concrete IDs.
// This is a second retrieval pass: a short "passed" reply need not resemble the query.
export function latestSearchEvidence(db, matches, query, scope) {
  const terms = subjectTerms(query);
  if (!terms.length || !matches.length) return [];
  const { sql, params } = scopedWhere(scope);
  const ids = identifiers(matches);
  // Restrict cross-thread expansion to the projects actually supported by retrieval.
  let entityRows = [];
  const projects = [...new Set(matches.slice(0, 8).map((row) => row.project))];
  if (ids.length && projects.length) {
    const rows = db
      .prepare(
        `SELECT ${sourceFields} FROM chunks WHERE ${sql} AND project IN (${projects.map(() => "?").join(",")}) AND (${ids.map(() => "text LIKE ?").join(" OR ")}) ORDER BY julianday(timestamp) DESC,rowid DESC LIMIT 160`,
      )
      .all(...params, ...projects, ...ids.map((id) => `%${id}%`));
    const messages = new Map();
    entityRows = uniqueEvidence(rows)
      .filter((row) => !machineText(row.text))
      .filter((row) => {
        const key = `${row.session}:${row.role}:${row.timestamp}`;
        const count = messages.get(key) || 0;
        messages.set(key, count + 1);
        return count < 2;
      })
      .slice(0, 12);
  }
  const sessions = [
    ...new Map(
      [...entityRows, ...matches.slice(0, 24)].map((row) => [
        row.session,
        row.project,
      ]),
    ).entries(),
  ].slice(0, 8);
  const tails = [...entityRows];
  const select = db.prepare(
    `SELECT ${sourceFields} FROM chunks WHERE session=? AND project=? AND ${sql} AND ltrim(text) NOT LIKE '<task-notification>%' AND ltrim(text) NOT LIKE '<bash-input>%' ORDER BY julianday(timestamp) DESC,rowid DESC LIMIT 80`,
  );
  const related = (rows) =>
    rows.some((row) => {
      const text = row.text.toLowerCase().replace(/licenc/g, "licens");
      return terms.some((term) => text.includes(term));
    });
  for (const [session, project] of sessions) {
    const messages = new Map();
    const maxMessages = isStatusQuestion(query) ? 16 : 8;
    const rows = select.all(session, project, ...params).filter((row) => {
      if (machineText(row.text)) return false;
      const key = `${row.role}:${row.timestamp}`;
      if (!messages.has(key) && messages.size >= maxMessages) return false;
      const count = messages.get(key) || 0;
      messages.set(key, count + 1);
      return count < 2;
    });
    if (related(rows)) tails.push(...rows);
  }
  return uniqueEvidence(tails)
    .filter(
      (row) =>
        !machineText(row.text) && (usefulText(row.text) || row.role === "user"),
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 24);
}

export async function retrieveSearchEvidence(
  db,
  { query, hypothesis, signal, ...scope },
) {
  const terms = subjectTerms(query);
  const keywordQuery = terms
    .map((term) => (term === "licens" ? "license licence licensing" : term))
    .join(" ");
  const tasks = [searchEvidence(db, { ...scope, query, signal, limit: 30 })];
  if (hypothesis)
    tasks.push(
      searchEvidence(db, { ...scope, query, hypothesis, signal, limit: 30 }),
    );
  if (keywordQuery)
    tasks.push(
      searchEvidence(db, {
        ...scope,
        query: keywordQuery,
        mode: "keyword",
        signal,
        limit: 30,
      }),
    );
  const lists = await Promise.all(tasks);
  signal?.throwIfAborted();
  const combined = new Map();
  lists.forEach((list, pass) =>
    list.results.forEach((row, index) => {
      const previous = combined.get(row.id);
      const weight = pass === 0 ? 1.2 : hypothesis && pass === 1 ? 0.8 : 1;
      combined.set(row.id, {
        ...row,
        ...previous,
        retrievalScore:
          (previous?.retrievalScore || 0) + (20 * weight) / (60 + index + 1),
      });
    }),
  );
  const results = uniqueEvidence(
    rankRecent([...combined.values()], (row) => row.retrievalScore, scope.end),
  ).slice(0, 48);
  return {
    results,
    recent: latestSearchEvidence(db, results, query, scope),
    matched: Math.max(...lists.map((list) => list.matched)),
    passes: lists.length,
  };
}

// Status answers need the latest conversational state, not every old plan.
// Keep the latest topic-bearing assistant update per thread (all its chunks),
// preserving substantive review findings and decisions that still provide context.
// together with any subsequent user corrections. Other question types keep full context.
export function statusEvidence(sources, query) {
  const terms = subjectTerms(query);
  const latest = new Map();
  for (const row of sources) {
    const text = row.text.toLowerCase().replace(/licenc/g, "licens");
    if (row.role !== "assistant" || !terms.some((term) => text.includes(term)))
      continue;
    if (!latest.has(row.session) || row.timestamp > latest.get(row.session))
      latest.set(row.session, row.timestamp);
  }
  return sources.filter(
    (row) =>
      !latest.has(row.session) ||
      row.timestamp >= latest.get(row.session) ||
      (row.role === "assistant" &&
        /\b(?:must[ -]fix|review (?:found|identified)|review findings|confirmed (?:bug|blocker)|decided|agreed)\b/i.test(
          row.text,
        )),
  );
}

// A verification query has a different retrieval intent from similarity search:
// find later mentions of the item's distinctive vocabulary, even if a concise
// changed-scope decision is dissimilar to the original implementation plan.
export function latestSubjectEvidence(
  db,
  subject,
  query,
  scope,
  projects = [],
  seedText = "",
) {
  const where = scopedWhere(scope, null, "c"),
    projectSql = projects.length
      ? ` AND c.project IN (${projects.map(() => "?").join(",")})`
      : "",
    params = [...where.params, ...projects];
  const count = db.prepare(
    `SELECT count(*) AS n FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id WHERE chunks_fts MATCH ? AND ${where.sql}${projectSql}`,
  );
  const literal = (term) => `"${term.replaceAll('"', '""')}"`;
  const rawEntities = [
    ...[...seedText.matchAll(/`([a-zA-Z][a-zA-Z0-9_.-]{4,100})`/g)].map(
      (match) => match[1],
    ),
    ...(seedText.match(/\b[a-zA-Z][a-zA-Z0-9_]*(?:[-_.][a-zA-Z0-9_]+)+\b/g) ||
      []),
  ];
  const seeds = [...new Set(rawEntities.map((term) => term.toLowerCase()))]
    .map((term) => ({ term, n: count.get(literal(term), ...params).n }))
    .filter((item) => item.n > 0)
    .sort((a, b) => a.n - b.n)
    .slice(0, 6);
  const acronyms = new Set(
    (`${subject} ${query}`.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []).map((term) =>
      term.toLowerCase(),
    ),
  );
  let candidates = [
    ...new Set([...subjectTerms(subject), ...subjectTerms(query)]),
  ]
    .map((term) => ({ term, n: count.get(literal(term), ...params).n }))
    .filter((item) => item.n > 0);
  const entities = candidates.filter(
    (item) => /[\d_-]/.test(item.term) || acronyms.has(item.term),
  );
  candidates = (entities.length ? entities : candidates)
    .sort((a, b) => a.n - b.n)
    .slice(0, entities.length ? 3 : 1);
  const focuses = [
    ...new Map(
      [...seeds, ...candidates].map((item) => [item.term, item]),
    ).values(),
  ].slice(0, 9);
  if (!focuses.length) return [];
  const select = db.prepare(
    `SELECT ${sourceFields
      .split(",")
      .map((field) => `c.${field}`)
      .join(
        ",",
      )} FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id WHERE chunks_fts MATCH ? AND ${where.sql}${projectSql} ORDER BY julianday(c.timestamp) DESC,c.rowid DESC LIMIT 24`,
  );
  const rows = [];
  // Each observed identifier gets a small latest-mentions quota. A generic word
  // in a generated query cannot displace the source's actual entity vocabulary.
  for (const focus of focuses)
    rows.push(
      ...select
        .all(literal(focus.term), ...params)
        .filter((row) => !machineText(row.text))
        .slice(0, 4),
    );
  const seen = new Set();
  const ranked = rankRecent(rows, () => 1, scope.end).filter((row) => {
    const key = row.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const changed = (row) =>
    /\b(no longer|not needed|no need|on hold|sufficient|superseded|cancelled|deferred|nothing is needed|covers what)\b/i.test(
      row.text,
    )
      ? 1
      : 0;
  return ranked
    .sort((a, b) => changed(b) - changed(a) || b.rankScore - a.rankScore)
    .slice(0, 12);
}
