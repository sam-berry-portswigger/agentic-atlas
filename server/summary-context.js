import { freshness, recencyReference } from "./recency.js";
import { usefulText } from "./evidence.js";
import { shortName, readableText } from "./names.js";
export const SUMMARY_CONTEXT_LIMIT = 12000;
export const SUMMARY_MAX_SOURCES = 16;
export const SUMMARY_POLICY = "recent-relevant-stream-v3-compact";
const stop = new Set(
  "the and for with from this that your work topic discussion conversations using into across overview".split(
    " ",
  ),
);
function terms(text) {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter(
      (word) => !stop.has(word),
    ),
  );
}
function block(row, index) {
  return `[${index + 1}] ${row.project} · ${shortName(row.title, 100)} · ${row.timestamp} · ${row.role} · session=${row.session}\n${row.text}`;
}
export function summaryContext(
  rows,
  {
    title = "",
    description = "",
    kind = "cluster",
    anchors = new Set(),
    limit = SUMMARY_CONTEXT_LIMIT,
  } = {},
) {
  const prefix = `<work_item kind=${JSON.stringify(kind)}>${JSON.stringify({ title: shortName(title, 160), scope: shortName(description, 300) })}</work_item>\n<conversations>\n`,
    suffix = "\n</conversations>";
  if (Math.min(limit, SUMMARY_CONTEXT_LIMIT) < prefix.length + suffix.length)
    throw new RangeError(
      "Summary context limit is too small for source metadata.",
    );
  const budget = Math.max(
    0,
    Math.min(limit, SUMMARY_CONTEXT_LIMIT) - prefix.length - suffix.length,
  );
  const subject = terms(title);
  const valid = rows.filter(
    (row) => usefulText(row.text) && readableText(row.text).length >= 35,
  );
  const latest = recencyReference(valid);
  const seen = new Set();
  const ranked = [...valid]
    .sort(
      (a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0),
    )
    .filter((row) => {
      const key = row.text.replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => {
      const words = terms(row.text);
      const relevance =
        [...subject].filter((word) => words.has(word)).length /
        Math.max(1, subject.size);
      const recency = freshness(row.timestamp, latest);
      const outcome =
        /\b(decided|agreed|fixed|verified|passed|failed|blocked|remaining|implemented|resolved|regression)\b/i.test(
          row.text,
        )
          ? 1
          : 0;
      return { row, score: 0.5 * relevance + 0.35 * recency + 0.15 * outcome };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.timestamp.localeCompare(a.row.timestamp) ||
        a.row.id.localeCompare(b.row.id),
    );
  const sources = [],
    blocks = [],
    ids = new Set(),
    sessions = new Map(),
    texts = new Set();
  let used = 0;
  function add(row, maxSession = 2, maxBudget = budget) {
    if (
      !row ||
      ids.has(row.id) ||
      texts.has(row.text.replace(/\s+/g, " ").trim()) ||
      sources.length >= SUMMARY_MAX_SOURCES ||
      (sessions.get(row.session) || 0) >= maxSession
    )
      return;
    const text = block(row, sources.length),
      cost = text.length + (blocks.length ? 2 : 0);
    if (used + cost > maxBudget) return;
    sources.push(row);
    blocks.push(text);
    ids.add(row.id);
    texts.add(row.text.replace(/\s+/g, " ").trim());
    sessions.set(row.session, (sessions.get(row.session) || 0) + 1);
    used += cost;
  }
  // Keep a small amount of defining evidence, leaving most capacity for the
  // most relevant recent outcomes and other conversations in this saved topic.
  for (const id of anchors) {
    add(
      valid.find((row) => row.id === id),
      2,
      budget * 0.35,
    );
    if (sources.length >= 2) break;
  }
  for (const { row } of ranked) add(row);
  for (const { row } of ranked) add(row, 4);
  const prompt = prefix + blocks.join("\n\n") + suffix;
  return {
    prompt,
    sources,
    selection: {
      passages: sources.length,
      conversations: new Set(sources.map((row) => row.session)).size,
      totalPassages: rows.length,
      promptChars: prompt.length,
      limit: Math.min(limit, SUMMARY_CONTEXT_LIMIT),
      latestEvidence:
        sources
          .map((row) => row.timestamp)
          .sort()
          .at(-1) || null,
    },
  };
}
