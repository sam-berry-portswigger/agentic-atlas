import test from "node:test";
import assert from "node:assert/strict";
import {
  linkSharedHistory,
  coalesceClaudeRewinds,
} from "../server/today-lineage.js";
import { familyRoots } from "../shared/today-layout.js";
import {
  sessionReadTargets,
  unreadFamilyCount,
} from "../shared/session-read.js";
import { focusedSessions } from "../shared/today-focus.js";
const session = (id, requests, history, at, extras = {}) => ({
  id,
  provider: "claude",
  cwd: "/project",
  title: "Inherited title",
  _requests: requests.map(([id, text]) => ({ id, text })),
  _history: history.map((id) => ({ id })),
  _lastRequestAt: at,
  ...extras,
});
test("recorded undo replacements show one current chat and retain delegated children", () => {
  const old = session("old", [["u", "Review"]], ["u", "a", "b"], 1),
    current = session(
      "current",
      [
        ["u", "Review"],
        ["v", "Be specific"],
      ],
      ["u", "a", "b", "v"],
      2,
    ),
    fork = session(
      "fork",
      [
        ["u", "Review"],
        ["w", "Different goal"],
      ],
      ["u", "a", "b", "w"],
      3,
      { familyDetached: true },
    ),
    child = session("worker", [], [], 2, { parent: "old", child: true });
  const sessions = new Map([old, current, fork, child].map((s) => [s.id, s]));
  const edges = [{ parent: "old", child: "worker", kind: "spawned" }];
  coalesceClaudeRewinds(
    sessions,
    edges,
    new Map([
      ["current", { cliSessionId: "current", priorCliSessionIds: ["old"] }],
    ]),
  );
  linkSharedHistory(sessions, edges);
  assert.deepEqual([...sessions.keys()], ["current", "fork", "worker"]);
  assert.equal(child.parent, "current");
  assert.deepEqual(
    familyRoots([...sessions.values()], edges).roots.map((s) => s.id),
    ["current", "fork"],
  );
  assert.ok(
    edges.some(
      (e) =>
        e.parent === "current" && e.child === "worker" && e.kind === "spawned",
    ),
  );
});
test("an old log with its own Desktop chat or an unavailable replacement stays visible", () => {
  for (const withCurrent of [true, false]) {
    const sessions = new Map(
      [
        session("old", [], [], 1),
        ...(withCurrent ? [session("current", [], [], 2)] : []),
      ].map((s) => [s.id, s]),
    );
    const desktop = new Map([
      ["current", { cliSessionId: "current", priorCliSessionIds: ["old"] }],
      ...(withCurrent
        ? [["old", { cliSessionId: "old", priorCliSessionIds: [] }]]
        : []),
    ]);
    coalesceClaudeRewinds(sessions, [], desktop);
    assert.ok(sessions.has("old"));
  }
});
test("copied UUID histories collapse by default and detached branches retain their delegated children", () => {
  const a = session(
    "a",
    [
      ["u1", "Release"],
      ["u2", "Draft announcement"],
    ],
    ["u1", "answer1", "u2", "answer2"],
    1,
  );
  const b = session(
    "b",
    [
      ["u1", "Release"],
      ["u2", "Draft announcement"],
      ["u3", "Check SSO ownership"],
    ],
    ["u1", "answer1", "u2", "u3"],
    2,
  );
  const unrelated = session("other", [["x", "Release"]], ["x", "y", "z"], 3);
  const child = session("child", [], [], 3, { parent: "b", child: true });
  const sessions = new Map([a, b, unrelated, child].map((s) => [s.id, s]));
  const edges = [{ parent: "b", child: "child", kind: "spawned" }];
  linkSharedHistory(sessions, edges);
  assert.equal(b.parent, undefined);
  assert.notEqual(b.child, true);
  assert.equal(b.title, "Check SSO ownership");
  assert.equal(b.originalTitle, "Inherited title");
  assert.equal(b.relationship, "shared_history");
  assert.equal(unrelated.parent, undefined);
  assert.equal(child.parent, "b");
  assert.deepEqual(edges, [
    { parent: "b", child: "child", kind: "spawned" },
    { parent: "a", child: "b", kind: "shared_history" },
  ]);
  assert.equal(b._history, undefined);
  const values = [...sessions.values()];
  const forest = familyRoots(values, edges);
  assert.equal(forest.root("a"), "a");
  assert.equal(forest.root("b"), "a");
  assert.equal(forest.root("child"), "a");
  assert.deepEqual(
    focusedSessions(values, edges, [{ kind: "session", id: "a" }]).map(
      (s) => s.id,
    ),
    ["other"],
  );
  for (const s of values) {
    s.lastResponseAt = "2026-10-30T10:00:00Z";
    s.unread = s.id !== "other";
  }
  assert.deepEqual(
    sessionReadTargets("a", values, edges).map((s) => s.id),
    ["a", "b", "child"],
  );
  assert.deepEqual(
    sessionReadTargets("b", values, edges).map((s) => s.id),
    ["b", "child"],
  );
  assert.equal(unreadFamilyCount(values, edges), 1);
  b.familyDetached = true;
  assert.equal(familyRoots(values, edges).root("child"), "b");
  assert.equal(unreadFamilyCount(values, edges), 2);
  assert.deepEqual(
    focusedSessions(values, edges, [{ kind: "session", id: "a" }]).map(
      (s) => s.id,
    ),
    ["b", "other", "child"],
  );
});
test("same titles, text, or a single copied message cannot create a family", () => {
  const a = session("a", [["u", "Release"]], ["u"], 1);
  const b = session("b", [["u", "Release"]], ["u", "other"], 2);
  const c = session("c", [["u", "Release"]], ["u", "answer", "more"], 3, {
    cwd: "/other-project",
  });
  const edges = [];
  linkSharedHistory(new Map([a, b, c].map((s) => [s.id, s])), edges);
  assert.deepEqual(edges, []);
});

test("a recorded fork shares its display family until detached, retaining native delegates", () => {
  const sessions = ["original", "fork", "worker"].map((id) => ({
    id,
    topic: { id: "43" },
    lastResponseAt: "2026-10-30T11:00:00Z",
  }));
  const edges = [
    { parent: "original", child: "fork", kind: "forked" },
    { parent: "fork", child: "worker", kind: "delegated" },
  ];
  const attached = familyRoots(sessions, edges);
  assert.deepEqual(
    attached.roots.map((s) => s.id),
    ["original"],
  );
  assert.deepEqual(
    sessionReadTargets("original", sessions, edges).map((s) => s.id),
    ["original", "fork", "worker"],
  );
  sessions.find((s) => s.id === "fork").familyDetached = true;
  const forest = familyRoots(sessions, edges);
  assert.deepEqual(
    forest.roots.map((s) => s.id),
    ["original", "fork"],
  );
  assert.equal(forest.root("worker"), "fork");
  assert.deepEqual(
    sessionReadTargets("original", sessions, edges).map((s) => s.id),
    ["original"],
  );
  assert.deepEqual(
    sessionReadTargets("fork", sessions, edges).map((s) => s.id),
    ["fork", "worker"],
  );
});

test("discovery cleans reminders before clipping and ignores title bookkeeping for recency", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { discoverToday } = await import("../server/today.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-lineage-"));
  try {
    const project = path.join(dir, "project");
    await mkdir(project);
    const now = Date.now(),
      at = now - 60000,
      stamp = new Date(at).toISOString();
    const rows = [
      {
        type: "user",
        uuid: "request",
        timestamp: stamp,
        message: {
          content:
            "<system-reminder>" +
            "context ".repeat(300) +
            "</system-reminder>Check the release tests",
        },
      },
      {
        type: "custom-title",
        timestamp: new Date(now).toISOString(),
        customTitle: "Release",
      },
    ];
    await writeFile(
      path.join(project, "active.jsonl"),
      rows.map(JSON.stringify).join("\n"),
    );
    await writeFile(
      path.join(project, "metadata-only.jsonl"),
      JSON.stringify({
        ...rows[0],
        uuid: "metadata",
        message: {
          content:
            "<system-reminder>" + "context ".repeat(300) + "</system-reminder>",
        },
      }),
    );
    const result = await discoverToday(
      { source: dir, codexSource: "" },
      { start: now - 120000, end: now + 1000, now, home: dir },
    );
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].lastRequest, "Check the release tests");
    assert.equal(result.sessions[0].updated, stamp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native discovery follows Desktop undo metadata while ordinary copied chats remain separate", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { discoverToday } = await import("../server/today.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-native-rewind-"));
  try {
    const source = path.join(dir, "logs"),
      project = path.join(source, "project"),
      metadata = path.join(
        dir,
        "Library/Application Support/Claude/claude-code-sessions/org/account",
      );
    await mkdir(project, { recursive: true });
    await mkdir(metadata, { recursive: true });
    const old = "11111111-1111-4111-8111-111111111111",
      current = "22222222-2222-4222-8222-222222222222",
      fork = "33333333-3333-4333-8333-333333333333",
      host = "local_44444444-4444-4444-8444-444444444444",
      now = Date.now(),
      at = new Date(now - 60000).toISOString();
    const common = [
      {
        type: "user",
        uuid: "u1",
        timestamp: at,
        cwd: project,
        message: { content: "Review the release" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: at,
        message: { content: [{ type: "text", text: "Release evidence" }] },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: at,
        message: { content: "Give me the details" },
      },
    ];
    for (const id of [old, current, fork])
      await writeFile(
        path.join(project, id + ".jsonl"),
        common.map((r) => JSON.stringify({ ...r, sessionId: id })).join("\n"),
      );
    await mkdir(path.join(project, old, "subagents"), { recursive: true });
    await writeFile(
      path.join(project, old, "subagents/worker.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "worker-response",
        timestamp: at,
        message: {
          content: [{ type: "text", text: "Delegated review result" }],
        },
      }),
    );
    await writeFile(
      path.join(metadata, host + ".json"),
      JSON.stringify({
        sessionId: host,
        cliSessionId: current,
        priorCliSessionIds: [old],
        rewindEdges: [{ parent: old, child: current }],
      }),
    );
    const result = await discoverToday(
      { source, codexSource: "" },
      { start: now - 120000, end: now + 1000, now, home: dir },
    );
    assert.equal(
      result.sessions.some((s) => s.id === old),
      false,
    );
    assert.ok(
      result.sessions.some((s) => s.id === current && s.hostSessionId === host),
    );
    assert.ok(result.sessions.some((s) => s.id === fork));
    assert.ok(
      result.sessions.some(
        (s) => s.id === old + ":worker" && s.parent === current,
      ),
    );
    assert.equal(familyRoots(result.sessions, result.edges).roots.length, 1);
    result.sessions.find((s) => s.id === fork).familyDetached = true;
    assert.equal(familyRoots(result.sessions, result.edges).roots.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
