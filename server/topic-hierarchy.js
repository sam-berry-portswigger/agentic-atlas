import { createHash } from "node:crypto";
import { cosine, normalize, vectorArray } from "./db.js";
import { embedStreamScopes } from "./semantic-scopes.js";
import { isFallback } from "./semantic-policy.js";

const POLICY = "topic-hierarchy-v8";
const KEY = "topic_hierarchy";
const cache = new WeakMap();
const generic = new Set(
  "a an and are as at be by for from in into is it of on or that the their this to using with work working develop developing development implement implementation investigate investigating review reviewing test tests testing verify complete changes change features functionality refactor refactoring refine refining update management planning system code independent execute validate ensuring including following established prior efforts reproduce reproducing document documenting fix fixing tasks task agentic agents agent stream streams performance metrics visualization content multi full available reported current local generic specific related".split(
    " ",
  ),
);
const words = (text) =>
  (text.replace(/[-–—]/g, " ").match(/[\p{L}][\p{L}\p{N}]*/gu) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !generic.has(w));
const stem = (w) =>
  w
    .replace(/licenc/g, "licens")
    .replace(/(?:ing|s)$/g, "")
    .replace(/e$/g, "");
const signature = (topics) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        POLICY,
        topics.map((t) => [t.id, t.name, t.description]),
      ]),
    )
    .digest("hex");
function centered(vectors) {
  const mean = vectors[0].map(
    (_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length,
  );
  return vectors.map((v) => normalize(v.map((x, i) => x - mean[i])));
}
function label(members, vocabulary) {
  if (members.length === 1) return members[0].name;
  const counts = new Map(),
    spelling = new Map();
  for (const t of members)
    for (const word of new Set(words(t.name))) {
      const key = stem(word);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!spelling.has(key)) spelling.set(key, word);
    }
  const ranked = [...counts]
    .filter(([, count]) => count > 1)
    .sort(
      (a, b) =>
        b[1] *
          Math.log(
            1 + vocabulary.total / (vocabulary.frequency.get(b[0]) || 1),
          ) -
          a[1] *
            Math.log(
              1 + vocabulary.total / (vocabulary.frequency.get(a[0]) || 1),
            ) ||
        members.flatMap((t) => words(t.name).map(stem)).indexOf(a[0]) -
          members.flatMap((t) => words(t.name).map(stem)).indexOf(b[0]),
    );
  const phrases = new Map();
  for (const t of members) {
    const tokens =
      t.name.replace(/[-–—]/g, " ").match(/[\p{L}][\p{L}\p{N}]*/gu) || [];
    const used = new Set();
    for (let size = 2; size <= 4; size++)
      for (let i = 0; i + size <= tokens.length; i++) {
        const phrase = tokens.slice(i, i + size),
          significant = phrase.filter((w) => words(w).length > 0);
        if (
          significant.length < 2 ||
          generic.has(phrase[0].toLowerCase()) ||
          generic.has(phrase.at(-1).toLowerCase())
        )
          continue;
        const key = phrase.map((w) => w.toLowerCase()).join(" ");
        if (used.has(key)) continue;
        used.add(key);
        const old = phrases.get(key) || {
          text: phrase.join(" "),
          count: 0,
          terms: significant,
        };
        old.count++;
        phrases.set(key, old);
      }
  }
  const phrase = [...phrases.values()]
    .filter(
      (p) =>
        p.count > 1 &&
        p.terms.every(
          (w) =>
            (counts.get(stem(w.toLowerCase())) || 0) / members.length >= 0.25,
        ),
    )
    .sort(
      (a, b) =>
        (b.count *
          b.terms.reduce(
            (sum, w) =>
              sum +
              Math.log(
                1 +
                  vocabulary.total /
                    (vocabulary.frequency.get(stem(w.toLowerCase())) || 1),
              ),
            0,
          )) /
          b.terms.length -
        (a.count *
          a.terms.reduce(
            (sum, w) =>
              sum +
              Math.log(
                1 +
                  vocabulary.total /
                    (vocabulary.frequency.get(stem(w.toLowerCase())) || 1),
              ),
            0,
          )) /
          a.terms.length,
    )[0];
  if (phrase) return phrase.text[0].toUpperCase() + phrase.text.slice(1);
  const selected = ranked.slice(0, 3).map(([key]) => spelling.get(key));
  return selected.length
    ? selected
        .map((w) =>
          w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
        )
        .join(" · ")
    : null;
}

// A small, deterministic presentation layer. No archive scan, text generation,
// embedding request, coordinate change, or conversation reassignment.
export function groupTopics(topics, previous = []) {
  const normal = topics
    .filter((t) => !isFallback(t))
    .sort((a, b) => a.id - b.id);
  if (!normal.length) return [];
  const evidence = centered(normal.map((t) => Array.from(t.vector)));
  const scope = centered(normal.map((t) => Array.from(t.scope || t.vector)));
  const frequency = new Map();
  const tokens = normal.map(
    (t) => new Set(words(t.name + " " + t.description).map(stem)),
  );
  for (const set of tokens)
    for (const word of set) frequency.set(word, (frequency.get(word) || 0) + 1);
  const namedFrequency = new Map();
  for (const topic of normal)
    for (const word of new Set(words(topic.name).map(stem)))
      namedFrequency.set(word, (namedFrequency.get(word) || 0) + 1);
  const lexical = tokens.map(
    (set) =>
      new Map(
        [...set].map((word) => [
          word,
          Math.log(1 + normal.length / frequency.get(word)),
        ]),
      ),
  );
  for (const v of lexical) {
    const norm = Math.hypot(...v.values()) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
  }
  const similarities = normal.map(() => new Float64Array(normal.length)),
    best = new Float64Array(normal.length),
    edges = [];
  for (let i = 0; i < normal.length; i++)
    for (let j = i + 1; j < normal.length; j++) {
      let lexicalScore = 0;
      for (const [w, x] of lexical[i])
        lexicalScore += x * (lexical[j].get(w) || 0);
      const hasScope = normal[i].scope && normal[j].scope;
      const score =
        (hasScope
          ? 0.55 * cosine(scope[i], scope[j]) +
            0.15 * cosine(evidence[i], evidence[j])
          : 0.7 * cosine(evidence[i], evidence[j])) +
        0.3 * lexicalScore;
      similarities[i][j] = similarities[j][i] = score;
      best[i] = Math.max(best[i], score);
      best[j] = Math.max(best[j], score);
      if (score > 0) edges.push({ i, j, score });
    }
  edges.sort(
    (a, b) =>
      b.score - a.score ||
      normal[a.i].id - normal[b.i].id ||
      normal[a.j].id - normal[b.j].id,
  );
  const owner = normal.map((_, i) => i),
    groups = new Map(normal.map((_, i) => [i, [i]]));
  for (const edge of edges) {
    const a = owner[edge.i],
      b = owner[edge.j];
    if (a === b) continue;
    const left = groups.get(a),
      right = groups.get(b);
    let sum = 0,
      comparisons = 0;
    for (const i of left)
      for (const j of right) {
        sum += similarities[i][j];
        comparisons++;
      }
    const support = Math.max(
      ...left.map((i) => best[i]),
      ...right.map((i) => best[i]),
    );
    // Cohesion must survive the whole merge; a strong bridge cannot pull in
    // semantically opposed topics. Relative support adapts to this catalogue.
    if (sum / comparisons < Math.max(0.08, support * 0.35)) continue;
    left.push(...right);
    for (const i of right) owner[i] = a;
    groups.delete(b);
  }
  // Topic clusters can describe different phases of the same named component.
  // Broaden only with distinctive shared subjects AND positive semantic support;
  // generic activities such as review or planning cannot join work streams.
  let merged = true;
  while (merged) {
    merged = false;
    const values = [...groups.entries()];
    outer: for (let a = 0; a < values.length; a++)
      for (let b = a + 1; b < values.length; b++) {
        const [leftId, left] = values[a],
          [rightId, right] = values[b];
        const leftTerms = new Map(),
          rightTerms = new Map();
        for (const i of left)
          for (const word of new Set(words(normal[i].name).map(stem)))
            leftTerms.set(word, (leftTerms.get(word) || 0) + 1);
        for (const i of right)
          for (const word of new Set(words(normal[i].name).map(stem)))
            rightTerms.set(word, (rightTerms.get(word) || 0) + 1);
        const shared = [...leftTerms].some(
          ([w, n]) =>
            w.length >= 4 &&
            (namedFrequency.get(w) || 0) <= normal.length / 2 &&
            n / left.length >= 0.5 &&
            (rightTerms.get(w) || 0) / right.length >= 0.5,
        );
        if (!shared) continue;
        const scopeScore =
          left.reduce(
            (sum, i) =>
              sum +
              right.reduce((sub, j) => sub + cosine(scope[i], scope[j]), 0),
            0,
          ) /
          (left.length * right.length);
        if (scopeScore <= 0) continue;
        left.push(...right);
        groups.delete(rightId);
        merged = true;
        break outer;
      }
  }
  const supported = [];
  for (const indices of groups.values()) {
    const members = indices.map((i) => normal[i]);
    if (
      indices.length > 1 &&
      !label(members, { total: normal.length, frequency })
    )
      for (const index of indices) supported.push([index]);
    else supported.push(indices);
  }
  const used = new Set();
  return supported.map((indices) => {
    const members = indices.map((i) => normal[i]).sort((a, b) => a.id - b.id),
      ids = members.map((t) => t.id);
    const prior = previous
      .filter((p) => !used.has(p.id))
      .map((p) => ({
        p,
        n: p.topicIds.filter((id) => ids.includes(id)).length,
      }))
      .filter(
        ({ p, n }) => n / ids.length >= 0.5 && n / p.topicIds.length >= 0.5,
      )
      .sort((a, b) => b.n - a.n || a.p.id - b.p.id)[0]?.p;
    let id = prior?.id ?? members[0].id;
    if (used.has(id)) id = members.find((t) => !used.has(t.id))?.id ?? -1;
    while (used.has(id)) id--;
    used.add(id);
    return {
      id,
      name:
        label(members, { total: normal.length, frequency }) || members[0].name,
      color: prior?.color || members[0].color,
      topicIds: ids,
    };
  });
}

export function topicHierarchy(db, version) {
  const metadata = JSON.parse(
    db.prepare("SELECT data FROM analysis_runs WHERE id=?").get(version)
      ?.data || "{}",
  );
  if (metadata.workstreamPolicy)
    return db
      .prepare(
        "SELECT id,name,description,color FROM analysis_topics WHERE version=? ORDER BY id",
      )
      .all(version)
      .filter((t) => !isFallback(t))
      .map((t) => ({ ...t, topicIds: [t.id] }));
  const topics = db
    .prepare(
      "SELECT id,name,description,color,centroid FROM analysis_topics WHERE version=? ORDER BY id",
    )
    .all(version);
  const fingerprint = signature(topics);
  const remembered = cache.get(db);
  if (remembered?.fingerprint === fingerprint) return remembered.groups;
  const saved = JSON.parse(
    db.prepare("SELECT value FROM analysis_state WHERE key=?").get(KEY)
      ?.value || "null",
  );
  if (saved?.fingerprint === fingerprint) {
    cache.set(db, saved);
    return saved.groups;
  }
  const run = db
    .prepare("SELECT model FROM analysis_runs WHERE id=?")
    .get(version);
  for (const topic of topics) {
    topic.vector =
      topic.centroid?.length >= 4 && topic.centroid.length % 4 === 0
        ? vectorArray(topic.centroid)
        : [0];
    const key =
      "stream-scope-v1:" +
      createHash("sha256")
        .update(JSON.stringify([run.model, topic.name, topic.description]))
        .digest("hex");
    const scope = db
      .prepare("SELECT data FROM analysis_name_cache WHERE key=?")
      .get(key);
    if (scope) topic.scope = JSON.parse(scope.data);
  }
  const groups = groupTopics(topics, saved?.groups || []);
  const value = { fingerprint, groups };
  cache.set(db, value);
  return groups;
}

// This runs with catalogue writes, never when opening Today or Explore. The
// existing scope-embedding cache encodes only new or renamed topic descriptions.
export async function refreshTopicHierarchy(db, version, { signal } = {}) {
  const topics = db
    .prepare(
      "SELECT id,name,description,color,centroid FROM analysis_topics WHERE version=? ORDER BY id",
    )
    .all(version);
  const fingerprint = signature(topics);
  const saved = JSON.parse(
    db.prepare("SELECT value FROM analysis_state WHERE key=?").get(KEY)
      ?.value || "null",
  );
  if (saved?.fingerprint === fingerprint) return saved.groups;
  await embedStreamScopes(db, topics, { signal });
  signal?.throwIfAborted();
  cache.delete(db);
  const groups = topicHierarchy(db, version);
  db.prepare(
    "INSERT OR REPLACE INTO analysis_state(key,value) VALUES(?,?)",
  ).run(KEY, JSON.stringify({ fingerprint, groups }));
  const run = db
    .prepare("SELECT data FROM analysis_runs WHERE id=?")
    .get(version);
  db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
    JSON.stringify({
      ...JSON.parse(run.data),
      hierarchyUpdatedAt: new Date().toISOString(),
    }),
    version,
  );
  return groups;
}
