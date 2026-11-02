import {
  initAnalysisSchema,
  analysisFingerprint,
} from "../server/analysis-store.js";
import { prepareWork, saveWork } from "../server/work-store.js";
import { vectorArray, cosine, vectorBuffer } from "../server/db.js";
import { topicColors } from "../shared/topic-colors.js";
export function seedAnalysis(db, { scope = {}, links = [] } = {}) {
  initAnalysisSchema(db);
  const rows = db.prepare("SELECT * FROM chunks").all();
  const version = "fixture-analysis";
  const assigned = rows.filter((row) => row.cluster !== null);
  const groups = new Map();
  for (const row of rows) {
    let id = row.cluster;
    if (id === null)
      id =
        assigned
          .filter((r) => r.vector && row.vector)
          .sort(
            (a, b) =>
              cosine(vectorArray(row.vector), vectorArray(b.vector)) -
              cosine(vectorArray(row.vector), vectorArray(a.vector)),
          )[0]?.cluster ?? 0;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  db.exec("BEGIN");
  db.prepare("DELETE FROM analysis_members WHERE version=?").run(version);
  db.prepare("DELETE FROM analysis_topics WHERE version=?").run(version);
  db.prepare("DELETE FROM analysis_work WHERE version=?").run(version);
  db.prepare("DELETE FROM analysis_work_members WHERE version=?").run(version);
  db.prepare("INSERT OR REPLACE INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
    version,
    analysisFingerprint(db, "embeddinggemma"),
    "embeddinggemma",
    "mock",
    "2026-10-27T00:00:00Z",
    JSON.stringify({ passages: rows.length, topics: groups.size }),
  );
  const mapping = new Map();
  for (const [id, members] of groups) {
    db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
      version,
      id,
      `Saved discussion topic ${id}`,
      "A saved topic from the bulk analysis fixture.",
      topicColors[Math.abs(id) % topicColors.length],
      members[0].vector || vectorBuffer([1, 0]),
    );
    for (const row of members) {
      mapping.set(row.id, id);
      db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
        version,
        row.id,
        id,
        row.x ?? null,
        0.5,
      );
    }
  }
  saveWork(db, version, prepareWork(db, scope, links, mapping));
  db.prepare("INSERT OR REPLACE INTO analysis_state VALUES('active',?)").run(
    version,
  );
  db.exec("COMMIT");
  return version;
}
