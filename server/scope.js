export function parseScope(input = {}) {
  const project = input.project ?? "",
    start = input.start ?? "",
    end = input.end ?? "";
  if (
    typeof project !== "string" ||
    project.length > 200 ||
    [start, end].some((v) => typeof v !== "string" || (v && !validInstant(v)))
  )
    throw Object.assign(new Error("Invalid project or date range."), {
      status: 400,
    });
  if (start && end && Date.parse(start) >= Date.parse(end))
    throw Object.assign(
      new Error("Start must be before the end of the date range."),
      { status: 400 },
    );
  const streamId =
    input.streamId === undefined || input.streamId === ""
      ? undefined
      : Number(input.streamId);
  if (streamId !== undefined && (!Number.isInteger(streamId) || streamId < 0))
    throw Object.assign(new Error("Invalid stream ID."), { status: 400 });
  return {
    ...(streamId !== undefined ? { streamId } : {}),
    project,
    start: start ? new Date(start).toISOString() : "",
    end: end ? new Date(end).toISOString() : "",
  };
}
export function scopeWhere(scope, alias = "") {
  const prefix = alias ? alias + "." : "";
  const clauses = [],
    params = [];
  if (scope.streamId !== undefined) {
    clauses.push(
      `${prefix}id IN (SELECT chunk_id FROM analysis_members WHERE version=(SELECT value FROM analysis_state WHERE key='active') AND topic_id=?)`,
    );
    params.push(scope.streamId);
  }
  if (scope.project) {
    clauses.push(`${prefix}project=?`);
    params.push(scope.project);
  }
  if (scope.start) {
    clauses.push(`julianday(${prefix}timestamp)>=julianday(?)`);
    params.push(scope.start);
  }
  if (scope.end) {
    clauses.push(`julianday(${prefix}timestamp)<julianday(?)`);
    params.push(scope.end);
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

function validInstant(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = match.slice(1, 4).map(Number);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  );
}
