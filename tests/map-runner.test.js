import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMap } from "../server/map-runner.js";
import { projectTopics, PROJECTION_POLICY } from "../server/projection.js";
import { projectionNeedsRefresh } from "../server/projection-store.js";

async function fixture(source, fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-tsne-"));
  const script = path.join(directory, "worker.cjs");
  await writeFile(script, source);
  try {
    return await fn({ python: process.execPath, script });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const vectors = [
  [1, 0],
  [0, 1],
  [0.7, 0.7],
];

test("map worker receives numeric vectors only and forwards bounded progress", async () => {
  const messages = [];
  await fixture(
    `let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
    const value=JSON.parse(input);
    if (Object.keys(value).join(',')!=='vectors') process.exit(2);
    console.log(JSON.stringify({type:'progress',done:50,total:1000}));
    console.log(JSON.stringify({type:'result',points:value.vectors.map((_,i)=>[i,0]),perplexity:1}));
  });`,
    async (options) => {
      const result = await runMap(vectors, {
        ...options,
        send: (...message) => messages.push(message),
      });
      assert.equal(result.points.length, 3);
      assert.deepEqual(messages[0].slice(0, 3), ["projecting", 50, 1000]);
    },
  );
});

test("cancellation stops the worker before accepting a map", async () => {
  await fixture(
    "process.stdin.resume();setInterval(()=>{},1000)",
    async (options) => {
      const controller = new AbortController();
      const promise = runMap(vectors, {
        ...options,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(promise, { name: "AbortError" });
    },
  );
});

test("worker timeout and invalid output fail without returning a partial map", async () => {
  await fixture(
    "process.stdin.resume();setInterval(()=>{},1000)",
    async (options) => {
      await assert.rejects(
        runMap(vectors, { ...options, timeoutMs: 50 }),
        /timed out/,
      );
    },
  );
  await fixture(
    "console.log(JSON.stringify({type:'result',points:[[null,0],[0,1],[1,1]]}))",
    async (options) => {
      await assert.rejects(
        runMap(vectors, options),
        /Invalid projected coordinates/,
      );
    },
  );
  await fixture("console.log('{broken')", async (options) => {
    await assert.rejects(runMap(vectors, options), SyntaxError);
  });
});

test("missing runtime gives an actionable local setup error", async () => {
  await assert.rejects(
    runMap(vectors, {
      python: path.join(os.tmpdir(), "atlas-nonexistent-projection-python"),
    }),
    /npm run setup:projection/,
  );
});

test("a changed projection policy offers refresh without invalidating saved memberships", () => {
  assert.equal(
    projectionNeedsRefresh({
      projection: { policy: "embedding-neighborhood-v2" },
    }),
    true,
  );
  assert.equal(
    projectionNeedsRefresh({ projection: { policy: PROJECTION_POLICY } }),
    false,
  );
  assert.equal(
    projectionNeedsRefresh({
      projection: { policy: PROJECTION_POLICY },
      mapPending: true,
    }),
    true,
  );
});

test("small, degenerate and invalid archives have bounded predictable behavior", async () => {
  assert.deepEqual((await projectTopics([[1, 0]], [7])).points, [[0.5, 0.5]]);
  const identical = await projectTopics(
    [
      [1, 0],
      [1, 0],
      [1, 0],
    ],
    [1, 2, 3],
  );
  assert.deepEqual(identical.points, [
    [0.5, 0.5],
    [0.5, 0.5],
    [0.5, 0.5],
  ]);
  await assert.rejects(
    projectTopics(
      [
        [1, 0],
        [NaN, 0],
        [0, 1],
      ],
      [],
    ),
    /finite vectors/,
  );
  await assert.rejects(
    projectTopics(
      Array.from({ length: 1801 }, () => [1, 0]),
      [],
    ),
    /limited to 1,800/,
  );
});
