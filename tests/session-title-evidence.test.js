import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  sessionTitleEvidence,
  readSessionTitleEvidence,
} from "../server/session-title-evidence.js";

test("naming samples the whole conversation, retains user intent and stays stable across ordering and duplicates", () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({
    session: "one",
    role: i % 2 ? "assistant" : "user",
    timestamp: new Date(100000 + i * 1000).toISOString(),
    text:
      `Message ${i}: ${i === 0 ? "Improve Atlas session organisation" : "UX discussion"}. ` +
      "context ".repeat(150),
  }));
  const sample = sessionTitleEvidence(messages, "one");
  assert.equal(sample.length, 12);
  assert.ok(
    sample.some((m) => m.text.startsWith("Message 0:")),
    "opening intent is retained",
  );
  assert.ok(
    sample.some((m) => m.text.startsWith("Message 198:")),
    "latest user request is retained",
  );
  for (const [start, end] of [
    [1, 50],
    [50, 100],
    [100, 150],
  ])
    assert.ok(
      sample.some((m) => {
        const n = Number(m.text.match(/Message (\d+)/)[1]);
        return n >= start && n < end;
      }),
      "earlier and middle work contributes, not just the last messages",
    );
  assert.deepEqual(
    sessionTitleEvidence(
      [
        ...messages,
        ...messages,
        { session: "other", role: "user", text: "Unrelated" },
        { session: "one", role: "tool", text: "Ignore this" },
      ].reverse(),
      "one",
    ),
    sample,
  );
  assert.ok(sample.every((m) => m.text.length <= 700));
  assert.deepEqual(
    sample.map((m) => m.timestamp),
    sample.map((m) => m.timestamp).sort(),
  );
});

test("cached full-log evidence is isolated from callers and invalidates on file growth", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-title-cache-")),
    file = path.join(dir, "chat.jsonl");
  const row = (text) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-11-02",
      message: { content: text },
    }) + "\n";
  try {
    await writeFile(file, row("Improve Atlas topic navigation"));
    const first = await readSessionTitleEvidence(file, "chat");
    first[0].text = "Caller edit";
    assert.equal(
      (await readSessionTitleEvidence(file, "chat"))[0].text,
      "Improve Atlas topic navigation",
    );
    await writeFile(
      file,
      row("Investigate a completely different scheduling problem"),
    );
    assert.equal(
      (await readSessionTitleEvidence(file, "chat"))[0].text,
      "Investigate a completely different scheduling problem",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("on-demand naming reads the middle of large source logs and excludes tools, thinking and metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-name-evidence-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const rows = [
      { type: "session_meta", payload: { padding: "x".repeat(1000000) } },
      ...Array.from({ length: 30 }, (_, i) => ({
        type: "response_item",
        timestamp: new Date(100000 + i * 1000).toISOString(),
        payload: {
          type: "message",
          role: i % 2 ? "assistant" : "user",
          content: [
            {
              type: i % 2 ? "output_text" : "input_text",
              text:
                i === 0
                  ? "Build a consistent Atlas UX across sessions"
                  : `Middle-of-log discussion ${i}`,
            },
          ],
        },
      })),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          channel: "analysis",
          content: [{ type: "output_text", text: "Private reasoning" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "Tool output ".repeat(600000),
        },
      },
    ];
    await writeFile(file, rows.map(JSON.stringify).join("\n") + "\n");
    const sample = await readSessionTitleEvidence(file, "codex:one");
    assert.equal(sample.length, 12);
    assert.ok(
      sample.some(
        (m) => m.text === "Build a consistent Atlas UX across sessions",
      ),
    );
    assert.ok(sample.some((m) => m.text === "Middle-of-log discussion 28"));
    assert.ok(
      sample.every(
        (m) => !/Private reasoning|Tool output|padding/.test(m.text),
      ),
    );
    const claude = path.join(dir, "claude.jsonl");
    await writeFile(
      claude,
      [
        {
          type: "user",
          timestamp: "2026-10-30",
          message: { content: "Review semantic clustering" },
        },
        {
          type: "user",
          isMeta: true,
          message: { content: "Metadata instructions" },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "Secret tool command" },
              },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Compared the grouping results" }],
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n"),
    );
    assert.deepEqual(
      (await readSessionTitleEvidence(claude, "claude-one"))
        .map((m) => m.text)
        .sort(),
      ["Compared the grouping results", "Review semantic clustering"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
