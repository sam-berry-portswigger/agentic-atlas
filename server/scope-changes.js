import { subjectTerms } from "./search-retrieval.js";
const changed =
  /\b(no longer|not needed|no need|on hold|sufficient|superseded|cancelled|deferred|nothing is needed|covers what|now.{0,25}later|blocker.{0,15}gone)\b/i;
const generic = new Set([
  "start",
  "task",
  "work",
  "status",
  "model",
  "get",
  "create",
  "creation",
]);
const normalized = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
// Preserve direct changed-scope evidence even when free-form synthesis omits it.
// This adds no inferred facts: the displayed changes are verbatim source text.
export function scopeChanges(findings = [], sources = []) {
  const result = [];
  for (const finding of findings.filter(
    (item) => item.verified && item.state === "superseded",
  )) {
    const terms = subjectTerms(finding.subject).filter(
      (term) => !generic.has(term),
    );
    if (!terms.length) continue;
    const candidates = sources
      .map((source, index) => ({
        source,
        index,
        paragraphs: source.text
          .split(/\n\s*\n/)
          .filter((paragraph) => changed.test(paragraph)),
        score: terms.filter((term) => source.text.toLowerCase().includes(term))
          .length,
      }))
      .filter((item) => item.score > 0 && item.paragraphs.length);
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        b.paragraphs.length - a.paragraphs.length ||
        b.source.timestamp.localeCompare(a.source.timestamp),
    );
    const candidate = candidates[0];
    if (!candidate || result.some((item) => item.id === candidate.source.id))
      continue;
    const paragraphs = [];
    let length = 0;
    for (const paragraph of candidate.paragraphs) {
      if (length + paragraph.length > 1500) continue;
      paragraphs.push(paragraph);
      length += paragraph.length;
    }
    if (!paragraphs.length) continue;
    const text = paragraphs.join("\n\n");
    const identifiers = [
      ...text.matchAll(/`([a-zA-Z][a-zA-Z0-9_.-]{4,100})`/g),
    ].map((match) => normalized(match[1]));
    result.push({
      id: candidate.source.id,
      subject: finding.subject,
      terms,
      identifiers,
      text,
      citation: candidate.index + 1,
    });
  }
  return result.slice(0, 3);
}
export function preserveScopeChanges(answer, changes) {
  if (!changes.length) return answer;
  const retained = answer
    .split(/\n\s*\n/)
    .filter((paragraph) => !mentionsChangedScope(paragraph, changes))
    .join("\n\n")
    .trim();
  const evidence = changes
    .map(
      (change) =>
        `**Changed scope — ${change.subject}:**\n\n${change.text
          .split("\n")
          .map((line) => "> " + line)
          .join("\n")} [${change.citation}]`,
    )
    .join("\n\n");
  return evidence + (retained ? "\n\n" + retained : "");
}

export function mentionsChangedScope(text, changes) {
  const plain = text.toLowerCase(),
    canonical = normalized(text);
  return changes.some(
    (change) =>
      change.terms.some((term) =>
        new RegExp(
          `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(plain),
      ) ||
      change.identifiers.some((identifier) => canonical.includes(identifier)),
  );
}
