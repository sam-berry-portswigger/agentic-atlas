import { UMAP } from "umap-js";
export const PROJECTION_POLICY = "embedding-neighborhood-v2";
function random(seed = 42) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function normalizeProjection(points) {
  if (!points.length) return [];
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys),
    span = Math.max(right - left, bottom - top) || 1;
  return points.map(([x, y]) => [
    Math.max(0, Math.min(1, (x - (left + right) / 2) / span + 0.5)),
    Math.max(0, Math.min(1, (y - (top + bottom) / 2) / span + 0.5)),
  ]);
}
// Exact cosine neighbours of every plotted embedding. A subsample changes the
// neighbourhood being measured and can hide local projection errors.
export function projectionReference(vectors, labels) {
  const n = vectors.length;
  const normalized = vectors.map((v) => {
    const norm = Math.hypot(...v) || 1;
    return Float64Array.from(v, (value) => value / norm);
  });
  const distances = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++) {
      let dot = 0;
      for (let d = 0; d < normalized[i].length; d++)
        dot += normalized[i][d] * normalized[j][d];
      distances[i][j] = distances[j][i] = Math.max(0, 1 - dot);
    }
  const ordered = distances.map((row, i) =>
    Array.from({ length: n }, (_, j) => j)
      .filter((j) => j !== i)
      .sort((a, b) => row[a] - row[b] || a - b),
  );
  const ranks = ordered.map((row) => {
    const result = new Int32Array(n);
    row.forEach((j, rank) => (result[j] = rank + 1));
    return result;
  });
  return {
    indices: Array.from({ length: n }, (_, i) => i),
    k: Math.min(10, n - 1),
    neighbors: ordered.map((row) => row.slice(0, Math.min(100, n - 1))),
    ranks,
    distances,
    labels,
  };
}
export function projectionMetrics(points, reference) {
  const { indices, k, neighbors, labels, ranks } = reference,
    n = indices.length;
  if (k < 1)
    return {
      samples: n,
      neighborRecall: 1,
      topicCohesion: 1,
      originalCohesion: 1,
      neighborRecall30: 1,
      trustworthiness: 1,
      trustworthiness30: 1,
      topicComponents: n,
      largestTopicFraction: 1,
    };
  const nearest = indices.map((i) =>
    indices
      .filter((j) => j !== i)
      .sort(
        (a, b) =>
          (points[i][0] - points[a][0]) ** 2 +
            (points[i][1] - points[a][1]) ** 2 -
            ((points[i][0] - points[b][0]) ** 2 +
              (points[i][1] - points[b][1]) ** 2) || a - b,
      )
      .slice(0, Math.min(30, n - 1)),
  );
  const at = (size) => {
    let recall = 0,
      cohesion = 0,
      original = 0,
      penalty = 0;
    indices.forEach((i, index) => {
      const expected = new Set(neighbors[index].slice(0, size));
      for (const j of nearest[index].slice(0, size)) {
        recall += expected.has(j);
        cohesion += labels?.[j] === labels?.[i];
        penalty += Math.max(0, ranks[index][j] - size);
      }
      original += neighbors[index]
        .slice(0, size)
        .filter((j) => labels?.[j] === labels?.[i]).length;
    });
    return {
      recall: recall / (n * size),
      cohesion: cohesion / (n * size),
      original: original / (n * size),
      trust:
        2 * n - 3 * size - 1 > 0
          ? 1 - (2 * penalty) / (n * size * (2 * n - 3 * size - 1))
          : 1,
    };
  };
  const local = at(k),
    wide = at(Math.min(30, n - 1));
  const parent = indices.slice(),
    root = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
  nearest.forEach((row, i) =>
    row.slice(0, k).forEach((j) => {
      if (labels?.[j] === labels?.[i]) parent[root(j)] = root(i);
    }),
  );
  const components = new Map(),
    topicLargest = new Map();
  indices.forEach((i) => {
    const r = root(i);
    components.set(r, (components.get(r) || 0) + 1);
  });
  for (const [i, size] of components)
    topicLargest.set(
      labels?.[i],
      Math.max(topicLargest.get(labels?.[i]) || 0, size),
    );
  return {
    samples: n,
    neighborRecall: local.recall,
    neighborRecall30: wide.recall,
    trustworthiness: local.trust,
    trustworthiness30: wide.trust,
    topicCohesion: local.cohesion,
    topicCohesion30: wide.cohesion,
    originalCohesion: local.original,
    originalCohesion30: wide.original,
    topicComponents: components.size,
    largestTopicFraction:
      Array.from(topicLargest.values()).reduce((a, b) => a + b, 0) / n,
  };
}
// Labels are diagnostics only, including when comparing experimental layouts.
export function chooseProjection(candidates) {
  return candidates.reduce(
    (best, candidate) =>
      !best || candidate.metrics.neighborRecall > best.metrics.neighborRecall
        ? candidate
        : best,
    null,
  );
}
export async function projectTopics(
  vectors,
  labels,
  { send = () => {}, isStopped = () => false } = {},
) {
  if (vectors.length < 3)
    return {
      points: normalizeProjection(vectors.map((_, i) => [i, 0])),
      policy: PROJECTION_POLICY,
      candidates: [],
      selected: "small-sample",
    };
  send("projecting", 0, 1000, "Building exact embedding neighbourhoods");
  const reference = projectionReference(vectors, labels);
  if (isStopped()) throw new Error("Projection cancelled.");
  // Measured on the map's 1,800 embeddings against PCA, t-SNE, PaCMAP and
  // UMAP settings. More neighbours retain broader connections; more negative
  // samples and epochs improve fidelity without consulting topic assignments.
  const name = "semantic-exact-100",
    nNeighbors = Math.min(100, vectors.length - 1);
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist: 0.08,
    nEpochs: 1000,
    negativeSampleRate: 30,
    random: random(),
  });
  umap.setPrecomputedKNN(
    reference.neighbors.map((row, i) => [i, ...row].slice(0, nNeighbors)),
    reference.neighbors.map((row, i) =>
      [0, ...row.map((j) => reference.distances[i][j])].slice(0, nNeighbors),
    ),
  );
  const points = normalizeProjection(
    await umap.fitAsync(
      vectors.map((v) => Array.from(v)),
      (epoch) => {
        if (epoch % 30 === 0)
          send(
            "projecting",
            epoch,
            1000,
            "Preserving embedding neighbourhoods",
          );
        return !isStopped();
      },
    ),
  );
  if (isStopped()) throw new Error("Projection cancelled.");
  return {
    points,
    policy: PROJECTION_POLICY,
    selected: name,
    candidates: [
      {
        name,
        parameters: {
          algorithm: "umap",
          metric: "cosine",
          neighborSearch: "exact",
          nNeighbors,
          minDist: 0.08,
          nEpochs: 1000,
          negativeSampleRate: 30,
          seed: 42,
        },
        metrics: projectionMetrics(points, reference),
      },
    ],
  };
}
