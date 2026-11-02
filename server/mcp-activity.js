import { randomUUID } from "node:crypto";

// Metadata only: never persist queries, hypotheses, excerpt text or raw errors.
const retention = 1000;
export function trackMcpCall(db, tool, args = {}, client) {
  const id = randomUUID(),
    started = Date.now();
  const data = {
    tool,
    client: String(client?.name || "Unknown client").slice(0, 100),
    version: String(client?.version || "").slice(0, 50),
    status: "running",
    project: args.project || null,
    start: args.start || null,
    end: args.end || null,
    mode: args.mode || null,
    requestedBudget: args.budget || null,
  };
  function save(insert = false) {
    // Observability must never cause an otherwise successful retrieval to fail.
    try {
      if (insert) {
        db.prepare(
          "INSERT INTO mcp_calls(id,pid,started,data) VALUES(?,?,?,?)",
        ).run(id, process.pid, started, JSON.stringify(data));
        db.prepare(
          "DELETE FROM mcp_calls WHERE id IN (SELECT id FROM mcp_calls ORDER BY started DESC,rowid DESC LIMIT -1 OFFSET ?)",
        ).run(retention);
      } else
        db.prepare("UPDATE mcp_calls SET data=? WHERE id=?").run(
          JSON.stringify(data),
          id,
        );
    } catch {
      /* best effort; no conversation data in diagnostics */
    }
  }
  save(true);
  return {
    finish(value, { cancelled = false, failed = false } = {}) {
      const rows = value?.results || (value?.uri ? [value] : []);
      Object.assign(data, {
        status:
          cancelled || value?.cancelled
            ? "cancelled"
            : failed
              ? "error"
              : "success",
        duration: Date.now() - started,
        excerpts: rows.length,
        sessions: new Set(rows.map((row) => row.session).filter(Boolean)).size,
        characters: rows.reduce((n, row) => n + (row.text?.length || 0), 0),
        payloadBytes: value ? Buffer.byteLength(JSON.stringify(value)) : 0,
        omitted: value?.omitted || 0,
        moreAvailable: Boolean(
          value?.moreAvailable || value?.nextOffset != null,
        ),
        budget: value?.budget || null,
      });
      save();
    },
  };
}

export function readMcpActivity(db, { hours = 24, now = Date.now() } = {}) {
  hours = hours === 168 ? 168 : 24;
  const rows = db
    .prepare(
      "SELECT * FROM mcp_calls WHERE started>=? ORDER BY started DESC,rowid DESC LIMIT ?",
    )
    .all(now - hours * 3600000, retention);
  const calls = rows.map((row) => {
    const data = JSON.parse(row.data);
    if (data.status === "running") {
      try {
        process.kill(row.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") data.status = "interrupted";
      }
    }
    return { id: row.id, started: row.started, ...data };
  });
  const completed = calls.filter((row) => row.status === "success");
  const durations = completed.map((row) => row.duration).sort((a, b) => a - b);
  const percentile = (p) =>
    durations.length ? durations[Math.ceil(p * durations.length) - 1] : null;
  return {
    hours,
    retention,
    total: calls.length,
    summary: {
      running: calls.filter((row) => row.status === "running").length,
      errors: calls.filter(
        (row) => row.status === "error" || row.status === "interrupted",
      ).length,
      cancelled: calls.filter((row) => row.status === "cancelled").length,
      median: percentile(0.5),
      p95: percentile(0.95),
      excerpts: completed.reduce((n, row) => n + row.excerpts, 0),
      payloadBytes: completed.reduce((n, row) => n + row.payloadBytes, 0),
      clipped: completed.filter((row) => row.omitted > 0 || row.moreAvailable)
        .length,
    },
    calls: calls.slice(0, 100),
  };
}
