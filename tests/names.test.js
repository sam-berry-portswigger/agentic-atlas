import test from "node:test";
import assert from "node:assert/strict";
import { readableText, shortName, conversationName } from "../server/names.js";
import { validTopicName } from "../server/analysis.js";

const attachment = `# Files mentioned by the user:\n\n## codex-clipboard-abc.png: /var/folders/private/codex-clipboard-abc.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nMake the sidebar navigation clearer and improve the project filters.\n<image name="attachment">image payload</image>`;
test("attachment and formatting metadata cannot become a conversation title or preview", () => {
  assert.equal(
    readableText(attachment),
    "Make the sidebar navigation clearer and improve the project filters.",
  );
  assert.equal(
    readableText(
      "# Files mentioned by the user: ## codex-clipboard-abc.png: /var/fol",
    ),
    "",
  );
  const existing = conversationName(
    "# Files mentioned by the user: ## codex-clipboard-abc.png: /var/fol",
    "atlas",
    attachment,
  );
  assert.match(existing, /^Make the sidebar/);
  assert.doesNotMatch(
    existing,
    /clipboard|Image attachment|payload|var\/folders/,
  );
  assert.equal(
    conversationName(
      "# Files mentioned by the user: ## codex-clipboard-abc.png: /var/fol",
      "atlas",
    ),
    "Conversation in atlas",
  );
  assert.equal(
    readableText(
      "Fix **navigation** using [this design](https://example.com/design).",
    ),
    "Fix navigation using this design.",
  );
});
test("long names truncate at words with a visible ellipsis", () => {
  const title =
    "Sounds good. Now do harder red-teaming. We arent looking for perfect, so very niche races wont end up blocking this.";
  const name = shortName(title);
  assert.ok(name.length <= 80);
  assert.ok(name.endsWith("…"));
  assert.ok(title.includes(name.slice(0, -1)));
  assert.equal(
    shortName("Reviewing PR #1234 Findings"),
    "Reviewing PR #1234 Findings",
  );
  assert.equal(shortName("x".repeat(200)).length, 80);
});
test("bulk topic naming rejects the previous generic and prompt-derived fallbacks", () => {
  for (const name of [
    "Work",
    "Test · Fix · Review",
    "Sounds good. Now do harder red-teaming.",
    "# Files mentioned by the user: image.png",
  ])
    assert.equal(validTopicName(name), false, name);
  assert.equal(
    validTopicName("Managing Development Task State and Tooling"),
    true,
  );
  assert.equal(validTopicName("Exploring Work and Topic Navigation"), true);
});
test("session labels keep task intent and remove prompt framing without inference", () => {
  assert.equal(
    conversationName(
      "# Task\nimplement a test-only fix in the sample desktop repo (this working directory)\nEdit test code only, under testing/ui. Do not change production code.",
      "desktop",
    ),
    "Implement a test-only fix in the sample desktop repo",
  );
  assert.equal(
    conversationName(
      "Read-only research. Do not edit any files. Goal: summarise earlier Claude decisions. Return only the findings.",
      "desktop",
    ),
    "Summarise earlier Claude decisions",
  );
  assert.equal(
    conversationName("Please review PR 2345. Only edit tests.", "desktop"),
    "Review PR 2345",
  );
  assert.equal(
    conversationName(
      "Sounds good. Now investigate the schedule-fetch failure.",
      "desktop",
    ),
    "Investigate the schedule-fetch failure",
  );
});
test("session labels preserve native issue labels and technical names", () => {
  for (const title of [
    "DEMO-123. Turn on the quick-search flag.",
    "Review PR #2345",
    "Test QUICK_SEARCH=false and AUTOSAVE_ENABLED=true",
    "Jackson 2.18.1 record metadata",
  ])
    assert.equal(conversationName(title, "desktop"), title);
  const raw =
    "# Task\nFix SearchOptions.java for QUICK_SEARCH. Do not change AUTOSAVE_ENABLED.";
  assert.equal(
    conversationName(raw, "desktop"),
    "Fix SearchOptions.java for QUICK_SEARCH",
  );
});
