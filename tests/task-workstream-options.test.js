import test from "node:test";
import assert from "node:assert/strict";
import { taskStreamOptions } from "../shared/task-workstreams.js";

test("new task choices match mapped workstreams, excluding old catalogue entries and historical owners", () => {
  const map = {
    points: [{ cluster: 217 }, { cluster: 209 }, { cluster: 217 }],
    topics: [
      { cluster: 88, title: "Old triage work" },
      { cluster: 217, title: "Atlas UX" },
      { cluster: 209, title: "Agentic Pentest Tool" },
    ],
  };
  assert.deepEqual(taskStreamOptions(map), [
    { value: "209", label: "Agentic Pentest Tool" },
    { value: "217", label: "Atlas UX" },
  ]);
  assert.deepEqual(
    taskStreamOptions(map, { id: 188, name: "Atlas UX" }).at(-1),
    {
      value: "188",
      label: "Atlas UX · Outside this view",
    },
  );
  assert.equal(taskStreamOptions(map, { id: 217, name: "Old name" }).length, 2);
  assert.deepEqual(taskStreamOptions({ points: [], topics: map.topics }), []);
});

test("historical owners are labelled explicitly only while editing that task", () => {
  assert.deepEqual(
    taskStreamOptions(
      { points: [], topics: [] },
      { id: 188, name: "Atlas UX", historical: true },
    ),
    [{ value: "188", label: "Atlas UX · Previous workstream" }],
  );
});
