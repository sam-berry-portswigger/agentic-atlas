import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { stat, lstat, open } from "node:fs/promises";
import path from "node:path";
const cache = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const normalise = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
export const promptKey = (value) => normalise(value).slice(0, 900);

// Resolve literal shell paths only. Archived commands are evidence, never run.
function shellPath(token, variables) {
  if (!token) return null;
  let value = token.replace(/^(['"])(.*)\1$/, "$2");
  value = value.replace(
    /\$\{(\w+)\}|\$(\w+)/g,
    (match, a, b) => variables.get(a || b) ?? match,
  );
  return !/[\$`\n]/.test(value) && path.isAbsolute(value)
    ? path.normalize(value)
    : null;
}
function shellVariables(command) {
  const variables = new Map();
  for (const m of command.matchAll(
    /(?:^|[;\n])\s*([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;]+)/g,
  )) {
    const value = shellPath(m[2], variables);
    if (value) variables.set(m[1], value);
  }
  return variables;
}
function argument(command, name) {
  return new RegExp(
    "--" + name + "(?:=|\\s+)(\"[^\"\\n]*\"|'[^'\\n]*'|[^\\s;]+)",
  ).exec(command)?.[1];
}
function scratchOwner(file) {
  return /\/([0-9a-f]{8}-[0-9a-f-]{27})\/scratchpad\//i.exec(file || "")?.[1];
}
async function recordedThread(output, parent, at) {
  // The skill's output log contains Codex's actual thread.started event.
  // Restrict this fallback to the calling conversation's scratchpad.
  if (!output || scratchOwner(output) !== parent) return null;
  const log =
    output.slice(0, output.length - path.extname(output).length) + ".log";
  let file;
  try {
    const info = await lstat(log);
    if (!info.isFile() || info.mtimeMs < at) return null;
    file = await open(log, "r");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString().split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && uuid.test(event.thread_id))
          return event.thread_id;
      } catch {}
    }
  } catch {
  } finally {
    await file?.close();
  }
  return null;
}
export async function readClaudeLaunches(file) {
  const s = await stat(file),
    old = cache.get(file);
  if (old?.mtime === s.mtimeMs && old.size === s.size) return old.value;
  const writes = new Map(),
    launches = [],
    id = path.basename(file, ".jsonl");
  let title = "",
    cwd = "";
  const stream = createReadStream(file, { encoding: "utf8" }),
    lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
    if (r.cwd) cwd = r.cwd;
    if (r.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input || {},
        at = Date.parse(r.timestamp) || 0;
      if (
        b.name === "Write" &&
        typeof input.file_path === "string" &&
        typeof input.content === "string"
      )
        writes.set(input.file_path, { key: promptKey(input.content), at });
      if (
        !["Bash", "bash", "shell"].includes(b.name) ||
        typeof input.command !== "string"
      )
        continue;
      const command = input.command;
      const heredocs = [
        ...command.matchAll(
          /\bcat\s*<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*\n([\s\S]*?)\n\3(?=\s|;|$)/g,
        ),
      ];
      const shellCommand = command.replace(
        /\bcat\s*<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*\n([\s\S]*?)\n\3(?=\s|;|$)/g,
        "cat",
      );
      const variables = shellVariables(shellCommand);
      // A long literal prefix remains exact even when the shell appends a plan.
      const prefix = heredocs
        .map((m) => m[4])
        .find((text) => normalise(text).length >= 900);
      const redirected = /(?:>>|>)\s*("[^"\n]*"|'[^'\n]*'|[^\s;]+)/.exec(
        shellCommand,
      )?.[1];
      const written = shellPath(redirected, variables);
      if (prefix && written)
        writes.set(written, { key: promptKey(prefix), at });
      if (!/(?:run-codex\.py|\bcodex\s+exec\b)/.test(shellCommand)) continue;
      const brief = shellPath(argument(shellCommand, "prompt-file"), variables);
      const output = shellPath(argument(shellCommand, "out"), variables);
      const parent = scratchOwner(brief) || scratchOwner(output) || id;
      const write = brief && writes.get(brief);
      const validWrite =
        write &&
        write.key.length >= 80 &&
        at >= write.at &&
        at - write.at <= 120000;
      const nativeId = await recordedThread(output, parent, at);
      if (!validWrite && !nativeId) continue;
      launches.push({
        parent,
        key: validWrite ? write.key : null,
        nativeId,
        at,
        label: input.description || "",
        evidence: nativeId
          ? "Recorded Claude launch and Codex thread.started ID in its output log"
          : "Recorded Claude launch using the matching prompt file",
      });
    }
  }
  const value = { id, title, cwd, launches };
  cache.set(file, { mtime: s.mtimeMs, size: s.size, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
export function matchClaudeLaunch(session, launches) {
  const key = promptKey(session._prompt);
  const nativeId = session.nativeId || session.id?.replace(/^codex:/, "");
  const timely = launches.filter(
    (l) => Math.abs(l.at - session._created) < 120000,
  );
  const direct = nativeId ? timely.filter((l) => l.nativeId === nativeId) : [];
  const hits = direct.length
    ? direct
    : key.length >= 80
      ? timely.filter((l) => l.key === key && !l.nativeId)
      : [];
  const origins = new Set(hits.map((l) => l.parent));
  return origins.size === 1
    ? hits.sort(
        (a, b) =>
          Math.abs(a.at - session._created) - Math.abs(b.at - session._created),
      )[0]
    : null;
}
export function launchTitle(description) {
  const text = String(description || "")
    .replace(
      /^run\s+codex(?:\s+in\s+(?:write|read-only)\s+mode)?\s+(?:to|on)\s+/i,
      "",
    )
    .replace(/^codex[:\s]+/i, "")
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : null;
}
