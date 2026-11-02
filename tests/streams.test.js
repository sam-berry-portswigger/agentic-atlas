import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer } from "../server/db.js";
import {
  initAnalysisSchema,
  catalogue,
  readMap,
} from "../server/analysis-store.js";
import { analyseArchive as runAnalysis } from "../server/analysis.js";
const analyseArchive = (db, options) =>
  runAnalysis(db, { scopeEmbedder: null, ...options });
import {
  readStreams,
  overviewStreamContext,
  savedStreamFocus,
} from "../server/streams.js";
import { attachTodayStreams } from "../server/today-streams.js";
import { createEvidenceService } from "../server/mcp-service.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE insights(scope TEXT PRIMARY KEY,fingerprint TEXT,data TEXT);CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER);CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED,text);`,
  );
  initAnalysisSchema(db);
  const put = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  const rows = [
    [
      "release-implementation",
      "Implement quick search so we can release the new scheduling flow.",
      [1, 0, 0],
    ],
    [
      "release-tests",
      "Verify scheduling tests and telemetry before releasing quick search.",
      [1, 0, 0],
    ],
    [
      "atlas",
      "Build Atlas session boards and improve its semantic search interface.",
      [0, 0, 1],
    ],
  ];
  for (const [session, text, v] of rows)
    for (let i = 0; i < 4; i++) {
      const id = session + "-" + i;
      put.run(
        id,
        session,
        "same-repository",
        "Plan my day",
        i % 2 ? "assistant" : "user",
        `2026-10-28T1${i}:00:00Z`,
        text + " Supporting substantive evidence " + i + ".",
        vectorBuffer(v),
        "embeddinggemma",
        null,
        null,
        null,
      );
      db.prepare("INSERT INTO chunks_fts VALUES(?,?)").run(id, text);
    }
  return db;
}
const scope = {
  project: "",
  start: "2026-10-28T00:00:00Z",
  end: "2026-10-29T00:00:00Z",
};
function plan(prompt) {
  const input = JSON.parse(prompt);
  const streams = [
    ["Release quick search", /schedul/i],
    ["Build Atlas", /Atlas/],
  ].map(([name, pattern]) => {
    const briefs = input.sessions.filter((e) =>
      pattern.test(e.firstRequest + " " + e.recentRequest),
    );
    return {
      name,
      description:
        name === "Build Atlas"
          ? "Develop the personal session search and work visibility tool."
          : "Ship the new scheduling flow, including its implementation, tests and telemetry.",
      sources: briefs.map((e) => e.source),
      background: false,
    };
  });
  return { streams };
}
test("one interpretation pass merges different activities into stable goals, shared by map, boards, summary and MCP", async () => {
  const db = fixture();
  let calls = 0;
  try {
    const gen = async (db, system, prompt) => {
      calls++;
      return plan(prompt);
    };
    const version = await analyseArchive(db, {
      nameGenerator: gen,
      projectMap: false,
    });
    assert.equal(calls, 1);
    assert.equal(catalogue(db).length, 2);
    const release = catalogue(db).find(
      (s) => s.title === "Release quick search",
    );
    const releaseRows = db
      .prepare(
        "SELECT c.session,m.topic_id FROM analysis_members m JOIN chunks c ON c.id=m.chunk_id WHERE m.version=?",
      )
      .all(version);
    assert.ok(
      releaseRows
        .filter((r) => r.session.startsWith("release-"))
        .every((r) => r.topic_id === release.id),
    );
    assert.ok(
      releaseRows
        .filter((r) => r.session === "atlas")
        .every((r) => r.topic_id !== release.id),
    );
    assert.equal(db.prepare("SELECT count(*) n FROM analysis_work").get().n, 0);
    const sessions = ["release-implementation", "release-tests", "atlas"].map(
      (id) => ({ id }),
    );
    const today = attachTodayStreams(db, sessions);
    assert.equal(today.catalogueReady, true);
    assert.equal(sessions[0].boardStreamId, release.id);
    assert.equal(sessions[1].boardStreamId, release.id);
    const related = [
      { id: "release-implementation", historyFamily: "release-implementation" },
      {
        id: "release-tests",
        parent: "release-implementation",
        child: true,
        relationship: "shared_history",
        historyFamily: "release-implementation",
      },
      {
        id: "atlas",
        parent: "release-implementation",
        child: true,
        relationship: "shared_history",
        historyFamily: "release-implementation",
      },
    ];
    const relatedEdges = [
      {
        parent: "release-implementation",
        child: "release-tests",
        kind: "shared_history",
      },
      {
        parent: "release-implementation",
        child: "atlas",
        kind: "shared_history",
      },
    ];
    const unassignedAnchor = [
      { id: "unknown" },
      { id: "release-tests" },
      { id: "atlas" },
    ];
    const bridgingEdges = [
      { parent: "unknown", child: "release-tests", kind: "shared_history" },
      { parent: "unknown", child: "atlas", kind: "shared_history" },
    ];
    attachTodayStreams(db, unassignedAnchor, bridgingEdges);
    assert.equal(unassignedAnchor[1].boardStreamId, release.id);
    assert.equal(unassignedAnchor[2].boardStreamId, sessions[2].boardStreamId);
    assert.notEqual(
      unassignedAnchor[1].boardStreamId,
      unassignedAnchor[2].boardStreamId,
      "unassigned shared-history anchors cannot overwrite another saved board assignment",
    );
    attachTodayStreams(db, related, relatedEdges);
    assert.equal(related[1].parent, null);
    assert.equal(related[2].parent, null);
    assert.equal(related[2].boardStreamId, sessions[2].boardStreamId);
    assert.equal(
      relatedEdges.length,
      2,
      "shared history is retained as provenance, not hierarchy",
    );

    assert.ok(
      readMap(db, scope, "embeddinggemma")
        .points.filter((p) => p.topicName === release.title)
        .every((p) => p.cluster === release.id),
    );
    const inputs = overviewStreamContext(db, scope),
      summary = {
        streams: Object.fromEntries(
          inputs.groups.map((g) => [
            g.id,
            {
              text: "You advanced this stream using the supplied evidence.",
              sources: g.evidence.slice(0, 2),
            },
          ]),
        ),
      };
    const focus = savedStreamFocus(summary, inputs, scope);
    assert.equal(
      focus.find((f) => f.title === release.title).streamId,
      release.id,
    );
    assert.equal(
      focus.find((f) => f.title === release.title).links[0].streamId,
      release.id,
    );
    const mcp = createEvidenceService(db),
      results = await mcp.search({
        ...scope,
        streamId: release.id,
        query: "scheduling",
        mode: "keyword",
        limit: 20,
      });
    assert.ok(results.results.length);
    assert.ok(results.results.every((r) => r.streamId === release.id));
    assert.equal(
      (await mcp.streams({ ...scope, streamId: release.id })).streams.length,
      1,
    );
    const restricted = await createEvidenceService(db, {
      allowedProjects: [],
    }).streams(scope);
    assert.equal(restricted.streams.length, 0);
    await analyseArchive(db, { nameGenerator: gen, projectMap: false });
    assert.equal(calls, 1, "unchanged reads/sync reuse the same catalogue");
    assert.equal(
      catalogue(db).find((s) => s.title === release.title).id,
      release.id,
    );
  } finally {
    db.close();
  }
});
test("summary cannot introduce new groups or cite another stream and incomplete analysis cannot replace the catalogue", async () => {
  const db = fixture();
  try {
    await analyseArchive(db, {
      nameGenerator: async (db, s, p) => plan(p),
      projectMap: false,
    });
    const previous = catalogue(db),
      input = overviewStreamContext(db, scope),
      a = input.groups[0],
      b = input.groups[1];
    const result = {
      streams: Object.fromEntries(
        input.groups.map((g) => [
          g.id,
          {
            text: "Supported progress.",
            sources: [g.evidence[0]],
          },
        ]),
      ),
    };
    result.streams[a.id].sources = [b.evidence[0]];
    assert.throws(
      () => savedStreamFocus(result, input, scope),
      /different work stream/,
    );
    result.streams = {};
    assert.throws(
      () => savedStreamFocus(result, input, scope),
      /omitted stream/,
    );
    await assert.rejects(
      analyseArchive(db, {
        force: true,
        projectMap: false,
        nameGenerator: async () => ({ streams: [] }),
      }),
    );
    assert.deepEqual(catalogue(db), previous);
  } finally {
    db.close();
  }
});
