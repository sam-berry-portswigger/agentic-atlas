import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initTodaySchema } from "../server/today-store.js";
import {
  attachFamilyPreferences,
  setFamilyDetached,
} from "../server/today-family.js";
import { familyRoots, familyOutline } from "../shared/today-layout.js";
import { focusedSessions } from "../shared/today-focus.js";
import {
  sessionReadTargets,
  unreadFamilyCount,
} from "../shared/session-read.js";
import { mountToday } from "../server/today.js";
import { initAnalysisSchema } from "../server/analysis-store.js";

const fixture = () => {
  const sessions = ["root", "fork", "agent"].map((id) => ({
    id,
    topic: { id: "55" },
    unread: true,
    lastResponseAt: "2026-11-02T10:00:00Z",
  }));
  const edges = [
    { parent: "root", child: "fork", kind: "forked" },
    { parent: "fork", child: "agent", kind: "delegated" },
  ];
  return { sessions, edges };
};
test("detach preference persists, reattach restores the family, and source relationships stay intact", () => {
  const db = new DatabaseSync(":memory:");
  initTodaySchema(db);
  try {
    const { sessions, edges } = fixture();
    const original = structuredClone(edges);
    attachFamilyPreferences(db, sessions, edges);
    assert.equal(familyRoots(sessions, edges).roots.length, 1);
    assert.deepEqual(sessions.find((s) => s.id === "fork").familyLink, {
      parent: "root",
      kind: "forked",
      detached: false,
    });
    assert.equal(unreadFamilyCount(sessions, edges), 1);
    setFamilyDetached(db, { session: "fork", detached: true }, sessions, edges);
    const reloaded = fixture();
    attachFamilyPreferences(db, reloaded.sessions, reloaded.edges);
    assert.equal(
      familyRoots(reloaded.sessions, reloaded.edges).roots.length,
      2,
    );
    assert.equal(
      familyRoots(reloaded.sessions, reloaded.edges).root("agent"),
      "fork",
    );
    assert.equal(unreadFamilyCount(reloaded.sessions, reloaded.edges), 2);
    assert.deepEqual(
      sessionReadTargets("root", reloaded.sessions, reloaded.edges).map(
        (s) => s.id,
      ),
      ["root"],
    );
    assert.deepEqual(
      focusedSessions(reloaded.sessions, reloaded.edges, [
        { kind: "session", id: "root" },
      ]).map((s) => s.id),
      ["fork", "agent"],
    );
    setFamilyDetached(
      db,
      { session: "fork", detached: false },
      reloaded.sessions,
      reloaded.edges,
    );
    assert.equal(
      familyRoots(reloaded.sessions, reloaded.edges).roots.length,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM today_family_preferences").get().n,
      0,
    );
    assert.deepEqual(edges, original);
    assert.equal(
      sessions[1].parent,
      undefined,
      "display grouping does not invent native parenthood",
    );
    assert.throws(
      () =>
        setFamilyDetached(
          db,
          { session: "agent", detached: true },
          sessions,
          edges,
        ),
      /no related branch/,
    );
    assert.throws(
      () =>
        setFamilyDetached(
          db,
          { session: "missing", detached: true },
          sessions,
          edges,
        ),
      /Refresh Today/,
    );
    assert.throws(
      () =>
        setFamilyDetached(
          db,
          { session: "fork", detached: "yes" },
          sessions,
          edges,
        ),
      /boolean/,
    );
  } finally {
    db.close();
  }
});
test("cross-topic forks stay separate and cycles or duplicate provenance cannot lose chats", () => {
  const { sessions, edges } = fixture();
  sessions[1].topic.id = "43";
  sessions[2].topic.id = "43";
  assert.deepEqual(
    familyRoots(sessions, edges).roots.map((s) => s.id),
    ["root", "fork"],
  );
  sessions[1].topic.id = "55";
  sessions[2].topic.id = "55";
  const malformed = [
    ...edges,
    { parent: "agent", child: "root", kind: "shared_history" },
    { parent: "root", child: "fork", kind: "shared_history" },
    { parent: "missing", child: "fork", kind: "forked" },
  ];
  const forest = familyRoots(sessions, malformed);
  assert.equal(forest.roots.length, 1);
  assert.equal(
    new Set(
      familyOutline(sessions, malformed, forest.roots[0].id).map((r) => r.id),
    ).size,
    3,
  );
});
test("Today API detach and reattach survives refreshed native snapshots without changing history", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE chunks(id TEXT,session TEXT,project TEXT,title TEXT,provider TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT)",
  );
  initTodaySchema(db);
  initAnalysisSchema(db);
  const routes = new Map();
  const app = {
    use() {},
    get(route, handler) {
      routes.set("GET " + route, handler);
    },
    post(route, handler) {
      routes.set("POST " + route, handler);
    },
  };
  const now = Date.now(),
    stamp = new Date(now).toISOString();
  mountToday(app, db, {
    discover: async () => {
      const data = fixture();
      return {
        ...data,
        sessions: data.sessions.map((s) => ({
          ...s,
          provider: "claude",
          title: s.id,
          updated: stamp,
          status: "done",
        })),
        rewoundSessions: [],
        warnings: [],
      };
    },
  });
  const call = async (method, path, body) => {
    let result;
    await routes.get(method + " " + path)(
      {
        body,
        query: {
          start: new Date(now - 60000).toISOString(),
          end: new Date(now + 60000).toISOString(),
        },
      },
      {
        json(value) {
          result = value;
        },
      },
      (error) => {
        throw error;
      },
    );
    return result;
  };
  try {
    const first = await call("GET", "/api/today");
    assert.equal(familyRoots(first.sessions, first.edges).roots.length, 1);
    await call("POST", "/api/today/family", {
      session: "fork",
      detached: true,
    });
    const second = await call("GET", "/api/today");
    assert.equal(familyRoots(second.sessions, second.edges).roots.length, 2);
    assert.equal(
      second.sessions.find((s) => s.id === "fork").familyLink.detached,
      true,
    );
    await call("POST", "/api/today/family", {
      session: "fork",
      detached: false,
    });
    const final = await call("GET", "/api/today");
    assert.equal(familyRoots(final.sessions, final.edges).roots.length, 1);
    assert.deepEqual(final.edges, first.edges);
  } finally {
    db.close();
  }
});
test("a detached shared-history anchor stays separate when discovery changes its anchor", () => {
  const db = new DatabaseSync(":memory:");
  initTodaySchema(db);
  try {
    const sessions = ["a", "b", "c", "worker"].map((id) => ({
      id,
      topic: { id: "55" },
    }));
    const before = [
      { parent: "a", child: "b", kind: "shared_history" },
      { parent: "a", child: "c", kind: "shared_history" },
      { parent: "b", child: "worker", kind: "spawned" },
    ];
    setFamilyDetached(db, { session: "b", detached: true }, sessions, before);
    const changed = [
      { parent: "b", child: "a", kind: "shared_history" },
      { parent: "b", child: "c", kind: "shared_history" },
      { parent: "b", child: "worker", kind: "spawned" },
    ];
    attachFamilyPreferences(db, sessions, changed);
    const forest = familyRoots(sessions, changed);
    assert.equal(forest.roots.length, 2);
    assert.equal(forest.root("worker"), "b");
    assert.equal(forest.root("a"), forest.root("c"));
    assert.notEqual(forest.root("a"), "b");
    assert.equal(sessions[1].familyLink.detached, true);
    setFamilyDetached(db, { session: "b", detached: false }, sessions, changed);
    assert.equal(familyRoots(sessions, changed).roots.length, 1);
  } finally {
    db.close();
  }
});

test("an unassigned shared-history anchor cannot bridge distinct saved topics", () => {
  const sessions = [
    { id: "unknown" },
    { id: "scheduling", topic: { id: "43" } },
    { id: "atlas", topic: { id: "55" } },
  ];
  const edges = [
    { parent: "unknown", child: "scheduling", kind: "shared_history" },
    { parent: "unknown", child: "atlas", kind: "shared_history" },
  ];
  for (const ordered of [edges, [...edges].reverse()]) {
    const forest = familyRoots(sessions, ordered);
    assert.notEqual(forest.root("scheduling"), forest.root("atlas"));
    assert.equal(forest.roots.length, 2);
  }
  assert.equal(sessions[0].topic, undefined);
});
