import test from "node:test";
import assert from "node:assert/strict";
import { orderFocus, rankedFocus } from "../server/focus-order.js";
import { DatabaseSync } from "node:sqlite";
import { vectorBuffer } from "../server/db.js";

const now = Date.parse("2026-10-22T12:00:00Z");
function row(id, vector, days = 0, extra = {}) {
  return {
    id,
    vector,
    project: "desktop",
    session: id,
    role: "assistant",
    timestamp: new Date(now - days * 86400000).toISOString(),
    text:
      `${id}: ` +
      "Substantive discussion of implementation and decisions. ".repeat(20),
    ...extra,
  };
}
const items = [
  { id: "small", sourceIds: ["small-seed"] },
  { id: "large", sourceIds: ["large-seed"] },
];
const seeds = [row("small-seed", [1, 0]), row("large-seed", [0, 1])];
const order = (rows, scope = {}) =>
  orderFocus(items, rows, scope, now, seeds).map((i) => i.id);

test("substantial older work outranks a brief recent topic", () => {
  assert.deepEqual(
    order([
      row("brief", [1, 0]),
      ...[1, 2, 3, 4].map((i) => row(`work${i}`, [0, 1], 6)),
    ]),
    ["large", "small"],
  );
});

test("recency breaks ties in discussion volume and respects historical periods", () => {
  const rows = [row("old", [1, 0], 5), row("new", [0, 1], 1)];
  assert.deepEqual(order(rows), ["large", "small"]);
  assert.deepEqual(
    order([...rows, row("future", [1, 0])], {
      end: new Date(now - 0.5 * 86400000).toISOString(),
    }),
    ["large", "small"],
  );
});

test("forks, chunk splitting and long replies do not inflate intensity", () => {
  const long = row("long", [1, 0], 0, { text: "a".repeat(10000) });
  const rows = [
    long,
    { ...long, id: "fork", session: "fork" },
    { ...long, id: "chunk", text: "b".repeat(10000) },
    ...[1, 2, 3].map((i) => row(`work${i}`, [0, 1])),
  ];
  assert.deepEqual(order(rows), ["large", "small"]);
});

test("multi-topic sessions are assigned by content with no reliance on titles", () => {
  const rows = [
    row("one", [1, 0]),
    ...[1, 2, 3].map((i) => row(`two${i}`, [0, 1])),
    row("noise", [-1, 0], 0, { text: "z".repeat(10000) }),
    row("other-project", [1, 0], 0, {
      project: "other",
      text: "x".repeat(10000),
    }),
  ].map((r) => ({ ...r, session: "planning", title: "Plan my day" }));
  assert.deepEqual(order(rows), ["large", "small"]);
  assert.deepEqual(
    order(rows.map((r) => ({ ...r, title: "Completely different" }))),
    ["large", "small"],
  );
});

test("stable ordering preserves identity when no supporting evidence remains", () => {
  const result = orderFocus(items, [], {}, now, []);
  assert.equal(result[0], items[0]);
  assert.equal(result[1], items[1]);
});

test("cached ranking updates after newly indexed discussion", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings(key TEXT,value TEXT);
    CREATE TABLE chunks(id TEXT,project TEXT,session TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT);`);
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)");
  const add = (r) =>
    insert.run(
      r.id,
      r.project,
      r.session,
      r.role,
      r.timestamp,
      r.text,
      vectorBuffer(r.vector),
      "embeddinggemma",
    );
  try {
    seeds.forEach(add);
    add(row("extra-large", [0, 1]));
    assert.equal(rankedFocus(db, {}, items)[0].id, "large");
    assert.equal(rankedFocus(db, {}, items)[0].id, "large");
    for (let i = 0; i < 5; i++) add(row(`extra-small${i}`, [1, 0]));
    assert.equal(rankedFocus(db, {}, items)[0].id, "small");
  } finally {
    db.close();
  }
});
