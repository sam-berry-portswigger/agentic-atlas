import { freshness, recencyReference, recentRelevance } from "./recency.js";
import { cosine, vectorArray } from "./db.js";

const sessionCache = new WeakMap();
// Keep retrieval as plain text + SQL. Conversation windows are small enough for local inference.
export function clearEvidenceCache(db) {
  sessionCache.delete(db);
}
export function machineText(text) {
  return /^\s*(?:\[Request interrupted|<local-command-|<task-notification>|<bash-input>|<tool_result>|<system-reminder>)/i.test(
    text,
  );
}
export function usefulText(text) {
  const value = text.trim();
  return (
    value.length >= 35 &&
    !machineText(value) &&
    !/^\[Request interrupted|^<local-command-|^\[Image #\d+\]\s*$|^(?:Review done; reporting|Hooks are in place|Now making the edits|Writing the UI|The diff is open)/i.test(
      value,
    )
  );
}
export function evidenceKey(row) {
  return `${row.role}:${row.timestamp}:${row.text.replace(/\s+/g, " ").trim()}`;
}
export function uniqueEvidence(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = evidenceKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function conversationWindow(
  db,
  anchor,
  scope,
  { before = 2, after = 4 } = {},
) {
  if (!sessionCache.has(db)) sessionCache.set(db, new Map());
  const cache = sessionCache.get(db),
    key = anchor.session + ":" + (scope.end || "");
  let rows = cache.get(key);
  if (!rows) {
    rows = db
      .prepare(
        `SELECT id,session,project,title,role,timestamp,text,rowid AS position FROM chunks WHERE session=? AND (?='' OR julianday(timestamp)<julianday(?)) ORDER BY julianday(timestamp),rowid`,
      )
      .all(anchor.session, scope.end || "", scope.end || "");
    cache.set(key, rows);
  }
  const index = rows.findIndex((row) => row.id === anchor.id);
  if (index < 0) return [];
  // Keep all chunks of the anchor message; also read the user's request and subsequent response.
  let left = index,
    right = index;
  while (
    left > 0 &&
    rows[left - 1].timestamp === anchor.timestamp &&
    rows[left - 1].role === anchor.role
  )
    left--;
  while (
    right + 1 < rows.length &&
    rows[right + 1].timestamp === anchor.timestamp &&
    rows[right + 1].role === anchor.role
  )
    right++;
  let window = rows
    .slice(Math.max(0, left - before), Math.min(rows.length, right + after + 1))
    .filter((row) => !machineText(row.text));
  if (window.reduce((n, row) => n + row.text.length, 0) > 9000) {
    window = rows.slice(
      Math.max(0, index - 1),
      Math.min(rows.length, index + 3),
    );
    const request = [...rows.slice(0, left)]
      .reverse()
      .find((row) => row.role === "user");
    if (request && !window.some((row) => row.id === request.id))
      window.unshift(request);
  }
  return window;
}
export function selectContext(
  db,
  rows,
  scope,
  budget = 22000,
  { diverse = false } = {},
) {
  const unique = uniqueEvidence(rows).filter((row) => usefulText(row.text));
  const now = recencyReference(unique, scope.end);
  const score = (row) => {
    const signal =
      /\b(decided|agreed|fixed|implemented|verified|passed|failed|blocked|still|remaining|next steps|done|commit|need to)\b/i.test(
        row.text,
      )
        ? 1
        : 0;
    return (
      Math.min(row.text.length, 1800) / 1800 +
      signal * 0.6 +
      freshness(row.timestamp, now) * 1.2
    );
  };
  // Prefer recent substantive outcomes and requests, while preserving a few representative earlier passages.
  const latest = [...unique].sort(
    (a, b) => score(b) - score(a) || b.timestamp.localeCompare(a.timestamp),
  );
  const anchors = [],
    perSession = new Map();
  for (const row of latest)
    if ((perSession.get(row.session) || 0) < 2) {
      anchors.push(row);
      perSession.set(row.session, (perSession.get(row.session) || 0) + 1);
    }
  if (diverse) {
    // Titles such as "Plan my day" are labels, not work identities. Read actual
    // requests per session, covering its beginning, recent intent and a different task.
    const sessions = [
      ...new Set(
        [...latest]
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .map((row) => row.session),
      ),
    ];
    const requests = db.prepare(
      `SELECT id,session,project,title,role,timestamp,text,rowid AS position FROM chunks WHERE session=? AND role='user' AND length(text)>=35 AND (?='' OR julianday(timestamp)>=julianday(?)) AND (?='' OR julianday(timestamp)<julianday(?)) ORDER BY timestamp,rowid`,
    );
    const pools = sessions.map((session) => {
      const turns = new Set();
      const candidates = uniqueEvidence(
        requests.all(
          session,
          scope.start || "",
          scope.start || "",
          scope.end || "",
          scope.end || "",
        ),
      ).filter((row) => {
        if (!usefulText(row.text) || turns.has(row.timestamp)) return false;
        turns.add(row.timestamp);
        return true;
      });
      const chosen = [candidates[0], candidates.at(-1)].filter(Boolean);
      const coveredTerms = new Set(
        chosen.flatMap((row) => issueTerms(row.text)),
      );
      const novelty = (row) => {
        const terms = issueTerms(row.text);
        return (
          terms.filter((term) => !coveredTerms.has(term)).length /
          Math.max(1, terms.length)
        );
      };
      const different = candidates
        .filter((row) => !chosen.some((c) => c.id === row.id))
        .sort(
          (a, b) =>
            novelty(b) - novelty(a) || b.timestamp.localeCompare(a.timestamp),
        )[0];
      if (different) chosen.push(different);
      return [...new Map(chosen.map((row) => [row.id, row])).values()];
    });
    const coverage = [];
    for (let pass = 0; pass < 3; pass++)
      for (const pool of pools) if (pool[pass]) coverage.push(pool[pass]);
    anchors.unshift(...coverage);
  }
  anchors.push(...latest);
  const sources = [],
    seen = new Set();
  let used = 0;
  for (const anchor of anchors) {
    if (seen.has(evidenceKey(anchor))) continue;
    let window = conversationWindow(db, anchor, scope);
    const costOf = (rows) =>
      rows.reduce((n, row) => n + row.text.length + 160, 0);
    const windowBudget = diverse
      ? Math.max(2000, Math.floor(budget / 4))
      : budget;
    if (costOf(window) > windowBudget)
      window = conversationWindow(db, anchor, scope, { before: 1, after: 1 });
    if (costOf(window) > windowBudget)
      window = conversationWindow(db, anchor, scope, { before: 0, after: 1 });
    if (diverse && costOf(window) > windowBudget)
      window = window.filter((row) => row.id === anchor.id);
    const fresh = uniqueEvidence(window).filter(
      (row) => !seen.has(evidenceKey(row)),
    );
    const cost = fresh.reduce((n, row) => n + row.text.length + 160, 0);
    // Never cut a passage in half to fit: choose another complete, smaller window instead.
    if (!fresh.length || used + cost > budget) continue;
    for (const row of fresh) {
      seen.add(evidenceKey(row));
      sources.push(row);
    }
    used += cost;
    if (used > budget * 0.9) break;
  }
  return sources.sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      (a.position || 0) - (b.position || 0),
  );
}
const stopWords = new Set(
  "the and for with this that what which how should could would does did have has was were are from into about your you our their them they work need question unresolved whether current changes change specific elsewhere codebase".split(
    " ",
  ),
);
export function issueTerms(text) {
  return [
    ...new Set(
      (text.match(/[\p{L}\p{N}_./-]{3,}/gu) || [])
        .map((x) => x.toLowerCase())
        .filter((x) => !stopWords.has(x)),
    ),
  ].slice(0, 14);
}
export function retrieveFollowups(
  db,
  fact,
  sources,
  scope,
  queryVector,
  budget = 10000,
) {
  const cited = sources.filter((s) => fact.sourceIds.includes(s.id));
  if (!cited.length) return [];
  const projects = [...new Set(cited.map((s) => s.project))];
  const terms = issueTerms(fact.text);
  const since =
    typeof fact.since === "string"
      ? fact.since
      : cited
          .map((s) => s.timestamp)
          .filter(Boolean)
          .sort()[0] || "";
  const rows = db
    .prepare(
      `SELECT id,session,project,title,role,timestamp,text,vector FROM chunks WHERE project IN (${projects.map(() => "?").join(",")}) AND (?='' OR julianday(timestamp)>=julianday(?)) AND (?='' OR julianday(timestamp)<julianday(?)) ORDER BY timestamp DESC`,
    )
    .all(...projects, since, since, scope.end || "", scope.end || "");
  const relevant = uniqueEvidence(rows)
    .filter((row) => usefulText(row.text))
    .map((row) => {
      const text = row.text.toLowerCase();
      const matches = terms.filter((term) => text.includes(term)).length;
      const similarity =
        row.vector && queryVector
          ? cosine(queryVector, vectorArray(row.vector))
          : 0;
      return {
        ...row,
        similarity,
        matches,
        relevance: similarity + Math.min(matches, 5) * 0.06,
      };
    })
    .filter(
      (row) =>
        row.matches >= 2 ||
        row.similarity >= 0.5 ||
        (terms.length === 1 && row.matches === 1),
    );
  const best = relevant.reduce((n, row) => Math.max(n, row.relevance), 0);
  // Recency breaks ties among genuinely related passages; unrelated new messages cannot win by date alone.
  const recent = relevant
    .filter((row) => row.relevance >= best - 0.18)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const reference = recencyReference(relevant, scope.end);
  const ranked = [...relevant].sort(
    (a, b) =>
      recentRelevance(b.relevance, b.timestamp, reference) -
      recentRelevance(a.relevance, a.timestamp, reference),
  );
  const anchors = [
    cited[0],
    ...recent.slice(0, 4),
    ...cited.slice(1),
    ...ranked.slice(0, 4),
  ];
  const found = [],
    seen = new Set();
  let used = 0;
  for (const anchor of anchors) {
    let window = conversationWindow(db, anchor, scope, { before: 1, after: 3 });
    const costOf = (rows) =>
      rows.reduce((n, row) => n + row.text.length + 160, 0);
    // Reserve room for a later outcome even when the original discussion is long.
    if (costOf(window) > budget / 2)
      window = conversationWindow(db, anchor, scope, { before: 0, after: 1 });
    if (costOf(window) > budget / 2)
      window = window.filter((row) => row.id === anchor.id);
    const fresh = uniqueEvidence(window).filter(
      (row) => !seen.has(evidenceKey(row)),
    );
    const cost = fresh.reduce((n, row) => n + row.text.length + 160, 0);
    if (used + cost > budget) continue;
    for (const row of fresh) {
      seen.add(evidenceKey(row));
      found.push(row);
    }
    used += cost;
  }
  return found.sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      (a.position || 0) - (b.position || 0),
  );
}
export function cleanVerdict(verdict, evidence) {
  const source = evidence.find((row) => row.id === verdict.sourceId);
  const quote = typeof verdict.quote === "string" ? verdict.quote.trim() : "";
  const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    !source ||
    quote.length < 12 ||
    !normalize(source.text).includes(normalize(quote))
  )
    return {
      status: "unclear",
      reason: "No supporting quotation was returned.",
      sourceIds: [],
    };
  const aside =
    /\b(?:I (?:did not|didn't|have not|haven't) (?:check|inspect|verify|look)|if you want|should I (?:commit|push)|tell me (?:next|whether))\b/i.test(
      quote,
    );
  const status = [
    "open",
    "resolved",
    "superseded",
    "unclear",
    "not_actionable",
  ].includes(verdict.status)
    ? verdict.status
    : "unclear";
  if (
    status === "resolved" &&
    /\b(?:I['’]ll|I will|we will|we['’]ll|going to|plan to)\b/i.test(quote) &&
    !/\b(?:completed|verified|passed|resolved|cancelled|stopped|reverted|finished|accepted|merged)\b/i.test(
      quote,
    )
  )
    return {
      status: "unclear",
      reason:
        "The quotation describes intended action, not a confirmed outcome.",
      sourceIds: [source.id],
    };
  if (
    status === "open" &&
    (aside || !["user_commitment", "observed_blocker"].includes(verdict.kind))
  )
    return {
      status: "not_actionable",
      reason:
        "An assistant caveat or permission question is not an agreed work item.",
      sourceIds: [source.id],
    };
  if (
    status === "open" &&
    verdict.kind === "user_commitment" &&
    source.role !== "user" &&
    !/\byou (?:asked|chose|decided|requested|agreed|said)\b/i.test(quote)
  )
    return {
      status: "unclear",
      reason: "No explicit user commitment could be cited.",
      sourceIds: [source.id],
    };
  if (
    status === "open" &&
    verdict.kind === "observed_blocker" &&
    !/\b(fail(?:s|ed|ing|ure)?|block(?:ed|er|ing)?|broken|error|cannot|can.t|unable|still missing|not working)\b/i.test(
      quote,
    )
  )
    return {
      status: "unclear",
      reason: "The evidence does not establish an observed blocker.",
      sourceIds: [source.id],
    };
  return {
    status,
    reason:
      typeof verdict.reason === "string" ? verdict.reason.slice(0, 450) : "",
    sourceIds: [source.id],
    quote,
    lastEvidenceAt: source.timestamp,
  };
}
