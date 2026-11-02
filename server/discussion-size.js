import { usefulText } from "./evidence.js";
export function discussionSize(rows) {
  const messages = new Map();
  for (const row of rows) {
    if (!usefulText(row.text)) continue;
    const key = `${row.session}:${row.role}:${row.timestamp}`;
    if (!messages.has(key))
      messages.set(key, { role: row.role, parts: new Set() });
    messages.get(key).parts.add(row.text.replace(/\s+/g, " ").trim());
  }
  const unique = new Map();
  for (const message of messages.values()) {
    const text = [...message.parts].sort().join(" ");
    unique.set(`${message.role}:${text}`, { role: message.role, text });
  }
  const turns = [...unique.values()];
  const userTurns = turns.filter((turn) => turn.role === "user").length;
  const assistantTurns = turns.filter(
    (turn) => turn.role === "assistant",
  ).length;
  const characters = turns.reduce(
    (sum, turn) => sum + Math.min(turn.text.length, 2000),
    0,
  );
  return {
    turns: turns.length,
    userTurns,
    assistantTurns,
    characters,
    substantial:
      turns.length >= 6 &&
      userTurns >= 2 &&
      assistantTurns >= 2 &&
      characters >= 2000,
  };
}
