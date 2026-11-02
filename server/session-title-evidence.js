import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { extractText } from "./parser.js";
import { readableText } from "./names.js";
import { stat } from "node:fs/promises";
const samples = new Map();

// Stable random sampling gives every part of the conversation a chance to
// contribute without changing the evidence on every retry. Retain the opening
// and latest user requests as anchors, with ten other messages from anywhere.
export function titleEvidenceSampler(session) {
  const candidates = new Map();
  let first = null,
    last = null;
  const compare = (a, b) =>
    (Date.parse(a.message.timestamp) || 0) -
      (Date.parse(b.message.timestamp) || 0) || a.key.localeCompare(b.key);
  return {
    add(row) {
      if (row.session !== session || !["user", "assistant"].includes(row.role))
        return;
      const text = readableText(row.text || "").slice(0, 700);
      if (!text) return;
      const message = {
        session,
        role: row.role,
        timestamp: row.timestamp || "",
        text,
      };
      const key = createHash("sha256")
        .update(JSON.stringify(message))
        .digest("hex");
      const item = { key, message };
      if (row.role === "user") {
        if (!first || compare(item, first) < 0) first = item;
        if (!last || compare(item, last) > 0) last = item;
      }
      candidates.set(key, item);
      if (candidates.size > 12)
        candidates.delete([...candidates.keys()].sort().at(-1));
    },
    messages() {
      const chosen = new Map(
        [first, last].filter(Boolean).map((item) => [item.key, item]),
      );
      for (const item of [...candidates.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        if (chosen.size === 12) break;
        chosen.set(item.key, item);
      }
      return [...chosen.values()].sort(compare).map((item) => item.message);
    },
  };
}

export function sessionTitleEvidence(messages, session) {
  const sampler = titleEvidenceSampler(session);
  for (const message of messages) sampler.add(message);
  return sampler.messages();
}

// Today activity discovery samples the head/tail of large logs. Naming instead
// walks the full selected log on demand, retaining only a bounded text sample.
export async function readSessionTitleEvidence(file, session) {
  const info = await stat(file);
  const key = file + ":" + session;
  const signature = `${info.mtimeMs}:${info.size}`;
  const cached = samples.get(key);
  if (cached?.signature === signature)
    return (await cached.promise).map((row) => ({ ...row }));
  const promise = readTitleEvidence(file, session);
  samples.set(key, { signature, promise });
  if (samples.size > 64) samples.delete(samples.keys().next().value);
  try {
    return (await promise).map((row) => ({ ...row }));
  } catch (error) {
    if (samples.get(key)?.promise === promise) samples.delete(key);
    throw error;
  }
}
async function readTitleEvidence(file, session) {
  const sampler = titleEvidenceSampler(session);
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const role = row.type === "response_item" ? row.payload?.role : row.type;
      if (!["user", "assistant"].includes(role)) continue;
      const text = extractText({ ...row, isSidechain: false });
      sampler.add({ session, role, timestamp: row.timestamp, text });
    }
    return sampler.messages();
  } finally {
    lines.close();
    input.destroy();
  }
}
