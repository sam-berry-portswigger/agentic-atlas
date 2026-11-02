import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readClaudeLaunches,
  matchClaudeLaunch,
  launchTitle,
} from "../server/today-origins.js";
test("Claude delegation requires the exact written brief, an actual launch, and matching creation time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-origin-"));
  try {
    const sid = "11111111-1111-1111-1111-111111111111",
      file = path.join(dir, sid + ".jsonl"),
      brief = "/tmp/" + sid + "/scratchpad/codex-brief.md",
      text =
        "# Task\nRun the headed and forked scheduling tests. " +
        "Specific evidence and code context. ".repeat(30),
      now = Date.now();
    const row = (input, offset) => ({
      type: "assistant",
      timestamp: new Date(now + offset).toISOString(),
      message: {
        content: [
          { type: "tool_use", name: input.file_path ? "Write" : "Bash", input },
        ],
      },
    });
    await writeFile(
      file,
      [
        row({ file_path: brief, content: text }, 0),
        row(
          {
            command: `python run-codex.py --prompt-file ${brief}`,
            description: "Run Codex to execute headed tests",
          },
          1000,
        ),
      ]
        .map(JSON.stringify)
        .join("\n"),
    );
    const e = await readClaudeLaunches(file),
      session = { _prompt: text, _created: now + 2000 };
    assert.equal(matchClaudeLaunch(session, e.launches).parent, sid);
    assert.equal(
      matchClaudeLaunch(
        { ...session, _prompt: "Different prompt" },
        e.launches,
      ),
      null,
    );
    assert.equal(
      matchClaudeLaunch({ ...session, _created: now + 300000 }, e.launches),
      null,
    );
    assert.equal(launchTitle(e.launches[0].label), "Execute headed tests");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shell-created briefs with variables and appended plans link while Codex is still running", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-heredoc-"));
  try {
    const parent = "22222222-2222-2222-2222-222222222222",
      at = Date.now();
    const scratch = path.join(dir, parent, "scratchpad"),
      file = path.join(dir, parent + ".jsonl");
    const text =
      "# Task: Fix given<X>_when<Y>_then<Z> tests.\n" +
      "Specific code context and requested implementation. ".repeat(40);
    const command = `S=${scratch}; { cat <<'EOF'\n${text}\nEOF\ncat $S/plan.md; } > $S/codex-brief.md; python3 -I ~/.claude/skills/codex-agent/run-codex.py --prompt-file $S/codex-brief.md --out $S/answer.md`;
    await writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(at).toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command,
                description: "Run Codex in write mode to implement the plan",
              },
            },
          ],
        },
      }),
    );
    const result = await readClaudeLaunches(file);
    assert.equal(result.launches.length, 1);
    assert.equal(
      matchClaudeLaunch(
        { _prompt: text + "\nAppended plan.", _created: at + 3000 },
        result.launches,
      ).parent,
      parent,
    );
    assert.equal(launchTitle(result.launches[0].label), "Implement the plan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Codex's recorded thread ID links review launches and disambiguates copied Claude histories", async () => {
  const { mkdir } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-thread-link-"));
  try {
    const parent = "33333333-3333-3333-3333-333333333333",
      child = "44444444-4444-4444-4444-444444444444",
      at = Date.now();
    const scratch = path.join(dir, parent, "scratchpad");
    await mkdir(scratch, { recursive: true });
    await writeFile(
      path.join(scratch, "review.log"),
      JSON.stringify({ type: "thread.started", thread_id: child }) + "\n",
    );
    const file = path.join(dir, "copied-session.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(at).toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command: `S='${scratch}'; python3 run-codex.py --review WORKTREE --out "$S/review.json"`,
              },
            },
          ],
        },
      }),
    );
    const result = await readClaudeLaunches(file);
    assert.equal(
      matchClaudeLaunch(
        { nativeId: child, _prompt: "", _created: at + 1000 },
        result.launches,
      ).parent,
      parent,
    );
    assert.equal(
      matchClaudeLaunch(
        { nativeId: "different", _prompt: "", _created: at + 1000 },
        result.launches,
      ),
      null,
    );
    assert.equal(
      matchClaudeLaunch(
        { nativeId: child, _prompt: "", _created: at + 300000 },
        result.launches,
      ),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("quoting launch instructions inside a heredoc is not a launch and ambiguous parents stay unlinked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-no-launch-"));
  try {
    const at = Date.now(),
      text = "Exact prompt context. ".repeat(60),
      file = path.join(dir, "parent.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(at).toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command: `cat <<'EOF'\n${text}\npython3 run-codex.py --prompt-file /tmp/brief.md\nEOF\n`,
              },
            },
          ],
        },
      }),
    );
    assert.equal((await readClaudeLaunches(file)).launches.length, 0);
    const launches = ["one", "two"].map((parent) => ({
      parent,
      key: text.replace(/\s+/g, " ").trim().slice(0, 900),
      at,
    }));
    assert.equal(
      matchClaudeLaunch({ _prompt: text, _created: at + 1 }, launches),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
