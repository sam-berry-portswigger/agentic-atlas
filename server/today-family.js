import { isFamilyEdge } from "../shared/today-layout.js";

export function attachFamilyPreferences(db, sessions, edges) {
  const detached = new Set(
    db
      .prepare("SELECT session FROM today_family_preferences WHERE detached=1")
      .all()
      .map((r) => r.session),
  );
  const incoming = new Map(),
    outgoing = new Map();
  const prefer = (map, id, edge) => {
    const previous = map.get(id);
    if (
      !previous ||
      (previous.kind === "shared_history" && edge.kind === "forked") ||
      (previous.kind === edge.kind &&
        edge.parent.localeCompare(previous.parent) < 0)
    )
      map.set(id, edge);
  };
  for (const edge of edges) {
    if (isFamilyEdge(edge)) continue;
    prefer(incoming, edge.child, edge);
    prefer(outgoing, edge.parent, edge);
  }
  for (const session of sessions) {
    session.familyDetached = detached.has(session.id);
    const edge =
      incoming.get(session.id) ||
      (session.familyDetached ? outgoing.get(session.id) : null);
    if (edge)
      session.familyLink = {
        parent: edge.parent === session.id ? edge.child : edge.parent,
        kind: edge.kind,
        detached: session.familyDetached,
      };
    else delete session.familyLink;
  }
}

export function setFamilyDetached(db, body, sessions, edges) {
  const session = sessions.find((s) => s.id === body?.session);
  if (!session)
    throw Object.assign(new Error("Refresh Today before changing this chat."), {
      status: 404,
    });
  if (typeof body.detached !== "boolean")
    throw Object.assign(new Error("Supply detached as a boolean."), {
      status: 400,
    });
  if (
    !edges.some(
      (e) =>
        (e.child === session.id ||
          (!body.detached &&
            session.familyDetached &&
            e.parent === session.id)) &&
        !isFamilyEdge(e),
    )
  )
    throw Object.assign(
      new Error("This chat has no related branch to detach."),
      { status: 400 },
    );
  if (body.detached)
    db.prepare(
      "INSERT INTO today_family_preferences VALUES(?,1,?) ON CONFLICT(session) DO UPDATE SET detached=1,updated=excluded.updated",
    ).run(session.id, new Date().toISOString());
  else
    db.prepare("DELETE FROM today_family_preferences WHERE session=?").run(
      session.id,
    );
  attachFamilyPreferences(db, sessions, edges);
  return { session: session.id, detached: body.detached };
}
