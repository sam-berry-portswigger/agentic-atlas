import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readNDJSON } from "../shared/stream.js";
import { STREAM_SUMMARY_SYSTEM } from "../server/summary-style.js";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "local pipeline: incremental index, real vectors, normal/HyDE search and source-grounded summary",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-integration-"));
    const calls = [];
    let cancelledGenerations = 0;
    let summaryMode = "normal";
    async function modelReply(res, response, stream) {
      if (!stream) return res.end(JSON.stringify({ response }));
      res.setHeader("Content-Type", "application/x-ndjson");
      res.on("close", () => {
        if (!res.writableEnded) cancelledGenerations++;
      });
      for (let offset = 0; offset < response.length; offset += 16) {
        if (res.destroyed) return;
        res.write(
          JSON.stringify({
            response: response.slice(offset, offset + 16),
            done: false,
          }) + "\n",
        );
        await delay(4);
      }
      res.end(JSON.stringify({ response: "", done: true }) + "\n");
    }
    const mock = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = body ? JSON.parse(body) : {};
      calls.push({ route: req.url, ...data });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/tags")
        return res.end(
          JSON.stringify({ models: [{ name: "embeddinggemma", size: 1 }] }),
        );
      if (req.url === "/api/embed") {
        const inputs = Array.isArray(data.input) ? data.input : [data.input];
        return res.end(
          JSON.stringify({
            embeddings: inputs.map((text) =>
              text.includes("database") ? [1, 0.01, 0.02] : [0.01, 1, 0.02],
            ),
          }),
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system.startsWith("Identify the sustained work")
      ) {
        const input = JSON.parse(data.prompt);
        return res.end(
          JSON.stringify({
            response: JSON.stringify({
              goals: input.conversations.map((c) => ({
                key: c.key,
                objective:
                  "Develop the local database storage and application architecture",
                sources: [1],
              })),
            }),
          }),
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system.startsWith("Name sustained pieces of work")
      ) {
        const input = JSON.parse(data.prompt);
        return res.end(
          JSON.stringify({
            response: JSON.stringify({
              streams: [
                {
                  name: "Local storage architecture",
                  description:
                    "Develop the local storage and application architecture.",
                  sources: input.sessions.map((s) => s.source),
                  background: false,
                },
              ],
            }),
          }),
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system.startsWith("Summarise the supplied original")
      ) {
        if (data.format) {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({ error: "structured output is unavailable" }),
          );
        }
        const input = JSON.parse(data.prompt);
        return res.end(
          JSON.stringify({
            response: JSON.stringify({
              summary:
                "3–4 February 2026, you worked on local storage and interface architecture.",
              streams: Object.fromEntries(
                input.streams.map((group) => [
                  group.id,
                  {
                    text: "You worked on the SQLite database and React interface.",
                    sources: group.evidence.slice(0, 2).map((e) => e.source),
                  },
                ]),
              ),
            }),
          }),
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system.startsWith("Answer a question about")
      ) {
        if (data.format) {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({ error: "structured output is unavailable" }),
          );
        }
        if (
          !calls
            .slice(0, -1)
            .some(
              (c) =>
                c.system?.startsWith("Answer a question about") && !c.format,
            )
        )
          return res.end(JSON.stringify({ response: '{"answer":' }));
        const input = JSON.parse(data.prompt),
          source = input.evidence.at(-1);
        return modelReply(
          res,
          JSON.stringify({
            answer:
              "The later conversation confirms the database design was accepted.",
            sourceIds: [source.source],
            findings: [
              {
                text: "Database design acceptance",
                status: "resolved",
                kind: "user_commitment",
                reason: "Explicitly accepted in the later conversation.",
                sourceId: source.source,
                quote: source.text,
              },
            ],
          }),
          data.stream,
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system.startsWith("Answer the owner's original search")
      ) {
        const question = JSON.parse(data.prompt).question;
        return modelReply(
          res,
          question.includes("cancel search")
            ? "The database uses SQLite [1]. ".repeat(200)
            : "Your database uses SQLite and WAL [1, 999].",
          data.stream,
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system.startsWith("Plan the next searches")
      ) {
        const input = JSON.parse(data.prompt);
        return modelReply(
          res,
          JSON.stringify(
            input.round === 0
              ? {
                  done: false,
                  queries: ["database design acceptance verified"],
                }
              : { done: true, queries: [] },
          ),
          false,
        );
      }
      if (
        req.url === "/api/generate" &&
        data.system === STREAM_SUMMARY_SYSTEM
      ) {
        if (summaryMode === "incomplete")
          return res.end(
            JSON.stringify({ response: "Partial summary", done: false }) + "\n",
          );
        return modelReply(
          res,
          summaryMode === "long"
            ? "**Storage** uses SQLite [1, 2]. ".repeat(200)
            : "## Storage\n\nThe database uses **SQLite** [1]. Related evidence [1, 2].",
          data.stream,
        );
      }
      if (req.url === "/api/generate")
        return modelReply(
          res,
          data.system.startsWith("Write a plausible")
            ? "The database uses SQLite and WAL."
            : "The database uses SQLite [1].",
          data.stream,
        );
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    const ollamaPort = mock.address().port;
    const reserve = http.createServer();
    await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
    const port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    const source = path.join(root, "projects"),
      project = path.join(source, "test");
    await mkdir(project, { recursive: true });
    const file = path.join(project, "session.jsonl");
    const rows = [
      { type: "custom-title", customTitle: "Architecture notes" },
      ...Array.from({ length: 8 }, (_, i) => ({
        type: i % 2 ? "assistant" : "user",
        uuid: `m${i}`,
        cwd: "/work/atlas",
        timestamp: new Date(Date.UTC(2026, 1, i + 1)).toISOString(),
        message: {
          content:
            i % 2
              ? `The database uses SQLite, decision ${i}.`
              : `The interface uses React, decision ${i}.`,
        },
      })),
    ];
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ATLAS_UPDATE_CHECKS: "0",
        ATLAS_CODEX_SOURCE: "",
        PORT: String(port),
        ATLAS_DATA_DIR: path.join(root, "data"),
        OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    const request = async (route, body, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json()) };
    };
    try {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        try {
          await request("status");
          ready = true;
          break;
        } catch {
          await delay(50);
        }
      }
      assert.ok(ready, logs);
      const updates = await request("updates");
      assert.equal(updates.status, 200);
      assert.equal(updates.available, false);
      assert.equal(updates.canUpdate, false);
      const disabledUpdates = await request("updates/preferences", {
        enabled: false,
      });
      assert.equal(disabledUpdates.enabled, false);
      const uncheckedUpdate = await request("updates/apply", {
        expectedSha: "a".repeat(40),
      });
      assert.ok(uncheckedUpdate.error);
      assert.equal(uncheckedUpdate.applying, false);
      assert.equal((await request("config", { source })).status, 200);
      assert.equal((await request("sync", {})).status, 202);
      async function done() {
        for (let i = 0; i < 150; i++) {
          const status = await request("status");
          if (status.job.phase === "error") assert.fail(status.job.error);
          if (status.job.phase === "complete") return status;
          await delay(50);
        }
        assert.fail("Indexing did not finish: " + logs);
      }
      const indexed = await done();
      assert.equal(indexed.counts.excerpts, 8);
      assert.equal(indexed.counts.embedded, 8);
      assert.equal(indexed.counts.sessions, 1);
      const mcpActivity = await request("mcp/activity?hours=168");
      assert.equal(mcpActivity.hours, 168);
      assert.equal(
        mcpActivity.total,
        0,
        "browser requests do not count as MCP calls",
      );
      assert.deepEqual(mcpActivity.calls, []);
      const setup = await request("mcp/setup");
      assert.equal(setup.status, 200);
      assert.ok(path.isAbsolute(setup.launch.command));
      assert.match(setup.launch.args[0], /server\/mcp\.js$/);
      assert.equal(setup.launch.env.ATLAS_DATA_DIR, path.join(root, "data"));
      assert.equal(
        setup.launch.env.OLLAMA_URL,
        `http://127.0.0.1:${mock.address().port}`,
      );
      assert.equal(setup.defaultProjects, null);
      assert.deepEqual(
        setup.projects.map((p) => p.project),
        ["atlas"],
      );
      assert.equal(
        indexed.analysis.mapPending,
        true,
        "routine sync makes Today ready before optional layout work",
      );
      assert.equal((await request("map")).points.length, 0);
      const generationsBeforeMap = calls.filter(
        (c) => c.route === "/api/generate",
      ).length;
      assert.equal((await request("map/refresh", {})).status, 202);
      const mapped = await done();
      assert.equal(mapped.analysis.mapPending, false);
      assert.equal(
        calls.filter((c) => c.route === "/api/generate").length,
        generationsBeforeMap,
        "map-only refresh does not rename or reclassify",
      );
      const map = await request("map");
      assert.equal(map.points.length, 1);
      assert.equal(map.unit, "conversation");
      assert.ok(
        map.points.every((p) => Number.isFinite(p.x) && p.x >= 0 && p.x <= 1),
      );
      assert.ok(map.analysisVersion);
      assert.ok(
        map.topics.every((topic) => topic.title.length > 7 && topic.color),
      );
      assert.equal(
        new Set(map.topics.map((topic) => topic.color)).size,
        map.topics.length,
      );
      for (const point of map.points) {
        const topic = map.topics.find(
          (topic) => topic.cluster === point.cluster,
        );
        assert.equal(point.color, topic.color);
        assert.equal(point.topicName, topic.title);
        const panel = await request("topic", {
          selection: {
            kind: "cluster",
            id: point.id,
            analysisVersion: point.analysisVersion,
          },
        });
        assert.equal(panel.title, point.topicName);
        assert.equal(panel.color, point.color);
      }
      const normal = await request("search", {
        query: "database",
        mode: "normal",
      });
      assert.equal(normal.status, 200);
      assert.ok(normal.results[0].text.includes("database"));
      assert.equal(normal.hypothesis, null);
      assert.ok(
        calls.some((c) => c.input === "task: search result | query: database"),
      );
      assert.equal(normal.mapPoints.length, normal.results.length);
      const fixtureDb = new DatabaseSync(
        path.join(root, "data", "atlas.sqlite"),
      );
      fixtureDb
        .prepare("UPDATE chunks SET x=NULL,y=NULL,cluster=NULL WHERE id=?")
        .run(normal.results[0].id);
      fixtureDb
        .prepare("UPDATE analysis_members SET x=NULL,y=NULL WHERE chunk_id=?")
        .run(normal.results[0].id);
      fixtureDb.close();
      const interpolated = await request("search", {
        query: "database",
        mode: "normal",
      });
      const located = interpolated.mapPoints.find(
        (point) => point.id === normal.results[0].id,
      );
      assert.equal(located.approximate, true);
      assert.ok(Number.isFinite(located.x) && Number.isFinite(located.y));
      const hyde = await request("search", {
        query: "How did we store data?",
        mode: "hyde",
      });
      assert.equal(hyde.status, 200);
      assert.equal(hyde.hypothesis, "The database uses SQLite and WAL.");
      assert.ok(hyde.results[0].text.includes("database"));
      for (const mode of ["normal", "hyde"]) {
        const generatedBefore = calls.filter(
          (call) => call.route === "/api/generate",
        ).length;
        const retrieval = await fetch(
          `http://127.0.0.1:${port}/api/search/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: "How did I store data?",
              mode,
              summarize: false,
            }),
          },
        );
        const events = [];
        await readNDJSON(retrieval.body, (event) => events.push(event));
        const result = events.at(-1).result;
        assert.equal(result.summary, false);
        assert.equal(result.timings.complete, true);
        assert.equal(result.timings.models.length, mode === "hyde" ? 1 : 0);
        assert.ok(
          result.timings.stages.some(
            (stage) => stage.label === "Retrieve conversations",
          ),
        );
        assert.equal(result.answer, "");
        assert.ok(result.context.includes("SQLite"));
        assert.ok(result.sources.length);
        assert.ok(!events.some((event) => event.event === "answer"));
        assert.equal(
          calls.filter((call) => call.route === "/api/generate").length -
            generatedBefore,
          mode === "hyde" ? 1 : 0,
          "only HyDE retrieval may generate; summary generation is skipped",
        );
      }
      const retrievalCallStart = calls.length;
      const answerEvents = [];
      const answerResponse = await fetch(
        `http://127.0.0.1:${port}/api/search/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "How did I store data?",
            mode: "hyde",
            project: "atlas",
            start: "2026-02-02T00:00:00Z",
            end: "2026-02-07T00:00:00Z",
          }),
        },
      );
      assert.equal(answerResponse.status, 200);
      await readNDJSON(answerResponse.body, (event) =>
        answerEvents.push(event),
      );
      assert.ok(answerEvents.some((event) => event.event === "progress"));
      assert.ok(
        answerEvents.filter((event) => event.event === "answer").length > 1,
        "answer streams incrementally",
      );
      const answer = answerEvents.at(-1);
      assert.equal(answer.event, "done", JSON.stringify(answerEvents));
      assert.equal(answer.result.timings.complete, true);
      assert.equal(answer.result.timings.models.length, 2);
      assert.ok(answer.result.timings.models[1].firstTokenMs >= 0);
      assert.ok(
        answerEvents.some(
          (event) => event.event === "timings" && !event.timings.complete,
        ),
      );
      assert.match(answer.result.answer, /SQLite.*\[1\]/);
      assert.ok(
        !answer.result.answer.includes("999"),
        "invalid grouped citations are removed",
      );
      assert.ok(
        answer.result.sources.every(
          (row) =>
            row.project === "atlas" &&
            row.timestamp >= "2026-02-02" &&
            row.timestamp < "2026-02-07",
        ),
      );
      assert.ok(
        answer.result.sources.every((row) => !("text" in row)),
        "the default browser response abstracts raw excerpts away",
      );
      assert.ok(
        answer.result.sources.every(
          (row) => typeof row.title === "string" && row.title.length > 0,
        ),
        "browser source metadata includes readable conversation titles",
      );
      const generation = calls
        .filter((c) =>
          c.system?.startsWith("Answer the owner's original search"),
        )
        .at(-1);
      const prompt = JSON.parse(generation.prompt);
      assert.equal(prompt.question, "How did I store data?");
      assert.equal(
        prompt.hypothesis,
        undefined,
        "hypothetical text never enters answer evidence",
      );
      assert.ok(
        prompt.evidence.every((row) => !("title" in row)),
        "generic session titles cannot drive synthesis",
      );
      assert.equal(generation.stream, true);
      const answerEmbeds = calls
        .slice(retrievalCallStart)
        .filter((call) => call.route === "/api/embed");
      assert.ok(
        answerEmbeds.some(
          (call) =>
            call.input === "task: search result | query: How did I store data?",
        ),
        "HyDE preserves original-question retrieval",
      );
      assert.ok(
        answerEmbeds.some(
          (call) =>
            typeof call.input === "string" &&
            call.input.includes("Hypothetical answer"),
        ),
        "HyDE also searches the hypothetical passage",
      );

      const noEvidence = await fetch(
        `http://127.0.0.1:${port}/api/search/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "database",
            project: "missing-project",
          }),
        },
      );
      const emptyEvents = [];
      await readNDJSON(noEvidence.body, (event) => emptyEvents.push(event));
      assert.deepEqual(emptyEvents.at(-1).result.sources, []);
      assert.equal(
        calls.filter((c) =>
          c.system?.startsWith("Answer the owner's original search"),
        ).length,
        1,
        "empty retrieval does not run generation",
      );
      assert.equal(
        (await request("search/answer", { query: "", mode: "normal" })).status,
        400,
      );
      const abortSearch = new AbortController();
      const cancelResponse = await fetch(
        `http://127.0.0.1:${port}/api/search/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortSearch.signal,
          body: JSON.stringify({
            query: "cancel search database",
            mode: "normal",
          }),
        },
      );
      const cancelledBefore = cancelledGenerations;
      await assert.rejects(
        readNDJSON(cancelResponse.body, (event) => {
          if (event.event === "answer") abortSearch.abort();
        }),
      );
      for (let i = 0; i < 80 && cancelledGenerations === cancelledBefore; i++)
        await delay(10);
      assert.ok(
        cancelledGenerations > cancelledBefore,
        "stopping search cancels local generation",
      );
      const summary = await request("summary", { ids: [normal.results[0].id] });
      assert.equal(summary.status, 200);
      assert.match(summary.summary, /\[1\]/);
      assert.match(summary.sources[0], /session/);
      const agentCallStart = calls.length,
        agentEvents = [];
      const agentResponse = await fetch(
        `http://127.0.0.1:${port}/api/search/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "What was the database result?",
            project: "atlas",
            start: "2026-02-02T00:00:00Z",
            end: "2026-02-07T00:00:00Z",
          }),
        },
      );
      await readNDJSON(agentResponse.body, (event) => agentEvents.push(event));
      const agentDone = agentEvents.find((event) => event.event === "done");
      assert.ok(agentDone, JSON.stringify(agentEvents));
      assert.ok(
        agentDone.result.verification.investigation.queries.length >= 2,
        "default mode runs an investigation",
      );
      assert.ok(
        calls
          .slice(agentCallStart)
          .some((call) => call.system?.startsWith("Plan the next searches")),
      );
      const agentAnswer = calls
        .slice(agentCallStart)
        .find((call) =>
          call.system?.startsWith("Answer the owner's original search"),
        );
      assert.equal(
        JSON.parse(agentAnswer.prompt).question,
        "What was the database result?",
        "follow-up queries never replace the original question",
      );
      assert.ok(
        agentDone.result.sources.every(
          (row) =>
            row.project === "atlas" && row.timestamp < "2026-02-07T00:00:00Z",
        ),
      );
      const generationsBeforeTopic = calls.filter(
        (c) => c.route === "/api/generate",
      ).length;
      const topic = await request("topic", { id: normal.results[0].id });
      assert.equal(topic.status, 200);
      assert.ok(topic.passages > 1);
      assert.equal(topic.conversations.length, 1);
      assert.equal(topic.conversations[0].session, normal.results[0].session);
      assert.ok(topic.conversations[0].preview);
      assert.equal(topic.evidence, undefined, "overview hides raw passages");
      assert.equal(
        calls.filter((c) => c.route === "/api/generate").length,
        generationsBeforeTopic,
        "topic overview does not invoke a model",
      );
      const topicSummary = await request("topic/summary", {
        id: normal.results[0].id,
      });
      assert.equal(topicSummary.status, 200);
      assert.match(topicSummary.summary, /\[1\]/);
      assert.ok(topicSummary.sources.length > 1);
      const afterSummaryCalls = calls.filter(
        (call) => call.route === "/api/generate",
      ).length;
      assert.equal(
        (await request("topic/summary", { id: normal.results[0].id })).summary,
        topicSummary.summary,
      );
      const reopened = await request("topic", { id: normal.results[0].id });
      assert.equal(reopened.cachedSummary.summary, topicSummary.summary);
      assert.equal(
        calls.filter((call) => call.route === "/api/generate").length,
        afterSummaryCalls,
        "reopening a panel or summary never regenerates topic names or a cached summary",
      );

      const streamSummary = async (force = true, signal) =>
        fetch(`http://127.0.0.1:${port}/api/topic/summary`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify({ id: normal.results[0].id, force }),
          signal,
        });
      const streamed = await streamSummary();
      const summaryEvents = [];
      await readNDJSON(streamed.body, (event) => summaryEvents.push(event));
      assert.equal(summaryEvents[0].event, "sources");
      assert.ok(
        summaryEvents.filter((event) => event.event === "summary").length > 1,
      );
      assert.equal(summaryEvents.at(-1).event, "done");
      const completedSummary = summaryEvents.at(-1).result;
      assert.ok(completedSummary.selection.promptChars <= 12000);
      const summaryCall = calls
        .filter((call) => call.system === STREAM_SUMMARY_SYSTEM)
        .at(-1);
      assert.equal(summaryCall.stream, true);
      assert.ok(summaryCall.prompt.length <= 12000);
      const beforeCachedStream = calls.length;
      const cachedStream = await streamSummary(false);
      const cachedEvents = [];
      await readNDJSON(cachedStream.body, (event) => cachedEvents.push(event));
      assert.equal(
        cachedEvents.at(-1).result.summary,
        completedSummary.summary,
      );
      assert.equal(calls.length, beforeCachedStream);
      summaryMode = "long";
      const cancelCount = cancelledGenerations,
        summaryAbort = new AbortController();
      const cancelledStream = await streamSummary(true, summaryAbort.signal);
      await assert.rejects(
        readNDJSON(cancelledStream.body, (event) => {
          if (event.event === "summary") summaryAbort.abort();
        }),
        { name: "AbortError" },
      );
      for (let i = 0; i < 40 && cancelledGenerations === cancelCount; i++)
        await delay(10);
      assert.ok(
        cancelledGenerations > cancelCount,
        "stopping a summary cancels model generation",
      );
      assert.equal(
        (await request("topic", { id: normal.results[0].id })).cachedSummary
          .summary,
        completedSummary.summary,
        "cancelled output never replaces completed cache",
      );
      summaryMode = "incomplete";
      const incompleteStream = await streamSummary();
      const incompleteEvents = [];
      await readNDJSON(incompleteStream.body, (event) =>
        incompleteEvents.push(event),
      );
      assert.equal(incompleteEvents.at(-1).event, "error");
      assert.ok(!incompleteEvents.some((event) => event.event === "done"));
      assert.equal(
        (await request("topic", { id: normal.results[0].id })).cachedSummary
          .summary,
        completedSummary.summary,
      );
      summaryMode = "normal";

      assert.ok(
        topicSummary.sources.every((source) =>
          topic.conversations.some(
            (conversation) => conversation.session === source.session,
          ),
        ),
      );
      assert.equal(
        (
          await request("topic", {
            id: normal.results[0].id,
            start: "2027-01-01T00:00:00Z",
          })
        ).status,
        404,
      );
      assert.equal((await request("topic", { id: [] })).status, 400);
      assert.equal(
        (await request("topic/summary", { id: "missing" })).status,
        404,
      );
      const embedsBefore = calls.filter((c) => c.route === "/api/embed").length;
      await request("sync", {});
      await done();
      assert.equal(
        calls.filter((c) => c.route === "/api/embed").length,
        embedsBefore,
        "unchanged chunks must not be embedded again",
      );
      rows.push({
        type: "user",
        uuid: "new",
        cwd: "/work/atlas",
        message: { content: "A new database detail" },
      });
      await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
      await request("sync", {});
      const updated = await done();
      assert.equal(updated.counts.excerpts, 9);
      assert.equal(updated.counts.embedded, 9);
      const newBatch = calls.filter((c) => c.route === "/api/embed").at(-1);
      assert.equal(newBatch.input.length, 1);
      assert.equal(
        (await request("search", { query: "x", mode: "unknown" })).status,
        400,
      );
      const scoped = {
        project: "atlas",
        start: "2026-02-03T00:00:00.000Z",
        end: "2026-02-05T00:00:00.000Z",
      };
      const scopeQuery = new URLSearchParams(scoped).toString();
      assert.equal((await request("recent?" + scopeQuery)).results.length, 2);
      assert.equal((await request("map?" + scopeQuery)).points.length, 1);
      assert.equal((await request("status?" + scopeQuery)).counts.excerpts, 2);
      const dateSearch = await request("search", {
        query: "database",
        mode: "normal",
        ...scoped,
      });
      assert.equal(dateSearch.results.length, 2);
      assert.ok(
        dateSearch.results.every(
          (r) => r.timestamp >= scoped.start && r.timestamp < scoped.end,
        ),
      );
      assert.equal((await request("map?start=bad-date")).status, 400);
      assert.equal(
        (
          await request("insights/generate", {
            ...scoped,
            periodLabel: "3–4 February 2026",
          })
        ).status,
        202,
      );
      let insights;
      for (let i = 0; i < 160; i++) {
        insights = await request("insights?" + scopeQuery);
        if (insights.job.phase === "error") assert.fail(insights.job.error);
        if (insights.job.phase === "complete") break;
        await delay(50);
      }
      assert.equal(insights.job.phase, "complete");
      assert.ok(insights.topics.length > 0);
      assert.equal(insights.total, 2);
      assert.ok(insights.overview.focus.length);
      assert.match(insights.overview.summary, /local storage/);
      assert.equal(insights.overview.focus[0].links.length, 1);
      assert.equal(insights.overview.watchouts, undefined);
      assert.equal(insights.timings.complete, true);
      assert.equal(
        insights.timings.models.length,
        2,
        "schema fallback records both model attempts",
      );
      assert.equal(insights.timings.models[0].failed, true);
      assert.equal(insights.timings.models[1].failed, false);
      assert.ok(
        insights.timings.stages.some(
          (stage) => stage.label === "Group and select context",
        ),
      );
      const overviewCalls = calls.filter((c) =>
        c.system?.startsWith("Summarise the supplied original"),
      );
      assert.equal(
        overviewCalls.filter((c) => !c.format).length,
        1,
        "overview requires one successful model call",
      );
      assert.equal(
        JSON.parse(overviewCalls.at(-1).prompt).period,
        "3–4 February 2026",
      );
      assert.ok(
        JSON.parse(overviewCalls.at(-1).prompt).streams.every((group) =>
          group.evidence.every((source) => !Object.hasOwn(source, "title")),
        ),
        "generic or misleading session titles cannot steer overview generation",
      );
      assert.match(overviewCalls.at(-1).system, /you and your/);
      assert.ok(
        !calls.some((c) => c.system?.startsWith("Answer a question about")),
        "no question or unresolved-work inference is pre-run",
      );
      assert.equal(insights.stale, false);
      assert.ok(
        insights.topics.every((t) =>
          t.sources.every((s) => s.session === "session"),
        ),
      );
      assert.ok(
        insights.topics.every((t) =>
          t.sourceIds.every((id) => t.sources.some((s) => s.id === id)),
        ),
      );
      const structuredAttempts = calls.filter(
        (c) =>
          c.format && c.system?.startsWith("Summarise the supplied original"),
      );
      assert.equal(
        structuredAttempts.length,
        1,
        "MLX fallback avoids repeating unsupported schema calls",
      );
      assert.ok(
        (
          await request(
            "insights?" + new URLSearchParams({ ...scoped, project: "other" }),
          )
        ).topics.length === 0,
        "summaries must not leak across filters",
      );
      // A new source file must be imported automatically before the next overview.
      await writeFile(
        path.join(project, "followup.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "followup",
          cwd: "/work/atlas",
          timestamp: "2026-02-04T12:00:00.000Z",
          message: {
            content:
              "The database design has been accepted after verification.",
          },
        }),
      );
      await request("insights/generate", { ...scoped, force: true });
      for (let i = 0; i < 160; i++) {
        insights = await request("insights?" + scopeQuery);
        if (insights.job.phase === "error") assert.fail(insights.job.error);
        if (insights.job.phase === "complete") break;
        await delay(50);
      }
      assert.equal(insights.job.phase, "complete");
      assert.equal(
        insights.total,
        3,
        "overview refresh imports newly created sessions",
      );
      assert.equal((await request("status?" + scopeQuery)).counts.embedded, 3);
      await writeFile(
        path.join(project, "after-overview.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "later",
          cwd: "/work/atlas",
          timestamp: "2026-02-04T14:00:00.000Z",
          message: {
            content:
              "The database design was accepted and the implementation is verified.",
          },
        }),
      );
      await writeFile(
        path.join(project, "future.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "future",
          cwd: "/work/atlas",
          timestamp: "2026-02-06T14:00:00.000Z",
          message: {
            content:
              "Future database changes should never affect this historical answer.",
          },
        }),
      );
      const question = await request("insights/ask", {
        ...scoped,
        itemId: insights.overview.focus[0].id,
        mode: "unresolved",
      });
      assert.equal(question.status, 200, question.error);
      assert.ok(
        question.sources.some((source) => source.session === "after-overview"),
        "on-demand questions import new evidence after the overview",
      );
      assert.ok(
        !question.sources.some((source) => source.session === "future"),
      );
      assert.match(question.answer, /accepted/);
      assert.equal(question.timings.complete, true);
      assert.equal(
        question.timings.models.filter((model) => model.label === "Answer")
          .length,
        2,
        "cached runner capabilities skip unsupported schema requests; malformed-output repair remains visible",
      );
      assert.ok(
        question.investigation.queries.length >= 2,
        "work questions investigate with additional searches",
      );
      assert.ok(
        question.timings.models.some(
          (model) => model.label === "Evidence reasoning",
        ),
      );
      assert.equal(question.findings[0].status, "resolved");
      assert.ok(
        question.sources.some((source) => source.session === "followup"),
      );
      assert.ok(
        question.sources.every((source) => source.timestamp < scoped.end),
      );
      assert.ok(
        question.sourceIds.every((id) =>
          question.sources.some((source) => source.id === id),
        ),
      );
      assert.ok(
        calls.some((c) =>
          c.system?.includes("Your previous response could not be parsed"),
        ),
        "malformed JSON gets one bounded retry",
      );
      assert.equal(
        (
          await request("insights/ask", {
            ...scoped,
            itemId: "missing",
            question: "What changed?",
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request("insights/ask", {
            ...scoped,
            itemId: insights.overview.focus[0].id,
            question: "",
          })
        ).status,
        400,
      );
      const ordinary = await request("insights/ask", {
        ...scoped,
        itemId: insights.overview.focus[0].id,
        mode: "question",
        question: "What did I decide about the database?",
      });
      assert.equal(ordinary.status, 200, ordinary.error);
      assert.ok(
        calls.some(
          (c) =>
            c.system?.startsWith("Answer a question about") &&
            JSON.parse(c.prompt).mode === "question",
        ),
      );
      const events = [];
      const streamResponse = await fetch(
        `http://127.0.0.1:${port}/api/insights/ask`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify({
            ...scoped,
            itemId: insights.overview.focus[0].id,
            question: "What changed in the database?",
          }),
        },
      );
      assert.match(streamResponse.headers.get("content-type"), /ndjson/);
      await readNDJSON(streamResponse.body, (event) => events.push(event));
      const doneIndex = events.findIndex((event) => event.event === "done");
      const partials = events.filter((event) => event.event === "answer");
      assert.ok(partials.length > 2, "real model chunks arrive incrementally");
      assert.ok(
        events.findIndex((event) => event.event === "sources") <
          events.findIndex((event) => event.event === "answer"),
        "retrieved sources are visible before generation",
      );
      assert.ok(
        events.findIndex((event) => event.event === "answer") < doneIndex,
        "answer text is delivered before completion",
      );
      assert.equal(partials.at(-1).text, events[doneIndex].result.answer);
      assert.ok(
        events.findIndex((event) => event.event === "finding") < doneIndex,
        "findings stream as soon as their supporting quote has been validated",
      );
      assert.ok(
        events.some(
          (event) => event.event === "progress" && event.phase === "checking",
        ),
      );
      // Closing/stopping a popup must release the worker and close the upstream model stream.
      const abort = new AbortController();
      const cancellable = await fetch(
        `http://127.0.0.1:${port}/api/insights/ask`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          signal: abort.signal,
          body: JSON.stringify({
            ...scoped,
            itemId: insights.overview.focus[0].id,
            question: "What did I decide?",
          }),
        },
      );
      await assert.rejects(
        readNDJSON(cancellable.body, (event) => {
          if (event.event === "answer") abort.abort();
        }),
        /abort/i,
      );
      let unlocked = false;
      for (let i = 0; i < 60; i++) {
        if ((await request("config", { source })).status === 200) {
          unlocked = true;
          break;
        }
        await delay(20);
      }
      assert.ok(unlocked, "cancelled question releases the local worker");
      assert.ok(
        cancelledGenerations > 0,
        "cancellation closes the upstream model response",
      );
      const changedDb = new DatabaseSync(
        path.join(root, "data", "atlas.sqlite"),
      );
      changedDb
        .prepare("UPDATE chunks SET title='Changed evidence' WHERE timestamp=?")
        .run("2026-02-03T00:00:00.000Z");
      changedDb.close();
      assert.equal((await request("insights?" + scopeQuery)).stale, true);
      // Search must see new outcomes without a separate manual Sync action.
      rows.push({
        type: "assistant",
        uuid: "fresh-search-result",
        cwd: "/work/atlas",
        timestamp: "2026-02-05T11:00:00.000Z",
        message: {
          content:
            "The database verification has now finished: all fifteen tests passed. Fresh search outcome.",
        },
      });
      await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"));
      const freshSearch = await fetch(
        `http://127.0.0.1:${port}/api/search/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "database verification",
            project: "atlas",
            summarize: false,
          }),
        },
      );
      const freshEvents = [];
      await readNDJSON(freshSearch.body, (event) => freshEvents.push(event));
      assert.equal(
        freshEvents.at(-1).event,
        "done",
        JSON.stringify(freshEvents),
      );
      assert.ok(
        freshEvents.at(-1).result.context.includes("Fresh search outcome"),
      );
      assert.ok(freshEvents.at(-1).result.verification.archiveCheckedAt);
      // Codex joins the same index, search and topic pipeline without re-embedding Claude.
      const codexSource = path.join(root, "codex", "sessions");
      const codexDay = path.join(codexSource, "2026", "02", "05");
      await mkdir(codexDay, { recursive: true });
      const codexFile = path.join(codexDay, "rollout-test.jsonl");
      const codexRows = [
        {
          type: "session_meta",
          payload: { id: "codex-fixture", cwd: "/work/atlas", source: "cli" },
        },
        {
          type: "response_item",
          timestamp: "2026-02-05T12:00:00Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Verify the database migration in Codex and preserve records.",
              },
            ],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-02-05T12:01:00Z",
          payload: {
            type: "message",
            role: "assistant",
            channel: "final",
            content: [
              {
                type: "output_text",
                text: "Codex database migration verification passed all regression tests.",
              },
            ],
          },
        },
      ];
      await writeFile(
        codexFile,
        codexRows.map((row) => JSON.stringify(row)).join("\n"),
      );
      assert.equal((await request("config", { codexSource })).status, 200);
      const beforeCodex = (await request("status")).counts.excerpts;
      await request("sync", {});
      await done();
      assert.equal((await request("status")).counts.excerpts, beforeCodex + 2);
      const codexSearch = await request("search", {
        query: "database Codex",
        mode: "normal",
        limit: 30,
      });
      assert.ok(
        codexSearch.results.some(
          (row) => row.session === "codex:codex-fixture",
        ),
      );
      const indexedSources = new DatabaseSync(
        path.join(root, "data", "atlas.sqlite"),
      );
      assert.equal(
        indexedSources
          .prepare("SELECT count(*) AS n FROM chunks WHERE provider='codex'")
          .get().n,
        2,
      );
      indexedSources.close();
      const embeddingsAfterCodex = calls.filter(
        (c) => c.route === "/api/embed",
      ).length;
      await request("sync", {});
      await done();
      assert.equal(
        calls.filter((c) => c.route === "/api/embed").length,
        embeddingsAfterCodex,
      );
      await writeFile(
        codexFile,
        codexRows.map((row) => JSON.stringify(row)).join("\n") +
          "\n" +
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-02-05T12:02:00Z",
            payload: {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Codex incremental verification completed with no data loss.",
                },
              ],
            },
          }),
      );
      await request("sync", {});
      await done();
      assert.equal((await request("status")).counts.excerpts, beforeCodex + 3);
      assert.equal((await request("config", { codexSource: "" })).status, 200);
      const focusDb = new DatabaseSync(path.join(root, "data", "atlas.sqlite"));
      const addFocused = focusDb.prepare(
        "INSERT INTO chunks(id,file,session,project,title,role,timestamp,text,vector,model,x,y,cluster) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const [id, role, timestamp, text] of [
        [
          "work-review",
          "user",
          "2026-02-05T13:00:00Z",
          "Please review PR #1234 and report the REFRESH_TOKEN_REVIEW findings.",
        ],
        [
          "work-findings",
          "assistant",
          "2026-02-05T13:01:00Z",
          "REFRESH_TOKEN_REVIEW found a missing expiry guard and cancellation test.",
        ],
        [
          "work-design",
          "user",
          "2026-02-05T14:00:00Z",
          "Now design a review workflow. WORKFLOW_DESIGN_ONLY is a separate task.",
        ],
        [
          "work-workflow",
          "assistant",
          "2026-02-05T14:01:00Z",
          "WORKFLOW_DESIGN_ONLY coordinates model reviewers and reconciles their reports.",
        ],
      ])
        addFocused.run(
          id,
          "fixture-work",
          "mixed-work",
          "atlas",
          "Mixed tasks",
          role,
          timestamp,
          text,
          Buffer.from(new Float32Array([1, 0.01, 0.02]).buffer),
          "embeddinggemma",
          0.5,
          0.5,
          0,
        );
      const fixtureScope = { project: "", start: "", end: "" };
      const { persistFocus } = await import("../server/work-store.js");
      const version = focusDb
        .prepare("SELECT value FROM analysis_state WHERE key='active'")
        .get().value;
      const topicId = focusDb
        .prepare("SELECT id FROM analysis_topics WHERE version=? LIMIT 1")
        .get(version).id;
      for (const id of [
        "work-review",
        "work-findings",
        "work-design",
        "work-workflow",
      ])
        focusDb
          .prepare("INSERT INTO analysis_members VALUES(?,?,?,?,?)")
          .run(version, id, topicId, null, null);
      persistFocus(focusDb, fixtureScope, [
        {
          links: [
            {
              title: "Reviewing PR #1234 Findings",
              sourceIds: ["work-review", "work-findings"],
            },
          ],
        },
      ]);
      focusDb.close();
      const selection = {
        kind: "work",
        title: "Reviewing PR #1234 Findings",
        sourceIds: ["work-review", "work-findings"],
      };
      const beforeFocusedOverview = calls.filter(
        (c) => c.route === "/api/generate",
      ).length;
      const focusedOverview = await request("topic", { selection });
      assert.equal(focusedOverview.status, 200);
      assert.equal(focusedOverview.title, selection.title);
      assert.equal(focusedOverview.kind, "work");
      assert.equal(focusedOverview.passages, 2);
      assert.equal(focusedOverview.conversations.length, 1);
      assert.doesNotMatch(
        JSON.stringify(focusedOverview),
        /WORKFLOW_DESIGN_ONLY/,
      );
      assert.equal(
        calls.filter((c) => c.route === "/api/generate").length,
        beforeFocusedOverview,
      );
      const focusedSummary = await request("topic/summary", { selection });
      assert.equal(focusedSummary.status, 200);
      assert.deepEqual(
        new Set(focusedSummary.sources.map((source) => source.id)),
        new Set(["work-review", "work-findings"]),
      );
      const focusedGeneration = calls
        .filter((c) => c.route === "/api/generate")
        .at(-1);
      assert.match(focusedGeneration.prompt, /Reviewing PR #1234 Findings/);
      assert.match(focusedGeneration.prompt, /REFRESH_TOKEN_REVIEW/);
      assert.doesNotMatch(focusedGeneration.prompt, /WORKFLOW_DESIGN_ONLY/);
      assert.equal((await request("summary", { ids: [] })).status, 400);
      assert.equal(
        (await request("sync", {}, { Origin: "https://evil.example" })).status,
        403,
      );
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      await new Promise((r) => mock.close(r));
      await rm(root, { recursive: true, force: true });
    }
  },
);
