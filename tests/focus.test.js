import test from "node:test";
import assert from "node:assert/strict";
import {
  focusContext,
  cleanFocus,
  workItems,
  projectFocusSchema,
  projectFocus,
} from "../server/focus.js";

test("focus uses shared numbered evidence and preserves distinct neighborhoods", () => {
  const first = {
    id: "one",
    text: "You chose SQLite.",
    timestamp: "2026-10-20T10:00:00Z",
  };
  const second = {
    id: "two",
    text: "You migrated the imaging UI to React.",
    timestamp: "2026-10-21T10:00:00Z",
  };
  const { sources, groups } = focusContext([
    { cluster: 1, sources: [first] },
    { cluster: 2, sources: [first, second] },
  ]);
  assert.deepEqual(
    groups.map((g) => g.evidence),
    [[1], [1, 2]],
  );
  assert.equal(sources.length, 2);
  const focus = cleanFocus(
    {
      focus: [
        {
          title: "Local storage",
          text: "You chose SQLite.",
          sources: [1, 999],
        },
        {
          title: "Imaging UI",
          text: "You migrated the imaging UI to React.",
          sources: [2],
        },
        { title: "Invented", text: "No source.", sources: [999] },
      ],
    },
    sources,
    { start: "2026-10-19T00:00:00Z", end: "2026-10-22T00:00:00Z" },
  );
  assert.equal(focus.length, 2);
  assert.deepEqual(focus[0].sourceIds, ["one"]);
  assert.deepEqual(focus[0].clusters, [1, 2]);
  assert.notEqual(focus[0].id, focus[1].id);
  assert.throws(
    () =>
      cleanFocus(
        {
          focus: [
            {
              title: "Old work",
              text: "Work outside the period.",
              sources: [1],
            },
          ],
        },
        sources,
        { start: "2026-10-21T00:00:00Z" },
      ),
    /supported/,
  );
});

test("existing focus text stays readable and supports on-demand questions without precomputation", () => {
  const data = {
    topics: [{ cluster: 3, title: "Authentication", sourceIds: ["source"] }],
    overview: {
      focus: [{ text: "You refined token persistence.", clusters: [3] }],
    },
  };
  assert.deepEqual(workItems(data), [
    {
      id: "legacy-0",
      title: "Authentication",
      text: "You refined token persistence.",
      clusters: [3],
      sourceIds: ["source"],
      links: [{ title: "Authentication", sourceIds: ["source"], cluster: 3 }],
    },
  ]);
});

test("project context joins research and migration across map neighborhoods", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { buildGroups } = await import("../server/insights.js");
  const { vectorBuffer } = await import("../server/db.js");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings(key TEXT,value TEXT);
    CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,cluster INTEGER);`);
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for (const row of [
    [
      "research",
      "imaging",
      "Understand activations",
      "Explain how the model brain imaging project's ablate and suppress modes modify activations.",
      1,
    ],
    [
      "migration",
      "imaging",
      "React migration",
      "Migrate this model brain imaging visualization from one HTML file to React and shadcn.",
      2,
    ],
    [
      "auth",
      "desktop",
      "Authentication",
      "Fix sign-out token refresh races in the desktop authentication flow.",
      1,
    ],
  ]) {
    const [id, project, title, text, cluster] = row;
    insert.run(
      id,
      id,
      project,
      title,
      "user",
      "2026-10-20T10:00:00Z",
      text,
      vectorBuffer(cluster === 1 ? [1, 0] : [0, 1]),
      "embeddinggemma",
      0,
      cluster,
    );
  }
  try {
    const snapshot = buildGroups(
      db,
      {
        project: "",
        start: "2026-10-19T00:00:00Z",
        end: "2026-10-22T00:00:00Z",
      },
      40000,
    );
    const filtered = buildGroups(
      db,
      {
        project: "",
        start: "2026-10-19T00:00:00Z",
        end: "2026-10-22T00:00:00Z",
      },
      40000,
      { minimumDiscussion: true },
    );
    assert.equal(
      filtered.projectGroups.length,
      0,
      "brief projects cannot consume the overview context budget",
    );
    const explicit = buildGroups(
      db,
      {
        project: "imaging",
        start: "2026-10-19T00:00:00Z",
        end: "2026-10-22T00:00:00Z",
      },
      40000,
      { minimumDiscussion: true },
    );
    assert.equal(
      explicit.projectGroups.length,
      1,
      "a deliberately selected project remains inspectable",
    );
    assert.equal(snapshot.projectGroups.length, 2);
    const imaging = snapshot.projectGroups.find((g) => g.project === "imaging");
    assert.deepEqual(
      new Set(imaging.sources.map((s) => s.id)),
      new Set(["research", "migration"]),
    );
    const context = focusContext(snapshot.projectGroups);
    assert.equal(
      context.groups.find((g) => g.project === "imaging").evidence.length,
      2,
    );
    assert.deepEqual(
      context.sources.find((s) => s.id === "research").clusters,
      [1],
    );
    assert.deepEqual(
      context.sources.find((s) => s.id === "migration").clusters,
      [2],
    );
    const merged = cleanFocus(
      {
        focus: [
          {
            title: "Model brain imaging",
            text: "You explored activation interventions and migrated the visualization to React.",
            sources: context.groups.find((g) => g.project === "imaging")
              .evidence,
          },
        ],
      },
      context.sources,
      { start: "2026-10-19T00:00:00Z" },
    );
    assert.deepEqual(new Set(merged[0].clusters), new Set([1, 2]));
    assert.equal(merged[0].sourceIds.length, 2);
  } finally {
    db.close();
  }
});

test("overview response provides one primary paragraph per project, with independent objectives explicit", () => {
  const groups = [{ project: "imaging" }, { project: "desktop" }];
  const schema = projectFocusSchema(groups);
  assert.deepEqual(schema.properties.projects.required, ["imaging", "desktop"]);
  const result = projectFocus(
    {
      summary: "This week",
      projects: {
        imaging: {
          title: "Model brain imaging",
          text: "Research and React migration",
          independentObjectives: [],
        },
        desktop: {
          title: "Authentication",
          independentObjectives: [{ title: "Review tooling" }],
        },
      },
    },
    groups,
  );
  assert.deepEqual(
    result.focus.map((f) => f.title),
    ["Model brain imaging", "Authentication", "Review tooling"],
  );
});

test("discussion threshold counts distinct messages, not chunks, forks or long one-off prompts", async () => {
  const { discussionSize } = await import("../server/insights.js");
  const row = {
    session: "one",
    role: "user",
    timestamp: "2026-10-20T10:00:00Z",
    text: "Please install and configure this development tool. ".repeat(80),
  };
  const fragments = Array.from({ length: 20 }, (_, i) => ({
    ...row,
    text: `${i}: ${row.text}`,
  }));
  assert.equal(discussionSize(fragments).turns, 1);
  assert.equal(discussionSize(fragments).substantial, false);
  const exchange = [
    row,
    {
      ...row,
      role: "assistant",
      text: "The tool is installed and the server is running. ".repeat(10),
    },
  ];
  const copies = Array.from({ length: 12 }, (_, i) =>
    exchange.map((r) => ({ ...r, session: `fork-${i}` })),
  ).flat();
  assert.equal(discussionSize(copies).turns, 2);
  assert.equal(discussionSize(copies).substantial, false);
  const sustained = Array.from({ length: 6 }, (_, i) => ({
    ...row,
    role: i % 2 ? "assistant" : "user",
    timestamp: `2026-10-20T10:0${i}:00Z`,
    text: `Discussion ${i}: ${"We investigated the activation pipeline and compared implementation approaches. ".repeat(10)}`,
  }));
  assert.equal(
    discussionSize(sustained).substantial,
    true,
    "one sustained session is sufficient",
  );
  assert.equal(
    discussionSize(
      sustained.map((r) => ({
        ...r,
        text:
          "A distinct substantive message with little detail " + r.timestamp,
      })),
    ).substantial,
    false,
    "brief exchanges still need enough content",
  );
});
