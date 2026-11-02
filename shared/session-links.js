const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function sessionOpenLink(session, sessions = new Map()) {
  if (session.provider === "codex")
    return {
      href: "codex://threads/" + encodeURIComponent(session.nativeId),
      label: "Open in Codex",
    };
  let target = session;
  // Claude's per-agent traces belong to their parent conversation, not a
  // separate desktop window or resumable CLI session.
  if (!uuid.test(target.nativeId)) {
    const seen = new Set();
    while (target.parent && !seen.has(target.id)) {
      seen.add(target.id);
      const parent = sessions.get(target.parent);
      if (!parent || parent.provider !== "claude") break;
      target = parent;
      if (uuid.test(target.nativeId)) break;
    }
  }
  const host = target.hostSessionId;
  if (typeof host === "string" && /^local_[0-9a-f-]{36}$/i.test(host))
    return {
      href: "claude://code/continue?session=" + encodeURIComponent(host),
      label: "Open in Claude",
      parent: target.id !== session.id,
    };
  if (uuid.test(target.nativeId))
    return {
      href: "claude://resume?session=" + encodeURIComponent(target.nativeId),
      label: "Open in Claude",
      parent: target.id !== session.id,
    };
  return { href: null, label: "Open in Claude" };
}
