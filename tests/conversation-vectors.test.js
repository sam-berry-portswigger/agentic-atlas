import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  conversationVectors,
  conversationAnchors,
} from "../server/conversation-vectors.js";
import { cosine, normalize, vectorBuffer, vectorArray } from "../server/db.js";
import { semanticConversationGroup } from "../server/semantic-policy.js";
import { analyseArchive } from "../server/analysis.js";
import { initAnalysisSchema, readMap } from "../server/analysis-store.js";

const message = (
  session,
  id,
  vector,
  text,
  role = "user",
  timestamp = "2026-10-29T10:00:00Z",
) => ({
  session,
  id,
  vector,
  text,
  role,
  timestamp,
  project: "same-repository",
  title: "Continue the task",
});

test("synthetic 768-dimensional examples distinguish related, ambiguous and unrelated conversations", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/semantic-conversations.json", import.meta.url),
    ),
  );
  for (const group of fixture.groups) {
    group.center = vectorArray(Buffer.from(group.center, "base64"));
    for (const reference of group.references)
      reference.vector = vectorArray(Buffer.from(reference.vector, "base64"));
  }
  for (const query of fixture.queries) {
    query.vector = vectorArray(Buffer.from(query.vector, "base64"));
    assert.equal(query.vector.length, fixture.dimensions);
    assert.equal(
      semanticConversationGroup(query.vector, fixture.groups)?.id ?? null,
      query.expected,
      query.name,
    );
  }
});

test("conversation vectors use the wider history and give long, repeatedly chunked messages one vote", () => {
  const rows = [
    message("ui", "opening", [0, 1], "Check the board"),
    message(
      "ui",
      "request",
      [1, 0],
      "Improve Atlas session navigation and make its task controls consistent.",
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      message(
        "ui",
        "chunk" + i,
        [0, 1],
        `Technical appendix section ${i}: ` +
          "A long unrelated technical example. ".repeat(10),
        "assistant",
        "2026-10-29T11:00:00Z",
      ),
    ),
    message(
      "ui",
      "request-2",
      [1, 0],
      "Group related Atlas conversations and simplify the work-stream interface.",
      "user",
      "2026-10-30T11:00:00Z",
    ),
  ];
  const representation = conversationVectors(rows)[0];
  assert.ok(
    cosine(representation.vector, [1, 0]) > 0.95,
    "an appendix's many chunks cannot overwhelm the work objective",
  );
  assert.equal(
    representation.rows.length,
    rows.length,
    "every original passage retains membership",
  );
  assert.equal(representation.evidence.length, 3);
  assert.deepEqual(
    Array.from(conversationVectors([...rows].reverse())[0].vector),
    Array.from(representation.vector),
  );
});

test("legacy examples incompatible with a stream's semantic scope cannot contaminate its prototype", () => {
  const rows = [
    message(
      "ui",
      "a",
      [1, 0],
      "Develop the Atlas session organisation and search interface.",
    ),
    message(
      "wrong",
      "b",
      [0, 1],
      "Investigate OpenTelemetry spans and verify the sample metrics dashboard.",
    ),
  ];
  const topics = [
    { id: 55, name: "Atlas interface" },
    { id: 51, name: "Telemetry evidence" },
  ];
  const scopes = new Map([
    [55, [1, 0]],
    [51, [0, 1]],
  ]);
  const anchors = conversationAnchors(
    topics,
    conversationVectors(rows),
    new Map([
      ["a", 55],
      ["b", 55],
    ]),
    scopes,
  );
  assert.deepEqual(
    anchors[0].references.map((r) => r.session),
    ["ui"],
  );
  assert.ok(cosine(anchors[0].center, [1, 0]) > 0.99);
});

test("local semantic support refines a mixed neighbourhood while unrelated ambiguity remains residual", () => {
  const ui = {
    name: "Atlas interface",
    center: normalize([1, 0, 0]),
    references: [
      {
        session: "ui",
        evidenceKey: "ui-evidence",
        vector: normalize([1, 0.01, 0]),
      },
    ],
  };
  const telemetry = {
    name: "Telemetry",
    center: normalize([0, 1, 0]),
    references: [
      {
        session: "telemetry",
        evidenceKey: "telemetry-evidence",
        vector: normalize([0, 1, 0]),
      },
    ],
  };
  assert.equal(
    semanticConversationGroup(normalize([1, 0.02, 0]), [ui, telemetry]),
    ui,
  );
  assert.equal(
    semanticConversationGroup(normalize([0, 1, 0.02]), [ui, telemetry]),
    telemetry,
  );
  assert.equal(
    semanticConversationGroup(normalize([1, 1, 0]), [ui, telemetry]),
    null,
  );
  assert.equal(semanticConversationGroup([0, 0, 1], [ui, telemetry]), null);
});

test("the map plots one conversation vector and date filters preserve its coordinates even when its representative is outside the window", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
    );
    initAnalysisSchema(db);
    const rows = [
      message(
        "ui",
        "early",
        [1, 0],
        "Improve the Atlas work-stream overview and session organisation.",
      ),
      message(
        "ui",
        "late",
        [1, 0],
        "Refine Atlas board cards and linked-session navigation controls.",
        "user",
        "2026-10-30T11:00:00Z",
      ),
      message(
        "telemetry",
        "trace",
        [0, 1],
        "Investigate telemetry traces and verify the sample metrics journey dashboard.",
        "user",
        "2026-10-30T11:00:00Z",
      ),
    ];
    for (const r of rows)
      db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
        r.id,
        r.session,
        r.project,
        r.title,
        r.role,
        r.timestamp,
        r.text,
        vectorBuffer(r.vector),
        "embeddinggemma",
        null,
        null,
        null,
      );
    await analyseArchive(db, {
      projectMap: false,
      scopeEmbedder: null,
      nameGenerator: async (_db, _system, prompt) => {
        const input = JSON.parse(prompt);
        return {
          streams: input.sessions.map((s) => ({
            name: s.firstRequest.includes("Atlas")
              ? "Atlas interface"
              : "Telemetry evidence",
            description:
              "A sustained work objective grounded in the supplied conversation evidence.",
            sources: [s.source],
            background: false,
          })),
        };
      },
    });
    const all = readMap(db, {}, "embeddinggemma");
    const today = readMap(
      db,
      { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" },
      "embeddinggemma",
    );
    assert.equal(all.unit, "conversation");
    assert.equal(all.points.length, 2);
    assert.equal(today.points.length, 2);
    const original = all.points.find((p) => p.session === "ui"),
      filtered = today.points.find((p) => p.session === "ui");
    assert.equal(original.passages, 2);
    assert.equal(filtered.passages, 1);
    assert.deepEqual(
      [filtered.x, filtered.y, filtered.cluster],
      [original.x, original.y, original.cluster],
    );
    assert.equal(filtered.id, "late");
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)")
          .run(
            "obsolete-client",
            "old",
            "embeddinggemma",
            "mock",
            "2026-10-30",
            JSON.stringify({ method: "workstreams-v2" }),
          ),
      /older analysis policy/,
    );
    assert.equal(
      readMap(db, {}, "embeddinggemma").analysisVersion,
      all.analysisVersion,
      "an old client cannot replace the conversation catalogue",
    );
  } finally {
    db.close();
  }
});
