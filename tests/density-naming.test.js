import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { nameDensityGroups } from "../server/density-naming.js";
import { vectorBuffer } from "../server/db.js";

test("fixed density naming changes only names and descriptions, preserves manual names, and reuses cached evidence", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initAnalysisSchema(db);
    db.exec(
      "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE chunks(id TEXT PRIMARY KEY,session TEXT,title TEXT,project TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,x REAL,y REAL,cluster INTEGER)",
    );
    db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
      "v",
      "f",
      "embeddinggemma",
      "mock",
      "now",
      JSON.stringify({ densityPolicy: "test-density", namingPending: true }),
    );
    db.exec("INSERT INTO analysis_state VALUES('active','v')");
    for (const [id, name] of [
      [10, "Representative title"],
      [20, "User chosen name"],
      [30, "Other sessions"],
    ])
      db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
        "v",
        id,
        name,
        "Existing scope sentence remains protected for manual work.",
        "#123456",
        vectorBuffer([1, 0]),
      );
    for (const [session, title, topic, vector] of [
      ["import", "Document import", 10, [1, 0]],
      ["verify", "Import validation", 10, [0.9, 0.1]],
      ["manual", "Protected conversation", 20, [0, 1]],
      ["noise", "Unclassified", 30, [-1, 0]],
    ]) {
      for (const suffix of ["", "-followup"]) {
        const id = session + suffix;
        db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
          id,
          session,
          title,
          "project",
          "user",
          "2026-11-03T10:00:00Z",
          "Implement document import and validate the resulting records without losing original content.",
          vectorBuffer(vector),
          0.2,
          0.7,
          topic,
        );
        db.prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)").run(
          "v",
          id,
          topic,
          0.2,
          0.7,
        );
      }
      db.prepare("INSERT INTO analysis_conversations VALUES(?,?,?,?,?,?)").run(
        "v",
        session,
        session,
        vectorBuffer(vector),
        0.2,
        0.7,
      );
    }
    db.prepare(
      "INSERT INTO analysis_state VALUES('stream_session_assignments',?)",
    ).run(JSON.stringify({ manual: 20 }));
    const invariant = () => ({
      chunks: db.prepare("SELECT * FROM chunks ORDER BY id").all(),
      members: db
        .prepare("SELECT * FROM analysis_members ORDER BY chunk_id")
        .all(),
      conversations: db
        .prepare("SELECT * FROM analysis_conversations ORDER BY session")
        .all(),
      topicMetadata: db
        .prepare(
          "SELECT version,id,color,centroid FROM analysis_topics ORDER BY id",
        )
        .all(),
      protectedTopics: db
        .prepare("SELECT * FROM analysis_topics WHERE id<>10 ORDER BY id")
        .all(),
    });
    db.prepare("INSERT INTO session_title_overrides VALUES(?,?,?)").run(
      "import",
      "Local Belfry setup",
      "now",
    );
    const before = invariant();
    let calls = 0;
    const nameGenerator = async (_db, system, prompt, schema) => {
      calls++;
      const input = JSON.parse(prompt);
      assert.match(system, /Name the concrete subject/);
      assert.match(system, /session names/);
      assert.doesNotMatch(
        system,
        /Split only|separately pursued|sessionLabels/,
      );
      const sessions = input.topics.flatMap((t) => t.sessions);
      assert.ok(sessions.some((s) => s.sessionName === "Local Belfry setup"));
      assert.deepEqual(schema.required, ["topics"]);
      assert.ok(sessions.length > 0);
      assert.ok(
        sessions.every((source) =>
          ["Local Belfry setup", "Import validation"].includes(
            source.sessionName,
          ),
        ),
      );
      return {
        topics: input.topics.map((t) => ({
          key: t.key,
          name: "Belfry",
          description:
            "Belfry setup and document import validation with original content preserved.",
          background: false,
        })),
      };
    };
    await nameDensityGroups(db, { nameGenerator });
    assert.equal(
      calls,
      1,
      "manual and residual groups are excluded from generation",
    );
    const named = db
      .prepare("SELECT name,description FROM analysis_topics WHERE id=10")
      .get();
    assert.equal(named.name, "Belfry");
    assert.match(named.description, /Belfry/);
    assert.deepEqual(invariant(), before);
    assert.equal(
      JSON.parse(
        db.prepare("SELECT data FROM analysis_runs WHERE id='v'").get().data,
      ).namingPending,
      false,
    );
    await nameDensityGroups(db, { nameGenerator });
    assert.equal(
      calls,
      1,
      "unchanged fixed-group evidence reuses the validated naming cache",
    );
    assert.deepEqual(invariant(), before);
    const data = JSON.parse(
      db.prepare("SELECT data FROM analysis_runs WHERE id='v'").get().data,
    );
    db.prepare("UPDATE analysis_runs SET data=? WHERE id='v'").run(
      JSON.stringify({
        ...data,
        workstreamPolicy: "named-workstream-clusters-v1",
        workstreamNamingIds: [],
      }),
    );
    db.prepare(
      "UPDATE session_title_overrides SET title=? WHERE session='import'",
    ).run("Belfry configuration");
    await nameDensityGroups(db, {
      nameGenerator: () => {
        throw Error("routine sync renamed stable work");
      },
    });
    const refreshed = async (_db, _system, prompt) => {
      calls++;
      assert.equal(JSON.parse(prompt).topics[0].existingName, "Belfry");
      assert.ok(
        JSON.parse(prompt).topics.some((t) =>
          t.sessions.some((s) => s.sessionName === "Belfry configuration"),
        ),
      );
      return {
        topics: JSON.parse(prompt).topics.map((t) => ({
          key: t.key,
          name: "Belfry configuration",
          description: "Belfry configuration and document import validation.",
          background: false,
        })),
      };
    };
    await nameDensityGroups(db, { refresh: true, nameGenerator: refreshed });
    assert.equal(calls, 2, "explicit refresh uses changed displayed names");
    await nameDensityGroups(db, {
      refresh: true,
      nameGenerator: () => {
        throw Error("unchanged naming evidence missed cache");
      },
    });
    assert.equal(
      db.prepare("SELECT name FROM analysis_topics WHERE id=10").get().name,
      "Belfry",
    );
    assert.deepEqual(invariant(), before);
    db.prepare("UPDATE chunks SET text=? WHERE session='import'").run(
      "The work now covers importing documents and distributing organisation policy to clients.",
    );
    await nameDensityGroups(db, {
      refresh: true,
      nameGenerator: async (_db, _system, prompt) => ({
        topics: JSON.parse(prompt).topics.map((t) => ({
          key: t.key,
          name: "Belfry configuration distribution",
          description:
            "Import documents and distribute organisation policy to clients.",
          background: false,
          renameReason:
            "The scope now includes distributing organisation policy to clients as well as local setup.",
        })),
      }),
    });
    assert.equal(
      db.prepare("SELECT name FROM analysis_topics WHERE id=10").get().name,
      "Belfry configuration distribution",
    );
  } finally {
    db.close();
  }
});
