import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

test(
  "real worker reports committed final embedding counts and saves stage history without generation",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-sync-progress-"));
    const source = path.join(root, "sessions"),
      project = path.join(source, "project"),
      data = path.join(root, "data");
    await mkdir(project, { recursive: true });
    await mkdir(data);
    await writeFile(
      path.join(project, "chat.jsonl"),
      Array.from({ length: 25 }, (_, i) =>
        JSON.stringify({
          type: "user",
          uuid: "request-" + i,
          timestamp: `2026-11-02T10:00:${String(i).padStart(2, "0")}Z`,
          cwd: "/project",
          message: {
            content: `Investigate and improve the scheduling workflow, example ${i}.`,
          },
        }),
      ).join("\n"),
    );
    const batches = [],
      messages = [];
    const server = http.createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      if (req.url !== "/api/embed") {
        res.writeHead(500);
        res.end("Generation must not run");
        return;
      }
      const body = JSON.parse(text);
      batches.push(body.input.length);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0]) }));
    });
    let worker;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      worker = new Worker(new URL("../server/worker.js", import.meta.url), {
        workerData: {
          config: { source, codexSource: "", embeddingModel: "test-embedding" },
          skipProjection: true,
        },
        env: {
          ...process.env,
          ATLAS_DATA_DIR: data,
          OLLAMA_URL: `http://127.0.0.1:${server.address().port}`,
        },
      });
      let committedAtFinalCount;
      worker.on("message", (message) => {
        messages.push(message);
        if (message.phase === "embedding" && message.done === 25) {
          const db = new DatabaseSync(path.join(data, "atlas.sqlite"), {
            readOnly: true,
          });
          committedAtFinalCount = db
            .prepare("SELECT count(*) n FROM chunks WHERE vector IS NOT NULL")
            .get().n;
          db.close();
        }
      });
      const [code] = await once(worker, "exit");
      assert.equal(code, 0);
      assert.deepEqual(batches, [24, 1]);
      assert.equal(
        committedAtFinalCount,
        25,
        "final count is emitted only after the database commit",
      );
      const final = messages.at(-1);
      assert.equal(final.phase, "complete", JSON.stringify(final));
      assert.equal(final.contentReady, true);
      assert.equal(
        final.assignmentsReady,
        false,
        "evidence-only sync does not claim topic publication",
      );
      assert.equal(final.stages.find((s) => s.phase === "embedding").done, 25);
      const db = new DatabaseSync(path.join(data, "atlas.sqlite"), {
        readOnly: true,
      });
      assert.equal(
        JSON.parse(
          db
            .prepare(
              "SELECT value FROM analysis_state WHERE key='sync_last_job'",
            )
            .get().value,
        ).id,
        final.id,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM analysis_dirty_sessions").get().n,
        1,
      );
      db.close();
    } finally {
      if (worker) await worker.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
