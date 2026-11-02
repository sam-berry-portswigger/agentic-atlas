import { randomUUID } from "node:crypto";
import { activeAnalysis } from "./analysis-store.js";
import { vectorArray } from "./db.js";
import { partition } from "./analysis.js";
import { intentRow, STREAM_METHOD } from "./stream-analysis.js";
import {
  isFallback,
  semanticAnchors,
  closestSemanticGroup,
} from "./semantic-policy.js";
import { acquireIndexLock } from "./index-lock.js";
const LEGACY_REPAIR_POLICY = "semantic-clusters-v3";
const alreadyRepaired = (run) =>
  Number(
    /semantic-clusters-v(\d+)/.exec(
      JSON.parse(run.data).semanticPolicy || "",
    )?.[1],
  ) >= 3;

export function prepareSemanticRepair(db) {
  const run = activeAnalysis(db);
  if (!run || alreadyRepaired(run)) return null;
  const metadata = JSON.parse(run.data);
  if (metadata.method !== STREAM_METHOD) return null;
  const topics = db
    .prepare("SELECT * FROM analysis_topics WHERE version=? ORDER BY id")
    .all(run.id)
    .map((t) => ({
      ...t,
      background:
        (metadata.backgroundIds || []).includes(t.id) || isFallback(t),
    }));
  const residual =
    topics.find((t) => t.name === "Other sessions") || topics.find(isFallback);
  if (!residual) return null;
  const anchors = semanticAnchors(topics);
  const rows = db
    .prepare(
      "SELECT c.id,c.session,c.role,c.title,c.timestamp,c.text,c.vector,m.topic_id FROM chunks c JOIN analysis_members m ON m.chunk_id=c.id WHERE m.version=? AND c.vector IS NOT NULL ORDER BY c.id",
    )
    .all(run.id)
    .map((r) => ({ ...r, vector: vectorArray(r.vector) }));
  const sessions = new Map();
  for (const r of rows) {
    if (!sessions.has(r.session)) sessions.set(r.session, []);
    sessions.get(r.session).push(r);
  }
  const intents = [...sessions].map(([session, rs]) => ({
    session,
    rows: rs,
    intent: intentRow(rs),
  }));
  const { centers, labels } = partition(intents.map((s) => s.intent.vector));
  const owners = centers.map(
    (center) => closestSemanticGroup(center, anchors)?.id ?? residual.id,
  );
  const corrections = JSON.parse(
    db
      .prepare(
        "SELECT value FROM analysis_state WHERE key='stream_session_assignments'",
      )
      .get()?.value || "{}",
  );
  // Repair the malformed normal Background entries introduced by the bug.
  // Legitimate residual assignments are outside this one-time migration.
  const fallbackIds = new Set(
    topics
      .filter(
        (t) => isFallback(t) && !(metadata.backgroundIds || []).includes(t.id),
      )
      .map((t) => t.id),
  );
  const changes = [];
  intents.forEach((s, i) => {
    if (Object.hasOwn(corrections, s.session)) return;
    const individual = closestSemanticGroup(s.intent.vector, anchors)?.id;
    const target = individual === owners[labels[i]] ? individual : residual.id;
    for (const r of s.rows) {
      if (fallbackIds.has(r.topic_id) && r.topic_id !== target)
        changes.push({
          id: r.id,
          session: s.session,
          from: r.topic_id,
          to: target,
        });
    }
  });
  return { run, metadata, topics, residual, changes };
}

// One versioned migration. Saved coordinates, explicit corrections and all
// established substantive memberships survive unchanged; no inference runs.
export function repairSemanticMemberships(
  db,
  { acquireLock = acquireIndexLock } = {},
) {
  const current = activeAnalysis(db);
  if (!current || alreadyRepaired(current)) return null;
  let release;
  try {
    release = acquireLock();
  } catch (e) {
    if (/Another Atlas index update/.test(e.message)) return null;
    throw e;
  }
  try {
    const plan = prepareSemanticRepair(db);
    if (!plan) return null;
    const version = randomUUID(),
      now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (activeAnalysis(db)?.id !== plan.run.id)
        throw Error("Catalogue changed during semantic repair.");
      const metadata = {
        ...plan.metadata,
        semanticPolicy: LEGACY_REPAIR_POLICY,
        repairedFrom: plan.run.id,
        repairedAt: now,
        repairedPassages: plan.changes.length,
        backgroundIds: plan.topics.filter(isFallback).map((t) => t.id),
      };
      db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
        version,
        plan.run.fingerprint,
        plan.run.model,
        plan.run.generation_model,
        now,
        JSON.stringify(metadata),
      );
      db.prepare(
        "INSERT INTO analysis_topics SELECT ?,id,name,description,color,centroid FROM analysis_topics WHERE version=?",
      ).run(version, plan.run.id);
      db.prepare(
        "INSERT INTO analysis_members SELECT ?,chunk_id,topic_id,x,y FROM analysis_members WHERE version=?",
      ).run(version, plan.run.id);
      db.prepare(
        "INSERT INTO analysis_session_labels SELECT ?,session,title,input_hash FROM analysis_session_labels WHERE version=?",
      ).run(version, plan.run.id);
      const put = db.prepare(
        "UPDATE analysis_members SET topic_id=? WHERE version=? AND chunk_id=?",
      );
      const legacy = db.prepare("UPDATE chunks SET cluster=? WHERE id=?");
      for (const c of plan.changes) {
        put.run(c.to, version, c.id);
        legacy.run(c.to, c.id);
      }
      metadata.topics = db
        .prepare(
          "SELECT count(DISTINCT topic_id) AS n FROM analysis_members WHERE version=?",
        )
        .get(version).n;
      db.prepare("UPDATE analysis_runs SET data=? WHERE id=?").run(
        JSON.stringify(metadata),
        version,
      );
      db.prepare(
        "INSERT OR REPLACE INTO analysis_state VALUES('active',?)",
      ).run(version);
      db.exec("COMMIT");
      return { version, previous: plan.run.id, changed: plan.changes.length };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    release();
  }
}
