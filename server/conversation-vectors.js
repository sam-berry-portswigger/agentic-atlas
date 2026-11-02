import { createHash } from "node:crypto";
import { cosine, normalize } from "./db.js";
import { readableText } from "./names.js";

export const CONVERSATION_POLICY = "conversation-vectors-v1";
const digest = (text) => createHash("sha256").update(text).digest("hex");
export const conversationTextKey = (row) =>
  digest(readableText(row.text) || row.text?.trim() || "");
export function averageVectors(items) {
  const sum = new Float64Array(items[0].vector.length);
  for (const item of items)
    item.vector.forEach((v, i) => {
      sum[i] += v * (item.weight ?? 1);
    });
  return normalize(sum);
}

// One message gets one vote, regardless of its chunk count. Copied messages and
// repeated procedural language contribute less than distinct conversation text.
export function conversationVectors(rows, { frequencies } = {}) {
  const grouped = new Map(),
    frequency = new Map();
  for (const row of rows) {
    if (!row.vector || !["user", "assistant"].includes(row.role)) continue;
    const text = readableText(row.text) || row.text?.trim() || "";
    const key = digest(text);
    if (!frequency.has(key)) frequency.set(key, new Set());
    frequency.get(key).add(row.session);
    if (!grouped.has(row.session)) grouped.set(row.session, []);
    grouped.get(row.session).push({ row, text, key });
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([session, entries]) => {
      const unique = [
        ...new Map(
          [...entries]
            .sort(
              (a, b) =>
                (a.row.timestamp || "").localeCompare(b.row.timestamp || "") ||
                a.row.id.localeCompare(b.row.id),
            )
            .map((e) => [e.key, e]),
        ).values(),
      ];
      const substantive = unique.filter(
        (e) => e.text.length >= (e.row.role === "user" ? 45 : 90),
      );
      const evidence = substantive.length ? substantive : unique;
      const messages = new Map();
      for (const e of evidence) {
        const key = e.row.role + ":" + (e.row.timestamp || e.row.id);
        if (!messages.has(key)) messages.set(key, []);
        messages.get(key).push(e);
      }
      const records = [...messages.values()]
        .map((parts) => ({
          parts,
          vector: averageVectors(parts.map((e) => ({ vector: e.row.vector }))),
          timestamp: parts[0].row.timestamp || "",
          key: parts
            .map((e) => e.key)
            .sort()
            .join(":"),
          weight:
            (parts[0].row.role === "user" ? 2 : 1) /
            Math.sqrt(
              Math.max(
                ...parts.map(
                  (e) => frequencies?.get(e.key) ?? frequency.get(e.key).size,
                ),
              ),
            ),
        }))
        .sort(
          (a, b) =>
            a.timestamp.localeCompare(b.timestamp) ||
            a.key.localeCompare(b.key),
        );
      // A stable sample from each part of the history prevents a busy final phase
      // from replacing the overall subject, while keeping inference inputs bounded.
      const selected = [];
      for (let bucket = 0; bucket < Math.min(24, records.length); bucket++) {
        const start = Math.floor(
          (bucket * records.length) / Math.min(24, records.length),
        );
        const end = Math.floor(
          ((bucket + 1) * records.length) / Math.min(24, records.length),
        );
        selected.push(
          records
            .slice(start, end)
            .sort((a, b) => digest(a.key).localeCompare(digest(b.key)))[0],
        );
      }
      const vector = averageVectors(selected);
      const representative = evidence
        .map((e) => ({ row: e.row, score: cosine(vector, e.row.vector) }))
        .sort(
          (a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id),
        )[0].row;
      return {
        session,
        rows: entries.map((e) => e.row),
        vector,
        representative,
        evidence: selected.map((r) => r.parts[0].row),
        evidenceKey: digest(
          selected
            .map((r) => r.key)
            .sort()
            .join(":"),
        ),
      };
    });
}

export function distinctConversationVectors(conversations) {
  const distinct = [];
  for (const item of [...conversations].sort((a, b) =>
    a.session.localeCompare(b.session),
  ))
    if (
      !distinct.some(
        (other) =>
          item.evidenceKey === other.evidenceKey ||
          cosine(item.vector, other.vector) >= 0.985,
      )
    )
      distinct.push(item);
  return distinct;
}

export function conversationAnchors(
  topics,
  conversations,
  oldMembers,
  scopes = new Map(),
  corrections = {},
) {
  const owners = new Map();
  for (const s of conversations) {
    const counts = new Map();
    for (const row of s.rows) {
      const id = oldMembers.get(row.id);
      if (id !== undefined) counts.set(id, (counts.get(id) || 0) + 1);
    }
    owners.set(
      s.session,
      [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0],
    );
  }
  return topics.map((topic) => {
    const references = distinctConversationVectors(
      conversations.filter((s) => {
        if (owners.get(s.session) !== topic.id) return false;
        if (!scopes.has(topic.id) || corrections[s.session] === topic.id)
          return true;
        const own = cosine(s.vector, scopes.get(topic.id));
        const best = Math.max(
          ...[...scopes.values()].map((v) => cosine(s.vector, v)),
        );
        return own >= best - 0.02;
      }),
    );
    return {
      ...topic,
      references,
      ...(scopes.has(topic.id)
        ? {
            center: averageVectors([
              { vector: scopes.get(topic.id) },
              ...(references.length
                ? [{ vector: averageVectors(references) }]
                : []),
            ]),
          }
        : references.length
          ? { center: averageVectors(references) }
          : {}),
    };
  });
}
