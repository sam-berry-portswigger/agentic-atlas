import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import { conversationName } from "./names.js";
export async function sessionFiles(root) {
  const files = [];
  // Top-level session files only: subagent traces and tool transcripts are intentionally excluded.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    for (const item of await readdir(dir, { withFileTypes: true }))
      if (item.isFile() && item.name.endsWith(".jsonl"))
        files.push(path.join(dir, item.name));
  }
  return files;
}
export function extractText(row) {
  if (row.type === "response_item") return codexText(row);
  if (
    !["user", "assistant"].includes(row.type) ||
    row.isMeta ||
    row.isSidechain
  )
    return "";
  const content = row.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text || "")
            .join("\n\n")
        : "";
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}
export function chunkText(text, size = 1800, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > start + size * 0.6) end = boundary;
    }
    const part = text.slice(start, end).trim();
    if (part) chunks.push(part);
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
export async function parseSession(file) {
  let session = path.basename(file, ".jsonl"),
    provider = "claude";
  let title = "",
    cwd = "";
  const messages = new Map();
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    if (row.type === "session_meta") {
      provider = "codex";
      const meta = row.payload || {};
      if (
        meta.source === "subagent" ||
        (typeof meta.source === "object" && meta.source?.subagent)
      ) {
        input.destroy();
        return [];
      }
      session = "codex:" + (meta.session_id || meta.id || session);
      cwd = meta.cwd || cwd;
      title = meta.title || title;
    }
    if (provider === "codex" && row.type === "turn_context" && row.payload?.cwd)
      cwd = row.payload.cwd;
    if (row.type === "custom-title" && row.customTitle) title = row.customTitle;
    if (row.cwd) cwd = row.cwd;
    const text = extractText(row);
    if (!text) continue;
    const role = row.type === "response_item" ? row.payload.role : row.type;
    const id =
      row.uuid ||
      row.payload?.id ||
      createHash("sha256")
        .update(
          provider === "codex"
            ? `${role}:${row.timestamp || ""}:${text}`
            : `${row.type}:${text}`,
        )
        .digest("hex");
    // Claude can append updated copies of the same message. Keep its latest text.
    messages.set(id, {
      role,
      text,
      timestamp: row.timestamp || "",
      uuid: id,
    });
  }
  if (!title)
    title =
      [...messages.values()].find((m) => m.role === "user")?.text ||
      "Untitled session";
  let project = cwd
    ? path.basename(cwd)
    : path.basename(path.dirname(file)).replace(/^-Users-[^-]+-/, "");
  if (project === "scratch" || project.startsWith("scratch-"))
    project = provider === "codex" ? "Codex workspace" : "Claude workspace";
  project = project.slice(0, 80) || "Untitled project";
  title = conversationName(
    title,
    project,
    [...messages.values()].find((m) => m.role === "user")?.text,
  );
  const chunks = [];
  for (const message of messages.values())
    for (const [i, text] of chunkText(message.text).entries())
      chunks.push({
        id: createHash("sha256")
          .update(`${file}:${message.uuid}:${i}:${text}`)
          .digest("hex")
          .slice(0, 24),
        file,
        session,
        provider,
        project,
        title,
        role: message.role,
        timestamp: message.timestamp,
        text,
      });
  return chunks;
}

// Codex stores rollouts by date. Restrict traversal to those folders; never scan
// its configuration, credentials, tool transcripts or arbitrary subdirectories.
export async function codexSessionFiles(root) {
  if (!root) return [];
  const files = [];
  async function visit(dir, depth = 0) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
      else if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name))
        await visit(file, depth + 1);
    }
  }
  await visit(root);
  if (path.basename(root) === "sessions")
    await visit(path.join(path.dirname(root), "archived_sessions"));
  return files.sort();
}
export async function archiveFiles(config) {
  const [claude, codex] = await Promise.all([
    sessionFiles(config.source),
    codexSessionFiles(config.codexSource),
  ]);
  return [...new Set([...claude, ...codex])].sort();
}
function codexText(row) {
  const message = row.payload;
  if (
    row.type !== "response_item" ||
    message?.type !== "message" ||
    !["user", "assistant"].includes(message.role) ||
    message.channel === "analysis"
  )
    return "";
  return (Array.isArray(message.content) ? message.content : [])
    .filter(
      (block) =>
        ["input_text", "output_text", "text"].includes(block.type) &&
        !/^# AGENTS\.md instructions for /i.test(block.text || ""),
    )
    .map((block) => block.text || "")
    .join("\n\n")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(
      /<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/g,
      "",
    )
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, "")
    .trim();
}
