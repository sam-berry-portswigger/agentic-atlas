// Presentation-only cleanup: original conversation evidence stays untouched.
export function readableText(value = "") {
  let text = String(value);
  if (/^\s*# Files mentioned by the user:/i.test(text)) {
    const request = /(?:^|\n)## My request:\s*/i.exec(text);
    if (!request) return "";
    text = text.slice(request.index + request[0].length);
  }
  return text
    .replace(
      /<(environment_context|in-app-browser-context)\b[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:\/[\w.~-]+){2,}(?::\d+)?/g, " ")
    .replace(/(?:^|\n)\s*#{1,6}\s*/g, " ")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function shortName(value, max = 80) {
  const text = readableText(value);
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const boundary = head.lastIndexOf(" ");
  return (boundary > max * 0.6 ? head.slice(0, boundary) : head) + "…";
}
export function conversationName(title, project, request = "", max = 80) {
  const raw = String(title || "");
  const metadata =
    /files mentioned by the user|codex-clipboard-|image attachment:|<environment_context>|^# AGENTS\.md/i.test(
      raw,
    );
  const source = metadata ? request : raw;
  // Prefer an explicit task/goal heading over prompt framing. This is display
  // cleanup, not inferred intent: keep the original evidence and native labels.
  const heading =
    /(?:^|\n)\s*#{0,6}\s*(?:Task|Question|Goal|Objective)(?:\s*:\s*|\s*\n\s*)([\s\S]+)/i.exec(
      source,
    );
  let text = readableText(heading ? heading[1] : source);
  const original = text;
  text = text
    .replace(/^(?:Task|Question|Goal|Objective)\s*:\s*/i, "")
    .replace(/^(?:Task|Question)\s+/i, "")
    .replace(
      /^(?:Read[- ]only research[.!]\s*|Do not edit (?:any )?files[.!]\s*)+/i,
      "",
    )
    .replace(/^(?:Goal|Objective)\s*:\s*/i, "")
    .replace(/^(?:Sounds good|OK|Okay|Thanks)[.!]\s*(?:Now\s+)?/i, "")
    .replace(
      /^(?:Please\s+|(?:Can|Could|Would) you\s+(?:please\s+)?)(?=(?:fix|review|investigate|build|implement|run|test|add|remove|check|find|explain|summari[sz]e|update|refactor)\b)/i,
      "",
    )
    .replace(
      /\s*\((?:this working directory|this repository|this repo|current directory)\)/gi,
      "",
    );
  const prompt = heading || text !== original || text.length > max;
  const parts = prompt
    ? text.split(
        /[.!?](?:\s+|$)|\s+(?:(?:Constraints|Acceptance criteria)\s*:|Do not\b|Edit test code only\b|Only edit\b)/,
      )
    : [text];
  const first = (
    /^[A-Z][A-Z0-9_]*-\d+$/.test(parts[0]) && parts[1]
      ? parts.slice(0, 2).join(". ")
      : parts[0]
  ).trim();
  // Avoid turning a short conversational acknowledgement into the whole label.
  const name = first || text;
  const cleaned = name !== readableText(raw);
  return (
    shortName(
      cleaned && name ? name[0].toUpperCase() + name.slice(1) : name,
      max,
    ) || `Conversation in ${project || "Workspace"}`
  );
}
