import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  activeAnalysis,
  initAnalysisSchema,
} from "../server/analysis-store.js";
import { catalogueRevision } from "../shared/catalogue-revision.js";

test("stable catalogue IDs still notify polling clients after a fast incremental or map update", () => {
  const db = new DatabaseSync(":memory:");
  initAnalysisSchema(db);
  const initial = {
    assignmentsUpdatedAt: "2026-11-02T11:00:00.000Z",
    mapUpdatedAt: "2026-11-02T10:59:00.000Z",
    mapPending: false,
  };
  db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    "stable",
    "fingerprint",
    "embedding",
    "generation",
    "now",
    JSON.stringify(initial),
  );
  db.prepare("INSERT INTO analysis_state VALUES('active','stable')").run();
  const snapshot = () => {
    const run = activeAnalysis(db);
    return {
      phase: "complete",
      version: run.id,
      revision: catalogueRevision({ ...JSON.parse(run.data), version: run.id }),
    };
  };
  try {
    const before = snapshot();
    assert.deepEqual(
      snapshot(),
      before,
      "unchanged heartbeat does not trigger a metadata/map reload",
    );
    const assigned = {
      ...initial,
      assignmentsUpdatedAt: "2026-11-02T11:00:01.000Z",
      mapPending: true,
    };
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='stable'").run(
      JSON.stringify(assigned),
    );
    const afterAssignment = snapshot();
    assert.equal(
      afterAssignment.phase,
      before.phase,
      "an entire job can finish between polls",
    );
    assert.equal(afterAssignment.version, before.version);
    assert.notEqual(
      afterAssignment.revision,
      before.revision,
      "the saved assignment revision detects it",
    );
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='stable'").run(
      JSON.stringify({
        ...assigned,
        mapUpdatedAt: "2026-11-02T11:00:02.000Z",
        mapPending: false,
      }),
    );
    assert.notEqual(
      snapshot().revision,
      afterAssignment.revision,
      "map completion reloads coordinates without a new catalogue ID",
    );
  } finally {
    db.close();
  }
});

test("revision ignores live job counters and has no active-catalogue value before publication", () => {
  assert.equal(catalogueRevision(null), null);
  assert.equal(catalogueRevision({ version: null }), null);
  assert.equal(
    catalogueRevision({ version: "v", job: { done: 1 } }),
    catalogueRevision({ version: "v", job: { done: 100 }, elapsedMs: 1500 }),
  );
});
