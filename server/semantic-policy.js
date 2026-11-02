import { cosine, normalize, vectorArray } from "./db.js";

export const SEMANTIC_POLICY = "semantic-clusters-v5";
export const LEGACY_SEMANTIC_POLICY = "semantic-clusters-v3";
export const OTHER_DESCRIPTION =
  "Activity not yet assigned confidently to a sustained work stream.";

// Reserved residual labels from older catalogues are not substantive goals.
export function isFallback(topic) {
  return (
    topic.background === true ||
    /^(background|other(?: sessions)?)$/i.test(topic.name || "")
  );
}

export function semanticAnchors(previous) {
  return previous
    .filter((p) => !isFallback(p))
    .map((p) => ({
      ...p,
      center: p.center || vectorArray(p.centroid),
      background: false,
      rows: [],
    }));
}

// Use the same cosine ambiguity margin already used for competing exemplars.
// A low affinity is residual work, not a competing "Background" centroid.
export function closestSemanticGroup(vector, groups) {
  const scores = groups
    .filter((g) => !isFallback(g))
    .map((group) => ({
      group,
      score: cosine(vector, group.center),
    }))
    .sort((a, b) => b.score - a.score);
  if (
    !scores.length ||
    scores[0].score < 0.45 ||
    (scores[1] && scores[0].score - scores[1].score < 0.04)
  )
    return null;
  return scores[0].group;
}

// Refine individual conversations with nearby, independently represented
// conversations. Coarse naming candidates never determine final membership.
export function semanticConversationGroup(vector, groups) {
  const normal = groups.filter((g) => !isFallback(g));
  const neighbors = normal
    .flatMap((group) =>
      (group.references || []).map((r) => ({
        group,
        score: cosine(vector, r.vector),
        key: r.evidenceKey || r.session,
      })),
    )
    .sort((a, b) => b.score - a.score);
  const seen = new Set();
  const distinctGroups = new Map();
  for (const neighbor of neighbors)
    if (!distinctGroups.has(neighbor.group))
      distinctGroups.set(neighbor.group, neighbor);
  const closest = [...distinctGroups.values()];
  if (
    closest[0]?.score >= 0.82 &&
    (!closest[1] || closest[0].score - closest[1].score >= 0.05)
  )
    return closest[0].group;
  const local = neighbors
    .filter((n) => {
      if (seen.has(n.key)) return false;
      seen.add(n.key);
      return n.score >= 0.55 && n.score >= neighbors[0].score - 0.06;
    })
    .slice(0, 7);
  const votes = new Map();
  for (const n of local)
    votes.set(n.group, (votes.get(n.group) || 0) + (n.score - 0.45) ** 2);
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, weight]) => sum + weight, 0);
  if (
    ranked.length &&
    local.length >= 2 &&
    local[0].score >= 0.65 &&
    ranked[0][1] / total >= 0.7
  )
    return ranked[0][0];
  const confident = closestSemanticGroup(vector, normal);
  if (confident) return confident;
  const affinities = normal
    .map((group) => ({ group, score: cosine(vector, group.center) }))
    .sort((a, b) => b.score - a.score);
  // Close alternatives inside the same semantic neighbourhood are a fine-grain
  // choice, not evidence that the conversation is unrelated to every stream.
  if (affinities[0]?.score >= 0.5 && affinities[1]) {
    const [a, b] = affinities.map((r) => r.group);
    const related = cosine(a.center, b.center);
    const mutualNeighbors =
      related >= 0.7 &&
      [a, b].every((group) =>
        normal
          .filter((g) => g !== a && g !== b)
          .every((g) => cosine(group.center, g.center) < related),
      );
    if (mutualNeighbors) return a;
  }
  return null;
}

export function meanVector(rows) {
  return normalize(
    rows.reduce((sum, r) => {
      r.vector.forEach((v, i) => {
        sum[i] += v;
      });
      return sum;
    }, new Float64Array(rows[0].vector.length)),
  );
}
