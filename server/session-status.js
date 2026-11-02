const timestamp = (value) =>
  typeof value === "number"
    ? value > 1e11
      ? value
      : value * 1000
    : Date.parse(value) || 0;
const inputTool = (name) =>
  /(?:^|[.])(?:AskUserQuestion|ExitPlanMode|request_user_input|request_user_input_async)$/.test(
    name || "",
  );
const parse = (value) => {
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map(
            (c) => c.text || (typeof c.content === "string" ? c.content : ""),
          )
          .join("\n")
      : "";
const question = (text) =>
  /\?\s*(?:\*{1,2})?\s*$/.test(text.trim()) && !text.trim().endsWith("```");

export function logStatus(rows, provider, now = Date.now()) {
  let status = "unknown",
    basis = "No current activity signal",
    last = 0;
  const inputs = new Map(),
    tools = new Map(),
    jobs = new Set();
  const set = (state, why) => {
    status = state;
    basis = why;
  };
  const finish = (state, why) => {
    tools.clear();
    set(state, why);
  };
  function notification(text) {
    for (const m of text.matchAll(
      /<task-notification>([\s\S]*?)<\/task-notification>/g,
    )) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(m[1])?.[1];
      const state = /<status>([^<]+)<\/status>/.exec(m[1])?.[1];
      if (id && /^(completed|failed|killed|stopped)$/.test(state))
        jobs.delete(id);
    }
  }
  function call(id, name, args) {
    const key = id || "input",
      value = {
        name,
        args: parse(args),
        code: typeof args === "string" ? args : "",
      };
    if (inputTool(name)) {
      inputs.set(key, value);
      set("needs_input", "Explicit input or approval request in local log");
    } else {
      tools.set(key, value);
      set("running", "Waiting for a tool or command to finish");
    }
  }
  function result(id, output, metadata = {}) {
    const request = inputs.get(id);
    const text = textOf(output),
      data = parse(text);
    if (request) {
      const async = request.name.endsWith("request_user_input_async");
      if (!async || data.answers || /"answers"\s*:/.test(text))
        inputs.delete(id);
      if (!inputs.size) set("running", "Input request answered");
    }
    const tool = tools.get(id);
    tools.delete(id);
    const backgroundId = metadata.backgroundTaskId || data.backgroundTaskId;
    if (backgroundId) jobs.add(String(backgroundId));
    const task = metadata.task || data.task || {};
    const taskId =
      task.task_id || task.id || metadata.taskId || tool?.args?.task_id;
    const taskState = task.status || metadata.status || data.status;
    if (taskId && /^(running|async_launched|pending)$/.test(taskState))
      jobs.add(String(taskId));
    if (
      taskId &&
      /^(completed|failed|killed|stopped|cancelled)$/.test(taskState)
    )
      jobs.delete(String(taskId));
    if (
      /(?:^|[.])(?:exec|exec_command|write_stdin|wait)$/.test(tool?.name || "")
    ) {
      const chunks = Array.isArray(output)
        ? output.map((c) => parse(c.text))
        : [data];
      const stillRunning = new Set();
      for (const chunk of chunks)
        if (chunk?.session_id != null && chunk.exit_code == null) {
          stillRunning.add(String(chunk.session_id));
          jobs.add(String(chunk.session_id));
        }
      const header = Array.isArray(output)
        ? output[0]?.text || ""
        : text.split("Output:")[0];
      for (const match of header.matchAll(
        /(?:Process running with session ID|Script running with cell ID)\s+([\w-]+)/g,
      )) {
        stillRunning.add(match[1]);
        jobs.add(match[1]);
      }
      const targets = [tool?.args?.session_id, tool?.args?.cell_id]
        .filter((id) => id != null)
        .map(String);
      // Orchestration calls record literal poll IDs in their code rather than
      // as a top-level tool argument. Read those IDs without evaluating code.
      for (const match of (tool?.code || "").matchAll(
        /tools\.write_stdin\(\s*\{[^}]*?session_id\s*:\s*(\d+)/g,
      ))
        targets.push(match[1]);
      const completed =
        chunks.some((c) => c?.exit_code != null) ||
        /Process exited with code|Script completed/.test(header);
      if (completed)
        for (const target of targets)
          if (!stillRunning.has(target)) jobs.delete(target);
    }
    notification(text);
    if (!inputs.size && status !== "error")
      set("running", "Tool response received");
  }
  for (const row of rows) {
    const r = row,
      p = r.payload || {};
    if (r.type === "atlas_log_gap") {
      inputs.clear();
      tools.clear();
      jobs.clear();
      set("unknown", "Middle of large log not sampled");
      continue;
    }
    // Bookkeeping rows must not make old work appear fresh.
    if (["user", "assistant", "event_msg", "response_item"].includes(r.type))
      last = Math.max(last, timestamp(r.timestamp));
    if (provider === "codex") {
      if (r.type === "event_msg") {
        if (["task_started", "turn_started"].includes(p.type))
          set("running", "Turn started in local log");
        if (
          [
            "task_complete",
            "task_completed",
            "turn_complete",
            "turn_completed",
          ].includes(p.type)
        ) {
          // Codex's explicit turn-complete event ends its wait. A detached
          // development server must not keep a finished conversation active.
          jobs.clear();
          finish("done", "Last turn completed");
        }
        if (["turn_aborted", "task_aborted"].includes(p.type)) {
          inputs.clear();
          jobs.clear();
          finish("idle", "Turn stopped");
        }
        if (["turn_failed", "error"].includes(p.type)) {
          inputs.clear();
          jobs.clear();
          finish("error", "Error recorded in local log");
        }
        if (
          [
            "request_user_input",
            "approval_request",
            "permission_request",
          ].includes(p.type)
        ) {
          inputs.set(p.call_id || "event-input", {});
          set("needs_input", "Input or permission requested");
        }
        if (p.type === "user_message") {
          inputs.clear();
          set("running", "User message received");
        }
      }
      if (r.type === "response_item") {
        if (["function_call", "custom_tool_call"].includes(p.type))
          call(p.call_id, p.name, p.arguments || p.input);
        if (
          ["function_call_output", "custom_tool_call_output"].includes(p.type)
        )
          result(p.call_id, p.output || p.content);
        if (p.role === "user" && textOf(p.content).trim()) {
          inputs.clear();
          set("running", "User message received");
        }
        if (
          p.role === "assistant" &&
          (p.channel === "final" || p.phase === "final_answer") &&
          question(textOf(p.content))
        ) {
          inputs.set("question", {});
          set("needs_input", "Assistant asked a question");
        }
      }
    } else {
      const content = r.message?.content;
      if (r.type === "assistant" && Array.isArray(content)) {
        const calls = content.filter((c) => c.type === "tool_use");
        for (const c of calls) call(c.id, c.name, c.input);
        if (!calls.length && r.message?.stop_reason === "end_turn") {
          if (question(textOf(content))) {
            inputs.set("question", {});
            set("needs_input", "Assistant asked a question");
          } else finish("done", "Last turn completed");
        }
      }
      if (r.type === "user") {
        const results =
          r.toolResults ||
          (Array.isArray(content)
            ? content.filter((c) => c.type === "tool_result")
            : []);
        for (const output of results)
          result(output.tool_use_id, output.content, r.toolUseResult || {});
        const text = textOf(content);
        notification(text);
        notification(r.notificationText || "");
        if (
          !results.length &&
          text.trim() &&
          !r.isMeta &&
          !r.isSidechain &&
          !/<(?:system-reminder|task-notification)>|^\[Request interrupted by user/.test(
            text,
          )
        ) {
          inputs.clear();
          set("running", "User message received");
        }
        if (/^\[Request interrupted by user/.test(text.trim())) {
          inputs.clear();
          jobs.clear();
          finish("idle", "Turn interrupted");
        }
      }
      if (r.type === "system" && r.subtype === "stop_hook_summary")
        finish("done", "Turn stop recorded");
    }
  }
  if (inputs.size) set("needs_input", "Waiting for your answer or approval");
  else if (jobs.size) set("running", "Waiting on background commands");
  else if (tools.size && status !== "error")
    set("running", "Waiting for a tool or command to finish");
  else if (status === "running" && now - last > 150000)
    set("unknown", "Activity is stale; current state unverified");
  return {
    status,
    basis,
    statusAt: last ? new Date(last).toISOString() : null,
    waitingOnBackground: jobs.size > 0,
    pendingInput: inputs.size > 0,
  };
}

export function withLiveStatus(session, live) {
  const native = {
    idle: "idle",
    working: "running",
    running: "running",
    busy: "running",
    waiting_for_input: "needs_input",
    needs_input: "needs_input",
    waiting_for_approval: "needs_input",
    waiting_for_permission: "needs_input",
    needs_approval: "needs_input",
  }[live.status];
  const at = timestamp(live.statusUpdatedAt || live.updatedAt);
  if (!native || at < timestamp(session.statusAt)) return session;
  if (
    session.pendingInput ||
    (session.waitingOnBackground && native === "idle")
  )
    return session;
  return {
    ...session,
    status: native,
    basis: "Claude process reports " + live.status,
    statusAt: at ? new Date(at).toISOString() : session.statusAt,
  };
}
