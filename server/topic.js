import { visibleTopicLabel } from "./local-topic-labels.js";
import { summaryFingerprint } from "./summary-cache.js";
import { summaryContext } from "./summary-context.js";
import { markdownExcerpt } from "../shared/markdown.js";
import { usefulText } from "./evidence.js";
import { readableText } from "./names.js";
import { sessionNameResolver } from "./session-labels.js";
import {
  activeAnalysis,
  pendingAnalysis,
  workIdentity,
} from "./analysis-store.js";
import { scopeWhere } from "./scope.js";

export function readTopic(db, scope, selection) {
  const version =
    typeof selection === "object" ? selection?.analysisVersion : null;
  const run = activeAnalysis(db, version);
  if (!run) throw pendingAnalysis();
  const filter = scopeWhere(scope, "c");
  if (selection?.kind === "stream") {
    const topicId = Number(selection.streamId);
    if (!Number.isInteger(topicId) || topicId < 0)
      throw Object.assign(new Error("Invalid stream ID."), { status: 400 });
    const topic = db
      .prepare("SELECT * FROM analysis_topics WHERE version=? AND id=?")
      .get(run.id, topicId);
    const rows = db
      .prepare(
        `SELECT c.id,c.session,c.project,c.title,c.role,c.timestamp,c.text FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND m.topic_id=? AND ${filter.sql} ORDER BY c.timestamp DESC,c.id`,
      )
      .all(run.id, topicId, ...filter.params);
    if (!topic || !rows.length)
      throw Object.assign(
        new Error("This work stream has no evidence in the selected scope."),
        { status: 404 },
      );
    return presentTopic(
      db,
      rows,
      {
        kind: "stream",
        streamId: topic.id,
        cluster: topic.id,
        topicId: topic.id,
        analysisVersion: run.id,
        title: topic.name,
        description: topic.description,
        color: topic.color,
      },
      new Set(),
      scope,
    );
  }
  if (selection?.kind === "work") {
    let workId = selection.workId;
    if (!workId) {
      if (
        typeof selection.title !== "string" ||
        !selection.title.trim() ||
        selection.title.length > 200 ||
        !Array.isArray(selection.sourceIds) ||
        !selection.sourceIds.length ||
        selection.sourceIds.length > 100 ||
        selection.sourceIds.some(
          (id) => typeof id !== "string" || !id || id.length > 200,
        )
      )
        throw Object.assign(
          new Error("Select a named work item with supporting sources."),
          { status: 400 },
        );
      workId = workIdentity(scope, selection.title, selection.sourceIds);
    }
    if (typeof workId !== "string" || !/^[a-f0-9]{24}$/.test(workId))
      throw Object.assign(new Error("Invalid work item."), { status: 400 });
    const work = db
      .prepare("SELECT * FROM analysis_work WHERE version=? AND id=?")
      .get(run.id, workId);
    if (!work)
      throw pendingAnalysis(
        "Refresh the work overview to analyse this work item's supporting discussion.",
      );
    const rows = db
      .prepare(
        `SELECT c.id,c.session,c.project,c.title,c.role,c.timestamp,c.text FROM analysis_work_members w JOIN chunks c ON c.id=w.chunk_id WHERE w.version=? AND w.work_id=? AND ${filter.sql} ORDER BY c.timestamp DESC,c.id`,
      )
      .all(run.id, workId, ...filter.params);
    if (!rows.length)
      throw Object.assign(
        new Error(
          "No saved discussion of this work item is available in the selected date range.",
        ),
        { status: 404 },
      );
    const topicIds = JSON.parse(work.topic_ids);
    const topic =
      topicIds.length === 1
        ? db
            .prepare(
              "SELECT id,color FROM analysis_topics WHERE version=? AND id=?",
            )
            .get(run.id, topicIds[0])
        : null;
    return presentTopic(
      db,
      rows,
      {
        kind: "work",
        workId,
        analysisVersion: run.id,
        title: work.title,
        topicIds,
        cluster: topic?.id ?? null,
        color: topic?.color ?? "#82908a",
      },
      new Set(JSON.parse(work.source_ids)),
    );
  }
  const id =
    typeof selection === "string"
      ? selection
      : selection?.kind === "cluster"
        ? selection.id
        : null;
  if (typeof id !== "string" || !id || id.length > 200)
    throw Object.assign(new Error("Select a conversation or map point."), {
      status: 400,
    });
  const anchorFilter = scopeWhere({ ...scope, start: "" }, "c");
  const anchor = db
    .prepare(
      `SELECT m.topic_id FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND m.chunk_id=? AND ${anchorFilter.sql}`,
    )
    .get(run.id, id, ...anchorFilter.params);
  if (!anchor) {
    const available = db
      .prepare(`SELECT 1 FROM chunks c WHERE c.id=? AND ${anchorFilter.sql}`)
      .get(id, ...anchorFilter.params);
    if (!available)
      throw Object.assign(
        new Error(
          "This conversation is not available in the selected project or date range.",
        ),
        { status: 404 },
      );
    throw pendingAnalysis(
      "This conversation has not been included in the saved topic analysis. Sync sessions to analyse it.",
    );
  }
  const topic = db
    .prepare("SELECT * FROM analysis_topics WHERE version=? AND id=?")
    .get(run.id, anchor.topic_id);
  const rows = db
    .prepare(
      `SELECT c.id,c.session,c.project,c.title,c.role,c.timestamp,c.text FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=? AND m.topic_id=? AND ${filter.sql} ORDER BY c.timestamp DESC,c.id`,
    )
    .all(run.id, topic.id, ...filter.params);
  if (!rows.length)
    throw Object.assign(
      new Error(
        "No conversations in this topic fall within the selected date range.",
      ),
      { status: 404 },
    );
  return presentTopic(
    db,
    rows,
    {
      kind: "cluster",
      cluster: topic.id,
      topicId: topic.id,
      analysisVersion: run.id,
      title: topic.name,
      description: topic.description,
      color: topic.color,
    },
    new Set(),
    scope,
  );
}

function presentTopic(db, rows, metadata, anchors = new Set(), scope = {}) {
  const displayName = sessionNameResolver(db, metadata.analysisVersion);
  const usable = (row) => usefulText(row.text) && !/^\s*</.test(row.text);
  const sessions = new Map();
  for (const row of rows) {
    if (!sessions.has(row.session))
      sessions.set(row.session, {
        session: row.session,
        title: displayName(
          row.session,
          row.title,
          row.project,
          row.role === "user" ? row.text : "",
        ),
        project: row.project,
        provider: row.session.startsWith("codex:") ? "codex" : "claude",
        start: row.timestamp,
        end: row.timestamp,
        passages: 0,
      });
    const conversation = sessions.get(row.session);
    if (
      conversation.title === `Conversation in ${row.project}` &&
      row.role === "user"
    ) {
      const request = readableText(row.text);
      if (request.length >= 35)
        conversation.title = displayName(
          row.session,
          row.title,
          row.project,
          row.text,
        );
    }
    conversation.passages++;
    if (row.timestamp < conversation.start) conversation.start = row.timestamp;
    if (row.timestamp > conversation.end) conversation.end = row.timestamp;
    // Prefer substantive intent or outcomes over acknowledgements and progress chatter.
    const score =
      Math.min(row.text.length, 800) / 800 +
      (row.role === "user" ? 0.3 : 0) +
      (anchors.has(row.id) ? 2 : 0);
    if (usable(row) && score > (conversation.previewScore || 0)) {
      const preview = markdownExcerpt(row.text);
      if (!preview) continue;
      conversation.preview = preview;
      conversation.previewScore = score;
    }
  }
  const conversations = [...sessions.values()].map(
    ({ previewScore, ...row }) => ({
      ...row,
      preview:
        row.preview ||
        "Open the AI summary to explore the supporting discussion.",
    }),
  );
  if (metadata.kind === "cluster" || metadata.kind === "stream") {
    const label = visibleTopicLabel(
      db,
      metadata.analysisVersion,
      {
        id: metadata.topicId,
        name: metadata.title,
        description: metadata.description,
      },
      [...sessions.values()].map((s) => ({ ...s, timestamp: s.end })),
      scope,
    );
    metadata = {
      ...metadata,
      title: label.name,
      description: label.description,
    };
  }
  const anchorSessions = new Set(
    rows.filter((row) => anchors.has(row.id)).map((row) => row.session),
  );
  conversations.sort(
    (a, b) =>
      Number(anchorSessions.has(b.session)) -
        Number(anchorSessions.has(a.session)) || b.end.localeCompare(a.end),
  );
  const ordered = rows.map((r) => r.timestamp).sort();
  const selected = summaryContext(rows, {
    title: metadata.title,
    description: metadata.description,
    kind: metadata.kind,
    anchors,
  });
  return {
    ...metadata,
    passages: rows.length,
    start: ordered[0],
    end: ordered.at(-1),
    projects: [...new Set(rows.map((r) => r.project))],
    conversations,
    evidence: selected.sources,
    summaryFingerprint: summaryFingerprint(rows, metadata),
    summaryInput: selected.prompt,
    summarySelection: selected.selection,
  };
}
