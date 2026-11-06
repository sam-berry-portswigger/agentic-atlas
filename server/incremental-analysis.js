import { createHash, randomUUID } from "node:crypto";
import { balancedObjectiveGroup } from "./balanced-groups.js";
import { shortName } from "./names.js";
import { OBJECTIVE_POLICY } from "./conversation-objectives.js";
import { activeAnalysis, analysisFingerprint } from "./analysis-store.js";
import { analyseArchive } from "./analysis.js";
import { getConfig, vectorArray, vectorBuffer, cosine } from "./db.js";
import {
  conversationVectors,
  conversationTextKey,
  CONVERSATION_POLICY,
} from "./conversation-vectors.js";
import { sessionLabelInputHash } from "./session-labels.js";
import {
  semanticConversationGroup,
  SEMANTIC_POLICY,
  isFallback,
  OTHER_DESCRIPTION,
} from "./semantic-policy.js";
import {
  reconcileSessionStreams,
  invalidateSessionStreams,
} from "./session-streams.js";
import { nextTopicColor } from "../shared/topic-colors.js";

// Called inside the importer's transactions, including evidence-only imports.
// This journal survives a failed/cancelled run so the next sync can resume.
export function markCatalogueDirty(db, sessions) {
  const put = db.prepare(
    "INSERT OR IGNORE INTO analysis_dirty_sessions(session) VALUES(?)",
  );
  for (const session of new Set(sessions)) if (session) put.run(session);
}

const cancelled = (signal, isStopped) => {
  signal?.throwIfAborted();
  if (isStopped()) throw new Error("Analysis cancelled.");
};

// The representation downweights text copied across conversations. Preserve that
// corpus statistic when rebuilding just one conversation, without rereading all
// old text on every update. Only the first migration builds the complete index.
function updateTextDocuments(db, model, rowsBySession, check) {
  const key = "conversation-documents:" + model;
  const initialized =
    db.prepare("SELECT value FROM analysis_state WHERE key=?").get(key)
      ?.value === CONVERSATION_POLICY;
  const put = db.prepare(
    "INSERT OR IGNORE INTO analysis_text_documents VALUES(?,?,?)",
  );
  db.exec("BEGIN");
  try {
    if (!initialized) {
      db.prepare("DELETE FROM analysis_text_documents WHERE model=?").run(
        model,
      );
      for (const row of db
        .prepare(
          "SELECT session,role,text FROM chunks WHERE model=? AND vector IS NOT NULL",
        )
        .iterate(model)) {
        check();
        if (["user", "assistant"].includes(row.role))
          put.run(model, conversationTextKey(row), row.session);
      }
      db.prepare("INSERT OR REPLACE INTO analysis_state VALUES(?,?)").run(
        key,
        CONVERSATION_POLICY,
      );
    } else
      for (const [session, rows] of rowsBySession) {
        db.prepare(
          "DELETE FROM analysis_text_documents WHERE model=? AND session=?",
        ).run(model, session);
        for (const row of rows)
          if (["user", "assistant"].includes(row.role))
            put.run(model, conversationTextKey(row), session);
      }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const count = db.prepare(
    "SELECT count(*) n FROM analysis_text_documents WHERE model=? AND hash=?",
  );
  const frequencies = new Map();
  for (const rows of rowsBySession.values())
    for (const row of rows) {
      const hash = conversationTextKey(row);
      if (!frequencies.has(hash))
        frequencies.set(hash, count.get(model, hash).n);
    }
  return frequencies;
}

export async function updateCatalogue(
  db,
  {
    changedSessions = [],
    retryNaming = false,
    send = () => {},
    isStopped = () => false,
    signal,
    // Dependency injection keeps first-run/cancellation tests off real models.
    bootstrap = analyseArchive,
    objectiveRepresenter = null,
  } = {},
) {
  cancelled(signal, isStopped);
  markCatalogueDirty(db, changedSessions);
  const config = getConfig(db),
    previous = activeAnalysis(db);
  const metadata = JSON.parse(previous?.data || "{}");
  if (
    !previous ||
    (objectiveRepresenter && metadata.objectivePolicy !== OBJECTIVE_POLICY) ||
    (retryNaming && metadata.namingPending && !metadata.densityPolicy) ||
    previous.model !== config.embeddingModel ||
    metadata.mapUnit !== "conversation" ||
    metadata.conversationPolicy !== SEMANTIC_POLICY
  ) {
    const warnings = [];
    const version = await bootstrap(db, {
      objectiveRepresenter,
      ...(objectiveRepresenter && metadata.objectivePolicy !== OBJECTIVE_POLICY
        ? { force: true }
        : {}),
      projectMap: false,
      deferMap: true,
      namingOptional: true,
      retryNaming: retryNaming && !!metadata.namingPending,
      signal,
      send,
      isStopped,
      onWarning: (warning) => warnings.push(warning),
    });
    cancelled(signal, isStopped);
    // Clear only the entries observed before bootstrapping. Import is protected
    // by the shared writer lock; readers may continue using the prior snapshot.
    if (version) db.prepare("DELETE FROM analysis_dirty_sessions").run();
    const savedMetadata = JSON.parse(activeAnalysis(db)?.data || "{}");
    return {
      version,
      changedSessions: changedSessions.length,
      unchanged: false,
      mapPending: true,
      warnings: savedMetadata.warnings || warnings,
      contentReady: true,
      assignmentsReady: !!version && !savedMetadata.namingPending,
    };
  }

  const dirty = new Set(
    db
      .prepare("SELECT session FROM analysis_dirty_sessions")
      .all()
      .map((r) => r.session),
  );
  // Catch content imported by older/evidence-only clients without our journal.
  for (const r of db
    .prepare(
      "SELECT DISTINCT c.session FROM chunks c LEFT JOIN analysis_members m ON m.version=? AND m.chunk_id=c.id WHERE c.model=? AND c.vector IS NOT NULL AND m.chunk_id IS NULL",
    )
    .all(previous.id, config.embeddingModel))
    dirty.add(r.session);
  for (const r of db
    .prepare(
      "SELECT s.session FROM analysis_conversations s LEFT JOIN chunks c ON c.id=s.representative_id WHERE s.version=? AND c.id IS NULL",
    )
    .all(previous.id))
    dirty.add(r.session);
  const orphaned = !!db
    .prepare(
      "SELECT 1 FROM analysis_members m LEFT JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND c.id IS NULL LIMIT 1",
    )
    .get(previous.id);
  if (!dirty.size && !orphaned)
    return {
      version: previous.id,
      changedSessions: 0,
      unchanged: true,
      mapPending: !!metadata.mapPending,
      warnings: metadata.warnings || [],
      contentReady: true,
      assignmentsReady: !metadata.namingPending,
    };

  send(
    "assigning",
    0,
    dirty.size,
    "Updating changed conversations using saved topics",
  );
  const readRows = db.prepare(
    "SELECT id,session,project,title,role,timestamp,text,vector FROM chunks WHERE session=? AND model=? AND vector IS NOT NULL ORDER BY id",
  );
  const readInput = db.prepare(
    "SELECT input_hash FROM analysis_conversation_inputs WHERE version=? AND session=?",
  );
  const rowsBySession = new Map(
    [...dirty].map((session) => [
      session,
      readRows.all(session, config.embeddingModel),
    ]),
  );
  const frequencies = updateTextDocuments(
    db,
    config.embeddingModel,
    rowsBySession,
    () => cancelled(signal, isStopped),
  );
  const changed = [];
  let completed = 0;
  for (const session of dirty) {
    cancelled(signal, isStopped);
    const rows = rowsBySession.get(session);
    const hash = createHash("sha256").update(config.embeddingModel);
    for (const row of rows) {
      hash.update(
        JSON.stringify([
          row.id,
          row.role,
          row.timestamp,
          row.project,
          row.title,
        ]),
      );
      hash.update(row.vector);
      hash.update(String(frequencies.get(conversationTextKey(row))));
    }
    const inputHash = hash.digest("hex");
    if (readInput.get(previous.id, session)?.input_hash !== inputHash) {
      const conversation = rows.length
        ? conversationVectors(
            rows.map((r) => ({ ...r, vector: vectorArray(r.vector) })),
            { frequencies },
          )[0]
        : null;
      changed.push({ session, rows, inputHash, conversation });
    }
    send(
      "assigning",
      ++completed,
      dirty.size,
      "Updated changed conversation representations",
    );
    // Let cancellation/heartbeats run between conversations, not between chunks.
    await new Promise((resolve) => setImmediate(resolve));
  }
  cancelled(signal, isStopped);
  if (!changed.length && !orphaned) {
    const clear = db.prepare(
      "DELETE FROM analysis_dirty_sessions WHERE session=?",
    );
    for (const session of dirty) clear.run(session);
    return {
      version: previous.id,
      changedSessions: 0,
      unchanged: true,
      mapPending: !!metadata.mapPending,
      warnings: metadata.warnings || [],
      contentReady: true,
      assignmentsReady: !metadata.namingPending,
    };
  }

  if (objectiveRepresenter) {
    const represented = await objectiveRepresenter(
      db,
      changed
        .filter((item) => item.conversation)
        .map((item) => item.conversation),
      { signal, isStopped, send },
    );
    const bySession = new Map(represented.map((c) => [c.session, c]));
    for (const item of changed)
      if (item.conversation) item.conversation = bySession.get(item.session);
  }
  const cached = db
    .prepare(
      "SELECT s.*,m.topic_id FROM analysis_conversations s LEFT JOIN analysis_members m ON m.version=s.version AND m.chunk_id=s.representative_id WHERE s.version=?",
    )
    .all(previous.id);
  const oldBySession = new Map(cached.map((r) => [r.session, r]));
  const topics = db
    .prepare("SELECT * FROM analysis_topics WHERE version=?")
    .all(previous.id)
    .map((t) => ({
      ...t,
      center: vectorArray(t.centroid),
      background: metadata.backgroundIds?.includes(t.id) || isFallback(t),
      references: [],
    }));
  for (const c of cached) {
    const topic = topics.find((t) => t.id === c.topic_id);
    if (topic && !topic.background)
      topic.references.push({
        session: c.session,
        evidenceKey: createHash("sha256").update(c.vector).digest("hex"),
        vector: vectorArray(c.vector),
      });
  }
  const reuse = metadata.incrementalPolicy === "saved-topics-v1";
  const version = reuse ? previous.id : randomUUID(),
    now = new Date().toISOString();
  let mapPending = !!metadata.mapPending;
  const fingerprint = analysisFingerprint(db, config.embeddingModel);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (activeAnalysis(db)?.id !== previous.id)
      throw new Error(
        "The saved catalogue changed during sync. Retry the incremental update.",
      );
    const corrections = JSON.parse(
      db
        .prepare(
          "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
        )
        .get()?.value || "{}",
    );
    let fallback = topics.find((t) => t.background);
    const assignments = changed.map((item) => {
      const old = oldBySession.get(item.session);
      if (!item.conversation) return { ...item, old, topic: null };
      const prior = topics.find((t) => t.id === old?.topic_id);
      const candidates = topics.map((t) => ({
        ...t,
        references: t.references.filter((r) => r.session !== item.session),
      }));
      let topic =
        topics.find((t) => t.id === corrections[item.session]) ||
        // Preserve an inferred assignment for an unchanged representation, not
        // indefinitely after the conversation has acquired a different goal.
        (prior &&
        !prior.background &&
        old &&
        cosine(item.conversation.vector, vectorArray(old.vector)) >= 0.9995
          ? prior
          : item.conversation.objectiveUnclear
            ? null
            : objectiveRepresenter
              ? balancedObjectiveGroup(item.conversation, candidates)
              : semanticConversationGroup(
                  item.conversation.vector,
                  candidates,
                ));
      if (
        !topic &&
        objectiveRepresenter &&
        !item.conversation.objectiveUnclear
      ) {
        topic = {
          id: Math.max(-1, ...topics.map((t) => t.id)) + 1,
          name: shortName(item.conversation.objective, 80),
          description: item.conversation.objective,
          center: item.conversation.vector,
          references: [],
          background: false,
          color: nextTopicColor(new Set(topics.map((t) => t.color))),
        };
        topics.push(topic);
      }
      if (!topic) {
        if (!fallback) {
          const used = new Set(topics.map((t) => t.color));
          fallback = {
            id:
              (db.prepare("SELECT max(id) n FROM analysis_topics").get().n ??
                -1) + 1,
            name: "Other sessions",
            description: OTHER_DESCRIPTION,
            color: nextTopicColor(used),
            center: item.conversation.vector,
            background: true,
            references: [],
          };
          topics.push(fallback);
        }
        topic = fallback;
      }
      if (
        !old ||
        old.x === null ||
        cosine(item.conversation.vector, vectorArray(old.vector)) < 0.9995
      )
        mapPending = true;
      return { ...item, old, topic };
    });
    const nextMetadata = {
      ...metadata,
      mapPending,
      contentUpdatedAt: now,
      assignmentsUpdatedAt: now,
      incremental: true,
      incrementalPolicy: "saved-topics-v1",
      previousVersion: reuse ? metadata.previousVersion : previous.id,
    };
    if (reuse)
      db.prepare(
        "UPDATE analysis_runs SET fingerprint=?,generation_model=?,created_at=?,data=? WHERE id=?",
      ).run(
        fingerprint,
        config.generationModel,
        now,
        JSON.stringify(nextMetadata),
        version,
      );
    else
      db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
        version,
        fingerprint,
        config.embeddingModel,
        config.generationModel,
        now,
        JSON.stringify(nextMetadata),
      );
    if (!reuse)
      db.prepare(
        "INSERT INTO analysis_topics SELECT ?,id,name,description,color,centroid FROM analysis_topics WHERE version=?",
      ).run(version, previous.id);
    if (
      fallback &&
      !topics.some((t) => t !== fallback && t.id === fallback.id) &&
      !db
        .prepare("SELECT 1 FROM analysis_topics WHERE version=? AND id=?")
        .get(version, fallback.id)
    ) {
      db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
        version,
        fallback.id,
        fallback.name,
        fallback.description,
        fallback.color,
        vectorBuffer(fallback.center),
      );
    }
    // Clone the full/base snapshot once; subsequent updates atomically change
    // this live incremental catalogue in place. Open panel IDs stay valid and
    // routine background updates cannot accumulate archive-sized snapshots.
    if (!reuse)
      db.prepare(
        "INSERT INTO analysis_members SELECT ?,m.chunk_id,m.topic_id,m.x,m.y FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND c.model=? AND c.vector IS NOT NULL",
      ).run(version, previous.id, config.embeddingModel);
    if (!reuse)
      db.prepare(
        "INSERT INTO analysis_conversations SELECT ?,session,representative_id,vector,x,y FROM analysis_conversations WHERE version=?",
      ).run(version, previous.id);
    if (!reuse)
      db.prepare(
        "INSERT INTO analysis_conversation_inputs SELECT ?,session,input_hash FROM analysis_conversation_inputs WHERE version=?",
      ).run(version, previous.id);
    if (!reuse)
      db.prepare(
        "INSERT INTO analysis_session_labels SELECT ?,session,title,input_hash FROM analysis_session_labels WHERE version=?",
      ).run(version, previous.id);
    if (reuse)
      db.prepare(
        "DELETE FROM analysis_members WHERE version=? AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id=analysis_members.chunk_id AND c.model=? AND c.vector IS NOT NULL)",
      ).run(version, config.embeddingModel);
    const putMember = db.prepare(
      "INSERT OR REPLACE INTO analysis_members VALUES(?,?,?,?,?)",
    );
    const putConversation = db.prepare(
      "INSERT OR REPLACE INTO analysis_conversations VALUES(?,?,?,?,?,?)",
    );
    const putInput = db.prepare(
      "INSERT OR REPLACE INTO analysis_conversation_inputs VALUES(?,?,?)",
    );
    const legacy = db.prepare("UPDATE chunks SET cluster=?,x=?,y=? WHERE id=?");
    for (const item of assignments) {
      if (!item.topic) {
        db.prepare(
          "DELETE FROM analysis_conversations WHERE version=? AND session=?",
        ).run(version, item.session);
        db.prepare(
          "DELETE FROM analysis_conversation_inputs WHERE version=? AND session=?",
        ).run(version, item.session);
        db.prepare(
          "DELETE FROM analysis_session_labels WHERE version=? AND session=?",
        ).run(version, item.session);
        continue;
      }
      const { conversation, topic, old } = item;
      const label = db
        .prepare(
          "SELECT input_hash FROM analysis_session_labels WHERE version=? AND session=?",
        )
        .get(version, item.session);
      if (label && label.input_hash !== sessionLabelInputHash(item.rows))
        db.prepare(
          "DELETE FROM analysis_session_labels WHERE version=? AND session=?",
        ).run(version, item.session);
      // Existing coordinates remain stable and explicitly stale when necessary.
      // New conversations have no fabricated location; Refresh map plots them.
      putConversation.run(
        version,
        item.session,
        conversation.representative.id,
        vectorBuffer(conversation.vector),
        old?.x ?? null,
        old?.y ?? null,
      );
      putInput.run(version, item.session, item.inputHash);
      for (const row of item.rows) {
        const plotted = row.id === conversation.representative.id;
        putMember.run(
          version,
          row.id,
          topic.id,
          plotted ? (old?.x ?? null) : null,
          plotted ? (old?.y ?? null) : null,
        );
        legacy.run(
          topic.id,
          plotted ? (old?.x ?? null) : null,
          plotted ? (old?.y ?? null) : null,
          row.id,
        );
      }
    }
    invalidateSessionStreams(db);
    reconcileSessionStreams(db, version);
    nextMetadata.passages = db
      .prepare("SELECT count(*) n FROM analysis_members WHERE version=?")
      .get(version).n;
    nextMetadata.conversations = db
      .prepare("SELECT count(*) n FROM analysis_conversations WHERE version=?")
      .get(version).n;
    nextMetadata.topics = topics.length;
    nextMetadata.backgroundIds = topics
      .filter((t) => t.background)
      .map((t) => t.id);
    db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
      JSON.stringify(nextMetadata),
      version,
    );
    db.prepare("INSERT OR REPLACE INTO analysis_state VALUES('active',?)").run(
      version,
    );
    const clear = db.prepare(
      "DELETE FROM analysis_dirty_sessions WHERE session=?",
    );
    for (const session of dirty) clear.run(session);
    cancelled(signal, isStopped);
    db.exec("COMMIT");
    return {
      version,
      changedSessions: changed.length,
      passages: nextMetadata.passages,
      unchanged: false,
      mapPending,
      warnings: nextMetadata.warnings || [],
      contentReady: true,
      assignmentsReady: !nextMetadata.namingPending,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
