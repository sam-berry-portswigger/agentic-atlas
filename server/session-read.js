export function markSessionRead(db, { session, responseAt }) {
  if (typeof session !== "string" || !session || session.length > 200)
    throw Object.assign(Error("Invalid session ID."), { status: 400 });
  const at = Date.parse(responseAt);
  if (!Number.isFinite(at) || at > Date.now() + 60000)
    throw Object.assign(Error("Invalid response time."), { status: 400 });
  const value = new Date(at).toISOString();
  db.prepare(
    "INSERT INTO today_reads(session,response_at) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET response_at=max(response_at,excluded.response_at)",
  ).run(session, value);
  return { session, responseAt: value };
}
export function attachUnread(db, sessions, start, end) {
  const reads = new Map(
    db
      .prepare("SELECT session,response_at FROM today_reads")
      .all()
      .map((r) => [r.session, Date.parse(r.response_at)]),
  );
  for (const s of sessions) {
    const response = Date.parse(s.lastResponseAt) || 0,
      request = Date.parse(s.lastRequestAt) || 0;
    s.unread = Boolean(
      response >= start &&
      response < end &&
      response >= request &&
      response > (reads.get(s.id) || 0) &&
      s.status !== "running",
    );
  }
}
