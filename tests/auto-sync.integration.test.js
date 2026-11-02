import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initAnalysisSchema } from "../server/analysis-store.js";
import { vectorBuffer } from "../server/db.js";
import {
  SEMANTIC_POLICY,
  LEGACY_SEMANTIC_POLICY,
} from "../server/semantic-policy.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "Today foreground automatically syncs new evidence, coalesces clients, and respects persisted pause",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-auto-sync-"));
    const source = path.join(root, "sessions"),
      dataDir = path.join(root, "data");
    await mkdir(path.join(source, "project"), { recursive: true });
    await mkdir(dataDir);
    const file = path.join(source, "project", "chat.jsonl");
    const message = (uuid, text) =>
      JSON.stringify({
        type: "user",
        uuid,
        timestamp: new Date().toISOString(),
        cwd: "/fixture/project",
        message: { content: text },
      }) + "\n";
    await writeFile(
      file,
      message(
        "first",
        "Improve the Atlas session overview and preserve saved work stream names.",
      ),
    );
    const db = new DatabaseSync(path.join(dataDir, "atlas.sqlite"));
    db.exec(
      "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE chunks(id TEXT PRIMARY KEY,file TEXT,session TEXT,project TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT,vector BLOB,model TEXT,x REAL,y REAL,cluster INTEGER)",
    );
    initAnalysisSchema(db);
    for (const [key, value] of Object.entries({
      source,
      codexSource: "",
      embeddingModel: "embeddinggemma",
      generationModel: "unused-local-model",
    }))
      db.prepare("INSERT INTO settings VALUES(?,?)").run(
        key,
        JSON.stringify(value),
      );
    db.prepare("INSERT INTO analysis_runs VALUES(?,?,?,?,?,?)").run(
      "saved",
      "old",
      "embeddinggemma",
      "unused-local-model",
      new Date().toISOString(),
      JSON.stringify({
        method: "workstreams-v2",
        mapUnit: "conversation",
        conversationPolicy: SEMANTIC_POLICY,
        semanticPolicy: LEGACY_SEMANTIC_POLICY,
        backgroundIds: [],
        passages: 0,
        conversations: 0,
        mapPending: false,
      }),
    );
    db.prepare("INSERT INTO analysis_topics VALUES(?,?,?,?,?,?)").run(
      "saved",
      9,
      "Atlas interface",
      "Improve Atlas session organisation and everyday navigation.",
      "#a28bdb",
      vectorBuffer([1, 0]),
    );
    db.prepare("INSERT INTO analysis_state VALUES('active','saved')").run();
    db.close();
    const calls = [];
    const mock = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ route: req.url, inputs: body.input?.length || 0 });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/embed")
        return res.end(
          JSON.stringify({ embeddings: body.input.map(() => [1, 0]) }),
        );
      if (req.url === "/api/tags")
        return res.end(
          JSON.stringify({ models: [{ name: "embeddinggemma", size: 1 }] }),
        );
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: "Generation must not run during routine sync",
        }),
      );
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const free = http.createServer();
    free.listen(0, "127.0.0.1");
    await once(free, "listening");
    const port = free.address().port;
    await new Promise((resolve) => free.close(resolve));
    let child,
      logs = "";
    const request = async (route, body) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/${route}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      return { status: response.status, ...(await response.json()) };
    };
    const start = async () => {
      child = spawn(process.execPath, ["server/index.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          ATLAS_DATA_DIR: dataDir,
          ATLAS_CODEX_SOURCE: "",
          OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (b) => {
        logs += b;
      });
      child.stderr.on("data", (b) => {
        logs += b;
      });
      for (let i = 0; i < 100; i++) {
        try {
          await request("jobs");
          return;
        } catch {
          await delay(25);
        }
      }
      assert.fail(logs);
    };
    const stop = async () => {
      if (child?.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    };
    const until = async (predicate, timeout = 5000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const state = await request("jobs?today=1");
        if (state.job.phase === "error")
          assert.fail(state.job.error + "\n" + logs);
        if (predicate(state)) return state;
        await delay(50);
      }
      assert.fail("Timed out waiting for automatic sync\n" + logs);
    };
    try {
      await start();
      const began = Date.now();
      const first = await until(
        (s) => s.job.phase === "complete" && s.analysisVersion !== "saved",
      );
      assert.equal(first.job.contentReady, true);
      assert.equal(first.job.assignmentsReady, true);
      assert.equal(first.job.mapPending, true);
      assert.equal(calls.filter((c) => c.route === "/api/embed").length, 1);
      assert.equal(calls.filter((c) => c.route === "/api/generate").length, 0);
      const initialMs = Date.now() - began;
      // Multiple clients requesting the same no-op sync must not create workers.
      const before = calls.length;
      await Promise.all(Array.from({ length: 8 }, () => request("sync", {})));
      await until((s) => s.job.phase === "complete" && !s.autoSync.running);
      assert.equal(calls.length, before);
      // Let the one coalesced manual follow-up drain before testing the normal
      // 30-second background cadence, rather than crediting that follow-up.
      await until(
        (s) =>
          !s.autoSync.running &&
          Date.parse(s.autoSync.nextCheckAt) - Date.now() > 25000,
      );
      const appended = Date.now();
      await appendFile(
        file,
        message(
          "second",
          "Refine the Atlas work stream cards and keep Today current automatically.",
        ),
      );
      const second = await until(
        (s) =>
          s.job.phase === "complete" &&
          s.catalogueRevision !== first.catalogueRevision,
        36000,
      );
      assert.equal(calls.filter((c) => c.route === "/api/embed").length, 2);
      assert.equal(
        calls.filter((c) => c.route === "/api/embed").at(-1).inputs,
        1,
      );
      assert.equal(calls.filter((c) => c.route === "/api/generate").length, 0);
      const periodicMs = Date.now() - appended;
      await request("stop", {});
      await appendFile(
        file,
        message(
          "third",
          "Keep the current Atlas topic when the source conversation grows.",
        ),
      );
      await stop();
      await start();
      const paused = await request("jobs?today=1");
      assert.equal(
        paused.autoSync.paused,
        true,
        "pause survives restarting the backend",
      );
      await delay(700);
      assert.equal(calls.filter((c) => c.route === "/api/embed").length, 2);
      await request("sync", {});
      const resumed = await until(
        (s) =>
          s.job.phase === "complete" &&
          s.catalogueRevision !== second.catalogueRevision,
      );
      assert.equal(resumed.autoSync.paused, false);
      assert.equal(calls.filter((c) => c.route === "/api/embed").length, 3);
      assert.equal(calls.filter((c) => c.route === "/api/generate").length, 0);
      const inspect = new DatabaseSync(path.join(dataDir, "atlas.sqlite"), {
        readOnly: true,
      });
      const version = inspect
        .prepare("SELECT value FROM analysis_state WHERE key='active'")
        .get().value;
      assert.equal(inspect.prepare("SELECT count(*) n FROM chunks").get().n, 3);
      assert.deepEqual(
        inspect
          .prepare(
            "SELECT DISTINCT topic_id FROM analysis_members WHERE version=?",
          )
          .all(version)
          .map((r) => r.topic_id),
        [9],
      );
      assert.equal(
        inspect
          .prepare("SELECT name FROM analysis_topics WHERE version=? AND id=9")
          .get(version).name,
        "Atlas interface",
      );
      inspect.close();
      console.log(
        JSON.stringify({
          automaticInitialMs: initialMs,
          periodicAppendMs: periodicMs,
          embeddingRequests: 3,
          generationRequests: 0,
          noOpRequests: 8,
        }),
      );
    } finally {
      await stop();
      await new Promise((resolve) => mock.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
