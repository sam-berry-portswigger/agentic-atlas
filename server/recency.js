// Shared retrieval policy. Relevance remains the gate; age can change a score
// by at most 18%, so unrelated recent text cannot beat a strong match by date.
export const RECENCY_HALF_LIFE_DAYS = 30;
export const RECENCY_WEIGHT = 0.18;
export function recencyReference(rows, end = "") {
  const cutoff = Date.parse(end);
  return rows.reduce((latest, row) => {
    const date = Date.parse(row.timestamp);
    return Number.isFinite(date) && (!Number.isFinite(cutoff) || date < cutoff)
      ? Math.max(latest, date)
      : latest;
  }, 0);
}
export function freshness(timestamp, reference) {
  const date = Date.parse(timestamp);
  if (!Number.isFinite(date) || !reference) return 0;
  return Math.exp(
    (-Math.LN2 * Math.max(0, reference - date)) /
      (86400000 * RECENCY_HALF_LIFE_DAYS),
  );
}
export function recentRelevance(relevance, timestamp, reference) {
  return (
    Math.max(0, Number(relevance) || 0) *
    (1 - RECENCY_WEIGHT + RECENCY_WEIGHT * freshness(timestamp, reference))
  );
}
export function rankRecent(rows, relevance, end = "") {
  const reference = recencyReference(rows, end);
  return rows
    .map((row) => ({
      ...row,
      recency: freshness(row.timestamp, reference),
      rankScore: recentRelevance(relevance(row), row.timestamp, reference),
    }))
    .sort(
      (a, b) =>
        b.rankScore - a.rankScore ||
        (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0) ||
        a.id.localeCompare(b.id),
    );
}
