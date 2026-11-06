import { nextWorkstreamId } from "./workstream-identity.js";
import { balancedObjectiveTopics } from "./balanced-groups.js";
import { OBJECTIVE_POLICY } from "./conversation-objectives.js";
import { refineStreamGoals } from "./refine-streams.js";
import {
  refreshSessionRelationships,
  reconcileSessionStreams,
} from "./session-streams.js";
import { interpretStreams, STREAM_METHOD } from "./stream-analysis.js";
import { publishSessionLabels } from "./session-labels.js";
import { upgradeProjection } from "./projection-store.js";
import { randomUUID, createHash } from "node:crypto";
import { projectTopics, PROJECTION_POLICY } from "./projection.js";
import {
  getConfig,
  normalize,
  cosine,
  vectorArray,
  vectorBuffer,
} from "./db.js";
import { activeAnalysis, analysisFingerprint } from "./analysis-store.js";
import { jsonGenerate } from "./work-model.js";
import { usefulText } from "./evidence.js";
import { readableText } from "./names.js";
import { nextTopicColor } from "../shared/topic-colors.js";
import {
  SEMANTIC_POLICY,
  LEGACY_SEMANTIC_POLICY,
  isFallback,
} from "./semantic-policy.js";
import { embedStreamScopes } from "./semantic-scopes.js";
import {
  CONVERSATION_POLICY,
  conversationVectors,
  averageVectors,
  distinctConversationVectors,
  conversationAnchors,
} from "./conversation-vectors.js";

export function representativeSample(rows, limit = 1800) {
  const unique = new Map();
  for (const row of rows) {
    const key = createHash("sha256")
      .update(row.text.replace(/\s+/g, " ").trim())
      .digest("hex");
    if (!unique.has(key) || row.id < unique.get(key).id) unique.set(key, row);
  }
  return [...unique]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limit)
    .map(([, row]) => row);
}
export function partition(vectors) {
  if (!vectors.length) return { centers: [], labels: [] };
  const desired = Math.min(
    24,
    Math.max(2, Math.round(Math.sqrt(vectors.length / 4))),
  );
  const centers = [vectors[0]];
  while (centers.length < Math.min(desired, vectors.length)) {
    let chosen = -1,
      distance = 0;
    for (let i = 0; i < vectors.length; i++) {
      const d = 1 - Math.max(...centers.map((c) => cosine(c, vectors[i])));
      if (d > distance) {
        chosen = i;
        distance = d;
      }
    }
    if (chosen < 0 || distance < 0.025) break;
    centers.push(vectors[chosen]);
  }
  let labels = [];
  for (let step = 0; step < 15; step++) {
    const next = vectors.map((v) => nearest(v, centers));
    const sums = centers.map(() => new Float64Array(vectors[0].length));
    const counts = centers.map(() => 0);
    vectors.forEach((v, i) => {
      counts[next[i]]++;
      for (let j = 0; j < v.length; j++) sums[next[i]][j] += v[j];
    });
    sums.forEach((sum, i) => {
      if (counts[i]) centers[i] = normalize(sum);
    });
    if (labels.length && labels.every((label, i) => label === next[i])) {
      labels = next;
      break;
    }
    labels = next;
  }
  return { centers, labels };
}
function nearest(vector, centers) {
  let best = 0,
    score = -Infinity;
  centers.forEach((center, i) => {
    const value = cosine(vector, center);
    if (value > score) {
      score = value;
      best = i;
    }
  });
  return best;
}
export function validTopicName(name) {
  return (
    typeof name === "string" &&
    name.trim().length >= 8 &&
    name.trim().length <= 80 &&
    name.trim().split(/\s+/).length >= 2 &&
    !/^(?:sounds good|please|can you|could you|i (?:want|need)|now (?:do|make)|#|\$)/i.test(
      name.trim(),
    ) &&
    name
      .replace(
        /\b(?:work|tests?|fix|review|commit|topic|general|discussion|and|or|the)\b/gi,
        "",
      )
      .replace(/[\s·,:-]/g, "").length >= 4 &&
    !/^(?:work|topic|related (?:work|conversations)|general (?:work|discussion)|untitled|tickets)(?:\s*\d*)?$/i.test(
      name.trim(),
    ) &&
    !/files (?:mentioned|pasted)|codex-clipboard|https?:|\/Users\/|<[^>]+>|[\r\n]/i.test(
      name,
    )
  );
}
function identity(topics, previous, previousMembers) {
  const matches = [];
  for (const topic of topics)
    for (const old of previous) {
      if (isFallback(topic) !== isFallback(old)) continue;
      let overlap = 0;
      for (const row of topic.rows)
        if (previousMembers.get(row.id) === old.id) overlap++;
      const fraction = overlap / Math.max(1, topic.rows.length);
      const similarity = cosine(topic.center, vectorArray(old.centroid));
      const sameName = topic.name?.toLowerCase() === old.name.toLowerCase();
      if (sameName || fraction >= 0.45 || similarity >= 0.9)
        matches.push({
          topic,
          old,
          fraction,
          similarity,
          score: (sameName ? 3 : 0) + fraction + similarity,
        });
    }
  matches.sort((a, b) => b.score - a.score);
  const used = new Set(
    topics.filter((t) => t.id !== undefined).map((t) => t.id),
  );
  for (const match of matches)
    if (match.topic.id === undefined && !used.has(match.old.id)) {
      match.topic.id = match.old.id;
      match.topic.color = match.old.color;
      match.topic.previous = match.old;
      match.topic.reuseName = match.fraction >= 0.8 && match.similarity >= 0.96;
      used.add(match.old.id);
    }
}
function representative(topic) {
  const sorted = topic.rows
    .filter(
      (row) => usefulText(row.text) && readableText(row.text).length >= 60,
    )
    .map((row) => ({
      row,
      score:
        cosine(row.vector, topic.center) + (row.role === "user" ? 0.04 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set(),
    sessions = new Map(),
    chosen = [];
  for (const { row } of sorted) {
    const text = readableText(row.text).slice(0, 1500);
    const hash = createHash("sha256").update(text).digest("hex");
    if (seen.has(hash) || (sessions.get(row.session) || 0) >= 2) continue;
    seen.add(hash);
    sessions.set(row.session, (sessions.get(row.session) || 0) + 1);
    chosen.push({
      id: row.id,
      project: row.project,
      role: row.role,
      date: row.timestamp,
      text,
    });
    if (chosen.length === 8) break;
  }
  return chosen;
}
export async function analyseArchive(
  db,
  {
    send = () => {},
    isStopped = () => false,
    force = false,
    retryNaming = false,
    projectMap = true,
    deferMap = false,
    nameGenerator = jsonGenerate,
    scopeEmbedder = embedStreamScopes,
    objectiveRepresenter = null,
    namingOptional = false,
    signal,
    onWarning = () => {},
  } = {},
) {
  const config = getConfig(db),
    fingerprint = analysisFingerprint(db, config.embeddingModel);
  const previousRun = activeAnalysis(db);
  if (
    !force &&
    !retryNaming &&
    previousRun?.fingerprint === fingerprint &&
    previousRun.model === config.embeddingModel &&
    (!objectiveRepresenter ||
      JSON.parse(previousRun.data).objectivePolicy === OBJECTIVE_POLICY)
  ) {
    if (projectMap)
      await upgradeProjection(db, previousRun, { send, isStopped });
    reconcileSessionStreams(db, previousRun.id);
    // All consumers reuse the saved stream membership.
    return previousRun.id;
  }
  await refreshSessionRelationships(db, config);
  const rows = db
    .prepare(
      "SELECT id,session,project,title,role,timestamp,text,vector,model FROM chunks WHERE model=? AND vector IS NOT NULL ORDER BY id",
    )
    .all(config.embeddingModel)
    .map((row) => ({ ...row, vector: vectorArray(row.vector) }));
  if (!rows.length) return null;
  send(
    "analysing",
    0,
    rows.length,
    "Grouping conversations and saving topic membership",
  );
  const conversations = objectiveRepresenter
    ? await objectiveRepresenter(db, conversationVectors(rows), {
        nameGenerator,
        signal,
        isStopped,
        send,
      })
    : conversationVectors(rows);
  const training = [...conversations]
    .sort((a, b) =>
      createHash("sha256")
        .update(a.session)
        .digest("hex")
        .localeCompare(createHash("sha256").update(b.session).digest("hex")),
    )
    .slice(0, 1800)
    .map((s) => ({
      ...s.representative,
      vector: s.vector,
      session: s.session,
    }));
  const { centers } = partition(conversations.map((group) => group.vector));
  let topics = centers.map((center) => ({ center, rows: [] }));
  for (const group of conversations)
    topics[nearest(group.vector, centers)].rows.push(...group.rows);
  topics = topics.filter((topic) => topic.rows.length);
  const previousBackgrounds = new Set(
    previousRun ? JSON.parse(previousRun.data).backgroundIds || [] : [],
  );
  let previous =
    previousRun?.model === config.embeddingModel
      ? db
          .prepare("SELECT * FROM analysis_topics WHERE version=?")
          .all(previousRun.id)
          .map((topic) => ({
            ...topic,
            background: previousBackgrounds.has(topic.id) || isFallback(topic),
          }))
      : [];
  const oldMembers = new Map(
    previous.length
      ? db
          .prepare(
            "SELECT chunk_id,topic_id FROM analysis_members WHERE version=?",
          )
          .all(previousRun.id)
          .map((row) => [row.chunk_id, row.topic_id])
      : [],
  );
  // Prototypes and their local exemplars use one vector per conversation, just
  // like classification and the overview, rather than averaging every passage.
  previous = conversationAnchors(
    previous,
    conversations,
    oldMembers,
    scopeEmbedder && !objectiveRepresenter
      ? await scopeEmbedder(db, previous)
      : new Map(),
    JSON.parse(
      db
        .prepare(
          "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
        )
        .get()?.value || "{}",
    ),
  );
  topics = objectiveRepresenter
    ? balancedObjectiveTopics(conversations)
    : await interpretStreams(db, topics, {
        previous:
          !objectiveRepresenter &&
          previousRun &&
          JSON.parse(previousRun.data).method === STREAM_METHOD
            ? previous
            : [],
        fingerprint,
        force,
        send,
        isStopped,
        nameGenerator,
        conversations,
        namingOptional,
        retryNaming,
        signal,
        onWarning,
      });
  // A corrective rebuild retains unsampled established work, while allowing
  // validated direct source review to correct even a single wrong assignment.
  // Uncertainty alone cannot erase an established named goal.
  if (
    force &&
    !objectiveRepresenter &&
    previousRun &&
    JSON.parse(previousRun.data).method === STREAM_METHOD
  ) {
    const labels = topics.flatMap((t) => t.sessionLabels || []);
    const assigned = new Set();
    const corrections = JSON.parse(
      db
        .prepare(
          "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
        )
        .get()?.value || "{}",
    );
    const reviewed = new Set(
      topics
        .filter((t) => !isFallback(t))
        .flatMap((t) => t.explicitSessions || [])
        .filter((session) => !Object.hasOwn(corrections, session)),
    );
    const saved = previous
      .map((t) => {
        const members = rows.filter(
          (r) => oldMembers.get(r.id) === t.id && !reviewed.has(r.session),
        );
        members.forEach((r) => assigned.add(r.id));
        const sessions = new Set(members.map((r) => r.session));
        return {
          ...t,
          center: t.center,
          rows: members,
          sessionLabels: labels.filter((l) => sessions.has(l.session)),
        };
      })
      .filter((t) => t.rows.length);
    for (const topic of topics) {
      const additions = topic.rows.filter((r) => !assigned.has(r.id));
      if (additions.length) saved.push({ ...topic, rows: additions });
    }
    topics = saved;
  }
  try {
    if (!objectiveRepresenter)
      topics = await refineStreamGoals(db, topics, conversations, {
        nameGenerator,
        signal,
        isStopped,
        send,
        onWarning,
      });
  } catch (error) {
    signal?.throwIfAborted();
    if (isStopped() || force || !namingOptional) throw error;
    const warning = {
      stage: "naming",
      code: "naming-pending",
      category: "generation-or-validation",
      reason: error.message,
      message:
        "Sessions are indexed, but work-stream naming is incomplete. Retry naming.",
      retryAfter: new Date(Date.now() + 60000).toISOString(),
    };
    onWarning(warning);
    send("warning", 0, 0, warning.message);
    topics = topics.map((topic) => ({ ...topic, namingWarning: warning }));
  }
  const sessionLabels = topics.flatMap((t) => t.sessionLabels || []);
  // IDs and colours identify the end goal, not the current date or selected sources.
  identity(
    topics,
    previousRun && JSON.parse(previousRun.data).method === STREAM_METHOD
      ? previous
      : [],
    oldMembers,
  );
  if (!force)
    for (const topic of topics)
      if (topic.reuseName && topic.previous) {
        topic.name = topic.previous.name;
        topic.description = topic.previous.description;
      }
  if (
    !force &&
    previousRun &&
    JSON.parse(previousRun.data).method === STREAM_METHOD &&
    JSON.parse(previousRun.data).conversationPolicy === SEMANTIC_POLICY
  ) {
    const owners = new Map(topics.map((t) => [t.id ?? t, t]));
    // Incremental enrichment must not dissolve a saved stream just because the
    // interpretation proposes a merge. Explicit rebuilds can reconsider it.
    const backgrounds = new Set(
      JSON.parse(previousRun.data).backgroundIds || [],
    );
    for (const old of previous) {
      let owner = owners.get(old.id);
      if (!owner) {
        owner = { id: old.id, center: vectorArray(old.centroid), rows: [] };
        owners.set(old.id, owner);
      }
      Object.assign(owner, {
        name: old.name,
        description: old.description,
        color: old.color,
        background: backgrounds.has(old.id) || isFallback(old),
      });
    }
    const assigned = topics.flatMap((t) =>
      t.rows.map((row) => ({ row, fallback: t })),
    );
    for (const topic of owners.values()) topic.rows = [];
    for (const { row, fallback } of assigned) {
      const previousOwner = oldMembers.has(row.id)
        ? owners.get(oldMembers.get(row.id))
        : null;
      // Other is provisional, not a durable end goal. Retain established named
      // memberships but let new evidence move background work into a real stream.
      (previousOwner && !previousOwner.background
        ? previousOwner
        : fallback
      ).rows.push(row);
    }
    topics = [...owners.values()].filter((t) => t.rows.length);
  }
  let nextId = nextWorkstreamId(db);
  const usedColors = new Set(topics.map((t) => t.color).filter(Boolean));
  for (const topic of topics)
    if (topic.id === undefined) {
      topic.id = nextId++;
      topic.color = nextTopicColor(usedColors);
      usedColors.add(topic.color);
    }
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  for (const [session, id] of Object.entries(corrections)) {
    let target = topics.find((t) => t.id === id);
    const matching = rows.filter((r) => r.session === session);
    if (!matching.length) continue;
    if (!target) {
      const old = previous.find((t) => t.id === id);
      if (!old) continue;
      target = {
        id: old.id,
        name: old.name,
        description: old.description,
        color: old.color,
        background: isFallback(old),
        center: vectorArray(old.centroid),
        rows: [],
      };
      topics.push(target);
    }
    const manualTopic = previous.find((t) => t.id === id);
    if (manualTopic)
      Object.assign(target, {
        name: manualTopic.name,
        description: manualTopic.description,
        color: manualTopic.color,
      });
    for (const topic of topics)
      topic.rows = topic.rows.filter((r) => r.session !== session);
    target.rows.push(...matching);
  }
  topics = topics.filter((t) => t.rows.length);
  for (const topic of topics) {
    const ids = new Set(topic.rows.map((r) => r.session));
    topic.center = averageVectors(
      distinctConversationVectors(
        conversations.filter((s) => ids.has(s.session)),
      ),
    );
  }
  if (isStopped()) throw new Error("Analysis cancelled.");
  signal?.throwIfAborted();
  const assignments = new Map(
    topics.flatMap((topic) => topic.rows.map((row) => [row.id, topic.id])),
  );
  let coordinates = new Map(),
    projection = null;
  const plotted = [...training].sort((a, b) =>
    a.session.localeCompare(b.session),
  );
  const oldPositions =
    previousRun?.model === config.embeddingModel
      ? db
          .prepare(
            JSON.parse(previousRun.data).mapUnit === "conversation"
              ? "SELECT representative_id AS chunk_id,x,y,vector FROM analysis_conversations WHERE version=? AND x IS NOT NULL AND y IS NOT NULL"
              : "SELECT chunk_id,x,y FROM analysis_members WHERE version=? AND x IS NOT NULL AND y IS NOT NULL",
          )
          .all(previousRun.id)
      : [];
  const positionsById = new Map(oldPositions.map((p) => [p.chunk_id, p]));
  if (
    projectMap &&
    JSON.parse(previousRun?.data || "{}").representation ===
      CONVERSATION_POLICY &&
    JSON.parse(previousRun?.data || "{}").projection?.policy ===
      PROJECTION_POLICY &&
    oldPositions.length === plotted.length &&
    plotted.every((r) => {
      const previous = positionsById.get(r.id);
      return (
        previous?.vector &&
        cosine(r.vector, vectorArray(previous.vector)) >= 0.9995
      );
    })
  ) {
    coordinates = new Map(plotted.map((r) => [r.id, positionsById.get(r.id)]));
    projection = {
      ...JSON.parse(previousRun.data).projection,
      // Reusing geometry must also retain its density memberships during a
      // rebuild, rather than replacing them with generated legacy assignments.
      labels: undefined,
    };
  } else if (projectMap && plotted.length >= 3) {
    const labels = plotted.map((row) => assignments.get(row.id));
    projection = await projectTopics(
      plotted.map((row) => row.vector),
      labels,
      { send, isStopped, signal },
    );
    coordinates = new Map(
      plotted.map((row, i) => [
        row.id,
        { x: projection.points[i][0], y: projection.points[i][1] },
      ]),
    );
  } else if (!deferMap)
    coordinates = new Map(
      plotted.map((row, i) => [
        row.id,
        { x: plotted.length > 1 ? i / (plotted.length - 1) : 0.5, y: 0.5 },
      ]),
    );
  send(
    "analysing",
    rows.length,
    rows.length,
    "Saving focused work items and publishing analysis",
  );
  const version = randomUUID(),
    createdAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
      version,
      fingerprint,
      config.embeddingModel,
      config.generationModel,
      createdAt,
      JSON.stringify({
        passages: rows.length,
        conversations: conversations.length,
        topics: topics.length,
        plotted: plotted.length,
        method: STREAM_METHOD,
        backgroundIds: topics.filter((t) => t.background).map((t) => t.id),
        algorithm: "embedding-candidates-shared-workstreams-v1",
        groupingPolicy: "objective-neighborhoods-v1",
        // Connected v3 clients treat this as their one-time repair marker.
        // Version the new classifier separately so they cannot erase its map.
        semanticPolicy: LEGACY_SEMANTIC_POLICY,
        conversationPolicy: SEMANTIC_POLICY,
        representation: CONVERSATION_POLICY,
        ...(objectiveRepresenter ? { objectivePolicy: OBJECTIVE_POLICY } : {}),
        mapUnit: "conversation",
        mapPending: deferMap,
        projection: projection && {
          ...projection,
          points: undefined,
          labels: undefined,
        },
        namingPending: topics.some((topic) => topic.namingWarning),
        warnings: [
          ...new Map(
            topics
              .filter((topic) => topic.namingWarning)
              .map((topic) => [topic.namingWarning.code, topic.namingWarning]),
          ).values(),
        ],
      }),
    );
    const putTopic = db.prepare(
        "INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)",
      ),
      putMember = db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)");
    const putConversation = db.prepare(
      "INSERT INTO analysis_conversations(version,session,representative_id,vector,x,y) VALUES(?,?,?,?,?,?)",
    );
    for (const conversation of conversations) {
      const position = coordinates.get(conversation.representative.id);
      putConversation.run(
        version,
        conversation.session,
        conversation.representative.id,
        vectorBuffer(conversation.vector),
        position?.x ?? null,
        position?.y ?? null,
      );
    }
    // Legacy coordinates remain available to evidence-only clients; authoritative
    // identities, colours and assignments live together in the published snapshot.
    db.exec("UPDATE chunks SET x=NULL,y=NULL,cluster=NULL");
    const legacy = db.prepare("UPDATE chunks SET cluster=?,x=?,y=? WHERE id=?");
    for (const topic of topics) {
      putTopic.run(
        version,
        topic.id,
        topic.name,
        topic.description,
        topic.color,
        vectorBuffer(topic.center),
      );
      for (const row of topic.rows) {
        const pos = coordinates.get(row.id);
        putMember.run(
          version,
          row.id,
          topic.id,
          pos?.x ?? null,
          pos?.y ?? null,
        );
        legacy.run(topic.id, pos?.x ?? null, pos?.y ?? null, row.id);
      }
    }
    publishSessionLabels(db, version, sessionLabels, rows, previousRun?.id);
    reconcileSessionStreams(db, version);
    db.prepare("INSERT OR REPLACE INTO analysis_state VALUES('active',?)").run(
      version,
    );
    signal?.throwIfAborted();
    if (isStopped()) throw new Error("Analysis cancelled.");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return version;
}
