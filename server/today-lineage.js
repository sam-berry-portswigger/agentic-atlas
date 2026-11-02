// Desktop undo changes the CLI session ID without creating a new user chat.
// Retain the current log and its actual status; discarded logs remain on disk
// and in the search index. Real fork/shared-history sessions stay independent.
export function coalesceClaudeRewinds(sessions, edges, desktopSessions) {
  const replacements = new Map();
  for (const current of desktopSessions.values()) {
    if (!sessions.has(current.cliSessionId)) continue;
    for (const prior of current.priorCliSessionIds || []) {
      const old = sessions.get(prior);
      if (!old || old.provider !== "claude" || prior === current.cliSessionId)
        continue;
      // A prior log that also has its own Desktop chat is a separate branch.
      if (desktopSessions.has(prior)) continue;
      replacements.set(prior, current.cliSessionId);
    }
  }
  if (!replacements.size) return replacements;
  for (const prior of replacements.keys()) sessions.delete(prior);
  for (const session of sessions.values())
    if (replacements.has(session.parent))
      session.parent = replacements.get(session.parent);
  const seen = new Set();
  for (let i = edges.length - 1; i >= 0; i--) {
    const edge = edges[i];
    edge.parent = replacements.get(edge.parent) || edge.parent;
    edge.child = replacements.get(edge.child) || edge.child;
    const key = JSON.stringify([edge.parent, edge.child, edge.kind]);
    if (edge.parent === edge.child || seen.has(key)) edges.splice(i, 1);
    else seen.add(key);
  }
  return replacements;
}

// Shared message UUIDs establish copied history, not a recorded spawn relationship.
// Keep every real branch and label inferred links separately from parent/child links.
export function linkSharedHistory(sessions, edges) {
  const roots = [...sessions.values()].filter(
    (s) => s.provider === "claude" && !s.parent && s._history?.length,
  );
  const groups = [];
  const owner = new Map();
  const find = (id) => {
    while (owner.get(id) !== id) id = owner.get(id);
    return id;
  };
  for (const s of roots) owner.set(s.id, s.id);
  for (let i = 0; i < roots.length; i++) {
    const a = roots[i],
      ids = new Set(a._history.map((r) => r.id));
    const requests = new Set(a._requests.map((r) => r.id));
    for (const b of roots.slice(i + 1)) {
      if (a.cwd !== b.cwd) continue;
      const shared = b._history.filter((r) => ids.has(r.id)).length;
      const sharedRequests = b._requests.filter((r) =>
        requests.has(r.id),
      ).length;
      if (shared >= 3 && sharedRequests >= 1) owner.set(find(b.id), find(a.id));
    }
  }
  for (const root of new Set(roots.map((s) => find(s.id))))
    groups.push(roots.filter((s) => find(s.id) === root));
  for (const group of groups) {
    if (group.length < 2) continue;
    // A stable anchor identifies shared history, never a display parent.
    group.sort(
      (a, b) => a._lastRequestAt - b._lastRequestAt || a.id.localeCompare(b.id),
    );
    const anchor = group[0];
    for (const s of group) {
      s.historyFamily = anchor.id;
      s.originalTitle = s.title;
      const otherRequests = new Set(
        group
          .filter((o) => o !== s)
          .flatMap((o) => o._requests.map((r) => r.id)),
      );
      const own = s._requests.find((r) => !otherRequests.has(r.id));
      if (s !== anchor) {
        s.relationship = "shared_history";
        s.title = (own || s._requests.at(-1))?.text || s.title;
        edges.push({ parent: anchor.id, child: s.id, kind: "shared_history" });
      }
      s.branchRequest = own?.text || s._requests.at(-1)?.text || "";
    }
  }
  for (const s of sessions.values()) {
    delete s._history;
    delete s._requests;
    delete s._lastRequestAt;
  }
}
