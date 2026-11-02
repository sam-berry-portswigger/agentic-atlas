import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  extractText,
  chunkText,
  parseSession,
  sessionFiles,
} from "../server/parser.js";
test("only imports conversation text, never thinking or tool results", () => {
  assert.equal(
    extractText({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "tool_use", input: { token: "secret" } },
          { type: "text", text: "Keep this" },
        ],
      },
    }),
    "Keep this",
  );
  assert.equal(
    extractText({
      type: "user",
      message: { content: [{ type: "tool_result", content: "tool output" }] },
    }),
    "",
  );
  assert.equal(
    extractText({
      type: "user",
      isMeta: true,
      message: { content: "internal" },
    }),
    "",
  );
  assert.equal(
    extractText({
      type: "assistant",
      isSidechain: true,
      message: { content: "subagent" },
    }),
    "",
  );
  assert.equal(
    extractText({
      type: "user",
      message: {
        content: "hello<system-reminder>internal</system-reminder>world",
      },
    }),
    "helloworld",
  );
});
test("chunking bounds long messages, preserves their end, and overlaps context", () => {
  const text = "0123456789".repeat(701);
  const chunks = chunkText(text);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.equal(chunks[0].slice(-200), chunks[1].slice(0, 200));
  assert.ok(text.endsWith(chunks.at(-1)));
  assert.deepEqual(chunkText(""), []);
});
test("reads JSONL incrementally, tolerates partial lines, keeps latest UUID and title", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-parser-"));
  try {
    const dir = path.join(root, "project");
    await mkdir(dir);
    const file = path.join(dir, "abc.jsonl");
    const rows = [
      {
        type: "user",
        uuid: "u",
        cwd: "/work/hello",
        message: { content: "first question" },
      },
      {
        type: "assistant",
        uuid: "a",
        message: { content: [{ type: "text", text: "old" }] },
      },
      { type: "custom-title", customTitle: "A useful title" },
      {
        type: "assistant",
        uuid: "a",
        message: { content: [{ type: "text", text: "new answer" }] },
      },
    ];
    await writeFile(
      file,
      rows.map((r) => JSON.stringify(r)).join("\n") + '\n{"partial":',
    );
    await mkdir(path.join(dir, "subagents"));
    await writeFile(path.join(dir, "subagents", "agent.jsonl"), "{}");
    const chunks = await parseSession(file);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1].text, "new answer");
    assert.equal(chunks[1].title, "A useful title");
    assert.equal(chunks[0].project, "hello");
    assert.deepEqual(await sessionFiles(root), [file]);
    assert.deepEqual(
      (await parseSession(file)).map((c) => c.id),
      chunks.map((c) => c.id),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex import keeps conversation text, stable IDs and metadata without tool, reasoning or duplicate event records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-codex-parser-"));
  try {
    const file = path.join(root, "rollout.jsonl");
    const message = (role, text, extra = {}) => ({
      type: "response_item",
      timestamp: "2026-10-27T10:00:00Z",
      payload: {
        type: "message",
        role,
        content: [
          { type: role === "user" ? "input_text" : "output_text", text },
        ],
        ...extra,
      },
    });
    const rows = [
      {
        type: "session_meta",
        payload: { id: "codex-session", cwd: "/work/atlas", source: "cli" },
      },
      message("developer", "Private developer instructions"),
      message(
        "user",
        "# AGENTS.md instructions for /work/atlas\nLocal instructions",
      ),
      message(
        "user",
        "<environment_context>Private environment</environment_context>",
      ),
      message(
        "user",
        "Investigate the database migration and preserve all records.",
      ),
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "Investigate the database migration and preserve all records.",
        },
      },
      message("assistant", "Private reasoning", { channel: "analysis" }),
      {
        type: "response_item",
        payload: { type: "function_call_output", output: "Tool output" },
      },
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ text: "Private reasoning" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "encrypted_content", encrypted_content: "opaque" }],
        },
      },
      message(
        "assistant",
        "The database migration preserves all records and tests pass.",
        { channel: "final" },
      ),
    ];
    await writeFile(
      file,
      rows.map((r) => JSON.stringify(r)).join("\n") + '\n{"partial":',
    );
    const chunks = await parseSession(file);
    assert.equal(chunks.length, 2);
    assert.deepEqual(
      chunks.map((r) => r.role),
      ["user", "assistant"],
    );
    assert.ok(
      chunks.every(
        (r) =>
          r.provider === "codex" &&
          r.session === "codex:codex-session" &&
          r.project === "atlas",
      ),
    );
    assert.match(chunks[0].title, /^Investigate/);
    assert.deepEqual(
      (await parseSession(file)).map((r) => r.id),
      chunks.map((r) => r.id),
    );
    rows[0].payload.source = {
      subagent: { thread_spawn: { parent_thread_id: "parent" } },
    };
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
    assert.deepEqual(await parseSession(file), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery includes dated rollouts and archived sessions, skips unrelated trees and absent archives", async () => {
  const { codexSessionFiles, archiveFiles } =
    await import("../server/parser.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-codex-discovery-"));
  try {
    const codex = path.join(root, "sessions"),
      dated = path.join(codex, "2026", "10", "27");
    const archived = path.join(root, "archived_sessions"),
      claude = path.join(root, "claude"),
      project = path.join(claude, "atlas");
    for (const dir of [dated, archived, project, path.join(codex, "tools")])
      await mkdir(dir, { recursive: true });
    const paths = [
      path.join(dated, "rollout.jsonl"),
      path.join(archived, "archived.jsonl"),
      path.join(project, "claude.jsonl"),
    ];
    for (const file of [...paths, path.join(codex, "tools", "private.jsonl")])
      await writeFile(file, "{}");
    assert.deepEqual(await codexSessionFiles(codex), paths.slice(0, 2).sort());
    assert.deepEqual(
      await archiveFiles({ source: claude, codexSource: codex }),
      paths.sort(),
    );
    assert.deepEqual(await codexSessionFiles(path.join(root, "missing")), []);
    assert.deepEqual(await archiveFiles({ source: claude, codexSource: "" }), [
      path.join(project, "claude.jsonl"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex derives a readable title from the actual request after the attachment header", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-codex-title-"));
  try {
    const file = path.join(root, "rollout.jsonl");
    const rows = [
      {
        type: "session_meta",
        payload: { id: "title-fixture", cwd: "/work/atlas", source: "cli" },
      },
      {
        type: "response_item",
        timestamp: "2026-10-27T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# Files mentioned by the user:\n## codex-clipboard-example.png: /var/folders/tmp/example.png\nImage attachment: true\n\n## My request:\nImprove the sidebar navigation and simplify the project list.",
            },
          ],
        },
      },
    ];
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n"));
    const chunks = await parseSession(file);
    assert.equal(
      chunks[0].title,
      "Improve the sidebar navigation and simplify the project list.",
    );
    assert.match(
      chunks[0].text,
      /Files mentioned/,
      "original evidence is preserved",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
