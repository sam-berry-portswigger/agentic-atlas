import { cosine, vectorArray } from "./db.js";
import { scopeWhere } from "./scope.js";

const stop = new Set(
  "a an the to of for in on at and or with from by is it this that your my work working task topic update progress discussion conversation across about into using use reviewing review findings finding".split(
    " ",
  ),
);
function terms(text) {
  return [
    ...new Set(
      (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])
        .map((word) => word.replace(/(?:ings|ing|ed|s)$/, ""))
        .filter((word) => word.length > 2 && !stop.has(word)),
    ),
  ];
}
function identities(text) {
  return [
    ...new Set([
      ...[
        ...text.matchAll(
          /(?:#|\bPR\s*#?|\bpull\s+request\s*#?|\/pull\/)(\d+)\b/gi,
        ),
      ].map((m) => m[1]),
      ...[...text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)].map((m) =>
        m[0].toLowerCase(),
      ),
    ]),
  ];
}
const fields =
  "id,session,project,title,role,timestamp,text,vector,model,cluster";
export function workItemRows(db, scope, selection) {
  const { title, sourceIds } = selection;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200 ||
    !Array.isArray(sourceIds) ||
    !sourceIds.length ||
    sourceIds.length > 100 ||
    sourceIds.some((id) => typeof id !== "string" || !id || id.length > 200)
  )
    throw Object.assign(
      new Error("Select a named work item with supporting sources."),
      { status: 400 },
    );
  const ids = [...new Set(sourceIds)];
  // Cached overview links can cite preceding context, but never future evidence
  // or another project. Such anchors identify the work without widening scope.
  const anchorScope = scopeWhere({ ...scope, start: "" });
  const anchors = db
    .prepare(
      `SELECT ${fields} FROM chunks WHERE id IN (${ids.map(() => "?").join(",")}) AND ${anchorScope.sql}`,
    )
    .all(...ids, ...anchorScope.params);
  if (!anchors.length)
    throw Object.assign(
      new Error(
        "The supporting conversations are no longer available. Refresh the overview and try again.",
      ),
      { status: 404 },
    );
  const projects = [...new Set(anchors.map((row) => row.project))];
  const { sql, params } = scopeWhere(scope);
  const rows = db
    .prepare(
      `SELECT ${fields},rowid AS position FROM chunks WHERE ${sql} AND project IN (${projects.map(() => "?").join(",")}) ORDER BY julianday(timestamp),rowid`,
    )
    .all(...params, ...projects);
  const titleTerms = terms(title);
  const targetIds = identities(title);
  const seedIds = new Set(anchors.map((row) => row.id));
  const seedVectors = anchors
    .filter((row) => row.vector)
    .map((row) => ({ model: row.model, vector: vectorArray(row.vector) }));
  function similarity(row) {
    if (!row.vector || !seedVectors.length) return null;
    const matches = seedVectors.filter((seed) => seed.model === row.model);
    if (!matches.length) return null;
    return Math.max(
      ...matches.map((seed) => cosine(seed.vector, vectorArray(row.vector))),
    );
  }
  function relevant(row) {
    if (seedIds.has(row.id)) return true;
    // Concrete work identities outrank semantic proximity. Sharing a map cluster
    // or a session title is never sufficient to include a passage.
    if (targetIds.length) {
      const text = row.text.toLowerCase();
      const sameWork = targetIds.some((id) =>
        new RegExp(
          `\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(text),
      );
      if (!sameWork) return false;
      // The PR/ticket alone can cover implementation, planning and review.
      // Require closeness to the link's actual evidence as well as its identity.
      const score = similarity(row);
      return score === null
        ? !/review|finding/i.test(title) ||
            /review|finding|verif|regression/i.test(text)
        : score >= 0.78;
    }
    const rowTerms = new Set(terms(row.text));
    const overlap = titleTerms.filter((term) => rowTerms.has(term)).length;
    if (!titleTerms.length || overlap < Math.min(2, titleTerms.length))
      return false;
    const score = similarity(row);
    return score === null || score >= 0.65;
  }
  // A request and its replies form a bounded discussion unit. Expanding a match
  // stops at the next user request, instead of pulling in an entire session.
  const sessions = new Map();
  for (const row of rows) {
    if (!sessions.has(row.session)) sessions.set(row.session, []);
    const units = sessions.get(row.session);
    let unit = units.at(-1);
    if (
      !unit ||
      (row.role === "user" &&
        !(unit.lastRole === "user" && unit.lastTime === row.timestamp))
    ) {
      unit = { rows: [], lastRole: row.role, lastTime: row.timestamp };
      units.push(unit);
    }
    unit.rows.push(row);
    unit.lastRole = row.role;
    unit.lastTime = row.timestamp;
  }
  const selected = [];
  for (const units of sessions.values()) {
    let previousRelevant = false;
    for (const unit of units) {
      const request = unit.rows
        .filter((row) => row.role === "user")
        .map((row) => row.text)
        .join("\n");
      const hasAnchor = unit.rows.some((row) => seedIds.has(row.id));
      // A new request to design a review process is a different objective, even
      // when it cites the reviewed PR as an example.
      if (
        !hasAnchor &&
        /review|finding/i.test(title) &&
        !/workflow|process|skill/i.test(title) &&
        /\b(?:design|creat|build|develop)\w*\b[\s\S]{0,90}\b(?:workflow|skill|framework|process)\b/i.test(
          request,
        )
      ) {
        previousRelevant = false;
        continue;
      }
      const matches = unit.rows.flatMap((row, i) => (relevant(row) ? [i] : []));
      // Explicit follow-ups such as "fix both findings" inherit the immediately
      // preceding work item. A new task or intervening unrelated request breaks it.
      if (
        !matches.length &&
        previousRelevant &&
        request.length < 500 &&
        /\b(?:fix|verif|re.?review|rerun|test)\w*\b/i.test(request) &&
        /\b(?:both|those|these|the findings|the fixes|the regression)\b/i.test(
          request,
        ) &&
        !identities(request).some((id) => !targetIds.includes(id))
      ) {
        const score = similarity(unit.rows[0]);
        if (score === null || score >= 0.78) matches.push(0);
      }
      previousRelevant = matches.length > 0;
      if (!matches.length) continue;
      for (const [index, row] of unit.rows.entries()) {
        // Long replies can span many chunks and several subjects. Keep only a
        // small window around the actual matching evidence within this request.
        if (!matches.some((match) => Math.abs(index - match) <= 2)) continue;
        // An explicit reference to different work must not ride along as context.
        const references = identities(row.text);
        if (
          !seedIds.has(row.id) &&
          targetIds.length &&
          references.length &&
          !references.some((id) => targetIds.includes(id))
        )
          continue;
        selected.push(row);
      }
    }
  }
  if (!selected.length)
    throw Object.assign(
      new Error(
        "No discussion of this work item is available in the selected date range.",
      ),
      { status: 404 },
    );
  return {
    rows: selected.map(({ vector, model, position, ...row }) => row),
    anchorIds: seedIds,
    title: title.trim(),
    cluster: anchors.find((row) => row.cluster !== null)?.cluster ?? 0,
  };
}
