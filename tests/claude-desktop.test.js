import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { claudeDesktopSessions } from "../server/claude-desktop.js";
test("recorded Desktop IDs remain available after the live process metadata disappears", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "atlas-desktop-"));
  try {
    const dir = path.join(
      home,
      "Library/Application Support/Claude/claude-code-sessions/org/account",
    );
    await mkdir(dir, { recursive: true });
    const cli = "11111111-1111-4111-8111-111111111111",
      host = "local_22222222-2222-4222-8222-222222222222",
      newHost = "local_33333333-3333-4333-8333-333333333333";
    await writeFile(
      path.join(dir, host + ".json"),
      JSON.stringify({
        cliSessionId: cli,
        sessionId: host,
        lastFocusedAt: 1,
        title: "Must not be returned",
        promptAppendSnapshot: "private",
      }),
    );
    let sessions = await claudeDesktopSessions(home);
    assert.equal(sessions.get(cli).hostSessionId, host);
    assert.equal(sessions.get(cli).title, undefined);
    await writeFile(
      path.join(dir, newHost + ".json"),
      JSON.stringify({
        cliSessionId: cli,
        sessionId: newHost,
        lastFocusedAt: 2,
      }),
    );
    assert.equal(
      (await claudeDesktopSessions(home)).get(cli).hostSessionId,
      newHost,
    );
    await writeFile(
      path.join(dir, newHost + ".json"),
      JSON.stringify({
        cliSessionId: cli,
        sessionId: newHost,
        lastFocusedAt: 3,
        isArchived: true,
      }),
    );
    assert.equal(
      (await claudeDesktopSessions(home)).get(cli).hostSessionId,
      host,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Desktop metadata exposes only recorded rewind ancestors of the current CLI log", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "atlas-rewind-"));
  try {
    const dir = path.join(
      home,
      "Library/Application Support/Claude/claude-code-sessions/org/account",
    );
    await mkdir(dir, { recursive: true });
    const old = "11111111-1111-4111-8111-111111111111",
      middle = "22222222-2222-4222-8222-222222222222",
      current = "33333333-3333-4333-8333-333333333333",
      unrelated = "44444444-4444-4444-8444-444444444444",
      host = "local_55555555-5555-4555-8555-555555555555";
    await writeFile(
      path.join(dir, host + ".json"),
      JSON.stringify({
        sessionId: host,
        cliSessionId: current,
        priorCliSessionIds: [old, middle, unrelated],
        rewindEdges: [
          { parent: old, child: middle },
          { parent: middle, child: current },
          { parent: current, child: old }, // corrupt cycle must terminate
          { parent: unrelated, child: "not-a-session" },
        ],
      }),
    );
    assert.deepEqual(
      (await claudeDesktopSessions(home)).get(current).priorCliSessionIds,
      [middle, old],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
