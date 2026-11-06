import {
  refreshSavedDensityGroups,
  hasSavedWorkstreams,
} from "./numerical-streams.js";
import { nameDensityGroups } from "./density-naming.js";
import { parentPort, workerData } from "node:worker_threads";
import { stat } from "node:fs/promises";
import { openDb, vectorBuffer, normalize } from "./db.js";
import { archiveFiles, parseSession } from "./parser.js";
import { ollama, documentInput } from "./ollama.js";
import { acquireIndexLock } from "./index-lock.js";
import { analyseArchive } from "./analysis.js";
import { updateCatalogue, markCatalogueDirty } from "./incremental-analysis.js";
import { createSyncProgress } from "./sync-progress.js";
import { upgradeProjection } from "./projection-store.js";
import { activeAnalysis } from "./analysis-store.js";
const db = openDb();
let stopped = false;
const stopping = new AbortController();
parentPort.on("message", (message) => {
  if (message === "stop") {
    stopped = true;
    stopping.abort();
  }
});
const reporter = createSyncProgress((message) =>
  parentPort.postMessage(message),
);
const progress = (...args) => reporter.progress(...args);
const heartbeat = setInterval(() => reporter.heartbeat(), 1000);
heartbeat.unref();
let result = {};
async function index() {
  if (workerData.namingOnly) {
    await nameDensityGroups(db, {
      refresh: true,
      send: progress,
      signal: stopping.signal,
      isStopped: () => stopped,
    });
    const metadata = JSON.parse(activeAnalysis(db)?.data || "{}");
    result = {
      contentReady: true,
      assignmentsReady: !metadata.namingPending,
      mapPending: !!metadata.mapPending,
      warnings: metadata.warnings || [],
    };
    return;
  }
  if (workerData.projectionOnly) {
    const run = activeAnalysis(db);
    const established = hasSavedWorkstreams(JSON.parse(run?.data || "{}"));
    if (run)
      await upgradeProjection(db, run, {
        send: progress,
        signal: stopping.signal,
        isStopped: () => stopped,
      });
    // Initial grouping may need names; refreshing saved geometry never does.
    if (!established) {
      await nameDensityGroups(db, {
        send: progress,
        signal: stopping.signal,
        isStopped: () => stopped,
      });
    }
    const metadata = JSON.parse(activeAnalysis(db)?.data || "{}");
    result = {
      contentReady: true,
      assignmentsReady: !metadata.namingPending,
      mapPending: false,
      warnings: metadata.warnings || [],
    };
    return;
  }
  if (workerData.analysisOnly) {
    await analyseArchive(db, {
      send: progress,
      isStopped: () => stopped,
      force: true,
      signal: stopping.signal,
    });
    const metadata = JSON.parse(activeAnalysis(db)?.data || "{}");
    result = {
      contentReady: true,
      assignmentsReady: !metadata.namingPending,
      mapPending: false,
      warnings: metadata.warnings || [],
    };
    return;
  }
  const savedRun = activeAnalysis(db);
  const savedData = JSON.parse(savedRun?.data || "{}");
  if (
    workerData.retryNaming &&
    (savedData.densityPolicy || savedData.workstreamPolicy) &&
    (savedData.namingPending || !savedData.densityNamingPolicy)
  )
    await nameDensityGroups(db, {
      send: progress,
      signal: stopping.signal,
      isStopped: () => stopped,
    });
  const { embeddingModel } = workerData.config;
  const changedSessions = new Set();
  progress("discovering", 0, 0, "Checking for changed sessions");
  const files = await archiveFiles(workerData.config);
  const known = new Map(
    db
      .prepare("SELECT * FROM files")
      .all()
      .map((f) => [f.path, f]),
  );
  const insert = db.prepare(
    "INSERT INTO chunks(id,file,session,project,title,role,timestamp,text,provider) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  progress("importing", 0, files.length, "Checking session files");
  for (const [i, file] of files.entries()) {
    if (stopped) return;
    const info = await stat(file),
      old = known.get(file);
    known.delete(file);
    if (old?.mtime === info.mtimeMs && old?.size === info.size) {
      progress("importing", i + 1, files.length, "Checking session files");
      continue;
    }
    const chunks = await parseSession(file);
    const fileSessions = new Set();
    // Preserve vectors for unchanged chunks even when a session grows.
    db.exec("BEGIN");
    try {
      const existing = new Map(
        db
          .prepare("SELECT id,session FROM chunks WHERE file=?")
          .all(file)
          .map((r) => {
            changedSessions.add(r.session);
            fileSessions.add(r.session);
            return [r.id, true];
          }),
      );
      for (const c of chunks) {
        changedSessions.add(c.session);
        fileSessions.add(c.session);
        if (existing.delete(c.id)) {
          db.prepare("UPDATE chunks SET title=?,project=? WHERE id=?").run(
            c.title,
            c.project,
            c.id,
          );
          continue;
        }
        insert.run(
          c.id,
          c.file,
          c.session,
          c.project,
          c.title,
          c.role,
          c.timestamp,
          c.text,
          c.provider,
        );
      }
      const del = db.prepare("DELETE FROM chunks WHERE id=?");
      for (const id of existing.keys()) del.run(id);
      db.prepare("INSERT OR REPLACE INTO files VALUES(?,?,?)").run(
        file,
        info.mtimeMs,
        info.size,
      );
      markCatalogueDirty(db, [...fileSessions]);
      db.exec("COMMIT");
      progress("importing", i + 1, files.length, "Reading changed sessions");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  // Remove deleted sessions from the index, never from the source directory.
  db.exec("BEGIN");
  try {
    for (const file of known.keys()) {
      for (const row of db
        .prepare("SELECT DISTINCT session FROM chunks WHERE file=?")
        .all(file))
        changedSessions.add(row.session);
      db.prepare("DELETE FROM chunks WHERE file=?").run(file);
      db.prepare("DELETE FROM files WHERE path=?").run(file);
    }
    markCatalogueDirty(db, [...changedSessions]);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const pending = db
    .prepare(
      "SELECT id,session,text,title FROM chunks WHERE vector IS NULL OR model IS NOT ? ORDER BY timestamp DESC",
    )
    .all(embeddingModel);
  const save = db.prepare(
    "UPDATE chunks SET vector=?,model=?,x=NULL,y=NULL,cluster=NULL WHERE id=?",
  );
  progress(
    "embedding",
    0,
    pending.length,
    pending.length
      ? "Embedding new conversation text"
      : "Embeddings are up to date",
  );
  for (let i = 0; i < pending.length; i += 24) {
    if (stopped) break;
    progress(
      "embedding",
      i,
      pending.length,
      "Embedding locally · batch size 24",
    );
    const batch = pending.slice(i, i + 24);
    for (const row of batch) changedSessions.add(row.session);
    const result = await ollama(
      "embed",
      {
        model: embeddingModel,
        input: batch.map((c) => documentInput(embeddingModel, c.text, c.title)),
        truncate: true,
        keep_alive: "10m",
      },
      180000,
      stopping.signal,
    );
    if (
      result.embeddings?.length !== batch.length ||
      result.embeddings.some(
        (v) => !v.length || v.some((x) => !Number.isFinite(x)),
      )
    )
      throw new Error("Ollama returned invalid embeddings.");
    db.exec("BEGIN");
    try {
      batch.forEach((c, j) =>
        save.run(
          vectorBuffer(normalize(result.embeddings[j])),
          embeddingModel,
          c.id,
        ),
      );
      markCatalogueDirty(
        db,
        batch.map((row) => row.session),
      );
      db.exec("COMMIT");
      progress(
        "embedding",
        Math.min(i + batch.length, pending.length),
        pending.length,
        "Embedding new conversation text",
      );
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  result = { contentReady: !stopped, assignmentsReady: false };
  if (!stopped && !workerData.skipProjection) {
    progress("assigning", 0, 0, "Updating saved work streams", {
      contentReady: true,
    });
    const catalogue = await updateCatalogue(db, {
      send: progress,
      isStopped: () => stopped,
      signal: stopping.signal,
      changedSessions: [...changedSessions],
      retryNaming: !!workerData.retryNaming,
    });
    result = { ...catalogue, contentReady: true };
  }
}
let releaseLock;
try {
  releaseLock = acquireIndexLock();
  await index();
  if (
    !stopped &&
    !workerData.skipProjection &&
    !workerData.projectionOnly &&
    activeAnalysis(db)
  ) {
    try {
      await refreshSavedDensityGroups(db, activeAnalysis(db), {
        send: progress,
        signal: stopping.signal,
        isStopped: () => stopped,
      });
      await nameDensityGroups(db, {
        send: progress,
        signal: stopping.signal,
        isStopped: () => stopped,
      });
      const current = JSON.parse(activeAnalysis(db).data);
      result.assignmentsReady = !current.namingPending;
      result.warnings = current.warnings || [];
    } catch (error) {
      if (!stopped) {
        const warning = {
          stage: "hierarchy",
          code: "hierarchy-pending",
          message: "Saved clusters are ready; work-stream naming is pending.",
        };
        result.warnings = [...(result.warnings || []), warning];
        progress("warning", 0, 0, warning.message);
      }
    }
  }
  const final = progress(
    stopped ? "paused" : "complete",
    0,
    0,
    stopped
      ? "Sync paused"
      : result.assignmentsReady
        ? "Sessions and work streams are up to date"
        : "Conversation text is up to date",
    result,
  );
  db.prepare(
    "INSERT OR REPLACE INTO analysis_state(key,value) VALUES('sync_last_job',?)",
  ).run(JSON.stringify(final));
} catch (error) {
  const final = progress(
    stopped ? "paused" : "error",
    0,
    0,
    stopped ? "Sync paused" : "Sync could not finish",
    { ...result, ...(stopped ? {} : { error: error.message }) },
  );
  db.prepare(
    "INSERT OR REPLACE INTO analysis_state(key,value) VALUES('sync_last_job',?)",
  ).run(JSON.stringify(final));
} finally {
  clearInterval(heartbeat);
  releaseLock?.();
  db.close();
  parentPort.close();
}
