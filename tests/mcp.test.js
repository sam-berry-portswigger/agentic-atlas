import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const entry = fileURLToPath(new URL("../server/mcp.js", import.meta.url));

test(
  "MCP stdio: scoped evidence, shared retrieval, caller HyDE, follow-ups, resources and incremental sync",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-mcp-"));
    const source = path.join(root, "sessions"),
      data = path.join(root, "data");
    await mkdir(source);
    await mkdir(data);
    const calls = [];
    let holdEmbedding = false,
      notifyEmbedding = () => {},
      abortedEmbeddings = 0;
    const mock = http.createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      const request = JSON.parse(body || "{}");
      calls.push({ route: req.url, ...request });
      res.setHeader("Content-Type", "application/json");
      if (req.url !== "/api/embed") {
        res.statusCode = 500;
        return res.end(
          JSON.stringify({ error: "Generation is forbidden in this test" }),
        );
      }
      if (holdEmbedding) {
        res.on("close", () => {
          if (!res.writableEnded) abortedEmbeddings++;
        });
        res.write("{");
        notifyEmbedding();
        return;
      }
      const inputs = Array.isArray(request.input)
        ? request.input
        : [request.input];
      res.end(
        JSON.stringify({
          embeddings: inputs.map((text) =>
            /schedule|sign.out|token/i.test(text) ? [1, 0] : [0, 1],
          ),
        }),
      );
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const url = `http://127.0.0.1:${mock.address().port}`;
    const clients = [];
    let db;
    async function connect(projects, extraEnv = {}) {
      const client = new Client({ name: "atlas-test", version: "1.0" });
      const environment = {
        ...process.env,
        ATLAS_CODEX_SOURCE: "",
        ATLAS_DATA_DIR: data,
        OLLAMA_URL: url,
        ...extraEnv,
      };
      if (projects === null) delete environment.ATLAS_MCP_PROJECTS;
      else environment.ATLAS_MCP_PROJECTS = JSON.stringify(projects);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        cwd: root,
        env: environment,
        stderr: "pipe",
      });
      let errors = "";
      transport.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      await client.connect(transport);
      clients.push(client);
      return { client, errors: () => errors };
    }
    const unwrap = (result) => {
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    };
    const invoke = async (client, name, args = {}) =>
      unwrap(
        await client.callTool({
          name,
          arguments: name === "atlas_sync" ? { analyse: false, ...args } : args,
        }),
      );
    async function session(project, id, messages) {
      const dir = path.join(source, project);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, id + ".jsonl");
      const text =
        [
          { type: "custom-title", customTitle: "Plan my day" },
          ...messages.map((row, i) => ({
            uuid: `${id}-${i}`,
            cwd: `/work/${project}`,
            type: i % 2 ? "assistant" : "user",
            timestamp: `2026-10-${String(15 + i).padStart(2, "0")}T10:00:00.000Z`,
            message: { content: row.text },
            ...row,
          })),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n";
      await writeFile(file, text);
      return file;
    }
    try {
      db = new DatabaseSync(path.join(data, "atlas.sqlite"));
      db.exec(
        "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO settings VALUES('source',?)").run(
        JSON.stringify(source),
      );
      db.close();
      db = null;
      const file = await session(
        "imaging",
        "imaging",
        Array.from({ length: 8 }, (_, i) => ({
          text: `Task ${i}: ${i < 4 ? "Investigate brain activation interventions and compare suppression directions. " : "Migrate the brain imaging frontend to React with custom regions. "}`.repeat(
            8,
          ),
        })),
      );
      await session("private", "private", [
        { text: "Private schedule investigation with confidential details." },
        { text: "The private token refresh defect is fixed." },
      ]);
      await session("imaging", "later", [
        {
          text: "Please check whether activation suppression has been resolved.",
          timestamp: "2026-10-24T10:00:00.000Z",
        },
        {
          text: "Activation suppression is fixed; all custom region checks passed.",
          timestamp: "2026-10-24T11:00:00.000Z",
        },
      ]);
      await session("without-project-info", "misc", [
        {
          cwd: undefined,
          text: "A discussion outside an explicit project about planning the next experiment.",
        },
        {
          cwd: undefined,
          text: "These sessions still belong to the archive even without project metadata.",
        },
      ]);
      const original = await readFile(file, "utf8");
      const { client } = await connect(["imaging"]);
      const tools = (await client.listTools()).tools;
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [
          "atlas_streams",
          "atlas_status",
          "atlas_search",
          "atlas_read_context",
          "atlas_activity",
          "atlas_find_followups",
          "atlas_sync",
          "atlas_tasks",
          "atlas_task_image",
          "atlas_create_task",
          "atlas_update_task",
          "atlas_report_session",
        ].sort(),
      );
      assert.equal(
        tools.find((t) => t.name === "atlas_sync").annotations.readOnlyHint,
        false,
      );
      assert.ok(
        tools
          .filter(
            (t) =>
              ![
                "atlas_sync",
                "atlas_create_task",
                "atlas_update_task",
                "atlas_report_session",
              ].includes(t.name),
          )
          .every((t) => t.annotations.readOnlyHint),
      );
      const empty = await invoke(client, "atlas_status");
      assert.equal(empty.totals.excerpts, 0);
      const progress = [];
      unwrap(
        await client.callTool(
          { name: "atlas_sync", arguments: { analyse: false } },
          undefined,
          { onprogress: (value) => progress.push(value) },
        ),
      );
      assert.ok(progress.length > 0, "sync reports real worker progress");
      assert.equal(
        await readFile(file, "utf8"),
        original,
        "source sessions remain unchanged",
      );
      const status = await invoke(client, "atlas_status");
      assert.deepEqual(
        status.projects.map((p) => p.project),
        ["imaging"],
      );
      assert.ok(status.projects[0].embedded > 0);
      const beforeKeyword = calls.length;
      const keywords = await invoke(client, "atlas_search", {
        query: "brain",
        mode: "keyword",
        end: "2026-10-23T00:00:00Z",
        budget: 4000,
      });
      assert.equal(
        calls.length,
        beforeKeyword,
        "keyword retrieval makes no model calls",
      );
      assert.ok(keywords.returned > 0);
      assert.ok(keywords.characters <= 4000);
      assert.ok(keywords.moreAvailable);
      assert.ok(
        keywords.results.every(
          (r) => r.project === "imaging" && r.date < "2026-10-23T00:00:00Z",
        ),
      );
      const anchor = keywords.results[0];
      const semantic = await invoke(client, "atlas_search", {
        query: "brain visualization",
        mode: "semantic",
        hypothesis:
          "Brain activation interventions are applied to custom regions.",
        limit: 3,
      });
      assert.ok(semantic.results.length);
      assert.equal(semantic.hypothesisUsed, true);
      assert.match(calls.at(-1).input, /Hypothetical answer/);
      const hybrid = await invoke(client, "atlas_search", {
        query: "activation",
        mode: "hybrid",
        limit: 3,
      });
      assert.ok(hybrid.results.every((row) => row.rankScore > 0));
      const context = await invoke(client, "atlas_read_context", {
        ids: [anchor.id],
        after: 12,
        budget: 4000,
        end: "2026-10-23T00:00:00Z",
      });
      assert.ok(context.results.length);
      assert.ok(context.nextOffset > 0);
      assert.ok(context.omitted > 0);
      const page = await invoke(client, "atlas_read_context", {
        ids: [anchor.id],
        after: 12,
        budget: 4000,
        end: "2026-10-23T00:00:00Z",
        offset: context.nextOffset,
      });
      assert.ok(page.results.length);
      assert.ok(
        page.results.every(
          (row) => !context.results.some((first) => first.id === row.id),
        ),
      );
      const resource = await client.readResource({ uri: anchor.uri });
      assert.equal(JSON.parse(resource.contents[0].text).id, anchor.id);
      const activity = await invoke(client, "atlas_activity", {
        budget: 16000,
        end: "2026-10-23T00:00:00Z",
      });
      assert.ok(activity.results.length);
      assert.equal(activity.projects.length, 1);
      assert.equal(activity.projects[0].substantial, true);
      assert.ok(activity.projects[0].included);
      assert.equal(activity.evidenceOnly, true);
      const checked = await invoke(client, "atlas_find_followups", {
        ids: [anchor.id],
        query: "activation suppression custom regions",
        end: "2026-10-25T00:00:00Z",
      });
      assert.ok(
        checked.results.some((row) => row.session === "later"),
        "later resolution found across sessions",
      );
      assert.ok(checked.results.every((row) => row.project === "imaging"));
      const historical = await invoke(client, "atlas_find_followups", {
        ids: [anchor.id],
        query: "activation suppression custom regions",
        end: "2026-10-23T00:00:00Z",
      });
      assert.ok(!historical.results.some((row) => row.session === "later"));
      const denied = await client.callTool({
        name: "atlas_search",
        arguments: { project: "private", query: "schedule", mode: "keyword" },
      });
      assert.ok(denied.isError);
      assert.ok(!JSON.stringify(denied).includes("confidential"));
      db = new DatabaseSync(path.join(data, "atlas.sqlite"));
      const privateId = db
        .prepare("SELECT id FROM chunks WHERE project='private' LIMIT 1")
        .get().id;
      db.close();
      db = null;
      const deniedContext = await client.callTool({
        name: "atlas_read_context",
        arguments: { ids: [privateId] },
      });
      assert.ok(deniedContext.isError);
      await assert.rejects(() =>
        client.readResource({ uri: `atlas://excerpt/${privateId}` }),
      );
      const unrestricted = (await connect(null)).client;
      const allStatus = await invoke(unrestricted, "atlas_status");
      assert.deepEqual(
        new Set(allStatus.projects.map((p) => p.project)),
        new Set(["imaging", "private", "without-project-info"]),
      );
      const misc = await invoke(unrestricted, "atlas_search", {
        query: "explicit project",
        mode: "keyword",
        project: "without-project-info",
      });
      assert.ok(
        misc.returned > 0,
        "sessions without explicit project information stay retrievable by their fallback folder label",
      );
      await session("new-project", "new-session", [
        {
          text: "This new project was indexed after the unrestricted connection was configured.",
        },
      ]);
      await invoke(client, "atlas_sync");
      assert.ok(
        (await invoke(unrestricted, "atlas_status")).projects.some(
          (p) => p.project === "new-project",
        ),
        "unrestricted retrieval automatically includes projects indexed later",
      );
      const noAccess = (await connect([])).client;
      assert.equal((await invoke(noAccess, "atlas_status")).totals.excerpts, 0);
      assert.equal(
        (
          await invoke(noAccess, "atlas_search", {
            query: "private",
            mode: "keyword",
          })
        ).returned,
        0,
      );
      const disabled = (await connect(["imaging"], { ATLAS_MCP_SYNC: "0" }))
        .client;
      assert.ok(
        (
          await disabled.callTool({
            name: "atlas_sync",
            arguments: { analyse: false },
          })
        ).isError,
      );
      const callCount = calls.length;
      await invoke(client, "atlas_sync");
      assert.equal(
        calls.length,
        callCount,
        "unchanged files reuse their embeddings",
      );
      // A cancelled sync interrupts its in-flight local embedding request and
      // releases the same cross-process writer lock used by the web UI.
      await writeFile(
        file,
        original +
          JSON.stringify({
            uuid: "appended",
            cwd: "/work/imaging",
            type: "user",
            timestamp: "2026-10-25T10:00:00.000Z",
            message: {
              content:
                "Investigate a new activation intervention and verify the custom region steering behavior.",
            },
          }) +
          "\n",
      );
      holdEmbedding = true;
      const started = new Promise((resolve) => {
        notifyEmbedding = resolve;
      });
      const controller = new AbortController();
      const interrupted = client.callTool(
        { name: "atlas_sync", arguments: { analyse: false } },
        undefined,
        { signal: controller.signal },
      );
      interrupted.catch(() => {});
      await Promise.race([
        started,
        new Promise((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Embedding never started")),
            3000,
          );
          timeout.unref();
        }),
      ]);
      controller.abort();
      await assert.rejects(interrupted);
      let locked = true;
      for (let i = 0; i < 80; i++) {
        try {
          await readFile(path.join(data, "index.lock"));
        } catch (error) {
          if (error.code === "ENOENT") {
            locked = false;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(locked, false, "cancellation releases index writer lock");
      assert.ok(
        abortedEmbeddings > 0,
        "the pending Ollama request was aborted",
      );
      holdEmbedding = false;
      await invoke(client, "atlas_sync");
      const activityDb = new DatabaseSync(path.join(data, "atlas.sqlite"));
      try {
        const events = activityDb
          .prepare("SELECT data FROM mcp_calls")
          .all()
          .map((row) => JSON.parse(row.data));
        for (const tool of [
          "atlas_status",
          "atlas_search",
          "atlas_read_context",
          "atlas_activity",
          "atlas_find_followups",
          "atlas_sync",
          "read_excerpt",
        ])
          assert.ok(
            events.some((row) => row.tool === tool && row.status === "success"),
            `logged ${tool}`,
          );
        assert.ok(events.some((row) => row.status === "cancelled"));
        assert.ok(events.some((row) => row.status === "error"));
        assert.ok(events.every((row) => row.client === "atlas-test"));
        assert.ok(
          events.some((row) => row.excerpts > 0 && row.payloadBytes > 0),
        );
        assert.ok(
          events.every((row) => !("query" in row) && !("results" in row)),
        );
      } finally {
        activityDb.close();
      }
      assert.ok(
        calls.every((call) => call.route === "/api/embed"),
        "no local generation, reranking or overview synthesis",
      );
    } finally {
      db?.close();
      await Promise.allSettled(clients.map((client) => client.close()));
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
