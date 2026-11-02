import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
const cache = new Map(),
  id = /^local_[0-9a-f-]{36}$/i,
  uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// Rewinds replace the CLI log behind one Desktop chat. A copied history or
// ordinary fork alone is never enough to establish this identity.
function rewindPredecessors(record) {
  const parents = new Map();
  for (const edge of Array.isArray(record.rewindEdges)
    ? record.rewindEdges
    : [])
    if (
      uuid.test(edge.parent) &&
      uuid.test(edge.child) &&
      edge.parent !== edge.child
    ) {
      if (!parents.has(edge.child)) parents.set(edge.child, []);
      parents.get(edge.child).push(edge.parent);
    }
  const seen = new Set([record.cliSessionId]),
    pending = [record.cliSessionId];
  for (let i = 0; i < pending.length; i++)
    for (const parent of parents.get(pending[i]) || [])
      if (!seen.has(parent)) {
        seen.add(parent);
        pending.push(parent);
      }
  return pending.slice(1);
}
async function directories(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
// Only local metadata IDs and timestamps are retained. No conversation or prompt
// text is returned, and Desktop's settings/approval files are never modified.
export async function claudeDesktopSessions(home) {
  const root = path.join(
      home,
      "Library/Application Support/Claude/claude-code-sessions",
    ),
    sessions = new Map();
  for (const org of await directories(root))
    for (const account of await directories(org)) {
      let files;
      try {
        files = await readdir(account);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith(".json") || !id.test(name.slice(0, -5))) continue;
        const file = path.join(account, name);
        try {
          const info = await stat(file);
          if (info.size > 4e6) continue;
          let old = cache.get(file);
          if (!old || old.mtime !== info.mtimeMs || old.size !== info.size) {
            const r = JSON.parse(await readFile(file, "utf8"));
            const value =
              id.test(r.sessionId) && uuid.test(r.cliSessionId) && !r.isArchived
                ? {
                    cliSessionId: r.cliSessionId,
                    hostSessionId: r.sessionId,
                    priorCliSessionIds: rewindPredecessors(r),
                    updated: Math.max(
                      Number(r.lastFocusedAt) || 0,
                      Number(r.lastActivityAt) || 0,
                    ),
                  }
                : null;
            old = { mtime: info.mtimeMs, size: info.size, value };
            cache.set(file, old);
          }
          const v = old.value;
          if (
            v &&
            (!sessions.has(v.cliSessionId) ||
              sessions.get(v.cliSessionId).updated < v.updated)
          )
            sessions.set(v.cliSessionId, v);
        } catch {}
      }
    }
  return sessions;
}
