import test from "node:test";
import assert from "node:assert/strict";
import { logStatus, withLiveStatus } from "../server/session-status.js";
const now = Date.now(),
  at = (offset = 0) => new Date(now + offset).toISOString();
const assistant = (content, offset = 0, stop_reason) => ({
  type: "assistant",
  timestamp: at(offset),
  message: { content, stop_reason },
});
const user = (content, offset = 0, extra = {}) => ({
  type: "user",
  timestamp: at(offset),
  message: { content },
  ...extra,
});
const event = (type, offset = 0) => ({
  type: "event_msg",
  timestamp: at(offset),
  payload: { type },
});
const response = (type, rest, offset = 0) => ({
  type: "response_item",
  timestamp: at(offset),
  payload: { type, ...rest },
});

test("Claude questions and plan approvals stay pending until their own answer", () => {
  const rows = [
    assistant(
      [{ type: "tool_use", id: "ask", name: "AskUserQuestion" }],
      -600000,
    ),
    user(
      [{ type: "tool_result", tool_use_id: "unrelated", content: "done" }],
      -500000,
    ),
    { type: "system", subtype: "stop_hook_summary", timestamp: at(-400000) },
  ];
  assert.equal(logStatus(rows, "claude", now).status, "needs_input");
  const live = withLiveStatus(logStatus(rows, "claude", now), {
    status: "idle",
    updatedAt: now,
  });
  assert.equal(live.status, "needs_input");
  rows.push(
    user([
      { type: "tool_result", tool_use_id: "ask", content: "Chosen option A" },
    ]),
  );
  assert.equal(logStatus(rows, "claude", now).status, "running");
  assert.equal(
    logStatus(
      [assistant([{ type: "tool_use", id: "plan", name: "ExitPlanMode" }])],
      "claude",
      now,
    ).status,
    "needs_input",
  );
});
test("a direct final question needs input and the next human message answers it", () => {
  const rows = [
    assistant(
      [{ type: "text", text: "Which version should I use?" }],
      -1000,
      "end_turn",
    ),
    { type: "system", subtype: "stop_hook_summary", timestamp: at(-500) },
  ];
  assert.equal(logStatus(rows, "claude", now).status, "needs_input");
  rows.push(user("Use version two."));
  assert.equal(logStatus(rows, "claude", now).status, "running");
  const codex = [
    response("message", {
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Should I proceed?" }],
    }),
    event("task_complete"),
  ];
  assert.equal(logStatus(codex, "codex", now).status, "needs_input");
});
test("background Claude commands remain active across stop hooks and finish on notification", () => {
  const rows = [
    assistant([{ type: "tool_use", id: "bash", name: "Bash" }], -900000),
    user(
      [{ type: "tool_result", tool_use_id: "bash", content: "started" }],
      -890000,
      { toolUseResult: { backgroundTaskId: "job" } },
    ),
    { type: "system", subtype: "stop_hook_summary", timestamp: at(-800000) },
  ];
  let state = logStatus(rows, "claude", now);
  assert.equal(state.status, "running");
  assert.equal(state.waitingOnBackground, true);
  assert.equal(
    withLiveStatus(state, { status: "idle", updatedAt: now }).status,
    "running",
  );
  rows.push(
    user("", 0, {
      notificationText:
        "<task-notification><task-id>job</task-id><status>completed</status></task-notification>",
    }),
  );
  assert.equal(logStatus(rows, "claude", now).status, "done");
});
test("long foreground tools and Codex PTY sessions do not time out just because they are quiet", () => {
  const rows = [
    event("task_started", -900000),
    response(
      "function_call",
      {
        call_id: "exec",
        name: "functions.exec_command",
        arguments: '{"cmd":"long test"}',
      },
      -890000,
    ),
  ];
  assert.equal(logStatus(rows, "codex", now).status, "running");
  rows.push(
    response(
      "function_call_output",
      {
        call_id: "exec",
        output: JSON.stringify({ session_id: 123, output: "" }),
      },
      -800000,
    ),
  );
  assert.equal(logStatus(rows, "codex", now).waitingOnBackground, true);
  rows.push(
    response("function_call", {
      call_id: "poll",
      name: "functions.write_stdin",
      arguments: '{"session_id":123}',
    }),
  );
  rows.push(
    response("function_call_output", {
      call_id: "poll",
      output: JSON.stringify({ exit_code: 0, output: "success" }),
    }),
  );
  rows.push(event("task_complete"));
  assert.equal(logStatus(rows, "codex", now).status, "done");
});
test("Codex orchestrated background output and polling are paired without reading ordinary text as jobs", () => {
  const rows = [
    event("task_started"),
    response("custom_tool_call", {
      call_id: "start",
      name: "functions.exec",
      input: 'text(await tools.exec_command({cmd:"long test"}));',
    }),
    response("custom_tool_call_output", {
      call_id: "start",
      output: [
        { type: "input_text", text: "Script completed\nOutput:" },
        {
          type: "input_text",
          text: JSON.stringify({ session_id: 321, output: "" }),
        },
      ],
    }),
  ];
  assert.equal(logStatus(rows, "codex", now).waitingOnBackground, true);
  rows.push(
    response("custom_tool_call", {
      call_id: "poll",
      name: "functions.exec",
      input: 'text(await tools.write_stdin({session_id:321,chars:""}));',
    }),
  );
  rows.push(
    response("custom_tool_call_output", {
      call_id: "poll",
      output: [
        { type: "input_text", text: "Script completed\nOutput:" },
        {
          type: "input_text",
          text: JSON.stringify({
            exit_code: 0,
            output: 'Example data: {"session_id":888}',
          }),
        },
      ],
    }),
  );
  rows.push(event("task_complete"));
  assert.equal(logStatus(rows, "codex", now).status, "done");
});
test("async input acknowledgement is not an answer, and sampling gaps cannot leave phantom work active", () => {
  const rows = [
    event("task_started"),
    response("function_call", {
      call_id: "ask",
      name: "functions.request_user_input_async",
    }),
    response("function_call_output", {
      call_id: "ask",
      output: "Questions submitted",
    }),
    event("task_complete"),
  ];
  assert.equal(logStatus(rows, "codex", now).status, "needs_input");
  rows.push(
    response("message", {
      role: "user",
      content: [{ type: "input_text", text: "Yes, proceed." }],
    }),
  );
  assert.equal(logStatus(rows, "codex", now).status, "running");
  assert.equal(
    logStatus(
      [
        assistant([{ type: "tool_use", id: "old", name: "Bash" }], -1000000),
        { type: "atlas_log_gap" },
      ],
      "claude",
      now,
    ).status,
    "unknown",
  );
});

test("discovery preserves real question, background-result and wrapped completion signals", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { default: os } = await import("node:os");
  const { discoverToday } = await import("../server/today.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-status-"));
  try {
    const source = path.join(root, "projects"),
      project = path.join(source, "work");
    await mkdir(project, { recursive: true });
    const start = user("Run the scheduling tests", -900000);
    const background = [
      start,
      assistant([{ type: "tool_use", id: "run", name: "Bash" }], -890000),
      user(
        [{ type: "tool_result", tool_use_id: "run", content: "started" }],
        -880000,
        { toolUseResult: { backgroundTaskId: "build" } },
      ),
      { type: "system", subtype: "stop_hook_summary", timestamp: at(-870000) },
    ];
    const waiting = [
      start,
      assistant(
        [{ type: "tool_use", id: "question", name: "AskUserQuestion" }],
        -800000,
      ),
      { type: "system", subtype: "stop_hook_summary", timestamp: at(-790000) },
    ];
    const save = (name, rows) =>
      writeFile(
        path.join(project, name + ".jsonl"),
        rows.map(JSON.stringify).join("\n"),
      );
    await save("background", background);
    await save("waiting", waiting);
    const config = { source, codexSource: "" },
      scope = { start: now - 3600000, end: now + 10000, now, home: root };
    let snapshot = await discoverToday(config, scope);
    assert.equal(
      snapshot.sessions.find((s) => s.id === "background").status,
      "running",
    );
    assert.equal(
      snapshot.sessions.find((s) => s.id === "waiting").status,
      "needs_input",
    );
    background.push(
      user(
        "<system-reminder><task-notification><task-id>build</task-id><status>completed</status></task-notification></system-reminder>",
        0,
        { isMeta: true },
      ),
    );
    await save("background", background);
    snapshot = await discoverToday(config, scope);
    assert.equal(
      snapshot.sessions.find((s) => s.id === "background").status,
      "done",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit Codex turn completion ends its wait even if a detached server remains", () => {
  const rows = [
    event("task_started"),
    response("function_call", {
      call_id: "server",
      name: "functions.exec_command",
      arguments: '{"cmd":"npm run dev"}',
    }),
    response("function_call_output", {
      call_id: "server",
      output: JSON.stringify({ session_id: 999 }),
    }),
  ];
  assert.equal(logStatus(rows, "codex", now).status, "running");
  rows.push(event("task_complete"));
  assert.equal(logStatus(rows, "codex", now).status, "done");
});
