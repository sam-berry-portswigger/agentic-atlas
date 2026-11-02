import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer } from "../server/db.js";
import {
  initAnalysisSchema,
  activeAnalysis,
  catalogue,
  readMap,
} from "../server/analysis-store.js";
import {
  analyseArchive as runAnalysis,
  partition,
  representativeSample,
  validTopicName,
} from "../server/analysis.js";
import { PROJECTION_POLICY } from "../server/projection.js";
import { readTopic } from "../server/topic.js";
import { persistFocus } from "../server/work-store.js";
function fixture(n = 8) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings(key TEXT,value TEXT);
 CREATE TABLE insights(scope TEXT PRIMARY KEY,fingerprint TEXT,data TEXT);
 CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER);`);
  initAnalysisSchema(db);
  const put = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++)
    put.run(
      `row-${i}`,
      `session-${i}`,
      "atlas",
      "Human conversation title",
      i % 2 ? "assistant" : "user",
      `2026-10-${i % 2 ? "22" : "21"}T10:00:00Z`,
      i % 2
        ? `Design the review workflow and verify findings in independent code reviews. Evidence ${i}.`
        : `Investigate authentication token persistence and schedule switching. Evidence ${i}.`,
      vectorBuffer(i % 2 ? [0, 1] : [1, 0]),
      "embeddinggemma",
      null,
      null,
      null,
    );
  return db;
}
const analyseArchive = (db, options) =>
  runAnalysis(db, { scopeEmbedder: null, ...options });
const scope = { project: "", start: "", end: "" };
async function names(db, system, prompt) {
  const input = JSON.parse(prompt);
  return {
    topics: input.topics.map((topic) => ({
      key: topic.key,
      name: `Specific development topic ${topic.key}`,
      description:
        "A coherent development objective grounded in the supplied source conversations.",
    })),
  };
}
test("bulk analysis assigns every passage and persists one name and colour used by map and panel", async () => {
  const db = fixture(2005);
  try {
    const version = await analyseArchive(db, {
      nameGenerator: names,
      projectMap: false,
    });
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM analysis_members WHERE version=?")
        .get(version).n,
      2005,
    );
    const map = readMap(db, scope, "embeddinggemma");
    assert.ok(
      map.points.length < 2005,
      "map sampling does not limit saved membership",
    );
    assert.equal(
      new Set(map.topics.map((t) => t.color)).size,
      map.topics.length,
    );
    for (const point of map.points.slice(0, 12)) {
      const panel = readTopic(db, scope, {
        kind: "cluster",
        id: point.id,
        analysisVersion: version,
      });
      assert.equal(panel.title, point.topicName);
      assert.equal(panel.color, point.color);
      assert.equal(panel.analysisVersion, version);
      assert.equal(panel.cluster, point.cluster);
    }
    assert.equal(
      readMap(db, { ...scope, start: "2026-10-22T00:00:00Z" }, "embeddinggemma")
        .topics[0].title,
      map.topics[0].title,
      "date filtering never renames topics",
    );
  } finally {
    db.close();
  }
});
test("re-analysis preserves matched topic identity and colour; unchanged data performs no naming", async () => {
  const db = fixture();
  let calls = 0;
  const named = async (...args) => {
    calls++;
    return names(...args);
  };
  try {
    const first = await analyseArchive(db, {
      nameGenerator: named,
      projectMap: false,
    });
    const original = db
      .prepare(
        "SELECT chunk_id,topic_id FROM analysis_members WHERE version=? ORDER BY chunk_id",
      )
      .all(first);
    const originalTopics = catalogue(db);
    assert.equal(
      await analyseArchive(db, { nameGenerator: named, projectMap: false }),
      first,
    );
    assert.equal(calls, 1);
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "new",
      "codex:new",
      "atlas",
      "New conversation",
      "user",
      "2026-10-23T10:00:00Z",
      "Verify the authentication token persistence and schedule-switching implementation.",
      vectorBuffer([1, 0]),
      "embeddinggemma",
      null,
      null,
      null,
    );
    const second = await analyseArchive(db, {
      nameGenerator: named,
      projectMap: false,
    });
    assert.notEqual(second, first);
    assert.deepEqual(
      db
        .prepare(
          "SELECT chunk_id,topic_id FROM analysis_members WHERE version=? AND chunk_id!='new' ORDER BY chunk_id",
        )
        .all(second),
      original,
    );
    for (const topic of originalTopics) {
      const saved = catalogue(db).find((t) => t.id === topic.id);
      assert.equal(saved.color, topic.color);
      assert.equal(saved.title, topic.title);
    }
  } finally {
    db.close();
  }
});
test("invalid names never publish a partial snapshot, and views keep the previous complete analysis", async () => {
  const db = fixture();
  try {
    const before = await analyseArchive(db, {
      nameGenerator: names,
      projectMap: false,
    });
    const map = readMap(db, scope, "embeddinggemma");
    const bad = async (_db, _system, prompt) => {
      assert.equal(
        activeAnalysis(db).id,
        before,
        "previous analysis remains active while naming",
      );
      const input = JSON.parse(prompt);
      return {
        topics: input.topics.map((t) => ({
          key: t.key,
          name: "Work",
          description: "A deliberately invalid generic topic label.",
        })),
      };
    };
    await assert.rejects(
      analyseArchive(db, {
        nameGenerator: bad,
        projectMap: false,
        force: true,
      }),
      /failed validation/,
    );
    assert.equal(activeAnalysis(db).id, before);
    assert.deepEqual(readMap(db, scope, "embeddinggemma"), map);
  } finally {
    db.close();
  }
});
test("opening saved work and topics does not change membership, names or database state", async () => {
  const db = fixture();
  try {
    const version = await analyseArchive(db, {
      nameGenerator: names,
      projectMap: false,
    });
    const title = "Investigating authentication persistence";
    const focus = persistFocus(db, scope, [
      { links: [{ title, sourceIds: ["row-0"] }] },
    ]);
    const link = focus[0].links[0];
    assert.ok(link.workId);
    const selection = { kind: "work", ...link };
    const before = readTopic(db, scope, selection);
    db.exec("UPDATE chunks SET cluster=999,x=99,y=99");
    const changed = db.prepare("SELECT total_changes() AS n").get().n;
    db.exec("PRAGMA query_only=ON");
    const after = readTopic(db, scope, selection);
    assert.deepEqual(
      after,
      before,
      "read paths do not regroup passages from legacy fields",
    );
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changed);
    assert.equal(after.analysisVersion, version);
    assert.equal(after.title, title);
  } finally {
    db.close();
  }
});
test("pending conversations are explicit and never get invented topics or names", async () => {
  const db = fixture();
  try {
    assert.throws(() => readTopic(db, scope, "row-0"), { status: 409 });
    await analyseArchive(db, { nameGenerator: names, projectMap: false });
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "pending",
      "new",
      "atlas",
      "Latest prompt is not a topic",
      "user",
      "2026-10-23T10:00:00Z",
      "A new request that has not yet been analysed by the bulk pipeline.",
      vectorBuffer([1, 0]),
      "embeddinggemma",
      null,
      null,
      null,
    );
    assert.throws(() => readTopic(db, scope, "pending"), { status: 409 });
    assert.ok(
      readMap(db, scope, "embeddinggemma").points.every(
        (point) => point.id !== "pending",
      ),
    );
  } finally {
    db.close();
  }
});
test("granularity can exceed eight clusters, and duplicate vectors do not create empty topics", () => {
  const vectors = Array.from({ length: 1000 }, (_, i) => [
    Math.cos((i * Math.PI * 2) / 1000),
    Math.sin((i * Math.PI * 2) / 1000),
  ]);
  const result = partition(vectors);
  assert.ok(result.centers.length > 8);
  assert.equal(new Set(result.labels).size, result.centers.length);
  assert.equal(
    partition(Array.from({ length: 100 }, () => [1, 0])).centers.length,
    1,
  );
  for (const invalid of [
    "Work",
    "Tickets",
    "Related work",
    "Topic 2",
    "# Files mentioned by the user: image.png",
    "codex-clipboard-abc.png",
    "Topic\nname",
  ])
    assert.equal(validTopicName(invalid), false, invalid);
  assert.equal(validTopicName("Managing Development State and Tooling"), true);
});

test("catalogue publication does not create competing work identities from old summaries", async () => {
  const db = fixture();
  try {
    const legacyTitle = "Managing Development Task State and Tooling";
    db.prepare("INSERT INTO insights VALUES(?,?,?)").run(
      JSON.stringify(scope),
      "legacy",
      JSON.stringify({
        topics: [
          { cluster: 0, title: legacyTitle, sourceIds: ["row-0"], sources: [] },
        ],
        overview: {
          focus: [
            {
              id: "legacy-focus",
              title: "Existing overview",
              text: "Existing user-approved work overview.",
              clusters: [0],
              links: [],
            },
          ],
        },
      }),
    );
    const version = await analyseArchive(db, {
      nameGenerator: names,
      projectMap: false,
    });
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM analysis_work WHERE version=?")
        .get(version).n,
      0,
    );
    const stream = catalogue(db, version)[0];
    const panel = readTopic(db, scope, {
      kind: "stream",
      streamId: stream.id,
      analysisVersion: version,
    });
    assert.equal(panel.title, stream.title);
    assert.equal(panel.streamId, stream.id);
    assert.ok(panel.passages > 0);
  } finally {
    db.close();
  }
});

test("small archive updates do not reshuffle the representative sample", () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    id: `row-${i}`,
    text: `Substantive development conversation number ${i}.`,
  }));
  const before = representativeSample(rows);
  const after = representativeSample([
    {
      id: "aaa-new",
      text: "A new piece of software work with a different subject.",
    },
    ...rows,
  ]);
  const oldIds = new Set(before.map((row) => row.id));
  assert.equal(before.length, 1800);
  assert.equal(after.length, 1800);
  assert.ok(after.filter((row) => oldIds.has(row.id)).length >= 1799);
  assert.deepEqual(
    representativeSample([...rows].reverse()).map((row) => row.id),
    before.map((row) => row.id),
  );
});

test("completed naming checkpoints resume after publication failure without publishing partial topics", async () => {
  const db = fixture();
  let calls = 0;
  const named = async (...args) => {
    calls++;
    return names(...args);
  };
  try {
    db.exec(
      "CREATE TRIGGER reject_publication BEFORE INSERT ON analysis_runs BEGIN SELECT RAISE(ABORT,'publication failed'); END;",
    );
    await assert.rejects(
      analyseArchive(db, { nameGenerator: named, projectMap: false }),
      /publication failed/,
    );
    assert.equal(activeAnalysis(db), null);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM analysis_topics").get().n,
      0,
    );
    assert.ok(
      db.prepare("SELECT count(*) AS n FROM analysis_name_cache").get().n > 0,
    );
    db.exec("DROP TRIGGER reject_publication");
    await analyseArchive(db, { nameGenerator: named, projectMap: false });
    assert.equal(calls, 1, "valid completed names are not generated again");
    assert.ok(activeAnalysis(db));
  } finally {
    db.close();
  }
});

test("background membership can graduate into a named stream during incremental sync", async () => {
  const db = fixture(8);
  try {
    const first = await analyseArchive(db, {
      nameGenerator: names,
      projectMap: false,
    });
    const old = db
      .prepare(
        "SELECT id,name FROM analysis_topics WHERE version=? ORDER BY id",
      )
      .all(first);
    assert.ok(old.length > 1);
    const metadata = JSON.parse(activeAnalysis(db).data);
    metadata.backgroundIds = [old[1].id];
    db.prepare(
      "UPDATE analysis_topics SET name='Other sessions' WHERE version=? AND id=?",
    ).run(first, old[1].id);
    db.prepare(
      "UPDATE analysis_runs SET fingerprint='stale',data=? WHERE id=?",
    ).run(JSON.stringify(metadata), first);
    db.exec("DELETE FROM analysis_name_cache");
    // The formerly unclear conversations now have semantic evidence matching
    // the established goal, not merely a model claim to merge dissimilar work.
    db.prepare(
      "UPDATE chunks SET vector=? WHERE id IN (SELECT chunk_id FROM analysis_members WHERE version=? AND topic_id=?)",
    ).run(vectorBuffer([1, 0]), first, old[1].id);
    const next = await analyseArchive(db, {
      projectMap: false,
      nameGenerator: async (_db, _schema, prompt) => ({
        streams: [
          {
            name: old[0].name,
            description:
              "The established goal now has enough context to include the previously unclear work.",
            sources: JSON.parse(prompt).sessions.map((s) => s.source),
            background: false,
          },
        ],
      }),
    });
    const members = db
      .prepare("SELECT DISTINCT topic_id FROM analysis_members WHERE version=?")
      .all(next);
    assert.deepEqual(
      members.map((r) => r.topic_id),
      [old[0].id],
    );
    assert.deepEqual(JSON.parse(activeAnalysis(db).data).backgroundIds, []);
  } finally {
    db.close();
  }
});

test("incremental interpretation preserves streams omitted by a proposed merge and reuses the cloud", async () => {
  const db = fixture(8);
  try {
    const first = await analyseArchive(db, {
      nameGenerator: names,
      projectMap: false,
    });
    const old = db
      .prepare(
        "SELECT id,name,description,color FROM analysis_topics WHERE version=? ORDER BY id",
      )
      .all(first);
    assert.ok(old.length > 1);
    const members = db
      .prepare(
        "SELECT chunk_id,topic_id,x,y FROM analysis_members WHERE version=? ORDER BY chunk_id",
      )
      .all(first);
    // A new fingerprint invokes interpretation without replacing source evidence.
    const data = JSON.parse(activeAnalysis(db).data);
    data.projection = {
      policy: PROJECTION_POLICY,
      selected: "saved",
      candidates: [],
    };
    db.prepare("UPDATE analysis_runs SET fingerprint=?,data=? WHERE id=?").run(
      "outdated",
      JSON.stringify(data),
      first,
    );
    db.exec("DELETE FROM analysis_name_cache");
    const next = await analyseArchive(db, {
      send: (phase) => assert.notEqual(phase, "projecting"),
      nameGenerator: async (db, s, p) => ({
        streams: [
          {
            name: "Combined goal",
            description: "A proposed merger of all current session goals.",
            sources: JSON.parse(p).sessions.map((x) => x.source),
            background: false,
          },
        ],
      }),
    });
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,name,description,color FROM analysis_topics WHERE version=? ORDER BY id",
        )
        .all(next)
        .filter((t) => old.some((o) => o.id === t.id)),
      old,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT chunk_id,topic_id,x,y FROM analysis_members WHERE version=? ORDER BY chunk_id",
        )
        .all(next),
      members,
    );
  } finally {
    db.close();
  }
});
