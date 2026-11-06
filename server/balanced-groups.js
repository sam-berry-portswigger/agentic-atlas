import { cosine } from "./db.js";
import { averageVectors } from "./conversation-vectors.js";
import { shortName } from "./names.js";
import { isFallback, OTHER_DESCRIPTION } from "./semantic-policy.js";

// Reuse the classifier's established strong-neighbour affinity. Complete-link
// support prevents a sequence of individually plausible matches from joining
// unrelated work through a bridge conversation.
export const OBJECTIVE_AFFINITY = 0.65;
export function balancedObjectiveTopics(conversations) {
  const clear = conversations
    .filter((c) => !c.objectiveUnclear)
    .sort((a, b) => a.session.localeCompare(b.session));
  const similarities = clear.map(() => new Float32Array(clear.length));
  const edges = [];
  for (let i = 0; i < clear.length; i++)
    for (let j = i + 1; j < clear.length; j++) {
      const score = cosine(clear[i].vector, clear[j].vector);
      similarities[i][j] = similarities[j][i] = score;
      if (score >= OBJECTIVE_AFFINITY) edges.push({ i, j, score });
    }
  edges.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const owners = clear.map((_, i) => i),
    groups = new Map(clear.map((_, i) => [i, [i]]));
  for (const { i, j } of edges) {
    const a = owners[i],
      b = owners[j];
    if (a === b) continue;
    const left = groups.get(a),
      right = groups.get(b);
    if (
      !left.every((x) =>
        right.every((y) => similarities[x][y] >= OBJECTIVE_AFFINITY),
      )
    )
      continue;
    left.push(...right);
    for (const index of right) owners[index] = a;
    groups.delete(b);
  }
  const topics = [...groups.values()].map((indices) => {
    const members = indices.map((i) => clear[i]),
      center = averageVectors(members);
    const representative = [...members].sort(
      (a, b) =>
        cosine(b.vector, center) - cosine(a.vector, center) ||
        a.session.localeCompare(b.session),
    )[0];
    return {
      name: shortName(representative.objective, 80),
      description: representative.objective,
      center,
      rows: members.flatMap((c) => c.rows),
      references: members,
      background: false,
      sessionLabels: [],
    };
  });
  const unclear = conversations.filter((c) => c.objectiveUnclear);
  if (unclear.length)
    topics.push({
      name: "Other sessions",
      description: OTHER_DESCRIPTION,
      center: averageVectors(unclear),
      rows: unclear.flatMap((c) => c.rows),
      background: true,
      sessionLabels: [],
    });
  return topics;
}

export function balancedObjectiveGroup(conversation, topics) {
  if (conversation.objectiveUnclear) return null;
  const ranked = topics
    .filter((t) => !isFallback(t) && t.references?.length)
    .map((topic) => ({
      topic,
      score: Math.min(
        ...topic.references.map((r) => cosine(conversation.vector, r.vector)),
      ),
    }))
    .filter((r) => r.score >= OBJECTIVE_AFFINITY)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 0.04))
    return null;
  return ranked[0].topic;
}
